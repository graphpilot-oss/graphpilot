import fg from 'fast-glob';
import { resolve, relative } from 'node:path';
import { parseFile } from './parser.js';
import { extractSymbols, type SymbolRecord } from './symbols.js';

export interface IndexResult {
  rootPath: string;
  filesIndexed: number;
  filesFailed: number;
  symbols: SymbolRecord[];
  durationMs: number;
}

export interface IndexOptions {
  /** Override the default include patterns. */
  include?: string[];
  /** Extra ignore patterns appended to the defaults. */
  ignore?: string[];
  /** Store file paths relative to rootPath in symbols. Default: true. */
  relativePaths?: boolean;
}

const DEFAULT_INCLUDE = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.mjs',
  '**/*.cjs',
];

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/out/**',
  '**/*.d.ts',
];

export async function indexDirectory(
  rootPath: string,
  opts: IndexOptions = {},
): Promise<IndexResult> {
  const start = Date.now();
  const absRoot = resolve(rootPath);
  const include = opts.include ?? DEFAULT_INCLUDE;
  const ignore = [...DEFAULT_IGNORE, ...(opts.ignore ?? [])];
  const useRelative = opts.relativePaths ?? true;

  const files = await fg(include, {
    cwd: absRoot,
    ignore,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
  });

  const symbols: SymbolRecord[] = [];
  let filesIndexed = 0;
  let filesFailed = 0;

  for (const file of files) {
    try {
      const parsed = parseFile(file);
      if (!parsed) continue;
      const fileSymbols = extractSymbols(parsed);
      if (useRelative) {
        const rel = relative(absRoot, file);
        for (const s of fileSymbols) {
          s.file = rel;
          // Rewrite id with relative path to keep ids portable.
          s.id = s.id.replace(file, rel);
        }
      }
      symbols.push(...fileSymbols);
      filesIndexed++;
    } catch {
      filesFailed++;
    }
  }

  return {
    rootPath: absRoot,
    filesIndexed,
    filesFailed,
    symbols,
    durationMs: Date.now() - start,
  };
}
