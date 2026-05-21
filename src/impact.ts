/**
 * Impact analysis — the "blast radius" of changing a symbol.
 *
 * This is the marquee differentiator for v0.1: agents constantly ask
 * "what breaks if I rename X?" and answering it well requires composing
 * direct callers + transitive callers + test detection + public-API check.
 * Other code-context tools (CodeGraphContext, Serena) force agents to
 * compose these from 4–5 separate calls; we ship it as one primitive.
 *
 * Pure functions only — no I/O, no MCP-protocol awareness. The MCP layer
 * formats the output for the agent.
 */

import type { GraphIndex } from './query.js';
import type { SymbolRecord } from './symbols.js';
import type { CallEdge } from './edges.js';

export interface ImpactCaller {
  /** The caller's SymbolRecord, lifted from the index for convenience. */
  symbol: SymbolRecord;
  /** The CallEdge that connected the caller to its callee (one hop closer to the target). */
  edge: CallEdge;
  /** BFS depth — 1 = direct caller of the target, 2 = caller-of-caller, etc. */
  depth: number;
}

export interface ImpactResult {
  /** The resolved target symbol. */
  target: SymbolRecord;

  /**
   * Callers at depth 1. These are the symbols that explicitly call `target`.
   * Renaming `target` definitely requires updating each of these.
   */
  directCallers: ImpactCaller[];

  /**
   * Callers at depth 2..maxDepth. These are the symbols whose call paths
   * transitively reach `target` through one or more intermediaries. Renaming
   * `target` MAY require updating these (depends on whether the intermediary
   * leaks the change).
   */
  transitiveCallers: ImpactCaller[];

  /**
   * Subset of (directCallers ∪ transitiveCallers) whose source file looks
   * like a test file. Heuristic — see `isTestFile()`.
   */
  testsAffected: ImpactCaller[];

  /**
   * The target itself — is it exported from its file? If true, renaming is
   * a breaking change for any consumer of that file's public API.
   */
  publicApi: {
    exported: boolean;
    reason: string;
  };

  /**
   * Summary stats for quick agent consumption.
   */
  stats: {
    directCount: number;
    transitiveCount: number;
    testCount: number;
    sourceFileCount: number;
    truncated: boolean; // true if we hit any cap (depth or per-level)
  };
}

export interface ImpactOptions {
  /** BFS depth, 1..5. Default 3. */
  depth?: number;
  /** Max callers reported per depth level. Default 100. Cap on output, not search. */
  perLevelLimit?: number;
  /**
   * Differential mode: if provided, the returned callers (direct +
   * transitive) are filtered to only those whose source file is in this
   * set. The BFS itself still walks the full graph — filtering is applied
   * after, so transitive chains aren't broken by an intermediate hop that
   * lives in an unchanged file.
   *
   * Used by `gp_impact({since: <commit>})` to answer "which of the
   * callers of X are in code that *actually changed* since <commit>?"
   */
  changedFiles?: Set<string> | null;
}

const MAX_DEPTH = 5;
const DEFAULT_DEPTH = 3;
const DEFAULT_PER_LEVEL_LIMIT = 100;

/**
 * Conservative test-file detector. Matches:
 *   *.test.{ts,tsx,js,jsx,mjs,cjs}
 *   *.spec.{ts,tsx,js,jsx,mjs,cjs}
 *   any path containing a `__tests__/` segment
 *
 * Deliberately does NOT match a bare `test/` or `tests/` directory
 * (those collide with non-test files like `src/test/helpers.ts`).
 */
export function isTestFile(filePath: string): boolean {
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath)) return true;
  if (/(?:^|\/)__tests__\//.test(filePath)) return true;
  return false;
}

/**
 * Core blast-radius BFS. Walks the callers graph from `target` outward,
 * recording each caller exactly once with its first-discovered depth.
 *
 * Cycle-safe (visited set). Terminates at `depth`. Per-level cap is
 * applied to the OUTPUT only — search continues past the cap so we don't
 * miss test or public-API hits hidden in a wide level.
 */
function bfsCallers(
  idx: GraphIndex,
  targetId: string,
  maxDepth: number,
  perLevelLimit: number,
): { callers: ImpactCaller[]; truncated: boolean } {
  const visited = new Set<string>([targetId]);
  const out: ImpactCaller[] = [];
  let frontier: string[] = [targetId];
  let truncated = false;

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier: string[] = [];
    let emittedThisLevel = 0;

    for (const id of frontier) {
      const edges = idx.callers(id, { limit: 500 });
      for (const edge of edges) {
        if (visited.has(edge.fromId)) continue;
        visited.add(edge.fromId);

        const caller = idx.findById(edge.fromId);
        if (!caller) continue;

        if (emittedThisLevel < perLevelLimit) {
          out.push({ symbol: caller, edge, depth: d });
          emittedThisLevel++;
        } else {
          truncated = true;
        }

        nextFrontier.push(edge.fromId);
      }
    }

    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }

  return { callers: out, truncated };
}

/**
 * Analyze the blast radius of changing `symbolNameOrId`.
 *
 * Resolution order matches GraphIndex.resolveSymbol: full id beats name,
 * same-file beats global, first match wins on ambiguity. The result's
 * `target` field tells the agent which symbol we actually picked.
 *
 * Returns null if the symbol can't be resolved at all.
 */
export function analyzeImpact(
  idx: GraphIndex,
  symbolNameOrId: string,
  opts: ImpactOptions = {},
): ImpactResult | null {
  const target = idx.resolveSymbol(symbolNameOrId);
  if (!target) return null;

  const depth = Math.min(Math.max(opts.depth ?? DEFAULT_DEPTH, 1), MAX_DEPTH);
  const perLevelLimit = opts.perLevelLimit ?? DEFAULT_PER_LEVEL_LIMIT;

  const { callers: allCallers, truncated } = bfsCallers(idx, target.id, depth, perLevelLimit);

  const changedFiles = opts.changedFiles ?? null;
  const callers = changedFiles
    ? allCallers.filter((c) => changedFiles.has(c.symbol.file))
    : allCallers;

  const directCallers: ImpactCaller[] = [];
  const transitiveCallers: ImpactCaller[] = [];
  for (const c of callers) {
    (c.depth === 1 ? directCallers : transitiveCallers).push(c);
  }

  const testsAffected = callers.filter((c) => isTestFile(c.symbol.file));

  const sourceFiles = new Set<string>();
  for (const c of callers) sourceFiles.add(c.symbol.file);

  const publicApi = {
    exported: target.exported,
    reason: target.exported
      ? `${target.name} is exported from ${target.file}; renaming is a breaking change for any consumer of that module's public surface.`
      : `${target.name} is not exported from ${target.file}; impact is limited to in-repo callers.`,
  };

  return {
    target,
    directCallers,
    transitiveCallers,
    testsAffected,
    publicApi,
    stats: {
      directCount: directCallers.length,
      transitiveCount: transitiveCallers.length,
      testCount: testsAffected.length,
      sourceFileCount: sourceFiles.size,
      truncated,
    },
  };
}
