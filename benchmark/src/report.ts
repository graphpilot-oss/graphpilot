/**
 * report.ts — generate a markdown report from raw benchmark results.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from './config.js';
import type { BenchmarkRun, TaskResult, Summary, TaskType } from './types.js';

function pct(a: number, b: number): string {
  if (b === 0) return '—';
  return `${Math.round(((b - a) / b) * 100)}%`;
}

function fmtN(n: number): string {
  return n.toLocaleString();
}

function buildSummary(run: BenchmarkRun): Summary {
  const baseline = run.results.filter((r) => r.mode === 'baseline');
  const gp = run.results.filter((r) => r.mode === 'gp');

  const sumTokens = (arr: TaskResult[]) => ({
    input: arr.reduce((s, r) => s + r.inputTokens, 0),
    output: arr.reduce((s, r) => s + r.outputTokens, 0),
    total: arr.reduce((s, r) => s + r.totalTokens, 0),
  });

  const bt = sumTokens(baseline);
  const gt = sumTokens(gp);

  const types: TaskType[] = ['navigation', 'callers', 'impact', 'trace', 'dependency'];
  const byType = {} as Summary['byType'];
  for (const type of types) {
    const bTokens = baseline
      .filter((r) => run.tasks.find((t) => t.id === r.taskId)?.type === type)
      .reduce((s, r) => s + r.totalTokens, 0);
    const gTokens = gp
      .filter((r) => run.tasks.find((t) => t.id === r.taskId)?.type === type)
      .reduce((s, r) => s + r.totalTokens, 0);
    byType[type] = {
      baselineTokens: bTokens,
      gpTokens: gTokens,
      savedPercent: bTokens ? Math.round(((bTokens - gTokens) / bTokens) * 100) : 0,
    };
  }

  return {
    totalTasks: run.tasks.length,
    baselineTokens: bt,
    gpTokens: gt,
    savedTokens: bt.total - gt.total,
    savedPercent: bt.total ? Math.round(((bt.total - gt.total) / bt.total) * 100) : 0,
    baselineFilesRead: baseline.reduce((s, r) => s + r.filesRead.length, 0),
    gpFilesRead: gp.reduce((s, r) => s + r.filesRead.length, 0),
    baselineToolCalls: baseline.reduce((s, r) => s + r.toolCalls.length, 0),
    gpToolCalls: gp.reduce((s, r) => s + r.toolCalls.length, 0),
    baselineCorrect: baseline.filter((r) => r.correct).length,
    gpCorrect: gp.filter((r) => r.correct).length,
    baselineAvgMs: baseline.length
      ? Math.round(baseline.reduce((s, r) => s + r.durationMs, 0) / baseline.length)
      : 0,
    gpAvgMs: gp.length ? Math.round(gp.reduce((s, r) => s + r.durationMs, 0) / gp.length) : 0,
    byType,
  };
}

function formatReport(run: BenchmarkRun): string {
  const s = buildSummary(run);
  const lines: string[] = [];

  lines.push(`# GraphPilot Token Savings Benchmark`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| **Date** | ${run.timestamp} |`);
  lines.push(`| **Model** | ${run.model} |`);
  lines.push(`| **Fastify SHA** | ${run.fastifySha} |`);
  lines.push(`| **GP version** | ${run.gpVersion} |`);
  lines.push(`| **Tasks** | ${s.totalTasks} |`);
  lines.push('');

  // ── Top-line savings ──────────────────────────────────────────────────────
  lines.push(`## 🏆 Top-line Results`);
  lines.push('');
  lines.push(`| Metric | Baseline | GraphPilot | Saved |`);
  lines.push(`|---|---:|---:|---:|`);
  lines.push(
    `| **Total tokens** | ${fmtN(s.baselineTokens.total)} | ${fmtN(s.gpTokens.total)} | **${s.savedPercent}%** |`,
  );
  lines.push(
    `| Input tokens | ${fmtN(s.baselineTokens.input)} | ${fmtN(s.gpTokens.input)} | ${pct(s.gpTokens.input, s.baselineTokens.input)} |`,
  );
  lines.push(
    `| Output tokens | ${fmtN(s.baselineTokens.output)} | ${fmtN(s.gpTokens.output)} | ${pct(s.gpTokens.output, s.baselineTokens.output)} |`,
  );
  lines.push(
    `| Files read | ${fmtN(s.baselineFilesRead)} | ${fmtN(s.gpFilesRead)} | ${pct(s.gpFilesRead, s.baselineFilesRead)} |`,
  );
  lines.push(
    `| Tool calls | ${fmtN(s.baselineToolCalls)} | ${fmtN(s.gpToolCalls)} | ${pct(s.gpToolCalls, s.baselineToolCalls)} |`,
  );
  lines.push(
    `| Correct answers | ${s.baselineCorrect}/${s.totalTasks} | ${s.gpCorrect}/${s.totalTasks} | — |`,
  );
  lines.push(`| Avg time/task | ${s.baselineAvgMs}ms | ${s.gpAvgMs}ms | — |`);
  lines.push('');

  // ── By task type ─────────────────────────────────────────────────────────
  lines.push(`## 📊 Savings by Task Type`);
  lines.push('');
  lines.push(`| Type | Baseline | GraphPilot | Saved % |`);
  lines.push(`|---|---:|---:|---:|`);
  for (const [type, data] of Object.entries(s.byType)) {
    if (data.baselineTokens === 0 && data.gpTokens === 0) continue;
    lines.push(
      `| ${type} | ${fmtN(data.baselineTokens)} | ${fmtN(data.gpTokens)} | **${data.savedPercent}%** |`,
    );
  }
  lines.push('');

  // ── Per-task table ────────────────────────────────────────────────────────
  lines.push(`## 📋 Per-Task Results`);
  lines.push('');
  lines.push(`| Task | Type | B tokens | GP tokens | Saved | B files | GP files | B✓ | GP✓ |`);
  lines.push(`|---|---|---:|---:|---:|---:|---:|---|---|`);

  for (const task of run.tasks) {
    const b = run.results.find((r) => r.taskId === task.id && r.mode === 'baseline');
    const g = run.results.find((r) => r.taskId === task.id && r.mode === 'gp');
    if (!b && !g) continue;

    const bTok = b?.totalTokens ?? 0;
    const gTok = g?.totalTokens ?? 0;
    const saved = bTok ? `${Math.round(((bTok - gTok) / bTok) * 100)}%` : '—';

    lines.push(
      `| ${task.id} | ${task.type} | ${fmtN(bTok)} | ${fmtN(gTok)} | ${saved} | ${b?.filesRead.length ?? 0} | ${g?.filesRead.length ?? 0} | ${b?.correct ? '✓' : '✗'} | ${g?.correct ? '✓' : '✗'} |`,
    );
  }
  lines.push('');

  // ── Detailed answers ──────────────────────────────────────────────────────
  lines.push(`## 🔍 Question Details`);
  lines.push('');
  for (const task of run.tasks) {
    const b = run.results.find((r) => r.taskId === task.id && r.mode === 'baseline');
    const g = run.results.find((r) => r.taskId === task.id && r.mode === 'gp');

    lines.push(`### ${task.id} — ${task.question}`);
    lines.push('');
    lines.push(`**Type:** ${task.type}  `);
    lines.push(`**Expected keywords:** \`${task.expectedKeywords.join('`, `')}\``);
    lines.push('');
    lines.push(`**Ground truth:**`);
    lines.push('```');
    lines.push(task.groundTruth.slice(0, 500));
    if (task.groundTruth.length > 500) lines.push('... (truncated)');
    lines.push('```');
    lines.push('');

    if (b) {
      lines.push(
        `**Baseline** (${fmtN(b.totalTokens)} tokens, ${b.filesRead.length} files, score ${b.score}):`,
      );
      lines.push('```');
      lines.push(b.answer.slice(0, 400));
      if (b.answer.length > 400) lines.push('... (truncated)');
      lines.push('```');
      if (b.toolCalls.length) {
        lines.push(`Tools used: ${b.toolCalls.map((c) => c.name).join(' → ')}`);
      }
      lines.push('');
    }

    if (g) {
      lines.push(
        `**GraphPilot** (${fmtN(g.totalTokens)} tokens, ${g.filesRead.length} files, score ${g.score}):`,
      );
      lines.push('```');
      lines.push(g.answer.slice(0, 400));
      if (g.answer.length > 400) lines.push('... (truncated)');
      lines.push('```');
      if (g.toolCalls.length) {
        lines.push(`Tools used: ${g.toolCalls.map((c) => c.name).join(' → ')}`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

export function generateReport(rawJsonPath: string): string {
  const run = JSON.parse(readFileSync(rawJsonPath, 'utf8')) as BenchmarkRun;
  const report = formatReport(run);

  const reportPath = rawJsonPath.replace('raw.json', 'report.md');
  writeFileSync(reportPath, report, 'utf8');
  console.log(`\nReport → ${reportPath}`);
  return reportPath;
}

export function findLatestRun(): string | null {
  try {
    const entries = readdirSync(RESULTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(RESULTS_DIR, e.name, 'raw.json') }))
      .filter((e) => {
        try {
          statSync(e.path);
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.name.localeCompare(a.name));
    return entries[0]?.path ?? null;
  } catch {
    return null;
  }
}
