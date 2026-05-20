/**
 * Grep-style baseline. Simulates what an agent without structural memory
 * would do: scan every source file for the query as a literal substring,
 * return the matching files / function names.
 *
 * This UNDERSTATES the real baseline cost because:
 *   - A real agent reads context around each grep hit (we count just
 *     the matching files' raw bytes)
 *   - A real agent often grep+read multiple times before answering
 *
 * Even with that bias toward grep, GraphPilot should still win the
 * structural tasks by a large margin on `outputBytes` (proxy for tokens
 * the agent would have to read).
 */

import fg from 'fast-glob';
import { readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { Task } from './tasks.js';

export interface RunResult {
  returned: string[];
  /** Total bytes the agent would have to read to answer this question via grep. */
  outputBytes: number;
  durationMs: number;
}

const SOURCE_GLOB = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];
const IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/*.d.ts',
];

/** Cache: filePath -> bytes + lines. Avoids re-reading on every task. */
interface FileCache {
  path: string;
  rel: string;
  bytes: number;
  lines: string[];
}

export class BaselineRunner {
  readonly absRoot: string;
  private readonly files: FileCache[];

  constructor(repoRoot: string) {
    this.absRoot = resolve(repoRoot);
    const filePaths = fg.sync(SOURCE_GLOB, {
      cwd: this.absRoot,
      absolute: true,
      ignore: IGNORE,
      onlyFiles: true,
    });
    this.files = filePaths.map((p) => {
      const text = readFileSync(p, 'utf8');
      return {
        path: p,
        rel: relative(this.absRoot, p),
        bytes: statSync(p).size,
        lines: text.split('\n'),
      };
    });
  }

  /**
   * Scan all source files for `query` as a literal substring. Returns
   * (a) the set of matching files (for string-literal/tests-affected
   * tasks) and (b) function-like identifier names that appear adjacent
   * to `function`/`class`/`interface`/`const` keywords (a rough proxy
   * for "what an agent would conclude").
   */
  private grepScan(query: string): {
    matchedFiles: Set<string>;
    bytesRead: number;
    suspectedNames: Set<string>;
  } {
    const matchedFiles = new Set<string>();
    const suspectedNames = new Set<string>();
    let bytesRead = 0;

    for (const f of this.files) {
      let hitInFile = false;
      for (const line of f.lines) {
        if (!line.includes(query)) continue;
        hitInFile = true;
        // Heuristic: pull a likely caller name out of "function X(", "method X(",
        // "const X =", "X(" near the beginning, etc. Rough but it's what a
        // human-style grep+eyeball would produce.
        const fnMatch =
          line.match(/(?:function|class|interface)\s+([A-Za-z_$][\w$]*)/) ||
          line.match(/\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function|\()/);
        if (fnMatch) suspectedNames.add(fnMatch[1]);
      }
      if (hitInFile) {
        matchedFiles.add(f.rel);
        bytesRead += f.bytes;
      }
    }

    return { matchedFiles, bytesRead, suspectedNames };
  }

  run(task: Task): RunResult {
    const start = Date.now();
    let returned: string[] = [];
    let bytesRead = 0;

    switch (task.kind) {
      case 'callers':
      case 'impact':
      case 'recall':
      case 'recall-substring':
      case 'recall-miss': {
        // Grep for the query string, then collect identifier names near
        // each match. Best-effort approximation of what an agent would
        // do without structural memory.
        const { bytesRead: br, suspectedNames } = this.grepScan(task.query);
        bytesRead = br;
        // Exclude the query itself if it appears as a suspected name
        // (the function declaration line will have the query as its own
        // name; that's not a caller).
        suspectedNames.delete(task.query);
        returned = [...suspectedNames].sort();
        break;
      }

      case 'kind-filter': {
        // The query is a TypeScript keyword like "interface". Grep for
        // "interface " (with trailing space) to filter declarations from
        // string literals, then extract the next identifier.
        const re = new RegExp(`\\b${task.query}\\s+([A-Za-z_$][\\w$]*)`, 'g');
        const names = new Set<string>();
        for (const f of this.files) {
          if (!f.rel.startsWith('src/')) continue;
          const text = f.lines.join('\n');
          let m: RegExpExecArray | null;
          let matched = false;
          while ((m = re.exec(text)) !== null) {
            names.add(m[1]);
            matched = true;
          }
          if (matched) bytesRead += f.bytes;
        }
        returned = [...names].sort();
        break;
      }

      case 'tests-affected': {
        // Without structural memory, you'd grep for the symbol and look
        // at which *.test.ts files contain it.
        const { bytesRead: br, matchedFiles } = this.grepScan(task.query);
        bytesRead = br;
        returned = [...matchedFiles].filter((f) => /\.(test|spec)\.[jt]sx?$/.test(f)).sort();
        break;
      }

      case 'string-literal': {
        // GREP-NATIVE: just return matching files
        const { bytesRead: br, matchedFiles } = this.grepScan(task.query);
        bytesRead = br;
        returned = [...matchedFiles].sort();
        break;
      }
    }

    return {
      returned,
      outputBytes: bytesRead, // baseline cost = bytes the agent would read
      durationMs: Date.now() - start,
    };
  }
}
