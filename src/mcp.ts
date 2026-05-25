import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import { GraphIndex } from './query.js';
import { indexDirectory } from './indexer.js';
import { loadGraph, saveGraph, repoIdFor, type Graph } from './storage.js';
import { validateRootPath } from './validation.js';
import {
  validateGpIndex,
  validateGpRecall,
  validateGpCallers,
  validateGpImpact,
  validateGpStats,
  type GpRecallArgs,
  type GpCallersArgs,
  type GpImpactArgs,
  type GpIndexArgs,
  type GpStatsArgs,
} from './validators.js';
import { withInteractionLog } from './interactions.js';
import { analyzeImpact, type ImpactCaller, type ImpactResult } from './impact.js';
import { getChangedFiles, resolveIndexRoot } from './git.js';
import {
  formatNoIndexError,
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

const indexCache = new Map<string, GraphIndex>();

/** Set when buildMcpServer wires roots handlers — used for lazy roots/list. */
let mcpServerForRoots: Server | null = null;
let rootsRefreshInflight: Promise<void> | null = null;

function getOrLoadIndex(
  rawPath: string | undefined,
): { idx: GraphIndex; root: string } | { error: string; root: string } {
  const requested = resolveRepoPath(rawPath);
  // Re-root to the git worktree top so MCP tool calls from a subdir of a
  // worktree still resolve to the branch-level index. Outside git this is
  // a no-op.
  const { root } = resolveIndexRoot(requested);
  const cached = indexCache.get(root);
  if (cached) return { idx: cached, root };

  const graph = loadGraph(root);
  if (!graph) {
    return {
      root,
      error: formatNoIndexError(requested, root),
    };
  }
  const idx = new GraphIndex(graph);
  indexCache.set(root, idx);
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
  // Evidence anchor on the call site (the file:line where the call occurs).
  return `${prefix}${fromName}  →  ${toLabel}  (${e.file}:${e.line}${shaTag(idx)})`;
}

// ----------------------------------------------------------------------------
// Tool catalog (sent to clients via tools/list)
// ----------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'gp_stats',
    description:
      'Show GraphPilot index health for a repo (symbol count, edge count, ' +
      'when indexed). Use this to confirm the index is fresh before asking ' +
      'structural questions.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_FIELD_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gp_index',
    description:
      'Index or re-index a TypeScript/JavaScript repo into GraphPilot. Call ' +
      'this when the codebase has changed materially or when no index exists.',
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
      'Look up symbols (functions, classes, methods, types, interfaces) by ' +
      'name. Returns kind, location, and signature. Default: exact ' +
      'case-insensitive. Pass substring:true for partial matches.',
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
      'List callers of a symbol (who calls it) or callees (what it calls). ' +
      "Use direction='callers' for impact analysis ('what breaks if I " +
      "change this?'); direction='callees' to see what a function depends on.",
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
      'Analyze the BLAST RADIUS of changing a symbol. Returns direct callers, ' +
      'transitive callers (default depth 3), tests likely affected, and ' +
      'whether the symbol is part of the public API (exported). ' +
      'Use this BEFORE proposing a rename, signature change, or behavior ' +
      'change — it answers "what breaks if I change X?" in one call instead ' +
      'of composing multiple gp_callers queries. ' +
      'Pass `since: <commit|branch>` to restrict callers to files changed ' +
      'since that ref — ideal for PR review ("what does this branch touch?") ' +
      'and refactor scoping.',
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

async function handleGpStats(args: GpStatsArgs): Promise<ToolResult> {
  await ensureClientRootsCached();
  const out = getOrLoadIndex(args.path);
  if ('error' in out) {
    return { text: out.error, results: 0, isError: true };
  }
  const { idx } = out;
  const s = idx.stats;
  const g = idx.graph;
  // Git provenance — surface branch + short SHA so the agent can cite
  // the exact commit the index was built against. Omitted gracefully
  // when the indexed root isn't a git repo.
  const gitLines: string[] = [];
  if (g.indexedBranch) gitLines.push(`Branch:      ${g.indexedBranch}`);
  if (g.indexedSha) gitLines.push(`Commit SHA:  ${g.indexedSha.slice(0, 7)}`);
  const text = [
    `Repo:        ${g.rootPath}`,
    `Repo id:     ${g.repoId}`,
    `Indexed at:  ${g.indexedAt}`,
    ...gitLines,
    `Files:       ${g.filesIndexed}`,
    `Symbols:     ${s.symbols}`,
    `Calls:       ${s.edges} (${s.resolvedEdges} resolved)`,
  ].join('\n');
  return { text, results: 1 };
}

async function handleGpIndex(args: GpIndexArgs): Promise<ToolResult> {
  await ensureClientRootsCached();
  const requested = resolveRepoPath(args.path);
  const { root, redirected } = resolveIndexRoot(requested);
  const refusal = validateRootPath(root);
  if (refusal) return { text: `Error: ${refusal}`, results: 0, isError: true };

  const result = await indexDirectory(root);
  const graph: Graph = {
    version: 1,
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
        case 'gp_stats': {
          const v = validateGpStats(rawArgs);
          if (!v.ok) {
            result = { text: `Invalid input: ${v.error}`, results: 0, isError: true };
            break;
          }
          result = await handleGpStats(v.value);
          break;
        }
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
