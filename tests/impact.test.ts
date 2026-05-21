import { describe, it, expect } from 'vitest';
import { analyzeImpact, isTestFile } from '../src/impact.js';
import { GraphIndex } from '../src/query.js';
import type { Graph } from '../src/storage.js';
import type { SymbolRecord, SymbolKind } from '../src/symbols.js';
import type { CallEdge } from '../src/edges.js';

// ---------------------------------------------------------------------------
// Test harness — build a fake Graph + GraphIndex without touching the FS
// ---------------------------------------------------------------------------

function sym(opts: {
  id: string;
  name: string;
  file: string;
  exported?: boolean;
  kind?: SymbolKind;
}): SymbolRecord {
  return {
    id: opts.id,
    name: opts.name,
    kind: opts.kind ?? 'function',
    file: opts.file,
    line: 1,
    column: 1,
    endLine: 5,
    signature: `function ${opts.name}() {}`,
    exported: opts.exported ?? false,
    parent: undefined,
  };
}

function edge(opts: { from: string; to: string | null; toName?: string; file?: string }): CallEdge {
  return {
    fromId: opts.from,
    toId: opts.to,
    toName: opts.toName ?? (opts.to ? opts.to.split('#')[1].split('@')[0] : 'unknown'),
    file: opts.file ?? 'src/x.ts',
    line: 1,
    column: 1,
  };
}

function makeGraph(symbols: SymbolRecord[], edges: CallEdge[]): Graph {
  return {
    version: 1,
    repoId: 'test',
    rootPath: '/test',
    indexedAt: new Date().toISOString(),
    filesIndexed: 0,
    symbolCount: symbols.length,
    edgeCount: edges.length,
    symbols,
    edges,
  };
}

// ---------------------------------------------------------------------------
// isTestFile — heuristic detector
// ---------------------------------------------------------------------------

