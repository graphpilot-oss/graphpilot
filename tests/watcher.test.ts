import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { GraphWatcher } from '../src/watcher.js';
import { repoDir, loadGraph } from '../src/storage.js';

/**
 * Tests drive applyUpdate / applyDeletion directly. We do NOT spin chokidar
 * up in tests — it's timing-dependent and racy on CI. The chokidar wiring is
 * exercised manually with `graphpilot watch <path>` and observed in dev.
 */

let workDir: string;

function silentLog(): (s: string) => void {
  return () => undefined;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'graphpilot-watch-'));
});

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  // Clean the index dir this workDir would have produced
  const dir = repoDir(workDir);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe('GraphWatcher — initial state', () => {
  it('starts with empty graph when no index exists yet', () => {
    const w = new GraphWatcher(workDir, { log: silentLog() });
    expect(w.currentGraph.symbols.length).toBe(0);
    expect(w.currentGraph.edges.length).toBe(0);
    expect(w.currentGraph.rootPath).toBe(workDir);
  });

  it('loads existing graph from disk if present', async () => {
    writeFileSync(join(workDir, 'hello.ts'), 'export function hello() { return 1; }\n');
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();
    expect(w.currentGraph.symbols.length).toBeGreaterThan(0);

    // New watcher should pick the existing graph from disk.
    const w2 = new GraphWatcher(workDir, { log: silentLog() });
    expect(w2.currentGraph.symbols.length).toBe(w.currentGraph.symbols.length);
  });

  it('refuses to construct on a dangerous root path', () => {
    expect(() => new GraphWatcher(homedir(), { log: silentLog() })).toThrow(
      /home directory|system path/i,
    );
    expect(() => new GraphWatcher('/', { log: silentLog() })).toThrow(/system path/i);
  });
});

describe('GraphWatcher — applyUpdate (single-file change)', () => {
  it('adds symbols when a previously-unseen file appears', async () => {
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex(); // empty graph

    const newFile = join(workDir, 'new.ts');
    writeFileSync(newFile, 'export function appeared() { return 42; }\n');
    const r = await w.applyUpdate(newFile, 'add');

    expect(r).not.toBeNull();
    expect(r!.symbolsAfter).toBeGreaterThan(r!.symbolsBefore);
    const names = w.currentGraph.symbols.map((s) => s.name);
    expect(names).toContain('appeared');
  });

  it("replaces a file's symbols when it changes (rename function)", async () => {
    const file = join(workDir, 'a.ts');
    writeFileSync(file, 'export function oldName() { return 1; }\n');
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();
    expect(w.currentGraph.symbols.some((s) => s.name === 'oldName')).toBe(true);

    // Rewrite the file with a different function name
    writeFileSync(file, 'export function newName() { return 2; }\n');
    await w.applyUpdate(file, 'change');

    const names = w.currentGraph.symbols.map((s) => s.name);
    expect(names).toContain('newName');
    expect(names).not.toContain('oldName');
  });

  it('updates edges when a caller appears that resolves a previously-unresolved name', async () => {
    // Start with a self-contained caller that calls a not-yet-existing function
    writeFileSync(join(workDir, 'consumer.ts'), `function consume() { helper(); return 1; }\n`);
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();
    const unresolvedBefore = w.currentGraph.edges.filter(
      (e) => e.toName === 'helper' && e.toId === null,
    );
    expect(unresolvedBefore.length).toBe(1);

    // Add the helper — the edge should newly resolve
    const helperFile = join(workDir, 'helper.ts');
    writeFileSync(helperFile, 'export function helper() { return 7; }\n');
    await w.applyUpdate(helperFile, 'add');

    const resolved = w.currentGraph.edges.find((e) => e.toName === 'helper' && e.toId !== null);
    expect(resolved).toBeDefined();
    expect(resolved!.toId).toMatch(/helper/);
  });

  it('drops edges for a removed caller', async () => {
    writeFileSync(join(workDir, 'target.ts'), 'export function target() { return 1; }\n');
    writeFileSync(
      join(workDir, 'caller.ts'),
      'import { target } from "./target";\nfunction call() { return target(); }\n',
    );
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();
    const edgesBefore = w.currentGraph.edges.length;
    expect(edgesBefore).toBeGreaterThan(0);

    // Remove the caller's body — should drop the edge
    const callerFile = join(workDir, 'caller.ts');
    writeFileSync(callerFile, 'import { target } from "./target";\n');
    await w.applyUpdate(callerFile, 'change');

    const callTargetEdges = w.currentGraph.edges.filter((e) => e.toName === 'target');
    expect(callTargetEdges.length).toBe(0);
  });

  it('ignores non-watchable files', async () => {
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();
    const txtFile = join(workDir, 'note.txt');
    writeFileSync(txtFile, 'just text');
    const r = await w.applyUpdate(txtFile, 'add');
    expect(r).toBeNull();
  });

  it('ignores files outside the watched root', async () => {
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();
    // A path outside the root
    const outside = '/tmp/some-other-file.ts';
    const r = await w.applyUpdate(outside, 'change');
    expect(r).toBeNull();
  });
});

