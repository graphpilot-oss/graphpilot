/**
 * Run each benchmark task using GraphPilot's primitives directly.
 * Measures correctness against task.groundTruth + bytes of output the
 * tool returned (proxy for the token cost an agent would pay).
 */

import { loadGraph } from '../src/storage.js';
import { GraphIndex } from '../src/query.js';
import { analyzeImpact } from '../src/impact.js';
import type { Task } from './tasks.js';

export interface RunResult {
  /** Strings the tool returned. For caller/impact tasks, caller names. */
  returned: string[];
  /** Bytes the tool's structured output occupies as JSON. */
  outputBytes: number;
  /** Wall-clock for the tool call. */
  durationMs: number;
}

export class GraphpilotRunner {
  private readonly idx: GraphIndex;

  constructor(repoRoot: string) {
    const g = loadGraph(repoRoot);
    if (!g) {
      throw new Error(
        `No graph found at ${repoRoot}. Run \`graphpilot index\` first.`,
      );
    }
    this.idx = new GraphIndex(g);
  }

  run(task: Task): RunResult {
    const start = Date.now();
    let returned: string[];

    switch (task.kind) {
      case 'callers': {
        const target = this.idx.resolveSymbol(task.query);
        if (!target) {
          returned = [];
          break;
        }
        const edges = this.idx.callers(target.id);
        const names = new Set<string>();
        for (const e of edges) {
          const from = this.idx.findById(e.fromId);
          if (from) names.add(from.name);
        }
        returned = [...names].sort();
        break;
      }

      case 'recall': {
        const matches = this.idx.findByName(task.query, { limit: 50 });
        returned = matches.map((s) => s.name).sort();
        break;
      }

      case 'recall-substring': {
        const matches = this.idx.findByName(task.query, {
          substring: true,
          limit: 100,
        });
        returned = matches.map((s) => s.name).sort();
        break;
      }

      case 'kind-filter': {
        // Filter the full symbol table by kind. The MCP surface doesn't
        // expose this as a tool today (would be a v0.2 gp_list_by_kind)
        // but the data is in GraphIndex.graph.symbols.
        returned = this.idx.graph.symbols
          .filter(
            (s) => s.kind === task.query && s.file.startsWith('src/'),
          )
          .map((s) => s.name)
          .sort();
        break;
      }

      case 'impact': {
        const report = analyzeImpact(this.idx, task.query, { depth: 2 });
        if (!report) {
          returned = [];
          break;
        }
        const names = new Set<string>();
        for (const c of report.directCallers) names.add(c.symbol.name);
        for (const c of report.transitiveCallers) names.add(c.symbol.name);
        returned = [...names].sort();
        break;
      }

      case 'tests-affected': {
        const report = analyzeImpact(this.idx, task.query, { depth: 3 });
        if (!report) {
          returned = [];
          break;
        }
        const files = new Set<string>();
        for (const c of report.testsAffected) files.add(c.symbol.file);
        returned = [...files].sort();
        break;
      }

      case 'recall-miss': {
        const matches = this.idx.findByName(task.query, { limit: 10 });
        returned = matches.map((s) => s.name).sort();
        break;
      }

      case 'string-literal': {
        // GraphPilot intentionally doesn't index string literals or
        // identifier usages outside structural contexts. Best effort:
        // return any file where a symbol whose NAME matches the query
        // is defined. This will miss most usages (the honest "grep wins"
        // baseline).
        const decl = this.idx.findByName(task.query, { limit: 5 });
        const files = new Set<string>();
        for (const s of decl) files.add(s.file);
        returned = [...files].sort();
        break;
      }
    }

    const outputBytes = Buffer.byteLength(JSON.stringify(returned), 'utf8');
    return {
      returned,
      outputBytes,
      durationMs: Date.now() - start,
    };
  }
}
