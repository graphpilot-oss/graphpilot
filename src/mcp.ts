import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
import type { SymbolRecord } from './symbols.js';
import type { CallEdge } from './edges.js';

const SERVER_NAME = 'graphpilot';
const SERVER_VERSION = '0.0.1';

// ----------------------------------------------------------------------------
// Per-process cache of loaded GraphIndex by absolute repo path.
// ----------------------------------------------------------------------------

const indexCache = new Map<string, GraphIndex>();

function getOrLoadIndex(
  rawPath: string | undefined,
): { idx: GraphIndex; root: string } | { error: string; root: string } {
  // Re-root to the git worktree top so MCP tool calls from a subdir of a
  // worktree still resolve to the branch-level index. Outside git this is
  // a no-op.
  const { root } = resolveIndexRoot(rawPath ?? process.cwd());
  const cached = indexCache.get(root);
  if (cached) return { idx: cached, root };

  const graph = loadGraph(root);
  if (!graph) {
    return {
      root,
      error:
        `No GraphPilot index found for ${root}.\n` +
        `Ask the user to run \`graphpilot index ${rawPath ?? '.'}\` first, or ` +
        `call the gp_index tool to build one.`,
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
      'Show index health: when last indexed, file/symbol/edge counts, branch + SHA. ' +
      'ALWAYS call first if other gp_* tools return unexpected results — confirms ' +
      'the index is fresh and identifies the exact commit it was built against. ' +
      'Do NOT use to answer questions about code structure; use gp_recall or gp_impact for that.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo path. Default: cwd.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gp_index',
    description:
      'Re-index the repo after batch edits so subsequent gp_* calls see your changes. ' +
      'Call after any non-trivial edit session or when gp_stats shows a stale timestamp. ' +
      'Do NOT call before every query — indexing is slow; only needed when source files changed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repo path to index. Default: cwd.',
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
          description: 'Repo path. Default: cwd.',
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
          description: 'Repo path. Default: cwd.',
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
          description: 'Repo path. Default: cwd.',
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

function handleGpStats(args: GpStatsArgs): ToolResult {
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
  const requested = resolve(args.path ?? process.cwd());
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

function handleGpRecall(args: GpRecallArgs): ToolResult {
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

function handleGpCallers(args: GpCallersArgs): ToolResult {
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
// Server builder + dispatcher
// ----------------------------------------------------------------------------

export function buildMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

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
    const requestedLogPath = typeof rawArgs.path === 'string' ? rawArgs.path : process.cwd();
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
          result = handleGpStats(v.value);
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
          result = handleGpRecall(v.value);
          break;
        }
        case 'gp_callers': {
          const v = validateGpCallers(rawArgs);
          if (!v.ok) {
            result = { text: `Invalid input: ${v.error}`, results: 0, isError: true };
            break;
          }
          result = handleGpCallers(v.value);
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
