import type { Graph } from './storage.js';
import type { SymbolRecord } from './symbols.js';
import type { CallEdge } from './edges.js';

export interface RecallOptions {
  /** Max results. Default 10. Capped at 100. */
  limit?: number;
  /**
   * If true, match if the query is a substring of the symbol name.
   * If false (default), require exact case-insensitive match.
   */
  substring?: boolean;
}

export interface EdgeQueryOptions {
  /** Max edges to return. Default 50. Capped at 500. */
  limit?: number;
  /**
   * If true, include edges where the callee is unresolved (toId === null).
   * Default true — agents usually want to see those too.
   */
  includeUnresolved?: boolean;
}

const HARD_RESULT_CAP = 100;
const HARD_EDGE_CAP = 500;

/**
 * Pre-computed lookup tables over a Graph. Build once after loading; every
 * query is then O(1) or O(k) (k = result count).
 *
 * The whole index is built in one pass on construction. For graphpilot's own
 * code (50 symbols, 155 edges) build time is <1ms. For a 50k-symbol repo
 * we'd expect ~20ms — still negligible compared to a Claude Code round trip.
 */
export class GraphIndex {
  private readonly byNameLower: Map<string, SymbolRecord[]> = new Map();
  private readonly byId: Map<string, SymbolRecord> = new Map();
  /** Edges keyed by callee id — answers "who calls X?". */
  private readonly callersOf: Map<string, CallEdge[]> = new Map();
  /** Edges keyed by caller id — answers "what does X call?". */
  private readonly calleesOf: Map<string, CallEdge[]> = new Map();

  constructor(public readonly graph: Graph) {
    for (const s of graph.symbols) {
      this.byId.set(s.id, s);
      // Synthetic <module> scope symbols are addressable by id (so callers
      // display can name them) but must never surface in a name search.
      if (s.kind === 'module') continue;
      const key = s.name.toLowerCase();
      const list = this.byNameLower.get(key);
      if (list) list.push(s);
      else this.byNameLower.set(key, [s]);
    }

    for (const e of graph.edges) {
      // callers index — only resolved edges have a toId
      if (e.toId) {
        const list = this.callersOf.get(e.toId);
        if (list) list.push(e);
        else this.callersOf.set(e.toId, [e]);
      }
      // callees index — every edge has a fromId
      const list = this.calleesOf.get(e.fromId);
      if (list) list.push(e);
      else this.calleesOf.set(e.fromId, [e]);
    }
  }

  /**
   * Find symbols by name. Default behaviour is exact case-insensitive match;
   * pass `substring: true` to enable substring search.
   *
   * Returns ranked roughly by "best first" — exact case match before
   * case-folded matches.
   */
  findByName(query: string, opts: RecallOptions = {}): SymbolRecord[] {
    const limit = Math.min(opts.limit ?? 10, HARD_RESULT_CAP);
    if (!query) return [];

    if (opts.substring) {
      const q = query.toLowerCase();
      const results: SymbolRecord[] = [];
      for (const [name, syms] of this.byNameLower) {
        if (!name.includes(q)) continue;
        for (const s of syms) {
          results.push(s);
          if (results.length >= limit) return results;
        }
      }
      return results;
    }

    // Exact case-insensitive — fast path through the map.
    const candidates = this.byNameLower.get(query.toLowerCase()) ?? [];
    if (candidates.length === 0) return [];

    // Prefer exact case match first, then the rest.
    const exact = candidates.filter((s) => s.name === query);
    const rest = candidates.filter((s) => s.name !== query);
    return [...exact, ...rest].slice(0, limit);
  }

  /** Look up a symbol by its id. Returns null if not found. */
  findById(id: string): SymbolRecord | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * Resolve a name (or id) to a unique symbol. Used by tools that take a
   * "symbol" argument — accepts either a bare name or a full id.
   *
   * Ambiguity policy: if more than one symbol matches the name, returns the
   * first one (same heuristic as the resolver). Caller can disambiguate by
   * passing the full id.
   */
  resolveSymbol(nameOrId: string): SymbolRecord | null {
    if (nameOrId.includes('#') && nameOrId.includes('@')) {
      return this.findById(nameOrId);
    }
    const matches = this.findByName(nameOrId);
    return matches[0] ?? null;
  }

  /** Edges where this symbol is the target — "who calls X?". */
  callers(symbolId: string, opts: EdgeQueryOptions = {}): CallEdge[] {
    const limit = Math.min(opts.limit ?? 50, HARD_EDGE_CAP);
    return (this.callersOf.get(symbolId) ?? []).slice(0, limit);
  }

  /** Edges where this symbol is the source — "what does X call?". */
  callees(symbolId: string, opts: EdgeQueryOptions = {}): CallEdge[] {
    const limit = Math.min(opts.limit ?? 50, HARD_EDGE_CAP);
    const all = this.calleesOf.get(symbolId) ?? [];
    if (opts.includeUnresolved === false) {
      return all.filter((e) => e.toId !== null).slice(0, limit);
    }
    return all.slice(0, limit);
  }

  /** Convenience: how many symbols / edges are indexed. */
  get stats(): { symbols: number; edges: number; resolvedEdges: number } {
    let resolved = 0;
    for (const e of this.graph.edges) if (e.toId) resolved++;
    return {
      symbols: this.graph.symbols.length,
      edges: this.graph.edges.length,
      resolvedEdges: resolved,
    };
  }
}
