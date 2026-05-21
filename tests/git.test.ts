import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorktreeRoot, getRepoSha, getRepoBranch, shortSha, readGitInfo } from '../src/git.js';

/**
 * Tests for the minimal git helpers. We build fake .git/ trees by
 * hand rather than running real `git init` because (a) we can't shell
 * out from src/ (T6 ban) and (b) the tests should run identically
 * with or without `git` on the PATH.
 *
 * The bytes we write match real git internals exactly:
 *   .git/HEAD         => "ref: refs/heads/<branch>\n" OR a 40-hex SHA
 *   .git/refs/heads/<branch> => 40-hex SHA
 *   .git/packed-refs  => "<sha> <refname>" per line
 */

let workDir: string;
const FAKE_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const FAKE_SHA_2 = 'fedcba9876543210fedcba9876543210fedcba98';

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'graphpilot-git-'));
});

afterEach(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function makeFakeGit(
  worktreeRoot: string,
  opts: {
    head?: string; // contents of .git/HEAD
    refs?: Record<string, string>; // refname (e.g. "refs/heads/main") -> sha
    packedRefs?: string; // raw contents of packed-refs file
    asFile?: { gitdir: string }; // simulate linked worktree: .git is a file
  } = {},
): void {
  if (opts.asFile) {
    writeFileSync(join(worktreeRoot, '.git'), `gitdir: ${opts.asFile.gitdir}\n`);
    return;
  }
  const gitDir = join(worktreeRoot, '.git');
  mkdirSync(gitDir, { recursive: true });
  if (opts.head !== undefined) {
    writeFileSync(join(gitDir, 'HEAD'), opts.head);
  }
  if (opts.refs) {
    for (const [refname, sha] of Object.entries(opts.refs)) {
      const refPath = join(gitDir, refname);
      mkdirSync(join(refPath, '..'), { recursive: true });
      writeFileSync(refPath, sha + '\n');
    }
  }
  if (opts.packedRefs !== undefined) {
    writeFileSync(join(gitDir, 'packed-refs'), opts.packedRefs);
  }
}

// ---------------------------------------------------------------------------
// getWorktreeRoot
// ---------------------------------------------------------------------------

describe('getWorktreeRoot', () => {
  it('returns null outside any git repo', () => {
    expect(getWorktreeRoot(workDir)).toBeNull();
  });

  it('finds the repo when .git is a directory', () => {
    makeFakeGit(workDir);
    expect(getWorktreeRoot(workDir)).toBe(workDir);
  });

  it('finds the repo when .git is a file (linked worktree)', () => {
    makeFakeGit(workDir, { asFile: { gitdir: '/some/path/.git/worktrees/feat' } });
    expect(getWorktreeRoot(workDir)).toBe(workDir);
  });

  it('walks up from a subdirectory', () => {
    makeFakeGit(workDir, { head: 'ref: refs/heads/main\n' });
    const sub = join(workDir, 'src', 'deep', 'nested');
    mkdirSync(sub, { recursive: true });
    expect(getWorktreeRoot(sub)).toBe(workDir);
  });
});

// ---------------------------------------------------------------------------
// getRepoSha
// ---------------------------------------------------------------------------

describe('getRepoSha', () => {
  it('returns null outside any git repo', () => {
    expect(getRepoSha(workDir)).toBeNull();
  });

  it('resolves HEAD -> ref -> sha (loose ref)', () => {
    makeFakeGit(workDir, {
      head: 'ref: refs/heads/main\n',
      refs: { 'refs/heads/main': FAKE_SHA },
    });
    expect(getRepoSha(workDir)).toBe(FAKE_SHA);
  });

  it('returns the SHA directly when HEAD is detached', () => {
    makeFakeGit(workDir, { head: FAKE_SHA + '\n' });
    expect(getRepoSha(workDir)).toBe(FAKE_SHA);
  });

  it('falls back to packed-refs when the loose ref is absent', () => {
    makeFakeGit(workDir, {
      head: 'ref: refs/heads/feature\n',
      packedRefs:
        '# pack-refs with: peeled fully-peeled sorted\n' +
        `${FAKE_SHA_2} refs/heads/feature\n` +
        `${FAKE_SHA} refs/heads/main\n`,
    });
    expect(getRepoSha(workDir)).toBe(FAKE_SHA_2);
  });

  it('returns null when HEAD points at a missing ref and no packed-refs', () => {
    makeFakeGit(workDir, { head: 'ref: refs/heads/ghost\n' });
    expect(getRepoSha(workDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRepoBranch
// ---------------------------------------------------------------------------

describe('getRepoBranch', () => {
  it('returns null outside any git repo', () => {
    expect(getRepoBranch(workDir)).toBeNull();
  });

  it('parses the branch out of HEAD', () => {
    makeFakeGit(workDir, { head: 'ref: refs/heads/develop\n' });
    expect(getRepoBranch(workDir)).toBe('develop');
  });

  it('returns null for a detached HEAD', () => {
    makeFakeGit(workDir, { head: FAKE_SHA + '\n' });
    expect(getRepoBranch(workDir)).toBeNull();
  });

  it('handles branch names with slashes', () => {
    makeFakeGit(workDir, { head: 'ref: refs/heads/feat/pivot/evidence\n' });
    expect(getRepoBranch(workDir)).toBe('feat/pivot/evidence');
  });
});

// ---------------------------------------------------------------------------
// shortSha + readGitInfo
// ---------------------------------------------------------------------------

describe('shortSha', () => {
  it('returns the first 7 chars of the SHA', () => {
    makeFakeGit(workDir, {
      head: 'ref: refs/heads/main\n',
      refs: { 'refs/heads/main': FAKE_SHA },
    });
    expect(shortSha(workDir)).toBe(FAKE_SHA.slice(0, 7));
  });

  it('returns null outside a repo', () => {
    expect(shortSha(workDir)).toBeNull();
  });
});

describe('readGitInfo', () => {
  it('returns all-null when not in a git repo', () => {
    expect(readGitInfo(workDir)).toEqual({
      worktreeRoot: null,
      sha: null,
      shortSha: null,
      branch: null,
    });
  });

  it('returns a populated record when in a git repo', () => {
    makeFakeGit(workDir, {
      head: 'ref: refs/heads/main\n',
      refs: { 'refs/heads/main': FAKE_SHA },
    });
    const info = readGitInfo(workDir);
    expect(info.worktreeRoot).toBe(workDir);
    expect(info.sha).toBe(FAKE_SHA);
    expect(info.shortSha).toBe(FAKE_SHA.slice(0, 7));
    expect(info.branch).toBe('main');
  });
});
