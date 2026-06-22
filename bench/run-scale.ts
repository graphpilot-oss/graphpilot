/**
 * Scale benchmark — runs GraphPilot against an arbitrary TypeScript/JavaScript
 * repo (no hand-curated ground truth required) and reports the metrics that
 * matter for "does this work at scale":
 *
 *   1. Indexing throughput   — files/sec, symbols/sec, total wall-clock
 *   2. Index size on disk    — graph.json bytes vs repo source bytes
 *   3. Query latency         — sampled across 20 real symbols from the index
 *   4. Bytes-read vs grep    — same query, GraphPilot output vs grep file bytes
 *
 * Usage:
 *   pnpm bench:scale --repo=/path/to/large-ts-repo [--out=path.json]
 *
 * Unlike `bench/run.ts`, this does NOT compute F1 — it's the "floor" benchmark
 * that proves the system scales, not the "ceiling" benchmark that proves it's
 * accurate. Pair with a hand-curated Tier-A run for credibility claims.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import fg from 'fast-glob';
import { indexDirectory } from '../src/indexer.js';
import { saveGraph, graphPath, loadGraph, repoIdFor } from '../src/storage.js';
import { GraphIndex } from '../src/query.js';
import { analyzeImpact } from '../src/impact.js';

interface ScaleReport {
  meta: {
    corpus: string;
    corpusName: string;
    timestamp: string;
    nodeVersion: string;
    platform: NodeJS.Platform;
  };
  index: {
    filesIndexed: number;
    filesFailed: number;
    symbolCount: number;
    edgeCount: number;
    indexingMs: number;
    indexingFilesPerSec: number;
    graphJsonBytes: number;
    repoSourceBytes: number;
    compressionRatio: number;
  };
  queries: {
    recall: LatencyStats;
    callers: LatencyStats;
    impact: LatencyStats;
  };
  bytesComparison: {
    samples: BytesSample[];
    meanReduction: number;
  };
}

interface LatencyStats {
  samples: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanOutputBytes: number;
}

interface BytesSample {
  symbol: string;
  graphpilotBytes: number;
  grepBytes: number;
  reduction: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function stats(durations: number[], outputBytes: number[]): LatencyStats {
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = durations.reduce((s, n) => s + n, 0);
  const byteSum = outputBytes.reduce((s, n) => s + n, 0);
  return {
    samples: durations.length,
    meanMs: durations.length ? sum / durations.length : 0,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanOutputBytes: outputBytes.length ? byteSum / outputBytes.length : 0,
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtMs(n: number): string {
  if (n < 1) return `${n.toFixed(2)} ms`;
  if (n < 1000) return `${n.toFixed(1)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

/** Sample N symbol names spread across the index. */
function sampleSymbols(idx: GraphIndex, n: number): string[] {
  const all = idx.graph.symbols.filter((s) => s.kind === 'function' || s.kind === 'method');
  if (all.length === 0) return [];
  const step = Math.max(1, Math.floor(all.length / n));
  const out: string[] = [];
  for (let i = 0; i < all.length && out.length < n; i += step) {
    out.push(all[i].name);
  }
  return out;
}

/** Sample the most-called symbols — interesting for callers/impact queries. */
function sampleHotSymbols(idx: GraphIndex, n: number): string[] {
  const inDegree = new Map<string, number>();
  for (const e of idx.graph.edges) {
    inDegree.set(e.toId, (inDegree.get(e.toId) ?? 0) + 1);
  }
  const ranked = [...inDegree.entries()].sort((a, b) => b[1] - a[1]).slice(0, n * 3);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const [id] of ranked) {
    const s = idx.findById(id);
    if (s && !seen.has(s.name)) {
      seen.add(s.name);
      names.push(s.name);
      if (names.length >= n) break;
    }
  }
  return names;
}

function totalSourceBytes(repo: string): number {
  const files = fg.sync(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'], {
    cwd: repo,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.d.ts'],
    onlyFiles: true,
    suppressErrors: true,
  });
  let total = 0;
  for (const f of files) {
    try {
      total += statSync(f).size;
    } catch {
      // skip unreadable
    }
  }
  return total;
}

