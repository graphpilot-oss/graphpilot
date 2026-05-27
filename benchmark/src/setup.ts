/**
 * setup.ts — clone fastify at pinned SHA, build + index with GraphPilot.
 */
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FASTIFY_DIR, FIXTURES_DIR, FASTIFY_SHA, BENCHMARK_DIR } from './config.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const GP_ROOT = join(__dir, '..', '..'); // graphpilot repo root

function run(cmd: string, cwd?: string): string {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

export async function setup(): Promise<void> {
  console.log('\n=== STEP 1: Clone fastify ===');
  if (existsSync(join(FASTIFY_DIR, 'package.json'))) {
    console.log(`  fastify already cloned at ${FASTIFY_DIR}`);
  } else {
    run(`mkdir -p ${FIXTURES_DIR}`);
    run(
      `git clone --depth 1 --branch ${FASTIFY_SHA} https://github.com/fastify/fastify.git ${FASTIFY_DIR}`,
    );
    console.log(`  Cloned fastify ${FASTIFY_SHA}`);
  }

  // Record the actual SHA
  let sha = FASTIFY_SHA;
  try {
    sha = run('git rev-parse HEAD', FASTIFY_DIR).trim();
  } catch {}
  const metaPath = join(BENCHMARK_DIR, 'fixtures', 'fastify.meta.json');
  writeFileSync(
    metaPath,
    JSON.stringify({ sha, tag: FASTIFY_SHA, clonedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`  SHA pinned: ${sha.slice(0, 12)}`);

  console.log('\n=== STEP 2: Build GraphPilot (local) ===');
  run('pnpm build', GP_ROOT);
  console.log('  Build complete');

  console.log('\n=== STEP 3: Index fastify with GraphPilot ===');
  const gpCli = join(GP_ROOT, 'dist', 'cli.js');
  run(`node ${gpCli} index ${FASTIFY_DIR}`);
  console.log('  Index complete');

  console.log('\n=== Setup done ===\n');
}

export function getFastifySha(): string {
  const metaPath = join(BENCHMARK_DIR, 'fixtures', 'fastify.meta.json');
  if (!existsSync(metaPath)) return FASTIFY_SHA;
  try {
    return (JSON.parse(readFileSync(metaPath, 'utf8')) as { sha: string }).sha.slice(0, 12);
  } catch {
    return FASTIFY_SHA;
  }
}
