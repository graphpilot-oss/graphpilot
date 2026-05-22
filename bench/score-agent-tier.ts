/**
 * Tier-B Agent Benchmark Scorer
 *
 * Parses Claude Code session transcripts (.jsonl) and produces the per-task
 * metrics table for the agent-eval benchmark.
 *
 * Usage:
 *   npx tsx bench/score-agent-tier.ts \
 *     --baseline <path-to-baseline.jsonl> \
 *     --graphpilot <path-to-graphpilot.jsonl> \
 *     --output bench/results/agent-tier-2026-05-22.md
 *
 * Input: Claude Code session jsonl (one JSON message per line)
 * Output: Markdown table with per-task metrics + aggregate stats
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

interface Message {
  type: string;
  role?: string;
  content?: string;
  [key: string]: any;
}

interface TaskResult {
  id: string;
  prompt: string;
  // Scorer fills in:
  taskSuccessBaseline: 0 | 1;
  taskSuccessGraphPilot: 0 | 1;
  hallucCountBaseline: number;
  hallucCountGraphPilot: number;
  tokenCostBaseline: number;
  tokenCostGraphPilot: number;
  anchorResolutionRate: number; // 0..1, only for GP
  diffNoiseRatio: number; // 0..1, only for GP (impact-since tasks)
}

async function readJsonl(filePath: string): Promise<Message[]> {
  const messages: Message[] = [];
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      messages.push(JSON.parse(line));
    }
  }
  return messages;
}

function extractTokenUsage(msgs: Message[]): number {
  let total = 0;
  for (const msg of msgs) {
    if (msg.usage) {
      total += (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0);
    }
  }
  return total;
}

/**
 * Extract file:line @ sha anchors from transcript text.
 * Pattern: src/foo.ts:42 @ ab12cd3
 */
function extractAnchors(text: string): Array<{ file: string; line: number; sha: string }> {
  const anchors: Array<{ file: string; line: number; sha: string }> = [];
  const re = /(\S+\.(?:ts|tsx|js|jsx)):(\d+)(?:\s+@\s+([0-9a-f]{7}))?/g;
  let m;
  while ((m = re.exec(text))) {
    anchors.push({
      file: m[1],
      line: parseInt(m[2], 10),
      sha: m[3] ?? '',
    });
  }
  return anchors;
}

/**
 * Stub scorer: human-in-the-loop.
 *
 * Real scoring requires:
 *   1. Human opens the transcript
 *   2. Manually reads the agent's final answer
 *   3. Compares to ground truth (from tasks.ts)
 *   4. Marks success/hallucination count
 *
 * This function prompts for input or reads from a pre-filled CSV.
 * For now, it's a template showing the metrics to collect.
 */
async function scoreTask(
  taskId: string,
  baselineTranscript: string,
  graphpilotTranscript: string,
): Promise<TaskResult> {
  // TODO: Implement human-in-the-loop or CSV reader
  // For MVP, return a stub result
  return {
    id: taskId,
    prompt: '(placeholder)',
    taskSuccessBaseline: 0,
    taskSuccessGraphPilot: 0,
    hallucCountBaseline: 0,
    hallucCountGraphPilot: 0,
    tokenCostBaseline: 0,
    tokenCostGraphPilot: 0,
    anchorResolutionRate: 0,
    diffNoiseRatio: 0,
  };
}

/**
 * Format results as Markdown table suitable for README
 */
function formatResultsTable(results: TaskResult[]): string {
  let md = `# Tier-B Agent Benchmark Results\n\n`;
  md += `| Task | Baseline Success | GP Success | Halluc (B) | Halluc (GP) | Tokens (B) | Tokens (GP) | Anchor % | Diff Noise |\n`;
  md += `|---|---|---|---|---|---|---|---|---|\n`;

  for (const r of results) {
    md += `| ${r.id} | ${r.taskSuccessBaseline} | ${r.taskSuccessGraphPilot} | ${r.hallucCountBaseline} | ${r.hallucCountGraphPilot} | ${r.tokenCostBaseline} | ${r.tokenCostGraphPilot} | ${(r.anchorResolutionRate * 100).toFixed(0)}% | ${(r.diffNoiseRatio * 100).toFixed(0)}% |\n`;
  }

  // Aggregate stats
  const totalSuccessB = results.reduce((n, r) => n + r.taskSuccessBaseline, 0);
  const totalSuccessGP = results.reduce((n, r) => n + r.taskSuccessGraphPilot, 0);
  const totalHallucB = results.reduce((n, r) => n + r.hallucCountBaseline, 0);
  const totalHallucGP = results.reduce((n, r) => n + r.hallucCountGraphPilot, 0);
  const totalTokensB = results.reduce((n, r) => n + r.tokenCostBaseline, 0);
  const totalTokensGP = results.reduce((n, r) => n + r.tokenCostGraphPilot, 0);
  const avgAnchorRes = results.reduce((n, r) => n + r.anchorResolutionRate, 0) / results.length;

  md += `\n## Summary\n\n`;
  md += `- **Baseline success rate:** ${totalSuccessB}/${results.length}\n`;
  md += `- **GraphPilot success rate:** ${totalSuccessGP}/${results.length}\n`;
  md += `- **Hallucinations (Baseline):** ${totalHallucB}\n`;
  md += `- **Hallucinations (GraphPilot):** ${totalHallucGP}\n`;
  md += `- **Token cost (Baseline):** ${totalTokensB}\n`;
  md += `- **Token cost (GraphPilot):** ${totalTokensGP} (−${((1 - totalTokensGP / totalTokensB) * 100).toFixed(0)}%)\n`;
  md += `- **Anchor resolution rate:** ${(avgAnchorRes * 100).toFixed(0)}%\n`;

  return md;
}

async function main() {
  const args = process.argv.slice(2);
  const baselineArg =
    args.find((a) => a.startsWith('--baseline='))?.split('=')[1] ||
    args[args.indexOf('--baseline') + 1];
  const graphpilotArg =
    args.find((a) => a.startsWith('--graphpilot='))?.split('=')[1] ||
    args[args.indexOf('--graphpilot') + 1];
  const outputArg =
    args.find((a) => a.startsWith('--output='))?.split('=')[1] ||
    args[args.indexOf('--output') + 1];

  if (!baselineArg || !graphpilotArg || !outputArg) {
    console.error(
      'Usage: npx tsx bench/score-agent-tier.ts --baseline <path> --graphpilot <path> --output <path>',
    );
    process.exit(1);
  }

  console.log('Loading transcripts...');
  const baselineData = await readJsonl(baselineArg);
  const graphpilotData = await readJsonl(graphpilotArg);

  console.log(`Baseline: ${baselineData.length} messages`);
  console.log(`GraphPilot: ${graphpilotData.length} messages`);

  // TODO: Parse transcripts by task boundary, invoke scorer for each pair
  console.log('\n[Stub] Scoring requires human review. Prepare scoring input CSV with columns:');
  console.log('  task_id, baseline_success (0/1), gp_success (0/1), baseline_halluc, gp_halluc');
  console.log('Then run: npx tsx bench/score-agent-tier.ts --scores <csv> --output <path>');

  const results: TaskResult[] = [];
  // Placeholder: results would be populated from CSV or human input

  const output = formatResultsTable(results);
  fs.writeFileSync(outputArg, output);
  console.log(`Results written to ${outputArg}`);
}

main().catch(console.error);
