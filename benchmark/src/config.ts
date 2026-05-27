import { config } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dir, '../.env') });

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
export const MODEL = process.env.BENCHMARK_MODEL ?? 'claude-sonnet-4-5';
export const FASTIFY_SHA = process.env.FASTIFY_SHA ?? 'v4.28.1';
export const MAX_TOOL_TURNS = Number(process.env.MAX_TOOL_TURNS ?? 15);

// Paths
export const BENCHMARK_DIR = join(__dir, '..');
export const FIXTURES_DIR = join(BENCHMARK_DIR, 'fixtures');
export const FASTIFY_DIR = join(FIXTURES_DIR, 'fastify');
export const TASKS_FILE = join(BENCHMARK_DIR, 'tasks', 'generated.json');
export const RESULTS_DIR = join(BENCHMARK_DIR, 'results');

export const SYSTEM_PROMPT = `You are a code analysis assistant helping developers understand the fastify web framework codebase.
Answer questions accurately and concisely using the available tools.
When asked about symbols, callers, or dependencies — use tools to find facts rather than guessing.
Stop once you have a confident answer; do not over-explore.`;

if (!ANTHROPIC_API_KEY) {
  console.error(
    'ERROR: ANTHROPIC_API_KEY not set. Copy benchmark/.env.example → benchmark/.env and fill it in.',
  );
  process.exit(1);
}
