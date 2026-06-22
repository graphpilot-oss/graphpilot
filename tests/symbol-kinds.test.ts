import { describe, it, expect, afterAll } from 'vitest';
import { parseFile } from '../src/parser.js';
import { extractSymbols, type SymbolRecord } from '../src/symbols.js';
import { saveGraph, loadGraphResult, repoDir, type Graph } from '../src/storage.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'symbol-kinds.ts');

function symbolsOf(): SymbolRecord[] {
  const parsed = parseFile(fixture);
  if (!parsed) throw new Error('parse failed');
  return extractSymbols(parsed);
}

function findOne(syms: SymbolRecord[], name: string, kind?: string): SymbolRecord {
  const matches = syms.filter((s) => s.name === name && (!kind || s.kind === kind));
  if (matches.length !== 1) {
    throw new Error(`expected 1 match for ${name}/${kind ?? '*'}, got ${matches.length}`);
  }
  return matches[0];
}

describe('extractSymbols — #22 symbol kinds', () => {
  const syms = symbolsOf();

  it('classifies getters and setters distinctly (not plain methods)', () => {
    expect(findOne(syms, 'name', 'getter').parent).toBe('User');
    expect(findOne(syms, 'name', 'setter').parent).toBe('User');
  });

  it('flags static members', () => {
    const create = findOne(syms, 'create', 'method');
    expect(create.static).toBe(true);
    expect(create.parent).toBe('User');
  });

  it('leaves instance methods un-flagged', () => {
    const greet = findOne(syms, 'greet', 'method');
    expect(greet.static).toBeUndefined();
  });

  it('captures extends / implements on a class', () => {
    const user = findOne(syms, 'User', 'class');
    expect(user.extends).toEqual(['Base']);
    expect(user.implements).toEqual(['Greeter']);
  });

  it('sets namespace as the parent of namespaced functions', () => {
    expect(findOne(syms, 'area', 'function').parent).toBe('Geometry');
  });

  it('extracts an anonymous `export default function` as "default"', () => {
    expect(findOne(syms, 'default', 'function').exported).toBe(true);
  });

  it('extracts a const with an inline function-type annotation', () => {
    expect(findOne(syms, 'handler', 'variable').exported).toBe(true);
  });

  it('extracts object-literal methods and function-valued properties', () => {
    expect(findOne(syms, 'doThing', 'method').parent).toBe('obj');
    expect(findOne(syms, 'arrowProp', 'variable').parent).toBe('obj');
  });
});

describe('graph-schema — #22 fields survive the T4 load round-trip', () => {
  // Unique temp root → isolated ~/.graphpilot/<hash> slot (see graph-schema.test.ts).
  const workRoot = join(here, 'fixtures', '__rt_symbol_kinds__');

  afterAll(() => {
    const d = repoDir(workRoot);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  });

  it('round-trips getter/setter kinds + static + extends/implements', () => {
    const symbols = symbolsOf();
    const graph: Graph = {
      version: 1,
      repoId: 'symkinds00000000',
      rootPath: workRoot,
      indexedAt: '2026-06-18T00:00:00.000Z',
      filesIndexed: 1,
      symbolCount: symbols.length,
      edgeCount: 0,
      symbols,
      edges: [],
    };
    saveGraph(graph);
    const res = loadGraphResult(workRoot);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const back = res.graph.symbols;
    expect(back.find((s) => s.name === 'name' && s.kind === 'getter')).toBeDefined();
    expect(back.find((s) => s.name === 'name' && s.kind === 'setter')).toBeDefined();
    expect(back.find((s) => s.name === 'create')?.static).toBe(true);
    const user = back.find((s) => s.name === 'User' && s.kind === 'class');
    expect(user?.extends).toEqual(['Base']);
    expect(user?.implements).toEqual(['Greeter']);
  });
});
