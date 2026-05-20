/**
 * Tier-A benchmark runner. Runs each task in TASKS in two conditions
 * (graphpilot, baseline grep), scores both, writes a JSON result file
 * plus a markdown summary to bench/results/.
 *
 * Usage:
 *   pnpm bench [--repo=<path>] [--out=<file>]
 *
 * Defaults to running against the graphpilot repo itself
 * (process.cwd()), which is the self-test corpus.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TASKS, type Task } from './tasks.js';
import { GraphpilotRunner, type RunResult } from './runner-graphpilot.js';
import { BaselineRunner } from './runner-baseline.js';
import { score, type Scored } from './score.js';

interface PerTaskResult {
  task: Task;
  graphpilot: { run: RunResult; score: Scored };
  baseline: { run: RunResult; score: Scored };
  winner: 'graphpilot' | 'grep' | 'tie';
  /** Did the winner match expectedWinner? Diagnostic. */
  expectedMatch: boolean;
}

interface AggregateMetrics {
  totalTasks: number;
  graphpilotF1Sum: number;
  baselineF1Sum: number;
  graphpilotBytesTotal: number;
  baselineBytesTotal: number;
  graphpilotWins: number;
  baselineWins: number;
  ties: number;
  expectedWinnerHits: number;
}

interface BenchmarkReport {
  meta: {
    corpus: string;
    timestamp: string;
    graphpilotVersion: string;
    nodeVersion: string;
    platform: NodeJS.Platform;
  };
  aggregate: AggregateMetrics;
  perTask: PerTaskResult[];
}

function pickWinner(
  gp: Scored,
  bl: Scored,
): 'graphpilot' | 'grep' | 'tie' {
  const epsilon = 0.001;
  if (Math.abs(gp.f1 - bl.f1) < epsilon) return 'tie';
  return gp.f1 > bl.f1 ? 'graphpilot' : 'grep';
}

function fmt(n: number, dp = 2): string {
  return Number.isFinite(n) ? n.toFixed(dp) : '?';
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function summaryMarkdown(report: BenchmarkReport): string {
  const a = report.aggregate;
  const lines: string[] = [];
  lines.push(`# GraphPilot Benchmark — ${report.meta.timestamp}`);
  lines.push('');
  lines.push(`Corpus: \`${report.meta.corpus}\``);
  lines.push(`graphpilot v${report.meta.graphpilotVersion}`);
  lines.push(`Node ${report.meta.nodeVersion} on ${report.meta.platform}`);
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push(`- Tasks run: **${a.totalTasks}**`);
  lines.push(
    `- F1 (avg): graphpilot **${fmt(a.graphpilotF1Sum / a.totalTasks)}** ` +
      `vs grep **${fmt(a.baselineF1Sum / a.totalTasks)}**`,
  );
  lines.push(
    `- Bytes processed (total): graphpilot **${fmtBytes(a.graphpilotBytesTotal)}** ` +
      `vs grep **${fmtBytes(a.baselineBytesTotal)}**` +
      ` (${fmt((1 - a.graphpilotBytesTotal / a.baselineBytesTotal) * 100, 1)}% reduction)`,
  );
  lines.push(`- Winner counts: graphpilot **${a.graphpilotWins}** · grep **${a.baselineWins}** · tie **${a.ties}**`);
  lines.push(
    `- Expected-winner accuracy: **${a.expectedWinnerHits}/${a.totalTasks}** ` +
      `(${fmt((a.expectedWinnerHits / a.totalTasks) * 100, 0)}%)`,
  );
  lines.push('');
  lines.push('## Per-task');
  lines.push('');
  lines.push('| # | Task | GP F1 | Grep F1 | GP bytes | Grep bytes | Winner | Expected |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const t of report.perTask) {
    const match = t.expectedMatch ? '✓' : '✗';
    lines.push(
      `| ${t.task.id} | ${t.task.description} ` +
        `| ${fmt(t.graphpilot.score.f1)} ` +
        `| ${fmt(t.baseline.score.f1)} ` +
        `| ${fmtBytes(t.graphpilot.run.outputBytes)} ` +
        `| ${fmtBytes(t.baseline.run.outputBytes)} ` +
        `| ${t.winner} ` +
        `| ${t.task.expectedWinner} ${match} |`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let repoArg: string | undefined;
  let outArg: string | undefined;
  for (const a of args) {
    if (a.startsWith('--repo=')) repoArg = a.slice('--repo='.length);
    else if (a.startsWith('--out=')) outArg = a.slice('--out='.length);
  }

  const repo = resolve(repoArg ?? process.cwd());
  const gp = new GraphpilotRunner(repo);
  const baseline = new BaselineRunner(repo);

  const perTask: PerTaskResult[] = [];
  const agg: AggregateMetrics = {
    totalTasks: TASKS.length,
    graphpilotF1Sum: 0,
    baselineF1Sum: 0,
    graphpilotBytesTotal: 0,
    baselineBytesTotal: 0,
    graphpilotWins: 0,
    baselineWins: 0,
    ties: 0,
    expectedWinnerHits: 0,
  };

  for (const task of TASKS) {
    const gpRun = gp.run(task);
    const blRun = baseline.run(task);

    const gpScore = score(gpRun.returned, task.groundTruth);
    const blScore = score(blRun.returned, task.groundTruth);
    const winner = pickWinner(gpScore, blScore);
    const expectedMatch = winner === task.expectedWinner;

    perTask.push({
      task,
      graphpilot: { run: gpRun, score: gpScore },
      baseline: { run: blRun, score: blScore },
      winner,
      expectedMatch,
    });

    agg.graphpilotF1Sum += gpScore.f1;
    agg.baselineF1Sum += blScore.f1;
    agg.graphpilotBytesTotal += gpRun.outputBytes;
    agg.baselineBytesTotal += blRun.outputBytes;
    if (winner === 'graphpilot') agg.graphpilotWins++;
    else if (winner === 'grep') agg.baselineWins++;
    else agg.ties++;
    if (expectedMatch) agg.expectedWinnerHits++;
  }

  // Pull package.json version for the meta block.
  const pkgVersion = JSON.parse(
    readFileSync(join(repo, 'package.json'), 'utf8'),
  ).version as string;

  const report: BenchmarkReport = {
    meta: {
      corpus: repo,
      timestamp: new Date().toISOString(),
      graphpilotVersion: pkgVersion,
      nodeVersion: process.version,
      platform: process.platform,
    },
    aggregate: agg,
    perTask,
  };

  const resultsDir = join(repo, 'bench', 'results');
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

  const ts = report.meta.timestamp.replace(/[:.]/g, '-');
  const jsonPath = outArg ?? join(resultsDir, `bench-${ts}.json`);
  const mdPath = jsonPath.replace(/\.json$/, '.md');

  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(mdPath, summaryMarkdown(report), 'utf8');

  // Console summary
  console.log(summaryMarkdown(report));
  console.log('');
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);

  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  },
);
