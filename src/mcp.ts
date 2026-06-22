import { statSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { GraphIndex } from './query.js';
import { indexDirectory } from './indexer.js';
import {
  loadGraphResult,
  saveGraph,
  repoIdFor,
  graphPath,
  type Graph,
  type GraphLoadFailure,
} from './storage.js';
import { validateRootPath } from './validation.js';
import {
  validateGpIndex,
  validateGpRecall,
  validateGpCallers,
  validateGpImpact,
  type GpRecallArgs,
  type GpCallersArgs,
  type GpImpactArgs,
  type GpIndexArgs,
} from './validators.js';
import { withInteractionLog } from './interactions.js';
import { analyzeImpact, type ImpactCaller, type ImpactResult } from './impact.js';
import { getChangedFiles, resolveIndexRoot } from './git.js';
import {
  formatNoIndexError,
  formatBrokenIndexError,
  getMcpClientRoots,
  resolveRepoPath,
  rootUriToFilesystemPath,
  setMcpClientRoots,
} from './repo-resolve.js';
import type { SymbolRecord } from './symbols.js';
import type { CallEdge } from './edges.js';

const SERVER_NAME = 'graphpilot';
const SERVER_VERSION = '0.0.1';

/** Shown on every tool's optional `path` field. */
const PATH_FIELD_DESC =
  'Repo root with a GraphPilot index. Optional: when omitted, resolves via ' +
  'GRAPHPILOT_ROOT, MCP workspace roots, parent walk, or a single ~/.graphpilot index.';

// ----------------------------------------------------------------------------
// Per-process cache of loaded GraphIndex by absolute repo path.
// ----------------------------------------------------------------------------

interface CacheEntry {
  idx: GraphIndex;
  /**
   * mtime + size of graph.json when this entry was loaded.
   * Size is checked alongside mtime because some filesystems (Windows FAT/exFAT,
   * certain container mounts) have 1-second mtime resolution — a write within
   * the same second would share the mtime but produce a different size.
   */
  mtimeMs: number;
  sizeBytes: number;
}

const indexCache = new Map<string, CacheEntry>();

/** Set when buildMcpServer wires roots handlers — used for lazy roots/list. */
let mcpServerForRoots: Server | null = null;
let rootsRefreshInflight: Promise<void> | null = null;

/**
 * Map a stat outcome + load outcome to the agent-facing error, or null when
 * there's nothing to report. Pure (no FS/cache), so the message policy is
 * unit-testable in isolation from the cache/stat side effects in
 * getOrLoadIndex.
 *
 * #67: a corrupt index gets a different message than a missing one — the agent
 * must not tell the user to `index` a repo whose graph already exists.
 * #69: a non-ENOENT stat error means the index file is there but unreadable
 * right now, which is a transient condition, not "no index".
 */
export function indexErrorMessage(
  requested: string,
  root: string,
  statErrCode: string | undefined,
  loadReason: GraphLoadFailure | null,
): string | null {
  if (statErrCode && statErrCode !== 'ENOENT') {
    return formatBrokenIndexError(root, 'unreadable', statErrCode);
  }
  if (loadReason === null) return null;
  if (loadReason === 'missing') return formatNoIndexError(requested, root);
  if (loadReason === 'unreadable') return formatBrokenIndexError(root, 'unreadable');
  if (loadReason === 'stale-version') return formatBrokenIndexError(root, 'stale');
  return formatBrokenIndexError(root, 'corrupt', loadReason);
}

function getOrLoadIndex(
  rawPath: string | undefined,
): { idx: GraphIndex; root: string } | { error: string; root: string } {
  const requested = resolveRepoPath(rawPath);
  // Re-root to the git worktree top so MCP tool calls from a subdir of a
  // worktree still resolve to the branch-level index. Outside git this is
  // a no-op.
  const { root } = resolveIndexRoot(requested);

  // Check whether graph.json changed since we last loaded it. Any external
  // writer (CLI re-index, another MCP process, gp_index from a parallel
  // session) will bump the mtime and trigger a cache miss here.
  let currentMtimeMs = 0;
  let currentSizeBytes = 0;
  let statErrCode: string | undefined;
  try {
    const st = statSync(graphPath(root));
    currentMtimeMs = st.mtimeMs;
    currentSizeBytes = st.size;
  } catch (e) {
    statErrCode = (e as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
  }

  // Fast path: we successfully stat'd the file (currentMtimeMs !== 0) and its
  // fingerprint matches the cached copy.
  const cached = indexCache.get(root);
  if (
    cached &&
    currentMtimeMs !== 0 &&
    cached.mtimeMs === currentMtimeMs &&
    cached.sizeBytes === currentSizeBytes
  ) {
    return { idx: cached.idx, root };
  }

  // #69: a stat error that is NOT ENOENT (EACCES, EMFILE, EIO, …) means the
  // index file exists but we couldn't read its metadata this instant. We must
  // not (a) keep silently serving a possibly-stale warm cache, nor (b) claim
  // "no index" — both mislead. Drop the cache and surface a clear transient
  // error the agent can relay verbatim.
  if (statErrCode && statErrCode !== 'ENOENT') {
    indexCache.delete(root);
    return { root, error: indexErrorMessage(requested, root, statErrCode, null) as string };
  }

  // Cache miss / stale / file genuinely gone — (re)load from disk.
  indexCache.delete(root);
  const res = loadGraphResult(root);
  if (!res.ok) {
    return { root, error: indexErrorMessage(requested, root, undefined, res.reason) as string };
  }
  const idx = new GraphIndex(res.graph);
  // Only cache when we have a trustworthy fingerprint. (currentMtimeMs is
  // always non-zero on this path — a zero would mean a non-ENOENT stat error,
  // which returned above — but guard explicitly so a future edit can't poison
  // the cache with a 0 mtime that never matches a real stat again.)
  if (currentMtimeMs !== 0) {
    indexCache.set(root, { idx, mtimeMs: currentMtimeMs, sizeBytes: currentSizeBytes });
  }
  return { idx, root };
}

function invalidateCache(absRoot: string): void {
  indexCache.delete(absRoot);
}

// ----------------------------------------------------------------------------
// Tool-output formatting helpers (terse, agent-friendly text).
// ----------------------------------------------------------------------------

/**
 * Render the short SHA suffix for an inline evidence anchor. Returns an
 * empty string when the indexed root isn't in a git repo.
 *
 * Format: " @ ab12cd3"
 */
function shaTag(idx: GraphIndex): string {
  const sha = idx.graph.indexedSha;
  if (!sha) return '';
  return ' @ ' + sha.slice(0, 7);
}

function fmtSymbol(s: SymbolRecord, idx: GraphIndex, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const parentTag = s.parent ? `${s.parent}.` : '';
  const exp = s.exported ? ' [exported]' : '';
  // Evidence anchor: file:line @ sha (when in a git repo) — agent can
  // include this verbatim in its reply for the user to verify.
  return (
    `${prefix}${parentTag}${s.name}  (${s.kind})  ${s.file}:${s.line}${shaTag(idx)}${exp}\n` +
    `   ${s.signature}`
  );
}

function fmtEdge(e: CallEdge, idx: GraphIndex, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  // We don't know upfront whether this is a callers or callees listing, so the
  // safest thing is to show both ends.
  const fromSym = idx.findById(e.fromId);
  const fromName = fromSym
    ? `${fromSym.parent ? fromSym.parent + '.' : ''}${fromSym.name}`
    : e.fromId;
  const toLabel = e.toId
    ? (() => {
        const t = idx.findById(e.toId);
        return t ? `${t.parent ? t.parent + '.' : ''}${t.name}` : e.toName;
      })()
    : `${e.toName} <unresolved>`;
  // Flag best-guess resolutions so the agent can disambiguate via full id
  // rather than trusting an arbitrary pick among homonyms (issue #18).
  const ambiguityTag = e.ambiguous
    ? `  [1 of ${e.candidateCount ?? 2} candidates — disambiguate via full id]`
    : '';
  // Evidence anchor on the call site (the file:line where the call occurs).
  return `${prefix}${fromName}  →  ${toLabel}  (${e.file}:${e.line}${shaTag(idx)})${ambiguityTag}`;
}

// ----------------------------------------------------------------------------
// Tool catalog (sent to clients via tools/list)
// ----------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'gp_index',
    description:
      'Re-index the repo after batch edits so subsequent gp_* calls see your changes. ' +
      'Call after any non-trivial edit session. ' +
      'Do NOT call before every query — indexing is slow; only needed when source files changed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: PATH_FIELD_DESC,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gp_recall',
    description:
      'Find a symbol definition by name — returns kind, file:line, and signature. ' +
      'ALWAYS use instead of `grep -rn "function X"` or reading files to locate a definition: ' +
      'pre-indexed, no false positives from comments or strings, sub-millisecond. ' +
      'Pass substring:true for partial-name searches. ' +
      'Do NOT use for "who calls X?" — use gp_callers for that.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name to look up.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max results (default 10).',
        },
        substring: {
          type: 'boolean',
          description: 'Enable substring match (default false).',
        },
        path: {
          type: 'string',
          description: PATH_FIELD_DESC,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'gp_callers',
    description:
      'List every caller of a symbol (direction=callers) or everything it calls ' +
      '(direction=callees). ALWAYS use instead of `grep -rn "X("` for "who calls X?" — ' +
      'pre-indexed reverse map, sub-millisecond, no false positives from comments or strings. ' +
      'Use direction=callers to find dependents before a rename; direction=callees to ' +
      'understand what a function depends on. ' +
      'Do NOT use for full blast-radius analysis across multiple hops — use gp_impact instead.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbol name or full id.',
        },
        direction: {
          type: 'string',
          enum: ['callers', 'callees'],
          description: "Default 'callers'.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Max edges (default 50).',
        },
        includeUnresolved: {
          type: 'boolean',
          description: 'Include external/stdlib calls (default true).',
        },
        path: {
          type: 'string',
          description: PATH_FIELD_DESC,
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'gp_impact',
    description:
      'Compute the blast radius of a rename or signature change: direct callers, ' +
      'transitive callers up to depth 3, affected tests, and whether the symbol is ' +
      'exported (breaking-change risk). ALWAYS call before proposing a rename, ' +
      'signature change, or behavior change — replaces `git diff | xargs grep` with ' +
      'a single structured answer. ' +
      'Pass `since: <commit|branch>` to scope callers to files changed since that ref ' +
      '(ideal for PR review or refactor scoping). ' +
      'Do NOT use just to see direct callers; use gp_callers for that.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbol name or full id to analyze.',
        },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: 'BFS depth over the callers graph. Default 3.',
        },
        path: {
          type: 'string',
          description: PATH_FIELD_DESC,
        },
        since: {
          type: 'string',
          description:
            'Optional commit SHA, tag, or branch. When set, restricts ' +
            'callers to files changed between that ref and HEAD.',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
] as const;