function grepBytesFor(repo: string, symbol: string): number {
  try {
    const out = execSync(
      `grep -rln --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' ` +
        `--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build ` +
        `-- ${JSON.stringify(symbol)} ${JSON.stringify(repo)}`,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    let total = 0;
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try {
        total += statSync(line).size;
      } catch {
        // file may have vanished
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function summaryMarkdown(r: ScaleReport): string {
  const lines: string[] = [];
  lines.push(`# GraphPilot Scale Benchmark — ${r.meta.corpusName}`);
  lines.push('');
  lines.push(`- Corpus: \`${r.meta.corpus}\``);
  lines.push(`- Date: ${r.meta.timestamp}`);
  lines.push(`- Node ${r.meta.nodeVersion} on ${r.meta.platform}`);
  lines.push('');
  lines.push('## Indexing');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Files indexed | ${r.index.filesIndexed.toLocaleString()} |`);
  lines.push(`| Files failed | ${r.index.filesFailed.toLocaleString()} |`);
  lines.push(`| Symbols extracted | ${r.index.symbolCount.toLocaleString()} |`);
  lines.push(`| Call edges resolved | ${r.index.edgeCount.toLocaleString()} |`);
  lines.push(`| Indexing wall-clock | ${fmtMs(r.index.indexingMs)} |`);
  lines.push(`| Files / second | ${r.index.indexingFilesPerSec.toFixed(0)} |`);
  lines.push(`| graph.json on disk | ${fmtBytes(r.index.graphJsonBytes)} |`);
  lines.push(`| Repo source size | ${fmtBytes(r.index.repoSourceBytes)} |`);
  lines.push(`| Graph as % of source | ${(r.index.compressionRatio * 100).toFixed(1)}% |`);
  lines.push('');
  lines.push('## Query latency');
  lines.push('');
  lines.push('| Query type | Samples | Mean | p50 | p95 | Max | Mean output |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const [name, s] of Object.entries(r.queries) as [string, LatencyStats][]) {
    lines.push(
      `| ${name} | ${s.samples} | ${fmtMs(s.meanMs)} | ${fmtMs(s.p50Ms)} | ` +
        `${fmtMs(s.p95Ms)} | ${fmtMs(s.maxMs)} | ${fmtBytes(s.meanOutputBytes)} |`,
    );
  }
  lines.push('');
  lines.push('## Bytes read — GraphPilot vs grep');
  lines.push('');
  lines.push(
    'Same question ("who calls X?"), two strategies. Bytes-read is a proxy for the tokens the agent would pay.',
  );
  lines.push('');
  lines.push('| Symbol | GraphPilot output | grep file bytes | Reduction |');
  lines.push('| --- | --- | --- | --- |');
  for (const s of r.bytesComparison.samples) {
    lines.push(
      `| \`${s.symbol}\` | ${fmtBytes(s.graphpilotBytes)} | ${fmtBytes(s.grepBytes)} | ${(s.reduction * 100).toFixed(2)}% |`,
    );
  }
  lines.push('');
  lines.push(`**Mean byte reduction: ${(r.bytesComparison.meanReduction * 100).toFixed(2)}%**`);
  lines.push('');
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
  if (!repoArg) {
    console.error('Usage: pnpm bench:scale --repo=/path/to/ts-repo [--out=file.json]');
    return 1;
  }
  const repo = resolve(repoArg);
  if (!existsSync(repo)) {
    console.error(`Repo path does not exist: ${repo}`);
    return 1;
  }

  console.log(`[scale-bench] indexing ${repo} ...`);
  const indexStart = Date.now();
  const result = await indexDirectory(repo);
  const indexingMs = Date.now() - indexStart;

  // Persist so loadGraph can be used downstream / for repeat measurements.
  saveGraph({
    version: 2,
    repoId: repoIdFor(repo),
    rootPath: repo,
    indexedAt: new Date().toISOString(),
    filesIndexed: result.filesIndexed,
    symbolCount: result.symbols.length,
    edgeCount: result.edges.length,
    symbols: result.symbols,
    edges: result.edges,
    indexedSha: result.git.sha,
    indexedBranch: result.git.branch,
  });

  const loaded = loadGraph(repo);
  if (!loaded) {
    console.error('[scale-bench] failed to load freshly-written graph');
    return 1;
  }
  const idx = new GraphIndex(loaded);

  const graphJsonBytes = statSync(graphPath(repo)).size;
  const repoSourceBytes = totalSourceBytes(repo);

  console.log(
    `[scale-bench] indexed ${result.filesIndexed} files / ${result.symbols.length} symbols / ${result.edges.length} edges in ${fmtMs(indexingMs)}`,
  );
  console.log(`[scale-bench] sampling queries ...`);

  // ---- Query: recall ----
  const recallNames = sampleSymbols(idx, 20);
  const recallDur: number[] = [];
  const recallBytes: number[] = [];
  for (const name of recallNames) {
    const t0 = performance.now();
    const matches = idx.findByName(name, { limit: 50 });
    recallDur.push(performance.now() - t0);
    recallBytes.push(Buffer.byteLength(JSON.stringify(matches.map((s) => s.name)), 'utf8'));
  }

  // ---- Query: callers ----
  const hotNames = sampleHotSymbols(idx, 20);
  const callerDur: number[] = [];
  const callerBytes: number[] = [];
  for (const name of hotNames) {
    const target = idx.resolveSymbol(name);
    if (!target) continue;
    const t0 = performance.now();
    const edges = idx.callers(target.id);
    const names = new Set<string>();
    for (const e of edges) {
      const from = idx.findById(e.fromId);
      if (from) names.add(from.name);
    }
    callerDur.push(performance.now() - t0);
    callerBytes.push(Buffer.byteLength(JSON.stringify([...names]), 'utf8'));
  }

  // ---- Query: impact (depth=2) ----
  const impactDur: number[] = [];
  const impactBytes: number[] = [];
  for (const name of hotNames.slice(0, 10)) {
    const t0 = performance.now();
    const report = analyzeImpact(idx, name, { depth: 2 });
    impactDur.push(performance.now() - t0);
    if (report) {
      const out = {
        direct: report.directCallers.map((c) => c.symbol.name),
        transitive: report.transitiveCallers.map((c) => c.symbol.name),
      };
      impactBytes.push(Buffer.byteLength(JSON.stringify(out), 'utf8'));
    } else {
      impactBytes.push(0);
    }
  }

  // ---- Bytes-read comparison: 5 hot symbols, GraphPilot output vs grep file bytes ----
  console.log(`[scale-bench] running grep comparison on 5 hot symbols ...`);
  const samples: BytesSample[] = [];
  for (const name of hotNames.slice(0, 5)) {
    const target = idx.resolveSymbol(name);
    if (!target) continue;
    const edges = idx.callers(target.id);
    const callerNames = new Set<string>();
    for (const e of edges) {
      const from = idx.findById(e.fromId);
      if (from) callerNames.add(from.name);
    }
    const gpOut = JSON.stringify([...callerNames]);
    const gpBytes = Buffer.byteLength(gpOut, 'utf8');
    const grepBytes = grepBytesFor(repo, name);
    const reduction = grepBytes > 0 ? 1 - gpBytes / grepBytes : 0;
    samples.push({ symbol: name, graphpilotBytes: gpBytes, grepBytes, reduction });
  }
  const meanReduction =
    samples.length > 0 ? samples.reduce((s, x) => s + x.reduction, 0) / samples.length : 0;

  const report: ScaleReport = {
    meta: {
      corpus: repo,
      corpusName: basename(repo),
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
    },
    index: {
      filesIndexed: result.filesIndexed,
      filesFailed: result.filesFailed,
      symbolCount: result.symbols.length,
      edgeCount: result.edges.length,
      indexingMs,
      indexingFilesPerSec: indexingMs > 0 ? (result.filesIndexed * 1000) / indexingMs : 0,
      graphJsonBytes,
      repoSourceBytes,
      compressionRatio: repoSourceBytes > 0 ? graphJsonBytes / repoSourceBytes : 0,
    },
    queries: {
      recall: stats(recallDur, recallBytes),
      callers: stats(callerDur, callerBytes),
      impact: stats(impactDur, impactBytes),
    },
    bytesComparison: { samples, meanReduction },
  };

  // Write into bench/results/ alongside Tier-A runs.
  const resultsDir = join(process.cwd(), 'bench', 'results');
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const slug = basename(repo)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const ts = report.meta.timestamp.replace(/[:.]/g, '-');
  const jsonPath = outArg ?? join(resultsDir, `scale-${slug}-${ts}.json`);
  const mdPath = jsonPath.replace(/\.json$/, '.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(mdPath, summaryMarkdown(report), 'utf8');

  console.log('');
  console.log(summaryMarkdown(report));
  console.log('');
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('Scale benchmark failed:', err);
    process.exit(1);
  },
);
