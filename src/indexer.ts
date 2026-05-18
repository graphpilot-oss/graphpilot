import fg from 'fast-glob';
import { realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { parseFile } from './parser.js';
import { extractSymbols, type SymbolRecord } from './symbols.js';
import { extractRawCalls, resolveCallEdges, type CallEdge, type RawCall } from './edges.js';
import { MAX_FILES_PER_INDEX } from './validation.js';

export interface IndexResult {
  rootPath: string;
  filesIndexed: number;
  filesFailed: number;
  symbols: SymbolRecord[];
  edges: CallEdge[];
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

  // Resolve symlinks at the root so the boundary check below is correct.
  // Defence against T2 (symlink escape): we'll verify every file's realpath
  // stays within this resolved root.
  const realRoot = realpathSync(absRoot);

  const files = await fg(include, {
    cwd: absRoot,
    ignore,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
    // T2 defence #1: don't even descend into symlinked directories.
    followSymbolicLinks: false,
  });

  // T10 defence: hard cap on files indexed per run. Throws so the CLI prints
  // a clear error instead of silently chewing through a million-file tree.
  if (files.length > MAX_FILES_PER_INDEX) {
    throw new Error(
      `Refusing to index ${files.length} files (limit: ${MAX_FILES_PER_INDEX}). ` +
        `Narrow the path or add patterns to ignore.`,
    );
  }

  const symbols: SymbolRecord[] = [];
  const rawCalls: RawCall[] = [];
  let filesIndexed = 0;
  let filesFailed = 0;
  let filesSkippedSymlink = 0;

  for (const file of files) {
    try {
      // T2 defence #2: belt-and-suspenders — even if a symlink slipped through,
      // verify the file's real path lives under the real root.
      let realFile: string;
      try {
        realFile = realpathSync(file);
      } catch {
        filesFailed++;
        continue;
      }
      if (!realFile.startsWith(realRoot)) {
        filesSkippedSymlink++;
        continue;
      }

      const parsed = parseFile(file);
      if (!parsed) continue;
      const fileSymbols = extractSymbols(parsed);
      const fileCalls = extractRawCalls(parsed, fileSymbols);

      if (useRelative) {
        const rel = relative(absRoot, file);
        // Track id rewrites so call edges can be remapped in lockstep.
        const idRewrites = new Map<string, string>();
        for (const s of fileSymbols) {
          const oldId = s.id;
          s.file = rel;
          s.id = oldId.replace(file, rel);
          idRewrites.set(oldId, s.id);
        }
        for (const c of fileCalls) {
          c.file = rel;
          c.fromId = idRewrites.get(c.fromId) ?? c.fromId;
        }
      }

      symbols.push(...fileSymbols);
      rawCalls.push(...fileCalls);
      filesIndexed++;
    } catch {
      filesFailed++;
    }
  }

  // Second pass: resolve names to symbol ids now that we've seen every file.
  const edges = resolveCallEdges(rawCalls, symbols);

  return {
    rootPath: absRoot,
    filesIndexed,
    filesFailed: filesFailed + filesSkippedSymlink,
    symbols,
    edges,
    durationMs: Date.now() - start,
  };
}
