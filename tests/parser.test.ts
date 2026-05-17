import { describe, it, expect } from 'vitest';
import { parseFile, listFunctions } from '../src/parser.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', name);

describe('parser', () => {
  it('parses a TypeScript file', () => {
    const parsed = parseFile(fixture('sample.ts'));
    expect(parsed).not.toBeNull();
    expect(parsed!.lang).toBe('typescript');
    expect(parsed!.tree.rootNode.type).toBe('program');
  });

  it('lists all function-like names in sample.ts', () => {
    const parsed = parseFile(fixture('sample.ts'))!;
    const names = listFunctions(parsed);
    expect(names).toContain('parseToken');
    expect(names).toContain('validateJwt');
    expect(names).toContain('internalHelper');
    expect(names).toContain('authenticate');
    expect(names).toContain('fetchUser');
  });

  it('returns null for unsupported extensions', () => {
    const parsed = parseFile(fixture('sample.ts').replace('.ts', '.txt'));
    expect(parsed).toBeNull();
  });
});
