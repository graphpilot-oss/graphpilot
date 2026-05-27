/**
 * Watch mode (A2) — keep the on-disk graph fresh as the user edits.
 *
 * Algorithm per file event:
 *   1. Remove all symbols + raw calls that came from this file
 *   2. Re-parse the file, extract its symbols + raw calls
 *   3. Re-resolve all raw calls against the full symbol table
 *      (cheap: under 50ms for a 2k-symbol repo)
 *   4. Atomic save via storage.saveGraph (.tmp + rename)
 *
 * No schema change: rawCalls are reconstructed from existing edges on
 * startup (every CallEdge carries fromId/toName/file/line/column, which
 * is exactly the RawCall shape).
 *
 * Diagnostic lines go to stderr — never stdout — so stdin/stdout stays
 * clean for any agent that's also reading the graph over MCP.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import { realpathSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { parseFile } from './parser.js';
import { extractSymbols, type SymbolRecord } from './symbols.js';
import { extractRawCalls, resolveCallEdges, type RawCall, type CallEdge } from './edges.js';
import { saveGraph, loadGraph, repoIdFor, graphPath, type Graph } from './storage.js';
import { readGitInfo } from './git.js';
import { indexDirectory } from './indexer.js';
import { validateRootPath, MAX_FILES_PER_INDEX } from './validation.js';

/** Per-event delta the watcher reports back to the caller (and to stderr). */
export interface UpdateResult {
  file: string;
  kind: 'add' | 'change' | 'delete';
  symbolsBefore: number;
  symbolsAfter: number;
  edgesBefore: number;
  edgesAfter: number;
  durationMs: number;
}

export interface WatcherOptions {
  /** Debounce window for editor "save in 3 syscalls" patterns. Default 100 ms. */
  awaitStabilityMs?: number;
  /** Logger for human-readable progress lines. Default: process.stderr. */
  log?: (line: string) => void;
}

const DEFAULT_IGNORE = [
  /(^|[/\\])\.git([/\\]|$)/,
  /(^|[/\\])node_modules([/\\]|$)/,
  /(^|[/\\])dist([/\\]|$)/,
  /(^|[/\\])build([/\\]|$)/,
  /(^|[/\\])coverage([/\\]|$)/,
  /(^|[/\\])\.next([/\\]|$)/,
  /(^|[/\\])\.nuxt([/\\]|$)/,
  /(^|[/\\])\.cache([/\\]|$)/,
  /(^|[/\\])out([/\\]|$)/,
  /\.d\.ts$/,
];

const WATCHED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function isWatchableFile(absPath: string): boolean {
  const dot = absPath.lastIndexOf('.');
  if (dot === -1) return false;
  return WATCHED_EXT.has(absPath.slice(dot).toLowerCase());
}

function defaultLogger(line: string): void {
  process.stderr.write(`[graphpilot:watch] ${line}\n`);
}

/**
 * Stateful watcher. Owns the in-memory Graph + raw calls and reconciles
 * the on-disk graph.json on every event.
 *
 * Methods come in two flavours:
 *   - lifecycle: start / stop, drive chokidar
 *   - applyUpdate / applyDeletion: synchronous-style helpers that tests
 *     can call directly, bypassing chokidar (which is racy in tests)
 */