// ----------------------------------------------------------------------------
// Tool handlers
// ----------------------------------------------------------------------------

interface ToolResult {
  text: string;
  results: number;
  isError?: boolean;
}

async function handleGpIndex(args: GpIndexArgs): Promise<ToolResult> {
  await ensureClientRootsCached();
  const requested = resolveRepoPath(args.path);
  const { root, redirected } = resolveIndexRoot(requested);
  const refusal = validateRootPath(root);
  if (refusal) return { text: `Error: ${refusal}`, results: 0, isError: true };

  const result = await indexDirectory(root);
  const graph: Graph = {
    version: 2,
    repoId: repoIdFor(root),
    rootPath: root,
    indexedAt: new Date().toISOString(),
    filesIndexed: result.filesIndexed,
    symbolCount: result.symbols.length,
    edgeCount: result.edges.length,
    symbols: result.symbols,
    edges: result.edges,
    indexedSha: result.git.sha,
    indexedBranch: result.git.branch,
  };
  saveGraph(graph);
  // After re-index, drop the cached GraphIndex for this root so subsequent
  // calls see fresh data.
  invalidateCache(root);
  const resolved = result.edges.filter((e) => e.toId !== null).length;
  // Mirror cmdIndex: surface git provenance in the agent-visible output so
  // the agent can cite the exact commit it just indexed against.
  let gitLine = '';
  if (result.git.shortSha || result.git.branch) {
    const parts: string[] = [];
    if (result.git.branch) parts.push(`branch ${result.git.branch}`);
    if (result.git.shortSha) parts.push(`sha ${result.git.shortSha}`);
    gitLine = `  Git:     ${parts.join(' @ ')}\n`;
  }
  const wtNote = redirected
    ? `(re-rooted to git worktree top; requested path was ${requested})\n`
    : '';
  const text =
    `Indexed ${root}\n` +
    wtNote +
    `  Files:   ${result.filesIndexed}\n` +
    `  Symbols: ${result.symbols.length}\n` +
    `  Calls:   ${result.edges.length} (${resolved} resolved)\n` +
    gitLine +
    `  Took:    ${result.durationMs}ms`;
  return { text, results: 1 };
}

