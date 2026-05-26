import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  rootUriToFilesystemPath,
  isPathUnder,
  resolveRepoPath,
  setMcpClientRoots,
  listIndexedRepos,
} from '../src/repo-resolve.js';
import { indexDirectory } from '../src/indexer.js';
import { saveGraph, repoIdFor } from '../src/storage.js';

describe('rootUriToFilesystemPath', () => {
  it('converts file:// URIs on Windows and POSIX', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gp-uri-'));
    try {
      const uri = pathToFileURL(dir).href;
      expect(rootUriToFilesystemPath(uri)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for non-file schemes', () => {
    expect(rootUriToFilesystemPath('https://example.com/')).toBeNull();
  });
});

describe('isPathUnder', () => {
  it('detects subdirectory relationships case-insensitively on Windows', () => {
    const root = 'C:\\Projects\\app';
    expect(isPathUnder('C:\\Projects\\app\\src\\x.ts', root)).toBe(true);
    expect(isPathUnder('C:\\Projects\\other', root)).toBe(false);
  });
});

describe('resolveRepoPath', () => {
  let workDir: string;
  const prevEnv = process.env.GRAPHPILOT_ROOT;
  const prevCwd = process.cwd();

  beforeEach(async () => {
    // realpath() canonicalises the macOS /var → /private/var symlink so that
    // saved-graph repoIds match what process.cwd() returns after chdir.
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'gp-resolve-')));
    writeFileSync(join(workDir, 'lib.ts'), 'export function seeded() {}\n');
    const result = await indexDirectory(workDir);
    saveGraph({
      version: 1,
      repoId: repoIdFor(workDir),
      rootPath: workDir,
      indexedAt: new Date().toISOString(),
      filesIndexed: result.filesIndexed,
      symbolCount: result.symbols.length,
      edgeCount: result.edges.length,
      symbols: result.symbols,
      edges: result.edges,
    });
    setMcpClientRoots([]);
    delete process.env.GRAPHPILOT_ROOT;
  });

  afterEach(() => {
    process.chdir(prevCwd);
    setMcpClientRoots([]);
    if (prevEnv !== undefined) process.env.GRAPHPILOT_ROOT = prevEnv;
    else delete process.env.GRAPHPILOT_ROOT;
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('honours an explicit path argument', () => {
    expect(resolveRepoPath(workDir)).toBe(workDir);
  });

  it('uses GRAPHPILOT_ROOT when path is omitted', () => {
    process.env.GRAPHPILOT_ROOT = workDir;
    process.chdir(tmpdir());
    expect(resolveRepoPath()).toBe(workDir);
  });

  it('uses MCP client roots when they point at an indexed repo', () => {
    process.chdir(tmpdir());
    setMcpClientRoots([workDir]);
    expect(resolveRepoPath()).toBe(workDir);
  });

  it('walks up from cwd to find an index', () => {
    const sub = join(workDir, 'pkg', 'src');
    mkdirSync(sub, { recursive: true });
    process.chdir(sub);
    expect(resolveRepoPath()).toBe(workDir);
  });
});

describe('listIndexedRepos', () => {
  it('includes repos saved under ~/.graphpilot', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'gp-list-'));
    try {
      writeFileSync(join(workDir, 'a.ts'), 'export function listed() {}\n');
      const result = await indexDirectory(workDir);
      saveGraph({
        version: 1,
        repoId: repoIdFor(workDir),
        rootPath: workDir,
        indexedAt: new Date().toISOString(),
        filesIndexed: result.filesIndexed,
        symbolCount: result.symbols.length,
        edgeCount: result.edges.length,
        symbols: result.symbols,
        edges: result.edges,
      });
      const all = listIndexedRepos();
      expect(all.some((r) => r.rootPath === workDir)).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
