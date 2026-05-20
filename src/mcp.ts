import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import { GraphIndex } from './query.js';
import { indexDirectory } from './indexer.js';
import {
  loadGraph,
  saveGraph,
  repoIdFor,
  type Graph,
} from './storage.js';
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
  const root = resolve(rawPath ?? process.cwd());
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

function fmtSymbol(s: SymbolRecord, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const parentTag = s.parent ? `${s.parent}.` : '';
  const exp = s.exported ? ' [exported]' : '';
  return (
    `${prefix}${parentTag}${s.name}  (${s.kind})  ${s.file}:${s.line}${exp}\n` +
    `   ${s.signature}`
  );
}

function fmtEdge(e: CallEdge, idx: GraphIndex, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  if (e.toId === null && /* edge as caller listing */ false) {
    // never hit — kept for future safety
    return `${prefix}<unresolved>`;
  }
  // We don't know upfront whether this is a callers or callees listing, so the
  // safest thing is to show both ends.
  const fromSym = idx.findById(e.fromId);
  const fromName = fromSym ? `${fromSym.parent ? fromSym.parent + '.' : ''}${fromSym.name}` : e.fromId;
  const toLabel = e.toId
    ? (() => {
        const t = idx.findById(e.toId);
        return t ? `${t.parent ? t.parent + '.' : ''}${t.name}` : e.toName;
      })()
    : `${e.toName} <unresolved>`;
  return `${prefix}${fromName}  →  ${toLabel}  (${e.file}:${e.line})`;
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
        path: { type: 'string', description: 'Repo path. Default: cwd.' },
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
          description: 'Repo path to index. Default: cwd.',
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
      "List callers of a symbol (who calls it) or callees (what it calls). " +
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
      'Analyze the BLAST RADIUS of changing a symbol. Returns direct callers, ' +
      'transitive callers (default depth 3), tests likely affected, and ' +
      'whether the symbol is part of the public API (exported). ' +
      'Use this BEFORE proposing a rename, signature change, or behavior ' +
      'change — it answers "what breaks if I change X?" in one call instead ' +
      'of composing multiple gp_callers queries.',
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
  const text = [
    `Repo:        ${g.rootPath}`,
    `Repo id:     ${g.repoId}`,
    `Indexed at:  ${g.indexedAt}`,
    `Files:       ${g.filesIndexed}`,
    `Symbols:     ${s.symbols}`,
    `Calls:       ${s.edges} (${s.resolvedEdges} resolved)`,
  ].join('\n');
  return { text, results: 1 };
}

async function handleGpIndex(args: GpIndexArgs): Promise<ToolResult> {
  const root = resolve(args.path ?? process.cwd());
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
  };
  saveGraph(graph);
  // After re-index, drop the cached GraphIndex for this root so subsequent
  // calls see fresh data.
  invalidateCache(root);
  const resolved = result.edges.filter((e) => e.toId !== null).length;
  const text =
    `Indexed ${root}\n` +
    `  Files:   ${result.filesIndexed}\n` +
    `  Symbols: ${result.symbols.length}\n` +
    `  Calls:   ${result.edges.length} (${resolved} resolved)\n` +
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
  const body = matches.map((s, i) => fmtSymbol(s, i)).join('\n\n');
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
  const header =
    `${edges.length} ${verb} ${target.name} ` +
    `(${target.file}:${target.line}):\n`;
  const body = edges.map((e, i) => fmtEdge(e, idx, i)).join('\n');
  return { text: header + body, results: edges.length };
}

/**
 * Format an ImpactCaller for the agent's text output. Includes via-symbol
 * context when depth > 1 so the agent can trace the chain.
 */
function fmtImpactCaller(c: ImpactCaller, idx: GraphIndex): string {
  const head = `  ${c.symbol.name} (${c.symbol.file}:${c.symbol.line})`;
  if (c.depth === 1) return head;
  // For transitive callers, show the immediate hop the edge connects to —
  // the symbol that this caller called (one closer to the target).
  const via = c.edge.toId ? idx.findById(c.edge.toId) : null;
  const viaText = via ? `  ← calls ${via.name}` : `  ← calls ${c.edge.toName}`;
  return `${head} [depth ${c.depth}]${viaText}`;
}

function fmtImpactReport(report: ImpactResult, idx: GraphIndex): string {
  const t = report.target;
  const lines: string[] = [];
  lines.push(
    `Impact of changing ${t.name} (${t.file}:${t.line}, kind=${t.kind}):`,
  );
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

  lines.push(
    `Public API: ${report.publicApi.exported ? 'YES (exported)' : 'no (internal)'}`,
  );
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
        (report.stats.testCount > 0
          ? ` + ${report.stats.testCount} test(s)`
          : '') +
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

function handleGpImpact(args: GpImpactArgs): ToolResult {
  const out = getOrLoadIndex(args.path);
  if ('error' in out) {
    return { text: out.error, results: 0, isError: true };
  }
  const { idx } = out;

  const report = analyzeImpact(idx, args.symbol, { depth: args.depth });
  if (!report) {
    return {
      text: `No symbol found matching "${args.symbol}".`,
      results: 0,
      isError: true,
    };
  }

  const text = fmtImpactReport(report, idx);
  const totalResults =
    report.stats.directCount + report.stats.transitiveCount;
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
    const repoRootForLog = resolve(
      typeof rawArgs.path === 'string' ? rawArgs.path : process.cwd(),
    );

    return withInteractionLog(
      repoRootForLog,
      name,
      rawArgs,
      async () => {
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
            result = handleGpImpact(v.value);
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
      },
    ).then((v) => v);
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