async function handleGpRecall(args: GpRecallArgs): Promise<ToolResult> {
  await ensureClientRootsCached();
  const out = getOrLoadIndex(args.path);
  if ('error' in out) {
    return { text: out.error, results: 0, isError: true };
  }
  const { idx } = out;
  const matches = idx.findByName(args.query, {
    limit: args.limit,
    substring: args.substring,
  });
  if (matches.length === 0) {
    return {
      text: `No symbols match "${args.query}".`,
      results: 0,
    };
  }
  const header = `Found ${matches.length} symbol(s) matching "${args.query}":\n`;
  const body = matches.map((s, i) => fmtSymbol(s, idx, i)).join('\n\n');
  return { text: header + body, results: matches.length };
}

async function handleGpCallers(args: GpCallersArgs): Promise<ToolResult> {
  await ensureClientRootsCached();
  const out = getOrLoadIndex(args.path);
  if ('error' in out) {
    return { text: out.error, results: 0, isError: true };
  }
  const { idx } = out;
  const direction = args.direction ?? 'callers';
  const target = idx.resolveSymbol(args.symbol);
  if (!target) {
    return {
      text: `No symbol found matching "${args.symbol}".`,
      results: 0,
      isError: true,
    };
  }

  const edges =
    direction === 'callers'
      ? idx.callers(target.id, { limit: args.limit })
      : idx.callees(target.id, {
          limit: args.limit,
          includeUnresolved: args.includeUnresolved !== false,
        });

  if (edges.length === 0) {
    const label = direction === 'callers' ? 'callers' : 'callees';
    return {
      text: `No ${label} found for ${target.name} (${target.file}:${target.line}).`,
      results: 0,
    };
  }

  const verb = direction === 'callers' ? 'callers of' : 'callees of';
  // Evidence anchor on the target itself: file:line @ sha so the agent can
  // verify the symbol it's about to act on really lives where we say.
  const header =
    `${edges.length} ${verb} ${target.name} ` + `(${target.file}:${target.line}${shaTag(idx)}):\n`;
  const body = edges.map((e, i) => fmtEdge(e, idx, i)).join('\n');
  return { text: header + body, results: edges.length };
}

