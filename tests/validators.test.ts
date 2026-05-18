import { describe, it, expect } from 'vitest';
import {
  validateGpIndex,
  validateGpRecall,
  validateGpCallers,
  validateGpStats,
} from '../src/validators.js';

describe('validateGpStats', () => {
  it('accepts empty object', () => {
    expect(validateGpStats({})).toEqual({ ok: true, value: { path: undefined } });
  });

  it('accepts a path', () => {
    expect(validateGpStats({ path: '/x' })).toEqual({
      ok: true,
      value: { path: '/x' },
    });
  });

  it('rejects non-object', () => {
    expect(validateGpStats('nope').ok).toBe(false);
    expect(validateGpStats(42).ok).toBe(false);
    expect(validateGpStats([]).ok).toBe(false);
  });

  it('rejects extra keys', () => {
    const r = validateGpStats({ path: '/x', sneaky: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sneaky/);
  });

  it('rejects non-string path', () => {
    const r = validateGpStats({ path: 42 });
    expect(r.ok).toBe(false);
  });
});

describe('validateGpIndex', () => {
  it('accepts empty (path defaults to cwd later)', () => {
    expect(validateGpIndex({}).ok).toBe(true);
  });
  it('accepts path', () => {
    const r = validateGpIndex({ path: '/repo' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.path).toBe('/repo');
  });
  it('rejects extra keys', () => {
    expect(validateGpIndex({ path: '/x', force: true }).ok).toBe(false);
  });
});

describe('validateGpRecall', () => {
  it('requires a non-empty query', () => {
    expect(validateGpRecall({}).ok).toBe(false);
    expect(validateGpRecall({ query: '' }).ok).toBe(false);
    expect(validateGpRecall({ query: '   ' }).ok).toBe(false);
  });

  it('accepts minimal valid input', () => {
    const r = validateGpRecall({ query: 'parseToken' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.query).toBe('parseToken');
      expect(r.value.limit).toBeUndefined();
      expect(r.value.substring).toBeUndefined();
    }
  });

  it('accepts full input', () => {
    const r = validateGpRecall({
      query: 'parse',
      limit: 25,
      substring: true,
      path: '/x',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.limit).toBe(25);
      expect(r.value.substring).toBe(true);
    }
  });

  it('caps limit range', () => {
    expect(validateGpRecall({ query: 'x', limit: 0 }).ok).toBe(false);
    expect(validateGpRecall({ query: 'x', limit: 51 }).ok).toBe(false);
    expect(validateGpRecall({ query: 'x', limit: 1.5 }).ok).toBe(false);
    expect(validateGpRecall({ query: 'x', limit: -1 }).ok).toBe(false);
  });

  it('rejects extra keys', () => {
    expect(validateGpRecall({ query: 'x', shellInjection: 'oops' }).ok).toBe(false);
  });

  it('rejects wrong types', () => {
    expect(validateGpRecall({ query: 42 }).ok).toBe(false);
    expect(validateGpRecall({ query: 'x', substring: 'yes' }).ok).toBe(false);
  });

  it('caps query length', () => {
    const r = validateGpRecall({ query: 'a'.repeat(500) });
    expect(r.ok).toBe(false);
  });
});

describe('validateGpCallers', () => {
  it('requires a non-empty symbol', () => {
    expect(validateGpCallers({}).ok).toBe(false);
    expect(validateGpCallers({ symbol: '' }).ok).toBe(false);
  });

  it('accepts minimal valid input', () => {
    const r = validateGpCallers({ symbol: 'parseToken' });
    expect(r.ok).toBe(true);
  });

  it('enforces direction enum', () => {
    expect(validateGpCallers({ symbol: 'x', direction: 'callers' }).ok).toBe(true);
    expect(validateGpCallers({ symbol: 'x', direction: 'callees' }).ok).toBe(true);
    expect(validateGpCallers({ symbol: 'x', direction: 'both' }).ok).toBe(false);
    expect(validateGpCallers({ symbol: 'x', direction: 42 }).ok).toBe(false);
  });

  it('caps limit at 100', () => {
    expect(validateGpCallers({ symbol: 'x', limit: 100 }).ok).toBe(true);
    expect(validateGpCallers({ symbol: 'x', limit: 101 }).ok).toBe(false);
  });

  it('rejects extra keys', () => {
    expect(validateGpCallers({ symbol: 'x', sql: 'drop table' }).ok).toBe(false);
  });
});
