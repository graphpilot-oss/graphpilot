/**
 * Default repo-path resolution for MCP tool calls.
 *
 * Agents often omit `path` or pass "." while the MCP process cwd is the
 * user's home directory — not the open workspace. Resolution order:
 *
 *   1. Explicit `path` argument
 *   2. GRAPHPILOT_ROOT environment variable
 *   3. MCP client workspace roots (roots/list)
 *   4. Walk parents of process.cwd() for an on-disk index
 *   5. Unique index whose rootPath contains cwd
 *   6. Sole index under ~/.graphpilot
 *   7. process.cwd() (may error with a helpful message)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph, type Graph } from './storage.js';
import { resolveIndexRoot } from './git.js';

export interface IndexedRepoSummary {
  rootPath: string;
  repoId: string;
  indexedAt: string;
  symbolCount: number;
  edgeCount: number;
}

/** Workspace roots reported by the MCP client via roots/list. */
let mcpClientRoots: string[] = [];

export function setMcpClientRoots(roots: string[]): void {
  mcpClientRoots = roots;
}

export function getMcpClientRoots(): readonly string[] {
  return mcpClientRoots;
}

/**
 * Convert an MCP root URI to an absolute filesystem path.
 * Supports file:// URIs (the common case from Cursor and VS Code).
 */
export function rootUriToFilesystemPath(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('file://')) {
    try {
      return resolve(fileURLToPath(trimmed));
    } catch {
      return null;
    }
  }
  // Some clients may pass a plain path; accept only absolute-looking paths.
  if (/^([A-Za-z]:[\\/]|\/)/.test(trimmed)) {
    return resolve(trimmed);
  }
  return null;
}

function normalizeForCompare(p: string): string {
  return resolve(p).replace(/\\/g, '/').toLowerCase();
}

/** True when `child` is `parent` or a subdirectory of `parent`. */
export function isPathUnder(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  return c === p || c.startsWith(p + '/');
}

/**
 * List every valid index under ~/.graphpilot by reading each graph.json.
 * Best-effort: skips corrupt entries.
 */
export function listIndexedRepos(): IndexedRepoSummary[] {
  const base = join(homedir(), '.graphpilot');
  if (!existsSync(base)) return [];

  const out: IndexedRepoSummary[] = [];
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }

  for (const repoId of entries) {
    const graphFile = join(base, repoId, 'graph.json');
    if (!existsSync(graphFile)) continue;
    let raw: string;
    try {
      raw = readFileSync(graphFile, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const o = parsed as Record<string, unknown>;
    const rootPath = typeof o.rootPath === 'string' ? o.rootPath : null;
    if (!rootPath) continue;
    const graph = loadGraph(rootPath);
    if (!graph) continue;
    out.push({
      rootPath: graph.rootPath,
      repoId: graph.repoId,
      indexedAt: graph.indexedAt,
      symbolCount: graph.symbolCount,
      edgeCount: graph.edgeCount,
    });
  }

  return out.sort((a, b) => b.indexedAt.localeCompare(a.indexedAt));
}

function firstRootWithIndex(paths: string[]): string | null {
  for (const p of paths) {
    const { root } = resolveIndexRoot(p);
    if (loadGraph(root)) return p;
  }
  return null;
}

/**
 * Resolve which filesystem path to use for an MCP tool call before
 * worktree re-rooting and graph loading.
 */
export function resolveRepoPath(rawPath?: string): string {
  if (rawPath !== undefined && rawPath.trim() !== '') {
    return resolve(rawPath.trim());
  }

  const envRoot = process.env.GRAPHPILOT_ROOT?.trim();
  if (envRoot) {
    return resolve(envRoot);
  }

  const fromMcp = firstRootWithIndex([...mcpClientRoots]);
  if (fromMcp) return fromMcp;

  let cur = resolve(process.cwd());
  for (let i = 0; i < 64; i++) {
    const { root } = resolveIndexRoot(cur);
    if (loadGraph(root)) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  const indexed = listIndexedRepos();
  const cwd = resolve(process.cwd());
  const underCwd = indexed.filter((r) => isPathUnder(cwd, r.rootPath));
  if (underCwd.length === 1) {
    return resolve(underCwd[0].rootPath);
  }

  if (indexed.length === 1) {
    return resolve(indexed[0].rootPath);
  }

  return cwd;
}

/**
 * Build a helpful error when no graph exists for the resolved root.
 */
export function formatNoIndexError(requestedPath: string, resolvedWorktreeRoot: string): string {
  const indexed = listIndexedRepos();
  const lines = [
    `No GraphPilot index found for ${resolvedWorktreeRoot}.`,
    `(Resolved from: ${requestedPath})`,
    '',
    'Fix:',
    `  • Run \`graphpilot index ${resolvedWorktreeRoot}\` in a terminal, or`,
    '  • Call the gp_index tool with the same path, or',
    '  • Set GRAPHPILOT_ROOT to your workspace folder in MCP config, or',
    '  • Use a Cursor/VS Code MCP client that supports workspace roots.',
  ];

  if (indexed.length > 0) {
    lines.push('', 'Indexed repos on this machine:');
    const cap = 8;
    for (const r of indexed.slice(0, cap)) {
      lines.push(
        `  • ${r.rootPath}  (${r.symbolCount} symbols, ${r.edgeCount} calls, ${r.indexedAt})`,
      );
    }
    if (indexed.length > cap) {
      lines.push(`  … and ${indexed.length - cap} more`);
    }
    lines.push('', 'Pass an explicit `path` to target one of the above.');
  }

  return lines.join('\n');
}

/** @internal Test hook: summarize a loaded graph. */
export function graphSummary(g: Graph): IndexedRepoSummary {
  return {
    rootPath: g.rootPath,
    repoId: g.repoId,
    indexedAt: g.indexedAt,
    symbolCount: g.symbolCount,
    edgeCount: g.edgeCount,
  };
}