export class GraphWatcher {
  readonly absRoot: string;
  private graph: Graph;
  private rawCalls: RawCall[];
  private watcher: FSWatcher | null = null;
  private readonly log: (line: string) => void;
  private readonly awaitStabilityMs: number;
  /** mtime + size of graph.json after the last save this process performed. */
  private lastSavedMtimeMs = 0;
  private lastSavedSizeBytes = 0;
  /**
   * Serializes the update queue so chokidar bursts (multiple `change`
   * events in 200ms) don't race each other into a torn graph.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(rawRoot: string, opts: WatcherOptions = {}) {
    this.absRoot = resolve(rawRoot);
    this.log = opts.log ?? defaultLogger;
    this.awaitStabilityMs = opts.awaitStabilityMs ?? 100;

    const refusal = validateRootPath(this.absRoot);
    if (refusal) throw new Error(refusal);

    // Defence-in-depth realpath check (T2): make sure the user-given path
    // resolves to a real directory. We do NOT overwrite this.absRoot with
    // the canonical form — that would break the path → repoId hash and
    // cause the watcher to read+write a different graph.json than `index`.
    realpathSync(this.absRoot);

    const loaded = loadGraph(this.absRoot);
    if (loaded) {
      this.graph = loaded;
      this.rawCalls = this.deriveRawCalls(loaded.edges);
      try {
        const st = statSync(graphPath(this.absRoot));
        this.lastSavedMtimeMs = st.mtimeMs;
        this.lastSavedSizeBytes = st.size;
      } catch {
        // best-effort baseline
      }
    } else {
      // No existing index — caller is expected to `start()`, which will
      // build one. We initialize empty here so applyUpdate is safe to call
      // pre-start in tests.
      this.graph = {
        version: 1,
        repoId: repoIdFor(this.absRoot),
        rootPath: this.absRoot,
        indexedAt: new Date().toISOString(),
        filesIndexed: 0,
        symbolCount: 0,
        edgeCount: 0,
        symbols: [],
        edges: [],
      };
      this.rawCalls = [];
    }
  }

  /** Build a one-shot full index if no graph exists, then start the watcher. */
  async start(): Promise<void> {
    if (this.graph.symbols.length === 0) {
      this.log(`No existing index. Running full index of ${this.absRoot} ...`);
      await this.fullReindex();
    }

    this.log(
      `Watching ${this.absRoot} ` +
        `(${this.graph.symbols.length} symbols, ${this.graph.edges.length} calls, ` +
        `${this.graph.filesIndexed} files). Edit a file to see updates.`,
    );

    this.watcher = chokidar.watch(this.absRoot, {
      ignored: DEFAULT_IGNORE,
      ignoreInitial: true, // we already have a graph
      persistent: true,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: this.awaitStabilityMs,
        pollInterval: 50,
      },
    });

