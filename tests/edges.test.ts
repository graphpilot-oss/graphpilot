import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile } from '../src/parser.js';
import { extractSymbols } from '../src/symbols.js';
import { extractRawCalls, resolveCallEdges, buildNameIndex } from '../src/edges.js';
import type { SymbolRecord } from '../src/symbols.js';
import { indexDirectory } from '../src/indexer.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', name);

// ---------------------------------------------------------------------------
// extractRawCalls (per-file)
// ---------------------------------------------------------------------------

describe('extractRawCalls', () => {
  it('finds in-file call: authenticate → parseToken', () => {
    const parsed = parseFile(fixture('sample.ts'))!;
    const syms = extractSymbols(parsed);
    const calls = extractRawCalls(parsed, syms);

    const authToParseToken = calls.find(
      (c) => c.toName === 'parseToken' && c.fromId.includes('AuthService.authenticate'),
    );
    expect(authToParseToken).toBeDefined();
  });

  it('finds method call: parseToken → trim (unresolvable but captured)', () => {
    const parsed = parseFile(fixture('sample.ts'))!;
    const syms = extractSymbols(parsed);
    const calls = extractRawCalls(parsed, syms);

    const trimCall = calls.find((c) => c.toName === 'trim');
    expect(trimCall).toBeDefined();
    expect(trimCall!.fromId).toContain('parseToken');
  });

  it('does not falsely emit calls for property accesses', () => {
    // validateJwt body is `return jwt.length > 0;` — `.length` is a property,
    // not a call. We should NOT emit it as a call.
    const parsed = parseFile(fixture('sample.ts'))!;
    const syms = extractSymbols(parsed);
    const calls = extractRawCalls(parsed, syms);

    expect(calls.find((c) => c.toName === 'length')).toBeUndefined();
  });

  it('returns line+column for every call site', () => {
    const parsed = parseFile(fixture('sample.ts'))!;
    const syms = extractSymbols(parsed);
    const calls = extractRawCalls(parsed, syms);

    for (const c of calls) {
      expect(c.line).toBeGreaterThan(0);
      expect(c.column).toBeGreaterThan(0);
      expect(c.fromId).toMatch(/.+#.+@\d+/);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveCallEdges (post-pass)
// ---------------------------------------------------------------------------

describe('resolveCallEdges', () => {
  it('resolves callee in same file', () => {
    const parsed = parseFile(fixture('sample.ts'))!;
    const syms = extractSymbols(parsed);
    const raw = extractRawCalls(parsed, syms);
    const edges = resolveCallEdges(raw, syms);

    const e = edges.find((x) => x.toName === 'parseToken');
    expect(e?.toId).not.toBeNull();
    expect(e?.toId).toContain('parseToken');
  });

  it('marks unknown calls as unresolved (toId: null)', () => {
    const parsed = parseFile(fixture('sample.ts'))!;
    const syms = extractSymbols(parsed);
    const raw = extractRawCalls(parsed, syms);
    const edges = resolveCallEdges(raw, syms);

    const e = edges.find((x) => x.toName === 'trim');
    expect(e?.toId).toBeNull();
    expect(e?.toName).toBe('trim');
  });

  it('prefers same-file candidate when multiple symbols share a name', () => {
    const fileASym = {
      id: 'a.ts#foo@1',
      name: 'foo',
      kind: 'function' as const,
      file: 'a.ts',
      line: 1,
      column: 1,
      endLine: 3,
      signature: 'function foo()',
      exported: false,
    };
    const fileBSym = {
      ...fileASym,
      id: 'b.ts#foo@1',
      file: 'b.ts',
    };
    const raw = [{ fromId: 'b.ts#bar@5', toName: 'foo', file: 'b.ts', line: 6, column: 10 }];
    const edges = resolveCallEdges(raw, [fileASym, fileBSym]);
    expect(edges[0].toId).toBe('b.ts#foo@1');
  });
});

// ---------------------------------------------------------------------------
// Integration: cross-file resolution end-to-end
// ---------------------------------------------------------------------------

describe('indexDirectory: cross-file edges', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'graphpilot-edges-'));
  });

  afterEach(() => {
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  it('resolves a call across two files', async () => {
    writeFileSync(join(workDir, 'a.ts'), `export function helper(): number { return 42; }\n`);
    writeFileSync(
      join(workDir, 'b.ts'),
      `import { helper } from './a';\nexport function main(): number { return helper(); }\n`,
    );

    const result = await indexDirectory(workDir);

    expect(result.symbols.map((s) => s.name).sort()).toEqual(['helper', 'main']);

    const mainToHelper = result.edges.find((e) => e.toName === 'helper' && e.file === 'b.ts');
    expect(mainToHelper).toBeDefined();
    expect(mainToHelper!.toId).not.toBeNull();
    expect(mainToHelper!.toId).toContain('a.ts#helper');
  });

  it('emits zero edges when no calls exist', async () => {
    writeFileSync(join(workDir, 'pure.ts'), `export const x = 1;\nexport type Y = string;\n`);
    const result = await indexDirectory(workDir);
    expect(result.edges.length).toBe(0);
  });

  it('does not attribute nested-arrow calls to the outer function', async () => {
    writeFileSync(
      join(workDir, 'nested.ts'),
      `export function outer(): void {\n` +
        `  const inner = () => { doThing(); };\n` +
        `  inner();\n` +
        `}\n` +
        `function doThing(): void {}\n`,
    );

    const result = await indexDirectory(workDir);

    // outer should only call `inner` (not `doThing`, which is called by the arrow).
    const outerSym = result.symbols.find((s) => s.name === 'outer')!;
    const outerCalls = result.edges.filter((e) => e.fromId === outerSym.id);
    const outerCalleeNames = outerCalls.map((e) => e.toName).sort();
    expect(outerCalleeNames).toEqual(['inner']);

    // The arrow itself is a SymbolRecord (assigned to `inner`); it should be
    // the one calling `doThing`.
    const innerSym = result.symbols.find((s) => s.name === 'inner')!;
    const innerCalls = result.edges.filter((e) => e.fromId === innerSym.id);
    expect(innerCalls.map((e) => e.toName)).toContain('doThing');
  });
});

// ---------------------------------------------------------------------------
// Module-scope calls (issue #19)
// ---------------------------------------------------------------------------

describe('module-scope calls (issue #19)', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'graphpilot-module-'));
  });
  afterEach(() => {
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  it('attributes a top-level call to a synthetic <module> symbol', async () => {
    writeFileSync(join(workDir, 'main.ts'), `export function setupApp(): void {}\nsetupApp();\n`);
    const result = await indexDirectory(workDir);

    const mod = result.symbols.find((s) => s.kind === 'module' && s.file === 'main.ts');
    expect(mod).toBeDefined();
    expect(mod!.name).toBe('<module>');

    const edge = result.edges.find((e) => e.toName === 'setupApp');
    expect(edge).toBeDefined();
    expect(edge!.fromId).toBe(mod!.id);
    expect(edge!.toId).toContain('main.ts#setupApp');
  });

  it('captures a call inside a top-level if block', async () => {
    writeFileSync(
      join(workDir, 'boot.ts'),
      `export function init(): void {}\nif (process.env.X) { init(); }\n`,
    );
    const result = await indexDirectory(workDir);
    const edge = result.edges.find((e) => e.toName === 'init');
    expect(edge?.fromId).toContain('#<module>');
  });

  it('does not synthesize a <module> symbol when there are no top-level calls', async () => {
    writeFileSync(join(workDir, 'clean.ts'), `export function a(): number { return 1; }\n`);
    const result = await indexDirectory(workDir);
    expect(result.symbols.find((s) => s.kind === 'module')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JSX component edges (issue #17)
// ---------------------------------------------------------------------------

describe('JSX component edges (issue #17)', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'graphpilot-jsx-'));
  });
  afterEach(() => {
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  it('treats <Header /> as a call into Header', async () => {
    writeFileSync(
      join(workDir, 'App.tsx'),
      `function Header() { return null }\nfunction App() { return <Header /> }\n`,
    );
    const result = await indexDirectory(workDir);

    const edge = result.edges.find((e) => e.toName === 'Header');
    expect(edge).toBeDefined();
    expect(edge!.toId).toContain('App.tsx#Header');

    const appSym = result.symbols.find((s) => s.name === 'App')!;
    expect(edge!.fromId).toBe(appSym.id);
  });

  it('ignores intrinsic lowercase HTML tags', async () => {
    writeFileSync(join(workDir, 'D.tsx'), `function D() { return <div /> }\n`);
    const result = await indexDirectory(workDir);
    expect(result.edges.find((e) => e.toName === 'div')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ambiguous resolution flag (issue #18)
// ---------------------------------------------------------------------------

describe('ambiguous resolution flag (issue #18)', () => {
  const mk = (over: Partial<SymbolRecord>): SymbolRecord => ({
    id: 'x.ts#foo@1',
    name: 'foo',
    kind: 'function',
    file: 'x.ts',
    line: 1,
    column: 1,
    endLine: 1,
    signature: 'function foo()',
    exported: false,
    ...over,
  });

  it('flags an edge resolved among multiple same-named candidates', () => {
    const a = mk({ id: 'userRepo.ts#UserRepo.save@1', name: 'save', file: 'userRepo.ts' });
    const b = mk({ id: 'productRepo.ts#ProductRepo.save@1', name: 'save', file: 'productRepo.ts' });
    const raw = [{ fromId: 'api.ts#<module>', toName: 'save', file: 'api.ts', line: 4, column: 1 }];
    const edges = resolveCallEdges(raw, [a, b]);
    expect(edges[0].toId).not.toBeNull();
    expect(edges[0].ambiguous).toBe(true);
    expect(edges[0].candidateCount).toBe(2);
  });

  it('does not flag a unique resolution', () => {
    const a = mk({ id: 'a.ts#foo@1', file: 'a.ts' });
    const raw = [{ fromId: 'a.ts#bar@5', toName: 'foo', file: 'a.ts', line: 6, column: 1 }];
    const edges = resolveCallEdges(raw, [a]);
    expect(edges[0].ambiguous).toBeUndefined();
    expect(edges[0].candidateCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Prebuilt name index (issue #28)
// ---------------------------------------------------------------------------

describe('prebuilt name index (issue #28)', () => {
  it('produces identical edges whether the index is rebuilt or prebuilt', () => {
    const parsed = parseFile(fixture('sample.ts'))!;
    const syms = extractSymbols(parsed);
    const raw = extractRawCalls(parsed, syms);

    const rebuilt = resolveCallEdges(raw, syms);
    const prebuilt = resolveCallEdges(raw, [], buildNameIndex(syms));

    expect(prebuilt).toEqual(rebuilt);
  });
});
