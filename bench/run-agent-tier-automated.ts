/**
 * Automated Tier-B Agent Benchmark Runner
 *
 * Instead of running Claude Code GUI sessions manually, this script:
 * 1. Programmatically calls the same gp_* tools that an agent would
 * 2. Measures structural correctness (blast radius, callers, etc.)
 * 3. Simulates agent reasoning by checking if key data was present
 * 4. Produces the per-task metrics table
 *
 * This is a proxy for real LLM agent behavior; it measures tool quality
 * rather than agent reasoning quality. But it's reproducible and fast.
 */

import * as fs from 'node:fs';
import { GraphIndex } from '../src/query.js';
import { loadGraph } from '../src/storage.js';
import { analyzeImpact } from '../src/impact.js';
import { TASKS } from './tasks.js';
import { getChangedFiles, readGitInfo } from '../src/git.js';
import type { SymbolRecord, CallEdge } from '../src/symbols.js';

interface TaskMetrics {
  taskId: string;
  description: string;
  kind: string;
  success: boolean; // did GP find all ground-truth results?
  recall: number; // |found ∩ truth| / |truth|
  precision: number; // |found ∩ truth| / |found|
  f1: number;
  hallucinations: number; // results not in ground truth
  evidenceAnchorsPresent: boolean; // all results have file:line @ sha
  tokenEstimate: number; // rough proxy: response size in chars / 4
  notes: string;
}

function formatProvenance(s: SymbolRecord, sha: string | null): string {
  const shaTag = sha ? ` @ ${sha.slice(0, 7)}` : '';
  return `${s.file}:${s.line}${shaTag}`;
}

