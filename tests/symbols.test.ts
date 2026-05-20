import { describe, it, expect } from 'vitest';
import { parseFile } from '../src/parser.js';
import { extractSymbols, type SymbolRecord } from '../src/symbols.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', name);

function symbolsOf(filename: string): SymbolRecord[] {
  const parsed = parseFile(fixture(filename));
  if (!parsed) throw new Error('parse failed');
  return extractSymbols(parsed);
}

function findOne(syms: SymbolRecord[], name: string, kind?: string) {
  const matches = syms.filter((s) => s.name === name && (!kind || s.kind === kind));
  if (matches.length !== 1) {
    throw new Error(`expected 1 match for ${name}/${kind ?? '*'}, got ${matches.length}`);
  }
  return matches[0];
}

describe('extractSymbols', () => {
  const syms = symbolsOf('sample.ts');

  it('finds top-level functions', () => {
    const s = findOne(syms, 'parseToken', 'function');
    expect(s.exported).toBe(true);
    expect(s.line).toBe(1);
    expect(s.signature).toContain('parseToken');
  });

  it('finds arrow-function consts as variables', () => {
    const s = findOne(syms, 'validateJwt', 'variable');
    expect(s.exported).toBe(true);
    expect(s.signature).toContain('validateJwt');
  });

  it('finds non-exported function expressions', () => {
    const s = findOne(syms, 'internalHelper', 'variable');
    expect(s.exported).toBe(false);
  });

  it('finds classes', () => {
    const s = findOne(syms, 'AuthService', 'class');
    expect(s.exported).toBe(true);
  });

  it('finds class methods with parent set', () => {
    const auth = findOne(syms, 'authenticate', 'method');
    expect(auth.parent).toBe('AuthService');
    const fetch = findOne(syms, 'fetchUser', 'method');
    expect(fetch.parent).toBe('AuthService');
  });

  it('finds interfaces', () => {
    const s = findOne(syms, 'Repository', 'interface');
    expect(s.exported).toBe(true);
  });

  it('finds type aliases', () => {
    const s = findOne(syms, 'UserId', 'type');
    expect(s.exported).toBe(true);
  });

  it('finds enums (non-exported)', () => {
    const s = findOne(syms, 'Role', 'enum');
    expect(s.exported).toBe(false);
  });

  it('assigns stable ids', () => {
    const s = findOne(syms, 'parseToken', 'function');
    expect(s.id).toBe(`${s.file}#parseToken@1`);
    const m = findOne(syms, 'authenticate', 'method');
    expect(m.id).toBe(`${m.file}#AuthService.authenticate@${m.line}`);
  });
});