/**
 * Format an ImpactCaller for the agent's text output. Includes via-symbol
 * context when depth > 1 so the agent can trace the chain.
 */
function fmtImpactCaller(c: ImpactCaller, idx: GraphIndex): string {
  // Evidence anchor on every caller — file:line @ sha lets the agent
  // (and ultimately the user) verify each impact entry.
  const head = `  ${c.symbol.name} (${c.symbol.file}:${c.symbol.line}${shaTag(idx)})`;
  if (c.depth === 1) return head;
  // For transitive callers, show the immediate hop the edge connects to —
  // the symbol that this caller called (one closer to the target).
  const via = c.edge.toId ? idx.findById(c.edge.toId) : null;
  const viaText = via ? `  ← calls ${via.name}` : `  ← calls ${c.edge.toName}`;
  return `${head} [depth ${c.depth}]${viaText}`;
}

function fmtImpactReport(
  report: ImpactResult,
  idx: GraphIndex,
  diff: { since?: string; changedFileCount: number | null } = { changedFileCount: null },
): string {
  const t = report.target;
  const lines: string[] = [];
  lines.push(`Impact of changing ${t.name} (${t.file}:${t.line}, kind=${t.kind}):`);
  if (diff.since !== undefined) {
    lines.push(
      `(differential mode: scoped to ${diff.changedFileCount ?? 0} file(s) changed since ${diff.since})`,
    );
  }
  lines.push('');

  lines.push(`Direct callers (${report.stats.directCount}):`);
  if (report.directCallers.length === 0) {
    lines.push('  (none in indexed code)');
  } else {
    for (const c of report.directCallers) lines.push(fmtImpactCaller(c, idx));
  }
  lines.push('');

  if (report.transitiveCallers.length > 0) {
    lines.push(`Transitive callers (${report.stats.transitiveCount}):`);
    for (const c of report.transitiveCallers) lines.push(fmtImpactCaller(c, idx));
    lines.push('');
  }

  lines.push(`Tests likely affected (${report.stats.testCount}):`);
  if (report.testsAffected.length === 0) {
    lines.push('  (no test files reach this symbol)');
  } else {
    for (const c of report.testsAffected) {
      lines.push(`  ${c.symbol.file}:${c.symbol.line} — ${c.symbol.name}`);
    }
  }
  lines.push('');

  lines.push(`Public API: ${report.publicApi.exported ? 'YES (exported)' : 'no (internal)'}`);
  lines.push(`  ${report.publicApi.reason}`);
  lines.push('');

  const totalCallers = report.stats.directCount + report.stats.transitiveCount;
  const summary =
    totalCallers === 0
      ? `Summary: ${t.name} has no callers in the indexed code. ` +
        `Safe to rename in-repo${
          report.publicApi.exported
            ? '; external consumers (if any) are not visible to this index.'
            : '.'
        }`
      : `Summary: ${totalCallers} callsite(s) across ` +
        `${report.stats.sourceFileCount} file(s)` +
        (report.stats.testCount > 0 ? ` + ${report.stats.testCount} test(s)` : '') +
        `. ` +
        (report.publicApi.exported
          ? `Renaming is a BREAKING change for the module's public API.`
          : `Renaming is contained within the repo.`);
  lines.push(summary);

  if (report.stats.truncated) {
    lines.push('');
    lines.push(
      '(Output truncated — per-level cap hit. Re-run with a smaller depth ' +
        'or query specific callers via gp_callers for full detail.)',
    );
  }

  return lines.join('\n');
}

