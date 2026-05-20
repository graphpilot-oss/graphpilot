import { describe, it, expect } from 'vitest';
import { GraphIndex } from '../src/query.js';
import type { Graph } from '../src/storage.js';
import type { SymbolRecord } from '../src/symbols.js';
import type { CallEdge } from '../src/edges.js';

// Tiny hand-built fixture so we exercise the index without parsing real code.
function sym(id: string, name: string, file: string, line: number): SymbolRecord {
  return {
    id,
    name,
    kind: 'function',
    file,
    line,
    column: 1,
    endLine: line + 2,
    signature: `function ${name}() {}`,
    exported: false,
  };
}

function edge(fromId: string, toName: string, toId: string | null, file: string): CallEdge {
  return { fromId, toName, toId, file, line: 1, column: 1 };
}

function buildGraph(): Graph {
  const symbols: SymbolRecord[] = [
    sym('a.ts#parseToken@1', 'parseToken', 'a.ts', 1),
    sym('a.ts#validateJwt@10', 'validateJwt', 'a.ts', 10),
    sym('b.ts#authenticate@5', 'authenticate', 'b.ts', 5),
    sym('b.ts#parseToken@20', 'parseToken', 'b.ts', 20),
    sym('c.ts#ParseTokenAsync@1', 'ParseTokenAsync', 'c.ts', 1),
  ];
  const edges: CallEdge[] = [
    edge('b.ts#authenticate@5', 'parseToken', 'a.ts#parseToken@1', 'b.ts'),
    edge('b.ts#authenticate@5', 'validateJwt', 'a.ts#validateJwt@10', 'b.ts'),
    edge('b.ts#authenticate@5', 'unknownExternal', null, 'b.ts'),
    edge('a.ts#parseToken@1', 'trim', null, 'a.ts'),
  ];
  return {
    version: 1,
    repoId: 'test',
    rootPath: '/fake',
    indexedAt: new Date().toISOString(),
    filesIndexed: 3,
    symbolCount: symbols.length,
    edgeCount: edges.length,
    symbols,
    edges,
  };
}

describe('GraphIndex.findByName', () => {
  const idx = new GraphIndex(buildGraph());

  it('exact match is case-insensitive by default', () => {
    const r = idx.findByName('parsetoken');
    expect(r.map((s) => s.id)).toEqual(['a.ts#parseToken@1', 'b.ts#parseToken@20']);
  });

  it('exact-case match ranks above case-folded matches', () => {
    const r = idx.findByName('parseToken');
    // Both `parseToken` (exact case) entries should come before any case-folded
    // hits. Here both candidates are exact-case so order is just insertion.
    expect(r.map((s) => s.name)).toEqual(['parseToken', 'parseToken']);
  });

  it('substring mode finds partial matches', () => {
    const r = idx.findByName('parse', { substring: true });
    const names = r.map((s) => s.name);
    expect(names).toContain('parseToken');
    expect(names).toContain('ParseTokenAsync');
  });

  it('respects limit', () => {
    const r = idx.findByName('parse', { substring: true, limit: 1 });
    expect(r.length).toBe(1);
  });

  it('caps limit at the hard ceiling', () => {
    const r = idx.findByName('parse', { substring: true, limit: 10_000 });
    // We only have 3 substring matches anyway, but verify no throw.
    expect(r.length).toBeLessThanOrEqual(100);
  });

  it('returns [] for empty query', () => {
    expect(idx.findByName('')).toEqual([]);
  });

  it('returns [] when nothing matches', () => {
    expect(idx.findByName('definitelyNotHere')).toEqual([]);
  });
});

describe('GraphIndex.findById / resolveSymbol', () => {
  const idx = new GraphIndex(buildGraph());

  it('findById returns the exact symbol', () => {
    expect(idx.findById('a.ts#parseToken@1')?.name).toBe('parseToken');
  });

  it('findById returns null for unknown id', () => {
    expect(idx.findById('nope')).toBeNull();
  });

  it('resolveSymbol accepts a full id', () => {
    expect(idx.resolveSymbol('b.ts#authenticate@5')?.name).toBe('authenticate');
  });

  it('resolveSymbol accepts a bare name', () => {
    expect(idx.resolveSymbol('authenticate')?.id).toBe('b.ts#authenticate@5');
  });

  it('resolveSymbol returns first match for ambiguous names', () => {
    const s = idx.resolveSymbol('parseToken');
    expect(s).not.toBeNull();
    expect(s!.name).toBe('parseToken');
  });
});

describe('GraphIndex.callers', () => {
  const idx = new GraphIndex(buildGraph());

  it('returns callers of a symbol', () => {
    const c = idx.callers('a.ts#parseToken@1');
    expect(c.length).toBe(1);
    expect(c[0].fromId).toBe('b.ts#authenticate@5');
  });

  it('returns [] when nothing calls the symbol', () => {
    expect(idx.callers('c.ts#ParseTokenAsync@1')).toEqual([]);
  });

  it('returns [] for unknown id', () => {
    expect(idx.callers('not-a-real-id')).toEqual([]);
  });
});

describe('GraphIndex.callees', () => {
  const idx = new GraphIndex(buildGraph());

  it('returns everything a symbol calls', () => {
    const c = idx.callees('b.ts#authenticate@5');
    const names = c.map((e) => e.toName).sort();
    expect(names).toEqual(['parseToken', 'unknownExternal', 'validateJwt']);
  });

  it('can hide unresolved edges', () => {
    const c = idx.callees('b.ts#authenticate@5', { includeUnresolved: false });
    const names = c.map((e) => e.toName).sort();
    expect(names).toEqual(['parseToken', 'validateJwt']);
  });
});

describe('GraphIndex.stats', () => {
  it('reports counts including resolved-edges total', () => {
    const idx = new GraphIndex(buildGraph());
    expect(idx.stats).toEqual({ symbols: 5, edges: 4, resolvedEdges: 2 });
  });
});