    this.watcher.on('add', (abs: string) => this.enqueue(() => this.handleEvent(abs, 'add')));
    this.watcher.on('change', (abs: string) => this.enqueue(() => this.handleEvent(abs, 'change')));
    this.watcher.on('unlink', (abs: string) => this.enqueue(() => this.handleDeletion(abs)));
    this.watcher.on('error', (err: unknown) => this.log(`watcher error: ${String(err)}`));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    await this.chain;
    this.log('Stopped.');
  }

  /**
   * Process a single file update. Public so tests can drive it directly
   * without spawning chokidar.
   */
  async applyUpdate(
    absFilePath: string,
    kind: 'add' | 'change' = 'change',
  ): Promise<UpdateResult | null> {
    if (!isWatchableFile(absFilePath)) return null;
    if (absFilePath !== this.absRoot && !absFilePath.startsWith(this.absRoot + sep)) return null;

    // Detect mtime drift — reload before computing the delta so we apply
    // the edit on top of the freshest known graph, not a stale in-memory one.
    this.reloadIfDrifted();

    const start = Date.now();
    const rel = relative(this.absRoot, absFilePath);
    const symbolsBefore = this.graph.symbols.length;
    const edgesBefore = this.graph.edges.length;

    // 1. Remove existing symbols + raw calls from this file
    const keptSymbols = this.graph.symbols.filter((s) => s.file !== rel);
    const keptRawCalls = this.rawCalls.filter((c) => c.file !== rel);

    // 2. Parse the new content + extract
    const parsed = parseFile(absFilePath);
    if (!parsed) {
      // Could not parse (too large, unknown ext, gone, etc.) — treat as a
      // deletion of that file's contribution. Keeps the index honest.
      this.commitState(keptSymbols, keptRawCalls);
      const result = this.finalize(rel, kind, symbolsBefore, edgesBefore, start);
      this.log(
        `${rel} unparseable; dropped ${symbolsBefore - keptSymbols.length} symbols (${result.durationMs}ms).`,
      );
      return result;
    }

    const fileSymbols = extractSymbols(parsed);
    const fileCalls = extractRawCalls(parsed, fileSymbols);

    // 3. Normalize paths + rewrite ids to relative form (same as indexer.ts)
    const idRewrites = new Map<string, string>();
    for (const s of fileSymbols) {
      const oldId = s.id;
      s.file = rel;
      s.id = oldId.replace(absFilePath, rel);
      idRewrites.set(oldId, s.id);
    }
    for (const c of fileCalls) {
      c.file = rel;
      c.fromId = idRewrites.get(c.fromId) ?? c.fromId;
    }

    const newSymbols = [...keptSymbols, ...fileSymbols];
    const newRawCalls = [...keptRawCalls, ...fileCalls];

    // 4. Re-resolve every edge against the new symbol table. Cheap.
    this.commitState(newSymbols, newRawCalls);

    const result = this.finalize(rel, kind, symbolsBefore, edgesBefore, start);
    this.log(
      `${rel}: ${this.deltaStr(symbolsBefore, result.symbolsAfter)} symbols, ` +
        `${this.deltaStr(edgesBefore, result.edgesAfter)} calls (${result.durationMs}ms).`,
    );
    return result;
  }

  /** Drop everything that came from a deleted file. */
  async applyDeletion(absFilePath: string): Promise<UpdateResult | null> {
    if (absFilePath !== this.absRoot && !absFilePath.startsWith(this.absRoot + sep)) return null;

    this.reloadIfDrifted();

    const start = Date.now();
    const rel = relative(this.absRoot, absFilePath);
    const symbolsBefore = this.graph.symbols.length;
    const edgesBefore = this.graph.edges.length;

    const keptSymbols = this.graph.symbols.filter((s) => s.file !== rel);
    const keptRawCalls = this.rawCalls.filter((c) => c.file !== rel);

    // No change? File wasn't in the index, ignore.
    if (
      keptSymbols.length === this.graph.symbols.length &&
      keptRawCalls.length === this.rawCalls.length
    ) {
      return null;
    }

    this.commitState(keptSymbols, keptRawCalls);
    const result = this.finalize(rel, 'delete', symbolsBefore, edgesBefore, start);
    this.log(
      `${rel} deleted: ${this.deltaStr(symbolsBefore, result.symbolsAfter)} symbols, ` +
        `${this.deltaStr(edgesBefore, result.edgesAfter)} calls (${result.durationMs}ms).`,
    );
    return result;
  }

  /** Force a full re-index from scratch. Used on startup if no graph exists. */
  async fullReindex(): Promise<void> {
    const result = await indexDirectory(this.absRoot);
    if (result.symbols.length > MAX_FILES_PER_INDEX) {
      throw new Error('Refusing to watch: index would exceed MAX_FILES_PER_INDEX.');
    }
    this.graph = {
      version: 1,
      repoId: repoIdFor(this.absRoot),
      rootPath: this.absRoot,
      indexedAt: new Date().toISOString(),
      filesIndexed: result.filesIndexed,
      symbolCount: result.symbols.length,
      edgeCount: result.edges.length,
      symbols: result.symbols,
      edges: result.edges,
      indexedSha: result.git.sha,
      indexedBranch: result.git.branch,
    };
    this.rawCalls = this.deriveRawCalls(result.edges);
    saveGraph(this.graph);
    try {
      const st = statSync(graphPath(this.absRoot));
      this.lastSavedMtimeMs = st.mtimeMs;
      this.lastSavedSizeBytes = st.size;
    } catch {
      // best-effort
    }
  }

  /** Read-only accessor, mainly for tests + diagnostics. */
  get currentGraph(): Graph {
    return this.graph;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Chain updates so chokidar's burst events don't run in parallel. Errors
   * are logged but never abort the chain — the next event still runs.
   */
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(
      () =>
        work().catch((err) => {
          this.log(`error: ${err instanceof Error ? err.message : String(err)}`);
        }),
      () => undefined, // can't reach because catch above never rejects
    );
  }

  private async handleEvent(abs: string, kind: 'add' | 'change'): Promise<void> {
    if (!isWatchableFile(abs)) return;
    await this.applyUpdate(abs, kind);
  }

  private async handleDeletion(abs: string): Promise<void> {
    await this.applyDeletion(abs);
  }

  /**
   * If graph.json was written by another process since we last saved, reload
   * it into memory so the next delta is applied on top of the fresh state.
   * This handles gp_index from an agent, a parallel CLI re-index, or a
   * git checkout while watch is running.
   */
  private reloadIfDrifted(): void {
    if (this.lastSavedMtimeMs === 0) return; // no baseline yet
    try {
      const st = statSync(graphPath(this.absRoot));
      // Check both mtime and size: mtime alone has 1-second resolution on some
      // Windows filesystems (FAT/exFAT, some container mounts), so a rapid
      // external write within the same second would not be detected. Adding the
      // size check catches content changes even when the clock doesn't advance.
      if (st.mtimeMs === this.lastSavedMtimeMs && st.size === this.lastSavedSizeBytes) return;
      const fresh = loadGraph(this.absRoot);
      if (fresh) {
        this.graph = fresh;
        this.rawCalls = this.deriveRawCalls(fresh.edges);
        this.lastSavedMtimeMs = st.mtimeMs;
        this.lastSavedSizeBytes = st.size;
        this.log(
          `Detected external re-index (${fresh.symbolCount} symbols); reloaded before applying delta.`,
        );
      }
    } catch {
      // best-effort — if statSync fails the file is gone; next save will recreate it
    }
  }

  /**
   * Apply a new (symbols, rawCalls) state: re-resolve edges, update the
   * graph object, save atomically.
   */
  private commitState(symbols: SymbolRecord[], rawCalls: RawCall[]): void {
    const edges = resolveCallEdges(rawCalls, symbols);

    // Recompute filesIndexed from surviving symbols' files.
    const files = new Set<string>();
    for (const s of symbols) files.add(s.file);

    // Re-read git info on every commit — branch / sha can change between
    // edits (e.g. user did `git checkout` mid-session) and we want the
    // graph stamped with the *current* state. Cheap: a few fs reads.
    const git = readGitInfo(this.absRoot);

    this.graph = {
      ...this.graph,
      indexedAt: new Date().toISOString(),
      filesIndexed: files.size,
      symbolCount: symbols.length,
      edgeCount: edges.length,
      symbols,
      edges,
      indexedSha: git.sha,
      indexedBranch: git.branch,
    };
    this.rawCalls = rawCalls;
    saveGraph(this.graph);
    try {
      const st = statSync(graphPath(this.absRoot));
      this.lastSavedMtimeMs = st.mtimeMs;
      this.lastSavedSizeBytes = st.size;
    } catch {
      // best-effort
    }
  }

  private finalize(
    file: string,
    kind: UpdateResult['kind'],
    symbolsBefore: number,
    edgesBefore: number,
    start: number,
  ): UpdateResult {
    return {
      file,
      kind,
      symbolsBefore,
      symbolsAfter: this.graph.symbols.length,
      edgesBefore,
      edgesAfter: this.graph.edges.length,
      durationMs: Date.now() - start,
    };
  }

  private deriveRawCalls(edges: CallEdge[]): RawCall[] {
    return edges.map((e) => ({
      fromId: e.fromId,
      toName: e.toName,
      file: e.file,
      line: e.line,
      column: e.column,
    }));
  }

  private deltaStr(before: number, after: number): string {
    const delta = after - before;
    if (delta === 0) return `${after} (=)`;
    const sign = delta > 0 ? '+' : '';
    return `${after} (${sign}${delta})`;
  }
}
