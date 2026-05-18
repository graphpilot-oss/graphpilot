import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parseFile } from '../src/parser.js';
import { indexDirectory } from '../src/indexer.js';
import { saveGraph, type Graph } from '../src/storage.js';
import { validateRootPath, MAX_FILE_BYTES, MAX_FILES_PER_INDEX } from '../src/validation.js';

const isWindows = process.platform === 'win32';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'graphpilot-sec-'));
});

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T1 — file size cap
// ---------------------------------------------------------------------------

describe('T1: file size cap', () => {
  it('skips files larger than MAX_FILE_BYTES', () => {
    const bigFile = join(workDir, 'huge.ts');
    // Write MAX_FILE_BYTES + 1KB of harmless TypeScript.
    const oversize = 'export const x = 1;\n'.repeat(Math.ceil(MAX_FILE_BYTES / 20)) + '\n';
    writeFileSync(bigFile, oversize);
    expect(statSync(bigFile).size).toBeGreaterThan(MAX_FILE_BYTES);

    const result = parseFile(bigFile);
    expect(result).toBeNull();
  });

  it('parses files just under MAX_FILE_BYTES', () => {
    const smallFile = join(workDir, 'small.ts');
    writeFileSync(smallFile, 'export function ok() { return 1; }');
    const result = parseFile(smallFile);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T2 — symlink escape
// ---------------------------------------------------------------------------

describe.skipIf(isWindows)('T2: symlink escape protection', () => {
  it('does not follow a symlink that escapes the indexed root', async () => {
    // Layout:
    //   workDir/
    //     project/
    //       good.ts            <- legit file inside the project
    //     outside/
    //       secret.ts          <- a file the attacker wants to leak
    //     project/escape -> ../outside  <- malicious symlink inside project
    const project = join(workDir, 'project');
    const outside = join(workDir, 'outside');
    mkdirSync(project);
    mkdirSync(outside);
    writeFileSync(join(project, 'good.ts'), 'export function good() {}');
    writeFileSync(join(outside, 'secret.ts'), 'export function leakedSecret() {}');
    symlinkSync(outside, join(project, 'escape'));

    const result = await indexDirectory(project);

    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('good');
    expect(names).not.toContain('leakedSecret');
  });
});

// ---------------------------------------------------------------------------
// T7 — index file permissions
// ---------------------------------------------------------------------------

describe.skipIf(isWindows)('T7: restrictive permissions on saved graph', () => {
  it('writes graph.json with mode 0600 and parent dir 0700', () => {
    const fakeRoot = join(workDir, 'pretend-repo');
    mkdirSync(fakeRoot);
    const graph: Graph = {
      version: 1,
      repoId: 'testrepo000000',
      rootPath: fakeRoot,
      indexedAt: new Date().toISOString(),
      filesIndexed: 0,
      symbolCount: 0,
      symbols: [],
    };
    const savedPath = saveGraph(graph);
    expect(existsSync(savedPath)).toBe(true);

    const fileMode = statSync(savedPath).mode & 0o777;
    expect(fileMode).toBe(0o600);

    const dirMode = statSync(savedPath.replace(/\/graph\.json$/, '')).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------
// T10 — refuse dangerous paths + max-files cap
// ---------------------------------------------------------------------------

describe('T10: dangerous path rejection', () => {
  it('refuses to index / (root)', () => {
    expect(validateRootPath('/')).toMatch(/system path/i);
  });

  it.skipIf(isWindows)('refuses to index /etc', () => {
    expect(validateRootPath('/etc')).toMatch(/system path/i);
  });

  it('refuses to index the home directory directly', () => {
    expect(validateRootPath(homedir())).toMatch(/home directory/i);
  });

  it('allows a normal project path', () => {
    expect(validateRootPath(workDir)).toBeNull();
  });

  it('returns an error for a path that does not exist', () => {
    expect(validateRootPath(join(workDir, 'definitely-not-here'))).toMatch(
      /does not exist|not accessible/i,
    );
  });
});

describe('T10: max-files cap is set sanely', () => {
  it('MAX_FILES_PER_INDEX is a reasonable ceiling', () => {
    expect(MAX_FILES_PER_INDEX).toBeGreaterThanOrEqual(10_000);
    expect(MAX_FILES_PER_INDEX).toBeLessThanOrEqual(1_000_000);
  });
});
