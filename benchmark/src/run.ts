/**
 * run.ts — execute the benchmark for all tasks in both modes.
 * Saves raw results JSON and prints live progress.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, MODEL } from './config.js';
import { runTask } from './runner.js';
import { loadTasks } from './generate.js';
import { getFastifySha } from './setup.js';
import type { BenchmarkRun, TaskResult } from './types.js';

function bar(correct: boolean, score: number): string {
  const pct = Math.round(score * 100);
  return `${correct ? '✓' : '✗'} ${pct}%`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export async function runBenchmark(
  opts: {
    taskFilter?: string[];
    modesOnly?: ('baseline' | 'gp')[];
    baselineFrom?: string; // timestamp or full path to a previous raw.json
  } = {},
): Promise<string> {
  const tasks = loadTasks();
  const filtered = opts.taskFilter?.length
    ? tasks.filter((t) => opts.taskFilter!.includes(t.id))
    : tasks;

  const modes: ('baseline' | 'gp')[] = opts.modesOnly ?? ['baseline', 'gp'];

  const results: TaskResult[] = [];
  if (opts.baselineFrom) {
    const srcPath = opts.baselineFrom.endsWith('.json')
      ? opts.baselineFrom
      : join(RESULTS_DIR, opts.baselineFrom, 'raw.json');
    if (!existsSync(srcPath)) throw new Error(`--baseline-from: file not found: ${srcPath}`);
    const prev = JSON.parse(readFileSync(srcPath, 'utf8')) as BenchmarkRun;
    const baselineResults = prev.results.filter(
      (r) => r.mode === 'baseline' && (!opts.taskFilter || opts.taskFilter.includes(r.taskId)),
    );
    results.push(...baselineResults);
    console.log(`Loaded ${baselineResults.length} baseline results from ${srcPath}`);
  }

  console.log(`\n=== BENCHMARK RUN ===`);
  console.log(`Model  : ${MODEL}`);
  console.log(`Tasks  : ${filtered.length}`);
  console.log(`Modes  : ${modes.join(', ')}`);
  console.log('');

  // Header
  console.log('ID    Type         Mode      Tokens(in+out)  Files  Score  Time');
  console.log('─'.repeat(72));

  for (const task of filtered) {
    for (const mode of modes) {
      process.stdout.write(`${task.id.padEnd(5)} ${task.type.padEnd(12)} ${mode.padEnd(9)} `);
      process.stdout.write('running...');

      try {
        const result = await runTask(task, mode);
        results.push(result);

        // Overwrite "running..." line
        const tokenStr = `${fmtTokens(result.inputTokens)}+${fmtTokens(result.outputTokens)}=${fmtTokens(result.totalTokens)}`;
        process.stdout.write(
          `\r${task.id.padEnd(5)} ${task.type.padEnd(12)} ${mode.padEnd(9)} ` +
            `${tokenStr.padEnd(16)} ${String(result.filesRead.length).padEnd(6)} ${bar(result.correct, result.score).padEnd(7)} ${result.durationMs}ms\n`,
        );
      } catch (err) {
        process.stdout.write(
          `\r${task.id.padEnd(5)} ${task.type.padEnd(12)} ${mode.padEnd(9)} ERROR: ${String(err)}\n`,
        );
      }
    }
  }

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = join(RESULTS_DIR, timestamp);
  if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

  const runData: BenchmarkRun = {
    timestamp,
    fastifySha: getFastifySha(),
    gpVersion: 'local',
    model: MODEL,
    tasks: filtered,
    results,
  };

  const rawPath = join(runDir, 'raw.json');
  writeFileSync(rawPath, JSON.stringify(runData, null, 2), 'utf8');
  console.log(`\nRaw results → ${rawPath}`);

  return rawPath;
}
