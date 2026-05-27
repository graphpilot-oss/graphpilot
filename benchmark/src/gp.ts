/**
 * gp.ts — thin wrapper around GraphPilot internals.
 * Loads the indexed graph and exposes the 4 GP query tools.
 *
 * Imports directly from graphpilot's src/ (same repo, tsx resolves .js → .ts).
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FASTIFY_DIR } from './config.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const GP_SRC = join(__dir, '..', '..', 'src');

// Lazy imports — resolved at runtime by tsx
const storageModule = await import(`${GP_SRC}/storage.js`);
const queryModule = await import(`${GP_SRC}/query.js`);
const impactModule = await import(`${GP_SRC}/impact.js`);

const { loadGraph } = storageModule as { loadGraph: (root: string) => unknown };
const { GraphIndex } = queryModule as { GraphIndex: new (graph: unknown) => GraphIndexInstance };
const { analyzeImpact } = impactModule as {
  analyzeImpact: (
    idx: GraphIndexInstance,
    nameOrId: string,
    opts?: Record<string, unknown>,
  ) => ImpactResultRaw | null;
};

// Minimal structural types matching what we actually use
interface SymbolRecord {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  exported: boolean;
}
interface CallEdge {
  fromId: string;
  toId: string | null;
  toName: string | null;
  file: string;
  line: number;
}
interface GraphIndexInstance {
  graph: {
    symbolCount: number;
    edgeCount: number;
    filesIndexed: number;
    indexedAt: string;
    rootPath: string;
  };
  findByName(query: string, opts?: { limit?: number; substring?: boolean }): SymbolRecord[];
  findById(id: string): SymbolRecord | null;
  resolveSymbol(nameOrId: string): SymbolRecord | null;
  callers(symbolId: string, opts?: { limit?: number }): CallEdge[];
  callees(symbolId: string, opts?: { limit?: number; includeUnresolved?: boolean }): CallEdge[];
}
interface ImpactResultRaw {
  target: SymbolRecord;
  callers: Array<{ symbol: SymbolRecord; depth: number }>;
  affectedFiles?: string[];
  sourceFiles?: Set<string>;
}

let _index: GraphIndexInstance | null = null;

export function getIndex(): GraphIndexInstance {
  if (_index) return _index;
  const graph = loadGraph(FASTIFY_DIR);
  if (!graph) throw new Error('GraphPilot index not found. Run `pnpm setup` first.');
  _index = new GraphIndex(graph);
  return _index;
}

// ── Tool implementations ─────────────────────────────────────────────────────

export function gpRecall(query: string, limit = 20): string {
  const idx = getIndex();
  const results = idx.findByName(query, { limit, substring: true });
  if (!results.length) return `No symbols found matching "${query}".`;
  return results
    .map(
      (s) =>
        `${s.name} [${s.kind}] — ${s.file}:${s.line}  (${s.exported ? 'exported' : 'internal'})`,
    )
    .join('\n');
}

export function gpCallers(symbolName: string, limit = 30): string {
  const idx = getIndex();
  // Try exact first, fall back to substring
  let symbols = idx.findByName(symbolName, { limit: 5, substring: false });
  if (!symbols.length) symbols = idx.findByName(symbolName, { limit: 5, substring: true });
  if (!symbols.length) return `No symbol named "${symbolName}" found in the index.`;

  const sym = symbols[0];
  const edges = idx.callers(sym.id, { limit });
  if (!edges.length) return `No callers found for "${sym.name}" (${sym.file}:${sym.line}).`;

  const lines = [`Callers of \`${sym.name}\` (${edges.length} found):`];
  for (const e of edges) {
    const caller = idx.findById(e.fromId);
    lines.push(`  ${caller?.name ?? e.fromId}  ← ${e.file}:${e.line}`);
  }
  return lines.join('\n');
}

export function gpCallees(symbolName: string, limit = 30): string {
  const idx = getIndex();
  const symbols = idx.findByName(symbolName, { limit: 5, substring: true });
  if (!symbols.length) return `No symbol named "${symbolName}" found.`;
  const sym = symbols[0];
  const edges = idx.callees(sym.id, { limit });
  if (!edges.length) return `"${sym.name}" makes no tracked calls.`;

  const lines = [`Callees of \`${sym.name}\` (${edges.length} found):`];
  for (const e of edges) {
    lines.push(`  → ${e.toName ?? '?'}  (${e.file}:${e.line})`);
  }
  return lines.join('\n');
}

export function gpImpact(symbolName: string, depth = 3): string {
  const idx = getIndex();
  const result = analyzeImpact(idx, symbolName, { depth });
  if (!result) return `No symbol named "${symbolName}" found.`;
  if (!result.callers.length)
    return `No callers found for "${symbolName}" — changing it has minimal blast radius.`;

  const affectedFiles = result.sourceFiles
    ? Array.from(result.sourceFiles as Set<string>)
    : (result.affectedFiles ?? []);

  const lines = [
    `Impact of changing \`${result.target.name}\` — ${result.callers.length} affected callers across ${affectedFiles.length} files:`,
  ];
  for (let d = 1; d <= depth; d++) {
    const atDepth = result.callers.filter((c) => c.depth === d);
    if (atDepth.length) {
      lines.push(`  Depth ${d}: ${atDepth.map((c) => c.symbol.name).join(', ')}`);
    }
  }
  if (affectedFiles.length) {
    lines.push(`  Files: ${affectedFiles.join(', ')}`);
  }
  return lines.join('\n');
}

export function gpStats(): string {
  const idx = getIndex();
  const g = idx.graph;
  return [
    `GraphPilot index stats for fastify:`,
    `  Symbols  : ${g.symbolCount}`,
    `  Edges    : ${g.edgeCount}`,
    `  Files    : ${g.filesIndexed}`,
    `  Indexed  : ${g.indexedAt}`,
    `  Root     : ${g.rootPath}`,
  ].join('\n');
}
