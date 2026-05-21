/**
 * Minimal git utilities — pure fs reads of the .git directory.
 *
 * The ESLint policy in src/ bans `child_process` (T6 defence), so we
 * can't shell out to `git`. Instead we read the small handful of
 * .git/* files needed to answer:
 *
 *   - What is the current commit SHA?
 *   - What is the current branch name?
 *   - Where is the worktree root for an arbitrary path inside a repo?
 *   - Does this directory live inside a git repository at all?
 *
 * For anything heavier than this (diffs, tree walks), we use the
 * `isomorphic-git` library which is also pure-JS no-shell.
 *
 * Every function is best-effort: if the .git directory is missing or
 * its contents look unexpected, we return null rather than throw.
 * Indexing a non-git directory is a perfectly normal use case.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Walk up the directory tree starting from `somePath` looking for a
 * `.git` directory or file. Returns the directory that contains the
 * `.git` entry (the worktree root), or null if none found before we
 * hit the filesystem root.
 *
 * Note: `.git` can be either:
 *   - a directory (the main worktree)
 *   - a file containing `gitdir: <path>` (a linked worktree via
 *     `git worktree add`)
 * We treat both as "this is a worktree root".
 */
export function getWorktreeRoot(somePath: string): string | null {
  let cur = resolve(somePath);
  // Climb a max of 64 levels to avoid pathological loops on weird FSes
  for (let i = 0; i < 64; i++) {
    const gitEntry = join(cur, '.git');
    if (existsSync(gitEntry)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null; // hit FS root
    cur = parent;
  }
  return null;
}

/**
 * Resolve the .git directory for a worktree. For the main worktree
 * this is `<root>/.git`. For linked worktrees, .git is a file whose
 * content is `gitdir: <absolute-path-to-worktree-git-dir>`.
 *
 * Returns null if no usable .git is found.
 */
function getGitDir(worktreeRoot: string): string | null {
  const dotGit = join(worktreeRoot, '.git');
  if (!existsSync(dotGit)) return null;
  try {
    const s = statSync(dotGit);
    if (s.isDirectory()) return dotGit;
    if (s.isFile()) {
      const content = readFileSync(dotGit, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (!match) return null;
      const referenced = match[1].trim();
      // gitdir path may be absolute or relative to the worktree root
      const abs = referenced.startsWith(sep) ? referenced : resolve(worktreeRoot, referenced);
      return existsSync(abs) ? abs : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve a ref file's contents. `.git/HEAD` typically contains either:
 *   - `ref: refs/heads/<branch>\n` (a symbolic ref)
 *   - `<40-hex-sha>\n` (a detached HEAD)
 * We follow one indirection only (HEAD -> ref -> sha).
 */
function resolveRef(gitDir: string, refPath: string): string | null {
  try {
    const content = readFileSync(join(gitDir, refPath), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(content)) return content;
    const m = content.match(/^ref:\s*(.+)$/);
    if (m) return resolveRef(gitDir, m[1].trim());
    return null;
  } catch {
    // Maybe the ref is packed. Look in packed-refs.
    try {
      const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8');
      for (const line of packed.split('\n')) {
        // Lines look like: "<sha> <refname>"
        const m = line.match(/^([0-9a-f]{40})\s+(.+)$/);
        if (m && m[2] === refPath) return m[1];
      }
    } catch {
      /* no packed-refs */
    }
    return null;
  }
}

/**
 * Current commit SHA for the worktree containing `somePath`. Returns
 * the full 40-char SHA, or null if not in a git repo / HEAD unresolvable.
 */
export function getRepoSha(somePath: string): string | null {
  const root = getWorktreeRoot(somePath);
  if (!root) return null;
  const gitDir = getGitDir(root);
  if (!gitDir) return null;
  return resolveRef(gitDir, 'HEAD');
}

/**
 * Current branch name (e.g. "main") for the worktree containing
 * `somePath`. Returns null if HEAD is detached, the repo has no
 * commits yet, or it isn't a git repo at all.
 */
export function getRepoBranch(somePath: string): string | null {
  const root = getWorktreeRoot(somePath);
  if (!root) return null;
  const gitDir = getGitDir(root);
  if (!gitDir) return null;
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Short (7-char) SHA prefix — convenient for display. Falls back to
 * null if the long SHA isn't available.
 */
export function shortSha(somePath: string): string | null {
  const long = getRepoSha(somePath);
  return long ? long.slice(0, 7) : null;
}

/**
 * One-shot info object useful when stamping an index. Every field is
 * optional and may be null — graphpilot is happy to index a directory
 * that isn't a git repo.
 */
export interface GitInfo {
  worktreeRoot: string | null;
  sha: string | null;
  shortSha: string | null;
  branch: string | null;
}

export function readGitInfo(somePath: string): GitInfo {
  const worktreeRoot = getWorktreeRoot(somePath);
  if (!worktreeRoot) {
    return { worktreeRoot: null, sha: null, shortSha: null, branch: null };
  }
  const sha = getRepoSha(somePath);
  return {
    worktreeRoot,
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    branch: getRepoBranch(somePath),
  };
}