async function handleGpImpact(args: GpImpactArgs): Promise<ToolResult> {
  await ensureClientRootsCached();
  const out = getOrLoadIndex(args.path);
  if ('error' in out) {
    return { text: out.error, results: 0, isError: true };
  }
  const { idx, root } = out;

  let changedFiles: Set<string> | null = null;
  if (args.since !== undefined) {
    changedFiles = await getChangedFiles(root, args.since);
    if (changedFiles === null) {
      return {
        text:
          `Could not compute diff against "${args.since}" — either the ref ` +
          `does not resolve to a commit, or ${root} is not a git repo. ` +
          `Drop the \`since\` argument to see the full blast radius.`,
        results: 0,
        isError: true,
      };
    }
  }

  const report = analyzeImpact(idx, args.symbol, {
    depth: args.depth,
    changedFiles,
  });
  if (!report) {
    return {
      text: `No symbol found matching "${args.symbol}".`,
      results: 0,
      isError: true,
    };
  }

  const text = fmtImpactReport(report, idx, {
    since: args.since,
    changedFileCount: changedFiles?.size ?? null,
  });
  const totalResults = report.stats.directCount + report.stats.transitiveCount;
  return { text, results: totalResults };
}

// ----------------------------------------------------------------------------
// MCP workspace roots (client → server)
// ----------------------------------------------------------------------------