describe('GraphWatcher — applyDeletion', () => {
  it('removes all symbols + edges that came from the deleted file', async () => {
    const a = join(workDir, 'a.ts');
    const b = join(workDir, 'b.ts');
    writeFileSync(a, 'export function fromA() { return 1; }\n');
    writeFileSync(b, 'import { fromA } from "./a";\nexport function fromB() { return fromA(); }\n');

    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();
    expect(w.currentGraph.symbols.some((s) => s.name === 'fromA')).toBe(true);

    unlinkSync(a);
    const r = await w.applyDeletion(a);
    expect(r).not.toBeNull();
    expect(w.currentGraph.symbols.some((s) => s.name === 'fromA')).toBe(false);
    // The fromA-call edge in b.ts is now unresolved
    const stillThere = w.currentGraph.edges.find((e) => e.toName === 'fromA');
    expect(stillThere?.toId).toBeNull();
  });

  it('is a no-op if the file was not in the index', async () => {
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();
    const r = await w.applyDeletion(join(workDir, 'never-existed.ts'));
    expect(r).toBeNull();
  });
});

describe('GraphWatcher — on-disk side effects', () => {
  it('persists each applyUpdate atomically (graph.json never partial)', async () => {
    writeFileSync(join(workDir, 'x.ts'), 'export function x() {}\n');
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();

    // After a change, on-disk graph.json must be parseable JSON matching
    // what's in memory. (Atomic .tmp + rename in storage.saveGraph.)
    writeFileSync(join(workDir, 'x.ts'), 'export function x() { return 9; }\n');
    await w.applyUpdate(join(workDir, 'x.ts'), 'change');

    const onDisk = loadGraph(workDir);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.symbolCount).toBe(w.currentGraph.symbols.length);
  });

  it('recomputes filesIndexed from surviving symbols', async () => {
    writeFileSync(join(workDir, 'one.ts'), 'export function one() {}\n');
    writeFileSync(join(workDir, 'two.ts'), 'export function two() {}\n');
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();
    expect(w.currentGraph.filesIndexed).toBe(2);

    unlinkSync(join(workDir, 'one.ts'));
    await w.applyDeletion(join(workDir, 'one.ts'));
    expect(w.currentGraph.filesIndexed).toBe(1);
  });

  it('serializes concurrent updates via the chain (no torn graph)', async () => {
    // Drive multiple applyUpdates in parallel — the watcher should still end
    // up consistent. (The internal chain only protects chokidar-triggered
    // events, but applyUpdate is awaitable from the outside; here we test
    // that two awaits in sequence produce a deterministic outcome.)
    const a = join(workDir, 'a.ts');
    const b = join(workDir, 'b.ts');
    writeFileSync(a, 'export function a1() {}\n');
    writeFileSync(b, 'export function b1() {}\n');
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();

    writeFileSync(a, 'export function a2() {}\n');
    writeFileSync(b, 'export function b2() {}\n');
    await Promise.all([w.applyUpdate(a, 'change'), w.applyUpdate(b, 'change')]);

    const names = w.currentGraph.symbols.map((s) => s.name).sort();
    expect(names).toEqual(['a2', 'b2']);
  });
});

describe('GraphWatcher — diagnostic output', () => {
  it('writes one diagnostic line per applyUpdate', async () => {
    writeFileSync(join(workDir, 'x.ts'), 'export function x() {}\n');
    const lines: string[] = [];
    const w = new GraphWatcher(workDir, { log: (s) => lines.push(s) });
    // fullReindex is silent by design; only event-driven updates log.
    await w.fullReindex();
    const before = lines.length;
    writeFileSync(join(workDir, 'x.ts'), 'export function x() { return 1; }\n');
    await w.applyUpdate(join(workDir, 'x.ts'), 'change');
    expect(lines.length).toBe(before + 1);
    expect(lines[lines.length - 1]).toMatch(/x\.ts/);
  });

  it('on-disk graph contains the new symbols after change', async () => {
    writeFileSync(join(workDir, 'x.ts'), 'export function oldOne() {}\n');
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();
    writeFileSync(join(workDir, 'x.ts'), 'export function newOne() {}\n');
    await w.applyUpdate(join(workDir, 'x.ts'), 'change');

    const raw = readFileSync(join(repoDir(workDir), 'graph.json'), 'utf8');
    expect(raw).toContain('newOne');
    expect(raw).not.toContain('oldOne');
  });
});

describe('GraphWatcher — POSIX path normalization', () => {
  it('stores forward-slash file paths in symbols after applyUpdate (Windows regression)', async () => {
    const file = join(workDir, 'sub', 'deep.ts');
    mkdirSync(join(workDir, 'sub'), { recursive: true });
    writeFileSync(file, 'export function deep() {}\n');

    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();

    // All symbol.file paths must use forward slashes, never OS sep.
    for (const s of w.currentGraph.symbols) {
      expect(s.file).not.toContain('\\');
    }
  });

  it('applyUpdate POSIX normalization: file path in added symbol uses forward slash', async () => {
    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();

    const sub = join(workDir, 'pkg', 'util.ts');
    mkdirSync(join(workDir, 'pkg'), { recursive: true });
    writeFileSync(sub, 'export function util() {}\n');
    await w.applyUpdate(sub, 'add');

    const sym = w.currentGraph.symbols.find((s) => s.name === 'util');
    expect(sym).toBeDefined();
    expect(sym!.file).toBe('pkg/util.ts');
    expect(sym!.file).not.toContain('\\');
  });

  it('applyDeletion uses POSIX path and correctly removes symbols', async () => {
    const sub = join(workDir, 'mod', 'gone.ts');
    mkdirSync(join(workDir, 'mod'), { recursive: true });
    writeFileSync(sub, 'export function gone() {}\n');

    const w = new GraphWatcher(workDir, { log: silentLog() });
    await w.fullReindex();
    expect(w.currentGraph.symbols.some((s) => s.name === 'gone')).toBe(true);

    unlinkSync(sub);
    await w.applyDeletion(sub);
    expect(w.currentGraph.symbols.some((s) => s.name === 'gone')).toBe(false);
  });
});
