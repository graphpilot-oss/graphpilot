/**
 * Baseline Tier-B: vanilla grep + CLI tools
 *
 * Simulates what an agent would do without GraphPilot:
 * - Use `grep -r` for queries
 * - No structured index, no blast-radius analysis
 * - High noise (false positives in comments, strings)
 *
 * This is a strawman baseline; real agents might use LSP or IDEs.
 * But grep represents the cost of *no* structured indexing.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { TASKS } from './tasks.js';

interface TaskMetrics {
  taskId: string;
  description: string;
  kind: string;
  success: boolean;
  recall: number;
  precision: number;
  f1: number;
  hallucinations: number;
  tokenEstimate: number;
  notes: string;
}

function runGrep(pattern: string, options: string[] = []): string[] {
  try {
    const cmd = [
      'grep',
      '-r',
      '--include=*.ts',
      '--include=*.tsx',
      ...options,
      pattern,
      'src',
      'tests',
    ].join(' ');
    const output = execSync(cmd, {
      encoding: 'utf8',
      cwd: '.',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (!output) return [];
    return output.split('\n').filter((l) => l);
  } catch {
    return [];
  }
}

function extractSymbolsFromGrep(lines: string[]): Set<string> {
  const results = new Set<string>();
  for (const line of lines) {
    const m = line.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g);
    if (m) m.forEach((n) => results.add(n));
  }
  return results;
}

async function runTask(taskId: string): Promise<TaskMetrics> {
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  let found = new Set<string>();
  let responseText = '';

  try {
    switch (task.kind) {
      case 'callers': {
        // grep for function call pattern (naive heuristic)
        const lines = runGrep(`\\b${task.query}\\s*\\(`);
        found = extractSymbolsFromGrep(lines);
        responseText = lines.join('\n').slice(0, 500);
        break;
      }

      case 'impact':
      case 'impact-since': {
        // Can't compute blast radius with grep — too many false positives
        // Simulate by grepping for the function name everywhere
        const lines = runGrep(`\\b${task.query}\\b`);
        found = extractSymbolsFromGrep(lines);
        responseText = `(grep can't compute blast radius; found ${lines.length} occurrences)`;
        break;
      }

      case 'recall':
      case 'recall-substring': {
        const pattern = task.kind === 'recall-substring' ? task.query : `\\b${task.query}\\b`;
        const lines = runGrep(pattern);
        found = extractSymbolsFromGrep(lines);
        responseText = lines.join('\n').slice(0, 500);
        break;
      }

      case 'kind-filter': {
        // grep for 'interface Foo', 'function bar', etc.
        const lines = runGrep(`${task.query}\\s+[a-zA-Z_]`);
        found = extractSymbolsFromGrep(lines);
        responseText = lines.join('\n').slice(0, 500);
        break;
      }

      case 'tests-affected': {
        const lines = runGrep(`\\b${task.query}\\b`, ['tests']);
        found = extractSymbolsFromGrep(lines);
        responseText = lines.join('\n').slice(0, 500);
        break;
      }

      case 'recall-miss': {
        const lines = runGrep(`\\b${task.query}\\b`);
        found = extractSymbolsFromGrep(lines);
        responseText = found.size === 0 ? '[not found in grep]' : found.size.toString();
        break;
      }

      case 'string-literal': {
        const lines = runGrep(task.query);
        found = new Set(lines.map((l) => l.split(':')[0])); // file paths
        responseText = lines.join('\n').slice(0, 500);
        break;
      }
    }
  } catch (err) {
    responseText = `[ERROR: ${err}]`;
  }

  // Score
  const truth = new Set(task.groundTruth);
  const intersection = new Set([...found].filter((n) => truth.has(n)));
  const recall = truth.size > 0 ? intersection.size / truth.size : 1;
  const precision = found.size > 0 ? intersection.size / found.size : 1;
  const f1 = precision + recall > 0 ? (2 * (precision * recall)) / (precision + recall) : 0;

  const success = recall === 1 && precision === 1;
  const hallucinations = found.size - intersection.size;
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
    tokenEstimate,
    notes: `truth=${Array.from(truth).join(',')} found=${Array.from(found).join(',')}`,
  };
}

async function main() {
  const results: TaskMetrics[] = [];

  console.log(`Running ${TASKS.length} tasks with grep baseline...\n`);

  for (const task of TASKS) {
    const metrics = await runTask(task.id);
    results.push(metrics);
    const icon = metrics.success ? '✓' : '✗';
    console.log(
      `${icon} ${metrics.taskId}: F1=${metrics.f1} recall=${metrics.recall} prec=${metrics.precision}`,
    );
  }

  const timestamp = new Date().toISOString().split('T')[0];
  const resultsPath = `bench/results/baseline-tier-${timestamp}.md`;

  let md = `# Baseline Tier-B (grep)\n\n`;
  md += `| Task | Description | Success | Recall | Precision | F1 | Halluc |\n`;
  md += `|---|---|---|---|---|---|---|\n`;

  let totalSuccess = 0;
  let totalHalluc = 0;

  for (const m of results) {
    const success = m.success ? '✓' : '✗';
    md += `| ${m.taskId} | ${m.description} | ${success} | ${m.recall} | ${m.precision} | ${m.f1} | ${m.hallucinations} |\n`;
    totalSuccess += m.success ? 1 : 0;
    totalHalluc += m.hallucinations;
  }

  md += `\n## Summary\n\n`;
  md += `- **Tasks passed:** ${totalSuccess}/${results.length}\n`;
  md += `- **Total hallucinations:** ${totalHalluc}\n`;
  md += `- **Mean F1:** ${(results.reduce((n, r) => n + r.f1, 0) / results.length).toFixed(2)}\n`;

  fs.mkdirSync('bench/results', { recursive: true });
  fs.writeFileSync(resultsPath, md);

  console.log(`\nResults written to ${resultsPath}`);
  console.log(`\n${md}`);
}

main().catch(console.error);
