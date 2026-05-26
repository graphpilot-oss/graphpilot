import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, renameSync } from 'node:fs';
import type { SymbolRecord } from './symbols.js';
import type { CallEdge } from './edges.js';
import { validateGraph } from './graph-schema.js';

const isWindows = process.platform === 'win32';

export interface Graph {
  version: 1;
  repoId: string;
  rootPath: string;
  indexedAt: string;
  filesIndexed: number;
  symbolCount: number;
  edgeCount: number;
  symbols: SymbolRecord[];
  edges: CallEdge[];
  /**
   * Optional git provenance — set when the indexed root lives inside a
   * git worktree. Both fields may be null even within a git repo (e.g.
   * detached HEAD has no branch; an empty repo has no SHA). Older
   * graph.json files written before the v0.1.5 pivot won't have these
   * fields; the schema validator treats them as optional so old graphs
   * still load.
   */
  indexedSha?: string | null;
  indexedBranch?: string | null;
}

export function repoIdFor(absRootPath: string): string {
  return createHash('sha256').update(absRootPath).digest('hex').slice(0, 16);
}

export function repoDir(absRootPath: string): string {
  return join(homedir(), '.graphpilot', repoIdFor(absRootPath));
}

export function graphPath(absRootPath: string): string {
  return join(repoDir(absRootPath), 'graph.json');
}

export function saveGraph(graph: Graph): string {
  const dir = repoDir(graph.rootPath);
  // T7 defence: 0700 dir + 0600 file so other users on shared machines can't
  // read the index. The mkdir/writeFileSync `mode` option only applies on
  // creation, so we explicitly chmod afterwards to fix permissions on any
  // pre-existing files (e.g. an index written before this protection landed).
  // On Windows these modes are silently ignored, which is fine — NTFS ACLs
  // are handled by the user profile boundary.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isWindows) chmodSync(dir, 0o700);
  const path = graphPath(graph.rootPath);

  // Atomic write — write to a sibling .tmp file and rename. Crash-safe:
  // a partial write never produces a corrupt graph.json that would later
  // fail T4's schema validator and force a full re-index. Defends watch
  // mode (which writes many times) against ungraceful shutdowns.
  const tmpPath = path + '.tmp';
  const pretty = process.env['GRAPHPILOT_PRETTY'] === '1';
  writeFileSync(tmpPath, pretty ? JSON.stringify(graph, null, 2) : JSON.stringify(graph), {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (!isWindows) chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  return path;
}

/**
 * Load and validate a graph from disk. Returns null if the file is missing,
 * unparseable, has a wrong schema version, or fails structural validation.
 *
 * T4 defence: anything from disk is untrusted. We re-parse and re-shape
 * every field before exposing the result to query / MCP layers. String
 * fields are sanitized (control chars stripped, lengths capped) so a
 * crafted graph.json can't smuggle prompt-injection payloads or fake JSON
 * Lines into tool output.
 *
 * Validation errors are written to stderr for diagnostics. The function
 * never throws on bad data — it returns null so the MCP tool layer can
 * surface "no index" cleanly.
 */
export function loadGraph(absRootPath: string): Graph | null {
  const path = graphPath(absRootPath);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(`[graphpilot] graph.json is not valid JSON: ${path}\n`);
    return null;
  }

  const errors: string[] = [];
  const validated = validateGraph(parsed, errors);
  if (!validated) {
    process.stderr.write(
      `[graphpilot] graph.json failed schema validation: ${path}\n` +
        errors.map((e) => `  - ${e}`).join('\n') +
        '\n',
    );
    return null;
  }
  return validated;
}
