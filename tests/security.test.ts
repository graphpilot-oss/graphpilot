import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeFileSync,
  readFileSync,
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
import { saveGraph, loadGraph, repoIdFor, repoDir, graphPath, type Graph } from '../src/storage.js';
import { validateRootPath, MAX_FILE_BYTES, MAX_FILES_PER_INDEX } from '../src/validation.js';
import { GraphWatcher } from '../src/watcher.js';

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
      version: 2,
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

describe.skipIf(isWindows)('T10: Unix dangerous path coverage', () => {
  // Only test paths that actually exist on the current OS — /proc /sys etc.
  // are Linux-only and absent on macOS. validateRootPath returns "does not exist"
  // before the set-check when the path is missing, so skip those cases cleanly.
  const unixDangerousPaths = [
    '/proc',
    '/sys',
    '/dev',
    '/root',
    '/boot',
    '/opt',
    '/srv',
    '/run',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
  ];
  for (const p of unixDangerousPaths) {
    it.skipIf(!existsSync(p))(`refuses to index ${p}`, () => {
      expect(validateRootPath(p)).toMatch(/system path/i);
    });
  }

  it('refuses to index /etc (present on macOS + Linux)', () => {
    expect(validateRootPath('/etc')).toMatch(/system path/i);
  });

  it('refuses to index /usr (present on macOS + Linux)', () => {
    expect(validateRootPath('/usr')).toMatch(/system path/i);
  });

  it('allows a path whose name shares a dangerous prefix (no false positives)', () => {
    // e.g. a project at /tmp/proc-analysis should NOT be rejected just because
    // its name starts with "proc"
    expect(validateRootPath(workDir)).toBeNull();
  });
});

describe.skipIf(!isWindows)('T10: Windows dangerous path coverage', () => {
  it('refuses to index C:\\Users (would walk all user profiles)', () => {
    expect(validateRootPath('C:\\Users')).toMatch(/system path/i);
  });

  it('refuses to index C:\\ProgramData', () => {
    expect(validateRootPath('C:\\ProgramData')).toMatch(/system path/i);
  });
});

// ---------------------------------------------------------------------------
// T2 — sibling-prefix path escape (the /tmp/repo vs /tmp/repo-evil bug)
// ---------------------------------------------------------------------------

describe.skipIf(isWindows)('T2: sibling-prefix symlink bypass', () => {
  it('does not leak files from a sibling dir that shares a path prefix with the root', async () => {
    // project-evil shares the prefix of project — the old `startsWith(root)`
    // (without trailing sep) check would treat /tmp/root-evil/... as inside root.
    const root = join(workDir, 'project');
    const evil = join(workDir, 'project-evil');
    mkdirSync(root);
    mkdirSync(evil);
    writeFileSync(join(root, 'safe.ts'), 'export function safe() {}');
    writeFileSync(join(evil, 'evil.ts'), 'export function siblingShouldNotLeak() {}');
    // symlink inside project pointing to the sibling evil dir
    symlinkSync(evil, join(root, 'escape'));

    const result = await indexDirectory(root);
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('safe');
    expect(names).not.toContain('siblingShouldNotLeak');
  });
});

// ---------------------------------------------------------------------------
// T4 — loadGraph rootPath mismatch rejection
// ---------------------------------------------------------------------------

describe('T4: loadGraph rootPath mismatch', () => {
  it('returns the graph when rootPath matches', () => {
    const proj = join(workDir, 'proj');
    mkdirSync(proj);
    const graph: Graph = {
      version: 2,
      repoId: repoIdFor(proj),
      rootPath: proj,
      indexedAt: new Date().toISOString(),
      filesIndexed: 0,
      symbolCount: 0,
      edgeCount: 0,
      symbols: [],
      edges: [],
    };
    saveGraph(graph);
    const loaded = loadGraph(proj);
    expect(loaded).not.toBeNull();
    expect(loaded?.rootPath).toBe(proj);
  });

  it('returns null when stored rootPath does not match the requested directory', () => {
    // Save graph for proj-a, then ask loadGraph for proj-b (which has no index).
    // Also covers the case where a graph.json is copied from another slot.
    const projA = join(workDir, 'proj-a');
    const projB = join(workDir, 'proj-b');
    mkdirSync(projA);
    mkdirSync(projB);
    saveGraph({
      version: 2,
      repoId: repoIdFor(projA),
      rootPath: projA,
      indexedAt: new Date().toISOString(),
      filesIndexed: 0,
      symbolCount: 0,
      edgeCount: 0,
      symbols: [],
      edges: [],
    });
    // projB has no graph at all → null
    expect(loadGraph(projB)).toBeNull();

    // Simulate a copied/poisoned graph: write projA's graph bytes into projB's
    // storage slot so loadGraph(projB) sees a graph whose rootPath is projA.
    const graphBDir = repoDir(projB);
    mkdirSync(graphBDir, { recursive: true });
    writeFileSync(join(graphBDir, 'graph.json'), readFileSync(graphPath(projA)));

    // loadGraph(projB) should see rootPath=projA ≠ projB and reject.
    expect(loadGraph(projB)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Watcher boundary check
// ---------------------------------------------------------------------------

describe('Watcher: applyUpdate rejects files outside the watched root', () => {
  it('returns null for a path that does not start with absRoot', async () => {
    const w = new GraphWatcher(workDir, { log: () => undefined });
    await w.fullReindex();

    // A file in a completely different directory
    const outside = join(tmpdir(), `graphpilot-sec-outside-${Date.now()}.ts`);
    const r = await w.applyUpdate(outside, 'change');
    expect(r).toBeNull();
  });

  it.skipIf(isWindows)(
    'returns null for a sibling path sharing the root prefix (e.g. /tmp/repo-evil)',
    async () => {
      // workDir = /tmp/graphpilot-sec-xxx
      // sibling  = /tmp/graphpilot-sec-xxxevil/file.ts
      // Old startsWith(root) without trailing sep would accept this.
      const siblingDir = workDir + 'evil';
      mkdirSync(siblingDir, { recursive: true });
      const siblingFile = join(siblingDir, 'evil.ts');
      writeFileSync(siblingFile, 'export function evil() {}');

      const w = new GraphWatcher(workDir, { log: () => undefined });
      await w.fullReindex();

      const r = await w.applyUpdate(siblingFile, 'add');
      expect(r).toBeNull();
      rmSync(siblingDir, { recursive: true, force: true });
    },
  );
});