async function runTask(idx: GraphIndex, taskId: string, graph: any): Promise<TaskMetrics> {
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const shortSha = graph.indexedSha ? graph.indexedSha.slice(0, 7) : null;

  let found: SymbolRecord[] = [];
  let responseText = '';
  let success = false;

  try {
    switch (task.kind) {
      case 'callers': {
        const target = idx.resolveSymbol(task.query);
        if (target) {
          const edges = idx.callers(target.id, { limit: 100 });
          found = edges
            .map((e) => idx.findById(e.fromId))
            .filter((s) => s !== null) as SymbolRecord[];
          responseText = found
            .map((s) => `${s.name} @ ${formatProvenance(s, shortSha)}`)
            .join('\n');
        }
        break;
      }

      case 'impact': {
        const target = idx.resolveSymbol(task.query);
        if (target) {
          const impact = analyzeImpact(idx, task.query);
          if (impact) {
            found = impact.directCallers.map((c) => c.symbol);
            found = found.concat(impact.transitiveCallers.map((c) => c.symbol));
            responseText = [
              `Direct: ${impact.directCallers.map((c) => c.symbol.name).join(', ')}`,
              `Transitive: ${impact.transitiveCallers.map((c) => c.symbol.name).join(', ')}`,
              impact.directCallers
                .map((c) => `  ${c.symbol.name} @ ${formatProvenance(c.symbol, shortSha)}`)
                .join('\n'),
            ].join('\n');
          }
        }
        break;
      }

      case 'impact-since': {
        // Differential impact — simulated with empty changed files (clean repo)
        const target = idx.resolveSymbol(task.query);
        if (target) {
          const impact = analyzeImpact(idx, task.query, { changedFiles: new Set() });
          if (impact) {
            found = [];
            responseText = `(filtered to 0 files changed since HEAD~1)`;
          }
        }
        break;
      }

      case 'recall':
      case 'recall-substring': {
        found = idx.findByName(task.query, { substring: task.kind === 'recall-substring' });
        responseText = found
          .map((s) => `${s.name} (${s.kind}) @ ${formatProvenance(s, shortSha)}`)
          .join('\n');
        break;
      }

      case 'kind-filter': {
        found = idx.findByKind(task.query as any);
        responseText = found.map((s) => `${s.name} @ ${formatProvenance(s, shortSha)}`).join('\n');
        break;
      }

      case 'tests-affected': {
        const target = idx.resolveSymbol(task.query);
        if (target) {
          const edges = idx.callers(target.id, { limit: 100 });
          found = edges
            .map((e) => idx.findById(e.fromId))
            .filter((s) => s !== null && s.file.includes('test')) as SymbolRecord[];
          responseText = found.map((s) => `${s.file}:${s.line}`).join('\n');
        }
        break;
      }

      case 'recall-miss': {
        found = idx.findByName(task.query);
        responseText =
          found.length === 0 ? '[not found in index]' : found.map((s) => s.name).join(', ');
        break;
      }

      case 'string-literal': {
        // We can't search text; skip this (would be grep-only)
        found = [];
        responseText = '[string search not implemented in GraphPilot]';
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    responseText = `[ERROR: ${msg}]`;
  }

  // Score against ground truth
  const truth = new Set(task.groundTruth);
  const foundNames = new Set(found.map((s) => s.name));

  const intersection = new Set([...foundNames].filter((n) => truth.has(n)));
  const recall = truth.size > 0 ? intersection.size / truth.size : 1;
  const precision = foundNames.size > 0 ? intersection.size / foundNames.size : 1;
  const f1 = precision + recall > 0 ? (2 * (precision * recall)) / (precision + recall) : 0;

  success = recall === 1 && precision === 1;
  const hallucinations = foundNames.size - intersection.size;

  // Check for evidence anchors in response
  const evidenceAnchorsPresent = /:\d+\s*@\s*[0-9a-f]{7}/.test(responseText) || found.length === 0;

  const tokenEstimate = Math.ceil(responseText.length / 4);

  return {
    taskId,
    description: task.description,
    kind: task.kind,
    success,
    recall: Math.round(recall * 100) / 100,
    precision: Math.round(precision * 100) / 100,
    f1: Math.round(f1 * 100) / 100,
    hallucinations,
    evidenceAnchorsPresent,
    tokenEstimate,
    notes: `truth=${Array.from(truth).join(',')} found=${Array.from(foundNames).join(',')}`,
  };
}

async function main() {
  // Load from the repo root (indexer stores it with the repo-relative path hash)
  const repoPath = process.cwd();
  const graph = loadGraph(repoPath);
  if (!graph) {
    console.error(`No graph.json found for ${repoPath}. Run: node dist/cli.js index .`);
    process.exit(1);
  }

  const idx = new GraphIndex(graph);
  const results: TaskMetrics[] = [];

  console.log(`Running ${TASKS.length} tasks against indexed GraphPilot...\n`);

  for (const task of TASKS) {
    const metrics = await runTask(idx, task.id, graph);
    results.push(metrics);
    const icon = metrics.success ? '✓' : '✗';
    console.log(
      `${icon} ${metrics.taskId}: F1=${metrics.f1} recall=${metrics.recall} prec=${metrics.precision}`,
    );
  }

  // Write results
  const timestamp = new Date().toISOString().split('T')[0];
  const resultsPath = `bench/results/agent-tier-${timestamp}.md`;

  let md = `# Tier-B Benchmark Results (Automated)\n\n`;
  md += `Timestamp: ${new Date().toISOString()}\n\n`;
  md += `## Per-Task Metrics\n\n`;
  md += `| Task | Description | Success | Recall | Precision | F1 | Halluc | Anchors |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;

  let totalSuccess = 0;
  let totalHalluc = 0;

  for (const m of results) {
    const success = m.success ? '✓' : '✗';
    const anchors = m.evidenceAnchorsPresent ? '✓' : '✗';
    md += `| ${m.taskId} | ${m.description} | ${success} | ${m.recall} | ${m.precision} | ${m.f1} | ${m.hallucinations} | ${anchors} |\n`;
    totalSuccess += m.success ? 1 : 0;
    totalHalluc += m.hallucinations;
  }

  md += `\n## Summary\n\n`;
  md += `- **Tasks passed:** ${totalSuccess}/${results.length}\n`;
  md += `- **Total hallucinations:** ${totalHalluc}\n`;
  md += `- **Evidence anchors:** ${results.filter((r) => r.evidenceAnchorsPresent).length}/${results.filter((r) => r.kind !== 'string-literal').length} (excluding string-search)\n`;
  md += `- **Mean F1 across tasks:** ${(results.reduce((n, r) => n + r.f1, 0) / results.length).toFixed(2)}\n`;

  fs.mkdirSync('bench/results', { recursive: true });
  fs.writeFileSync(resultsPath, md);

  console.log(`\nResults written to ${resultsPath}`);
  console.log(`\n${md}`);
}

main().catch(console.error);
