import { describe, it, expect } from 'vitest';
import {
  symbolProvenance,
  edgeProvenance,
  formatProvenance,
  formatEvidenceTag,
} from '../src/provenance.js';
import type { SymbolRecord } from '../src/symbols.js';
import type { CallEdge } from '../src/edges.js';

const SAMPLE_SYMBOL: SymbolRecord = {
  id: 'src/auth.ts#parseToken@42',
  name: 'parseToken',
  kind: 'function',
  file: 'src/auth.ts',
  line: 42,
  column: 1,
  endLine: 58,
  signature: 'function parseToken(token: string): Claims {',
  exported: true,
};

const SAMPLE_EDGE: CallEdge = {
  fromId: 'src/api.ts#handleLogin@10',
  toId: 'src/auth.ts#parseToken@42',
  toName: 'parseToken',
  file: 'src/api.ts',
  line: 17,
  column: 12,
};

describe('symbolProvenance', () => {
  it('captures the symbol location + signature excerpt + sha', () => {
    const p = symbolProvenance(SAMPLE_SYMBOL, 'abc1234');
    expect(p).toMatchObject({
      file: 'src/auth.ts',
      line: 42,
      column: 1,
      endLine: 58,
      sha: 'abc1234',
    });
    expect(p.excerpt).toMatch(/parseToken/);
  });

  it('sets sha to null when no git sha is available', () => {
    const p = symbolProvenance(SAMPLE_SYMBOL, null);
    expect(p.sha).toBeNull();
  });

  it('clips a long excerpt with an ellipsis', () => {
    const long = 'function ' + 'x'.repeat(500);
    const p = symbolProvenance({ ...SAMPLE_SYMBOL, signature: long }, null);
    expect(p.excerpt!.length).toBeLessThanOrEqual(200);
    expect(p.excerpt!.endsWith('…')).toBe(true);
  });

  it('drops the excerpt when the signature is empty', () => {
    const p = symbolProvenance({ ...SAMPLE_SYMBOL, signature: '' }, null);
    expect(p.excerpt).toBeUndefined();
  });
});

describe('edgeProvenance', () => {
  it('captures the call-site location + sha (no excerpt — v0.1)', () => {
    const p = edgeProvenance(SAMPLE_EDGE, 'def5678');
    expect(p).toMatchObject({
      file: 'src/api.ts',
      line: 17,
      column: 12,
      sha: 'def5678',
    });
    expect(p.excerpt).toBeUndefined();
  });

  it('sets sha to null when not in a git repo', () => {
    const p = edgeProvenance(SAMPLE_EDGE, null);
    expect(p.sha).toBeNull();
  });
});

describe('formatProvenance', () => {
  it('formats a minimal provenance as file:line', () => {
    expect(
      formatProvenance({
        file: 'src/auth.ts',
        line: 42,
      }),
    ).toBe('src/auth.ts:42');
  });

  it('includes column when present', () => {
    expect(
      formatProvenance({
        file: 'src/auth.ts',
        line: 42,
        column: 5,
      }),
    ).toBe('src/auth.ts:42:5');
  });

  it('appends sha when present', () => {
    expect(
      formatProvenance({
        file: 'src/auth.ts',
        line: 42,
        sha: 'abc1234',
      }),
    ).toBe('src/auth.ts:42 @ abc1234');
  });

  it('omits sha when null or undefined', () => {
    expect(
      formatProvenance({
        file: 'src/auth.ts',
        line: 42,
        sha: null,
      }),
    ).toBe('src/auth.ts:42');
  });
});

describe('formatEvidenceTag', () => {
  it('wraps the provenance in [evidence: ...]', () => {
    expect(
      formatEvidenceTag({
        file: 'src/auth.ts',
        line: 42,
        sha: 'abc1234',
      }),
    ).toBe('[evidence: src/auth.ts:42 @ abc1234]');
  });
});
