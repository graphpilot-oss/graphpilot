/**
 * tools.ts — Anthropic tool definitions + handlers for baseline and GP modes.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
type Tool = Anthropic.Tool;
import { FASTIFY_DIR } from './config.js';
import { gpRecall, gpCallers, gpImpact } from './gp.js';

const MAX_FILE_BYTES = 256 * 1024; // 256 KB cap per file read

// ── Filesystem tools (both modes) ─────────────────────────────────────────────

const READ_FILE_DEF: Tool = {
  name: 'read_file',
  description: 'Read the contents of a source file in the fastify repo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the fastify repo root (e.g. lib/route.js)',
      },
    },
    required: ['path'],
  },
};

const LIST_DIR_DEF: Tool = {
  name: 'list_directory',
  description: 'List files and directories inside a path in the fastify repo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Directory path relative to fastify repo root. Use "." for root.',
      },
    },
    required: ['path'],
  },
};

// ── GP tools ──────────────────────────────────────────────────────────────────

const GP_RECALL_DEF: Tool = {
  name: 'gp_recall',
  description:
    'Search for symbols (functions, classes, variables) by name in the GraphPilot index. Fast — no file reads needed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Symbol name or substring to search for.' },
      limit: { type: 'number', description: 'Max results (default 20).' },
    },
    required: ['query'],
  },
};

const GP_CALLERS_DEF: Tool = {
  name: 'gp_callers',
  description:
    'Find all functions/methods that call a given symbol. Returns caller names and locations.',
  input_schema: {
    type: 'object' as const,
    properties: {
      symbol: { type: 'string', description: 'Symbol name to find callers of.' },
      limit: { type: 'number', description: 'Max results (default 30).' },
    },
    required: ['symbol'],
  },
};

const GP_IMPACT_DEF: Tool = {
  name: 'gp_impact',
  description:
    'Compute blast radius — all symbols affected if the given symbol changes. Returns callers at each depth.',
  input_schema: {
    type: 'object' as const,
    properties: {
      symbol: { type: 'string', description: 'Symbol name to analyze impact for.' },
      depth: { type: 'number', description: 'BFS depth (default 3).' },
    },
    required: ['symbol'],
  },
};

// ── Tool handlers ─────────────────────────────────────────────────────────────

function safeResolve(relPath: string): string {
  const abs = resolve(FASTIFY_DIR, relPath);
  if (!abs.startsWith(FASTIFY_DIR)) throw new Error(`Path outside fastify root: ${relPath}`);
  return abs;
}

export function executeReadFile(args: Record<string, unknown>): {
  content: string;
  bytesRead: number;
} {
  const relPath = String(args.path ?? '');
  const abs = safeResolve(relPath);
  if (!existsSync(abs)) return { content: `File not found: ${relPath}`, bytesRead: 0 };
  const stat = statSync(abs);
  if (stat.size > MAX_FILE_BYTES) {
    return {
      content: `File too large (${Math.round(stat.size / 1024)}KB > 256KB limit): ${relPath}`,
      bytesRead: 0,
    };
  }
  const content = readFileSync(abs, 'utf8');
  return { content, bytesRead: stat.size };
}

export function executeListDir(args: Record<string, unknown>): string {
  const relPath = String(args.path ?? '.');
  const abs = safeResolve(relPath);
  if (!existsSync(abs)) return `Directory not found: ${relPath}`;
  try {
    const entries = readdirSync(abs, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => `${e.isDirectory() ? '[dir] ' : '[file]'} ${join(relPath, e.name)}`)
      .join('\n');
  } catch (err) {
    return `Error reading directory: ${String(err)}`;
  }
}

export function executeTool(
  name: string,
  args: Record<string, unknown>,
): { text: string; bytesRead: number; isFileRead: boolean } {
  switch (name) {
    case 'read_file': {
      const { content, bytesRead } = executeReadFile(args);
      return { text: content, bytesRead, isFileRead: true };
    }
    case 'list_directory':
      return { text: executeListDir(args), bytesRead: 0, isFileRead: false };
    case 'gp_recall':
      return {
        text: gpRecall(String(args.query ?? ''), Number(args.limit ?? 20)),
        bytesRead: 0,
        isFileRead: false,
      };
    case 'gp_callers':
      return {
        text: gpCallers(String(args.symbol ?? ''), Number(args.limit ?? 30)),
        bytesRead: 0,
        isFileRead: false,
      };
    case 'gp_impact':
      return {
        text: gpImpact(String(args.symbol ?? ''), Number(args.depth ?? 3)),
        bytesRead: 0,
        isFileRead: false,
      };
    default:
      return { text: `Unknown tool: ${name}`, bytesRead: 0, isFileRead: false };
  }
}

export const BASELINE_TOOLS: Tool[] = [READ_FILE_DEF, LIST_DIR_DEF];
export const GP_TOOLS: Tool[] = [
  READ_FILE_DEF,
  LIST_DIR_DEF,
  GP_RECALL_DEF,
  GP_CALLERS_DEF,
  GP_IMPACT_DEF,
];