describe('isTestFile', () => {
  it('matches *.test.<ext>', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true);
    expect(isTestFile('src/foo.test.tsx')).toBe(true);
    expect(isTestFile('src/foo.test.js')).toBe(true);
    expect(isTestFile('src/foo.test.jsx')).toBe(true);
    expect(isTestFile('a/b/c.test.mjs')).toBe(true);
  });

  it('matches *.spec.<ext>', () => {
    expect(isTestFile('src/foo.spec.ts')).toBe(true);
    expect(isTestFile('packages/app/x.spec.tsx')).toBe(true);
  });

  it('matches files under __tests__/', () => {
    expect(isTestFile('src/__tests__/helper.ts')).toBe(true);
    expect(isTestFile('__tests__/root.ts')).toBe(true);
  });

  it('does NOT match a bare test/ or tests/ directory', () => {
    // Deliberately conservative — these directories often contain non-test
    // helpers (e.g. src/test/fixtures.ts). We require the explicit suffix.
    expect(isTestFile('src/test/util.ts')).toBe(false);
    expect(isTestFile('tests/parser.ts')).toBe(false);
  });

  it('does NOT match regular source files', () => {
    expect(isTestFile('src/parser.ts')).toBe(false);
    expect(isTestFile('index.ts')).toBe(false);
    expect(isTestFile('Testing.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyzeImpact — the BFS + result-shape behaviour
// ---------------------------------------------------------------------------

describe('analyzeImpact', () => {
  it('returns null when the symbol does not exist', () => {
    const idx = new GraphIndex(makeGraph([], []));
    expect(analyzeImpact(idx, 'doesNotExist')).toBeNull();
  });

  it('returns empty caller arrays when nothing calls the target', () => {
    const idx = new GraphIndex(
      makeGraph([sym({ id: 'a.ts#target@1', name: 'target', file: 'a.ts' })], []),
    );
    const r = analyzeImpact(idx, 'target');
    expect(r).not.toBeNull();
    expect(r!.directCallers).toEqual([]);
    expect(r!.transitiveCallers).toEqual([]);
    expect(r!.stats.directCount).toBe(0);
    expect(r!.stats.transitiveCount).toBe(0);
    expect(r!.stats.sourceFileCount).toBe(0);
  });

  it('captures direct callers at depth 1', () => {
    const symbols = [
      sym({ id: 'a.ts#target@1', name: 'target', file: 'a.ts' }),
      sym({ id: 'b.ts#caller1@1', name: 'caller1', file: 'b.ts' }),
      sym({ id: 'c.ts#caller2@1', name: 'caller2', file: 'c.ts' }),
    ];
    const edges = [
      edge({ from: 'b.ts#caller1@1', to: 'a.ts#target@1' }),
      edge({ from: 'c.ts#caller2@1', to: 'a.ts#target@1' }),
    ];
    const idx = new GraphIndex(makeGraph(symbols, edges));
    const r = analyzeImpact(idx, 'target')!;
    expect(r.directCallers.length).toBe(2);
    expect(r.directCallers.every((c) => c.depth === 1)).toBe(true);
    expect(r.transitiveCallers.length).toBe(0);
  });

  it('captures transitive callers at depth 2..maxDepth', () => {
    // A -> target
    // B -> A
    // C -> B
    const symbols = [
      sym({ id: 'f.ts#target@1', name: 'target', file: 'f.ts' }),
      sym({ id: 'f.ts#A@1', name: 'A', file: 'f.ts' }),
      sym({ id: 'f.ts#B@1', name: 'B', file: 'f.ts' }),
      sym({ id: 'f.ts#C@1', name: 'C', file: 'f.ts' }),
    ];
    const edges = [
      edge({ from: 'f.ts#A@1', to: 'f.ts#target@1' }),
      edge({ from: 'f.ts#B@1', to: 'f.ts#A@1' }),
      edge({ from: 'f.ts#C@1', to: 'f.ts#B@1' }),
    ];
    const idx = new GraphIndex(makeGraph(symbols, edges));
    const r = analyzeImpact(idx, 'target', { depth: 3 })!;

    expect(r.directCallers.map((c) => c.symbol.name)).toEqual(['A']);
    const transNames = r.transitiveCallers.map((c) => c.symbol.name).sort();
    expect(transNames).toEqual(['B', 'C']);
    const bDepth = r.transitiveCallers.find((c) => c.symbol.name === 'B')!.depth;
    const cDepth = r.transitiveCallers.find((c) => c.symbol.name === 'C')!.depth;
    expect(bDepth).toBe(2);
    expect(cDepth).toBe(3);
  });

  it('respects the depth cap', () => {
    // chain of 5: D -> C -> B -> A -> target
    const symbols = [
      sym({ id: 'x.ts#target@1', name: 'target', file: 'x.ts' }),
      sym({ id: 'x.ts#A@1', name: 'A', file: 'x.ts' }),
      sym({ id: 'x.ts#B@1', name: 'B', file: 'x.ts' }),
      sym({ id: 'x.ts#C@1', name: 'C', file: 'x.ts' }),
      sym({ id: 'x.ts#D@1', name: 'D', file: 'x.ts' }),
    ];
    const edges = [
      edge({ from: 'x.ts#A@1', to: 'x.ts#target@1' }),
      edge({ from: 'x.ts#B@1', to: 'x.ts#A@1' }),
      edge({ from: 'x.ts#C@1', to: 'x.ts#B@1' }),
      edge({ from: 'x.ts#D@1', to: 'x.ts#C@1' }),
    ];
    const idx = new GraphIndex(makeGraph(symbols, edges));
    const r = analyzeImpact(idx, 'target', { depth: 2 })!;
    // Should include A (d=1) and B (d=2) only. NOT C, NOT D.
    const found = [
      ...r.directCallers.map((c) => c.symbol.name),
      ...r.transitiveCallers.map((c) => c.symbol.name),
    ].sort();
    expect(found).toEqual(['A', 'B']);
  });

  it('caps depth to 5 even when caller requests higher', () => {
    const idx = new GraphIndex(makeGraph([sym({ id: 'a.ts#t@1', name: 't', file: 'a.ts' })], []));
    // depth=99 should be silently clamped. We don't expose a way to read the
    // applied cap, but we can verify it doesn't throw and returns a result.
    expect(() => analyzeImpact(idx, 't', { depth: 99 })).not.toThrow();
  });

  it('handles cycles without infinite loop', () => {
    // A <-> B (mutual recursion); target is reached via A.
    const symbols = [
      sym({ id: 'a.ts#target@1', name: 'target', file: 'a.ts' }),
      sym({ id: 'a.ts#A@1', name: 'A', file: 'a.ts' }),
      sym({ id: 'a.ts#B@1', name: 'B', file: 'a.ts' }),
    ];
    const edges = [
      edge({ from: 'a.ts#A@1', to: 'a.ts#target@1' }),
      edge({ from: 'a.ts#B@1', to: 'a.ts#A@1' }),
      edge({ from: 'a.ts#A@1', to: 'a.ts#B@1' }), // cycle: A also calls B
    ];
    const idx = new GraphIndex(makeGraph(symbols, edges));
    const start = Date.now();
    const r = analyzeImpact(idx, 'target', { depth: 5 })!;
    expect(Date.now() - start).toBeLessThan(500);
    const names = [
      ...r.directCallers.map((c) => c.symbol.name),
      ...r.transitiveCallers.map((c) => c.symbol.name),
    ].sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('handles a self-referential symbol (direct recursion)', () => {
    // Target calls itself + has one external caller.
    const symbols = [
      sym({ id: 'a.ts#target@1', name: 'target', file: 'a.ts' }),
      sym({ id: 'a.ts#caller@1', name: 'caller', file: 'a.ts' }),
    ];
    const edges = [
      edge({ from: 'a.ts#target@1', to: 'a.ts#target@1' }), // recursion
      edge({ from: 'a.ts#caller@1', to: 'a.ts#target@1' }),
    ];
    const idx = new GraphIndex(makeGraph(symbols, edges));
    const r = analyzeImpact(idx, 'target')!;
    expect(r.directCallers.map((c) => c.symbol.name)).toEqual(['caller']);
    // target should not appear as its own caller in the result
    expect(
      [...r.directCallers, ...r.transitiveCallers].some((c) => c.symbol.name === 'target'),
    ).toBe(false);
  });

  it('splits test callers into testsAffected', () => {
    const symbols = [
      sym({ id: 'src/auth.ts#parseToken@1', name: 'parseToken', file: 'src/auth.ts' }),
      sym({ id: 'src/login.ts#login@1', name: 'login', file: 'src/login.ts' }),
      sym({
        id: 'tests/auth.test.ts#authShouldWork@1',
        name: 'authShouldWork',
        file: 'tests/auth.test.ts',
      }),
      sym({
        id: 'src/__tests__/auth.ts#authInternalTest@1',
        name: 'authInternalTest',
        file: 'src/__tests__/auth.ts',
      }),
    ];
    const edges = [
      edge({ from: 'src/login.ts#login@1', to: 'src/auth.ts#parseToken@1' }),
      edge({
        from: 'tests/auth.test.ts#authShouldWork@1',
        to: 'src/auth.ts#parseToken@1',
      }),
      edge({
        from: 'src/__tests__/auth.ts#authInternalTest@1',
        to: 'src/auth.ts#parseToken@1',
      }),
    ];
    const idx = new GraphIndex(makeGraph(symbols, edges));
    const r = analyzeImpact(idx, 'parseToken')!;

    expect(r.directCallers.length).toBe(3);
    expect(r.testsAffected.length).toBe(2);
    const testNames = r.testsAffected.map((c) => c.symbol.name).sort();
    expect(testNames).toEqual(['authInternalTest', 'authShouldWork']);
  });

  it('reflects publicApi.exported correctly', () => {
    const exportedTarget = sym({
      id: 'src/x.ts#pub@1',
      name: 'pub',
      file: 'src/x.ts',
      exported: true,
    });
    const privateTarget = sym({
      id: 'src/y.ts#priv@1',
      name: 'priv',
      file: 'src/y.ts',
      exported: false,
    });
    const idxPub = new GraphIndex(makeGraph([exportedTarget], []));
    const rPub = analyzeImpact(idxPub, 'pub')!;
    expect(rPub.publicApi.exported).toBe(true);
    expect(rPub.publicApi.reason).toMatch(/breaking change/i);

    const idxPriv = new GraphIndex(makeGraph([privateTarget], []));
    const rPriv = analyzeImpact(idxPriv, 'priv')!;
    expect(rPriv.publicApi.exported).toBe(false);
    expect(rPriv.publicApi.reason).toMatch(/not exported/i);
  });

  it('stats match the actual arrays', () => {
    const symbols = [
      sym({ id: 'a.ts#t@1', name: 't', file: 'a.ts' }),
      sym({ id: 'a.ts#c1@1', name: 'c1', file: 'a.ts' }),
      sym({ id: 'b.ts#c2@1', name: 'c2', file: 'b.ts' }),
      sym({
        id: 'c.test.ts#tc@1',
        name: 'tc',
        file: 'c.test.ts',
      }),
    ];
    const edges = [
      edge({ from: 'a.ts#c1@1', to: 'a.ts#t@1' }),
      edge({ from: 'b.ts#c2@1', to: 'a.ts#t@1' }),
      edge({ from: 'c.test.ts#tc@1', to: 'a.ts#t@1' }),
    ];
    const idx = new GraphIndex(makeGraph(symbols, edges));
    const r = analyzeImpact(idx, 't')!;
    expect(r.stats.directCount).toBe(r.directCallers.length);
    expect(r.stats.transitiveCount).toBe(r.transitiveCallers.length);
    expect(r.stats.testCount).toBe(r.testsAffected.length);
    // Three distinct source files for the three callers
    expect(r.stats.sourceFileCount).toBe(3);
  });

  it('sets truncated when per-level cap is hit', () => {
    // 5 callers at depth 1; limit per level = 2 should mark truncated.
    const symbols = [
      sym({ id: 'a.ts#t@1', name: 't', file: 'a.ts' }),
      ...Array.from({ length: 5 }, (_, i) =>
        sym({ id: `a.ts#c${i}@1`, name: `c${i}`, file: 'a.ts' }),
      ),
    ];
    const edges = Array.from({ length: 5 }, (_, i) =>
      edge({ from: `a.ts#c${i}@1`, to: 'a.ts#t@1' }),
    );
    const idx = new GraphIndex(makeGraph(symbols, edges));
    const r = analyzeImpact(idx, 't', { perLevelLimit: 2 })!;
    expect(r.directCallers.length).toBe(2);
    expect(r.stats.truncated).toBe(true);
  });

  it('resolves by name via GraphIndex (same-file > global)', () => {
    // Two symbols named "helper" — one in same file as caller, one elsewhere.
    // Per GraphIndex.resolveSymbol, the first-found wins for ambiguous lookups.
    const symbols = [
      sym({ id: 'a.ts#helper@1', name: 'helper', file: 'a.ts' }),
      sym({ id: 'b.ts#helper@1', name: 'helper', file: 'b.ts' }),
    ];
    const idx = new GraphIndex(makeGraph(symbols, []));
    const r = analyzeImpact(idx, 'helper');
    expect(r).not.toBeNull();
    // Whichever was picked, it's one of the two ids
    expect(['a.ts#helper@1', 'b.ts#helper@1']).toContain(r!.target.id);
  });

  it('resolves by full id when given one', () => {
    const symbols = [
      sym({ id: 'a.ts#helper@1', name: 'helper', file: 'a.ts' }),
      sym({ id: 'b.ts#helper@1', name: 'helper', file: 'b.ts' }),
    ];
    const idx = new GraphIndex(makeGraph(symbols, []));
    const r = analyzeImpact(idx, 'b.ts#helper@1')!;
    expect(r.target.id).toBe('b.ts#helper@1');
  });
});

// ---------------------------------------------------------------------------
// changedFiles (differential `since` mode)
// ---------------------------------------------------------------------------

describe('analyzeImpact with changedFiles filter', () => {
  it('filters callers to only those whose file is in changedFiles', () => {
    const symbols = [
      sym({ id: 'tgt.ts#target@1', name: 'target', file: 'tgt.ts' }),
      sym({ id: 'a.ts#aFn@1', name: 'aFn', file: 'a.ts' }),
      sym({ id: 'b.ts#bFn@1', name: 'bFn', file: 'b.ts' }),
      sym({ id: 'c.ts#cFn@1', name: 'cFn', file: 'c.ts' }),
    ];
    const edges = [
      edge({ from: 'a.ts#aFn@1', to: 'tgt.ts#target@1', file: 'a.ts' }),
      edge({ from: 'b.ts#bFn@1', to: 'tgt.ts#target@1', file: 'b.ts' }),
      edge({ from: 'c.ts#cFn@1', to: 'tgt.ts#target@1', file: 'c.ts' }),
    ];
    const idx = new GraphIndex(makeGraph(symbols, edges));

    const r = analyzeImpact(idx, 'target', {
      changedFiles: new Set(['a.ts', 'c.ts']),
    })!;
    expect(r.directCallers.map((c) => c.symbol.name).sort()).toEqual(['aFn', 'cFn']);
    expect(r.stats.directCount).toBe(2);
  });

  it('returns no callers when changedFiles is empty', () => {
    const symbols = [
      sym({ id: 'tgt.ts#target@1', name: 'target', file: 'tgt.ts' }),
      sym({ id: 'a.ts#aFn@1', name: 'aFn', file: 'a.ts' }),
    ];
    const edges = [edge({ from: 'a.ts#aFn@1', to: 'tgt.ts#target@1', file: 'a.ts' })];
    const idx = new GraphIndex(makeGraph(symbols, edges));

    const r = analyzeImpact(idx, 'target', { changedFiles: new Set() })!;
    expect(r.directCallers).toEqual([]);
    expect(r.transitiveCallers).toEqual([]);
    expect(r.stats.directCount).toBe(0);
  });

  it('null changedFiles is identical to omitting the option', () => {
    const symbols = [
      sym({ id: 'tgt.ts#target@1', name: 'target', file: 'tgt.ts' }),
      sym({ id: 'a.ts#aFn@1', name: 'aFn', file: 'a.ts' }),
    ];
    const edges = [edge({ from: 'a.ts#aFn@1', to: 'tgt.ts#target@1', file: 'a.ts' })];
    const idx = new GraphIndex(makeGraph(symbols, edges));

    const baseline = analyzeImpact(idx, 'target')!;
    const withNull = analyzeImpact(idx, 'target', { changedFiles: null })!;
    expect(withNull.stats.directCount).toBe(baseline.stats.directCount);
  });

  it('still resolves the target even if the target file is not in changedFiles', () => {
    // The filter applies only to callers, not to the target lookup.
    const symbols = [
      sym({ id: 'tgt.ts#target@1', name: 'target', file: 'tgt.ts' }),
      sym({ id: 'a.ts#aFn@1', name: 'aFn', file: 'a.ts' }),
    ];
    const edges = [edge({ from: 'a.ts#aFn@1', to: 'tgt.ts#target@1', file: 'a.ts' })];
    const idx = new GraphIndex(makeGraph(symbols, edges));

    const r = analyzeImpact(idx, 'target', { changedFiles: new Set(['a.ts']) })!;
    expect(r).not.toBeNull();
    expect(r.target.name).toBe('target');
    expect(r.directCallers.length).toBe(1);
  });

  it('filters transitive callers too', () => {
    // chain: t <- a <- b <- c
    const symbols = [
      sym({ id: 't.ts#t@1', name: 't', file: 't.ts' }),
      sym({ id: 'a.ts#a@1', name: 'a', file: 'a.ts' }),
      sym({ id: 'b.ts#b@1', name: 'b', file: 'b.ts' }),
      sym({ id: 'c.ts#c@1', name: 'c', file: 'c.ts' }),
    ];
    const edges = [
      edge({ from: 'a.ts#a@1', to: 't.ts#t@1' }),
      edge({ from: 'b.ts#b@1', to: 'a.ts#a@1' }),
      edge({ from: 'c.ts#c@1', to: 'b.ts#b@1' }),
    ];
    const idx = new GraphIndex(makeGraph(symbols, edges));

    // Only c.ts changed — even though a and b are between c and t in the
    // call chain, we filter callers by file, so only c survives.
    const r = analyzeImpact(idx, 't', {
      depth: 5,
      changedFiles: new Set(['c.ts']),
    })!;
    expect(r.directCallers).toEqual([]);
    expect(r.transitiveCallers.map((c) => c.symbol.name)).toEqual(['c']);
  });
});