/** Ensure roots/list has run when the client supports workspace roots. */
async function ensureClientRootsCached(): Promise<void> {
  if (!mcpServerForRoots?.getClientCapabilities()?.roots) return;
  if (getMcpClientRoots().length > 0) return;
  if (!rootsRefreshInflight) {
    rootsRefreshInflight = refreshMcpClientRoots(mcpServerForRoots).finally(() => {
      rootsRefreshInflight = null;
    });
  }
  await rootsRefreshInflight;
}

async function refreshMcpClientRoots(server: Server): Promise<void> {
  const caps = server.getClientCapabilities();
  if (!caps?.roots) {
    setMcpClientRoots([]);
    return;
  }
  try {
    const { roots } = await server.listRoots();
    const paths = roots
      .map((r) => rootUriToFilesystemPath(r.uri))
      .filter((p): p is string => p !== null);
    setMcpClientRoots(paths);
    if (paths.length > 0) {
      process.stderr.write(`[graphpilot] MCP workspace roots: ${paths.join(', ')}\n`);
    }
  } catch (err) {
    process.stderr.write(
      `[graphpilot] roots/list failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    setMcpClientRoots([]);
  }
}

function wireMcpClientRoots(server: Server): void {
  mcpServerForRoots = server;
  server.oninitialized = () => {
    void refreshMcpClientRoots(server);
  };
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    void refreshMcpClientRoots(server);
  });
}

// ----------------------------------------------------------------------------
// Server builder + dispatcher
// ----------------------------------------------------------------------------

export function buildMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  wireMcpClientRoots(server);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS as unknown as Array<{
      name: string;
      description: string;
      inputSchema: object;
    }>,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const rawArgs = (args ?? {}) as Record<string, unknown>;

    // We need to know the repo path *before* validation to drive the log,
    // so the log captures even invalid-input attempts. Fall back to cwd.
    // Resolve to the worktree top so per-tool calls from a subdir land in
    // the same interaction log as the rest of the branch's work.
    const requestedLogPath = resolveRepoPath(
      typeof rawArgs.path === 'string' ? rawArgs.path : undefined,
    );
    const repoRootForLog = resolveIndexRoot(requestedLogPath).root;

    return withInteractionLog(repoRootForLog, name, rawArgs, async () => {
      // Validate first
      let result: ToolResult;
      switch (name) {
        case 'gp_index': {
          const v = validateGpIndex(rawArgs);
          if (!v.ok) {
            result = { text: `Invalid input: ${v.error}`, results: 0, isError: true };
            break;
          }
          result = await handleGpIndex(v.value);
          break;
        }
        case 'gp_recall': {
          const v = validateGpRecall(rawArgs);
          if (!v.ok) {
            result = { text: `Invalid input: ${v.error}`, results: 0, isError: true };
            break;
          }
          result = await handleGpRecall(v.value);
          break;
        }
        case 'gp_callers': {
          const v = validateGpCallers(rawArgs);
          if (!v.ok) {
            result = { text: `Invalid input: ${v.error}`, results: 0, isError: true };
            break;
          }
          result = await handleGpCallers(v.value);
          break;
        }
        case 'gp_impact': {
          const v = validateGpImpact(rawArgs);
          if (!v.ok) {
            result = { text: `Invalid input: ${v.error}`, results: 0, isError: true };
            break;
          }
          result = await handleGpImpact(v.value);
          break;
        }
        default:
          result = { text: `Unknown tool: ${name}`, results: 0, isError: true };
      }

      return {
        // Caller (this lambda) returns to the dispatcher which sends to the
        // MCP client. We also return interaction-log metadata.
        value: {
          content: [{ type: 'text', text: result.text }] as const,
          isError: result.isError,
        },
        results: result.results,
        error: result.isError ? result.text.slice(0, 200) : undefined,
      };
    }).then((v) => v);
  });

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[graphpilot] MCP server ready (stdio).\n`);

  // server.connect() resolves once handlers are wired — it does NOT block.
  // We have to keep this promise pending until the client disconnects, or the
  // CLI's `process.exit(0)` will kill us before the initialize handshake
  // completes. Resolve on either the transport's onclose, or stdin EOF.
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    transport.onclose = finish;
    process.stdin.once('end', finish);
    process.stdin.once('close', finish);
  });
}
