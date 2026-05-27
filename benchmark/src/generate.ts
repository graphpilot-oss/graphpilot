/**
 * generate.ts — read fastify source, call Claude once to generate 40 benchmark
 * questions, then compute ground-truth answers via GP tools and extract keywords.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, MODEL, FASTIFY_DIR, TASKS_FILE } from './config.js';
import { gpRecall, gpCallers, gpImpact, gpStats, getIndex } from './gp.js';
import type { Task, TaskType } from './types.js';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const SOURCE_EXTS = new Set(['.js', '.ts', '.mjs', '.cjs']);
const MAX_FILE_PREVIEW = 6000; // chars per file for question generation prompt
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'test',
  'test-helper',
  'examples',
  'docs',
  'types',
  'benchmarks',
]);

// ── Step 1: Gather key source files ──────────────────────────────────────────

function collectSourceFiles(dir: string, maxFiles = 30): string[] {
  const results: string[] = [];

  function walk(d: string, depth: number): void {
    if (depth > 3) return;
    const entries = readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (SOURCE_EXTS.has(extname(e.name).toLowerCase())) {
        results.push(full);
        if (results.length >= maxFiles) return;
      }
    }
  }

  walk(dir, 0);
  return results;
}

function buildContextSnapshot(): string {
  const files = collectSourceFiles(FASTIFY_DIR, 30);
  const parts: string[] = [];

  for (const f of files) {
    const rel = f.replace(FASTIFY_DIR + '/', '');
    try {
      const content = readFileSync(f, 'utf8').slice(0, MAX_FILE_PREVIEW);
      parts.push(`\n### FILE: ${rel}\n\`\`\`\n${content}\n\`\`\``);
    } catch {}
  }

  return parts.join('\n');
}

// ── Step 2: Call Claude to generate 40 questions ──────────────────────────────

interface RawQuestion {
  id: string;
  type: TaskType;
  question: string;
  hints: string[]; // symbol/file names we expect in a good answer
}

async function generateRawQuestions(contextSnapshot: string): Promise<RawQuestion[]> {
  console.log('  Calling Claude to generate 40 questions...');

  const prompt = `You are creating a benchmark test suite for GraphPilot — a code-graph tool for coding agents.

Below is the source code of the fastify web framework. Read it carefully and generate exactly 40 diverse questions that a developer or coding agent might ask about this codebase.

DISTRIBUTION (must match exactly):
- 10 questions of type "navigation"   — "Where is X defined?", "What file contains Y?", "What does function Z do?"
- 10 questions of type "callers"       — "What functions call X?", "Who uses Y?", "What calls Z?"
- 8  questions of type "impact"        — "What breaks if I change X?", "What depends on Y?"
- 7  questions of type "trace"         — "Trace how A reaches B", "What is the call chain from X to Y?"
- 5  questions of type "dependency"    — "Does module A use module B?", "Is X imported by Y?"

RULES:
- Questions must be about REAL symbols/files visible in the code below
- Each question must have 2–5 "hints": the exact symbol names, file names, or keywords that a CORRECT answer must contain
- Questions should be specific and answerable from the codebase
- Vary difficulty: mix simple lookups with complex cross-file traces
- Do NOT repeat the same symbol in multiple questions

Return ONLY valid JSON. No markdown, no explanation. Schema:
[
  {
    "id": "T01",
    "type": "navigation",
    "question": "...",
    "hints": ["symbolName", "fileName"]
  },
  ...
]

---FASTIFY SOURCE---
${contextSnapshot}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Extract JSON array from response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Claude did not return a JSON array');

  const raw = JSON.parse(jsonMatch[0]) as RawQuestion[];
  console.log(`  Generated ${raw.length} raw questions`);
  return raw;
}

// ── Step 3: Compute ground-truth answers via GP + extract keywords ─────────────

function computeGroundTruth(q: RawQuestion): { groundTruth: string; expectedKeywords: string[] } {
  let groundTruth = '';

  switch (q.type) {
    case 'navigation': {
      // For each hint, try to recall it
      const parts: string[] = [];
      for (const hint of q.hints) {
        const r = gpRecall(hint, 5);
        if (!r.includes('No symbols')) parts.push(r);
      }
      groundTruth = parts.join('\n') || `Symbols: ${q.hints.join(', ')}`;
      break;
    }
    case 'callers': {
      const symbol = q.hints[0] ?? '';
      groundTruth = gpCallers(symbol, 20);
      break;
    }
    case 'impact': {
      const symbol = q.hints[0] ?? '';
      groundTruth = gpImpact(symbol, 3);
      break;
    }
    case 'trace':
    case 'dependency': {
      const parts: string[] = [];
      for (const hint of q.hints.slice(0, 3)) {
        const r = gpRecall(hint, 3);
        if (!r.includes('No symbols')) parts.push(r);
      }
      groundTruth = parts.join('\n') || `Related symbols: ${q.hints.join(', ')}`;
      break;
    }
  }

  // Keywords = hints + any symbol names that appear in the ground truth
  const additionalKeywords = (groundTruth.match(/`([^`]+)`/g) ?? [])
    .map((m) => m.replace(/`/g, ''))
    .slice(0, 5);

  const expectedKeywords = Array.from(new Set([...q.hints, ...additionalKeywords])).slice(0, 8);

  return { groundTruth, expectedKeywords };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateTasks(): Promise<Task[]> {
  console.log('\n=== STEP: Generate benchmark tasks ===');

  if (!existsSync(FASTIFY_DIR)) {
    throw new Error(`fastify not cloned yet. Run \`pnpm setup\` first.`);
  }

  // Ensure index is loaded (warm up GP)
  console.log('  Loading GraphPilot index...');
  const idx = getIndex();
  console.log(`  Index loaded: ${idx.graph.symbolCount} symbols, ${idx.graph.edgeCount} edges`);

  console.log('  Reading fastify source files...');
  const contextSnapshot = buildContextSnapshot();
  console.log(`  Context snapshot: ${Math.round(contextSnapshot.length / 1024)}KB`);

  const rawQuestions = await generateRawQuestions(contextSnapshot);

  console.log('  Computing ground-truth answers via GP...');
  const tasks: Task[] = rawQuestions.map((q, i) => {
    const { groundTruth, expectedKeywords } = computeGroundTruth(q);
    return {
      id: q.id ?? `T${String(i + 1).padStart(2, '0')}`,
      type: q.type,
      question: q.question,
      expectedKeywords,
      groundTruth,
    };
  });

  // Ensure tasks dir exists
  const tasksDir = dirname(TASKS_FILE);
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });

  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
  console.log(`  Saved ${tasks.length} tasks → ${TASKS_FILE}`);

  return tasks;
}

export function loadTasks(): Task[] {
  if (!existsSync(TASKS_FILE)) {
    throw new Error(`Tasks file not found: ${TASKS_FILE}\nRun \`pnpm generate\` first.`);
  }
  return JSON.parse(readFileSync(TASKS_FILE, 'utf8')) as Task[];
}
