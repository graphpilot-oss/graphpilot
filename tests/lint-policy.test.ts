/**
 * Meta-tests for the ESLint policy (T12).
 *
 * These tests use the ESLint Node API to verify that:
 *   - A `src/` file importing a banned network module is flagged
 *   - A `src/` file importing child_process is flagged
 *   - The same imports in tests/ and scripts/ are allowed (they need to
 *     spawn subprocesses for the smoke runner / bench harness)
 *
 * Why this matters: a future PR could quietly relax the rule. CI would
 * still pass because no current src/ file imports banned modules. These
 * tests assert that the policy stays in force by feeding ESLint
 * adversarial sources and checking the verdict.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint({ cwd: repoRoot });
});

// Helper: lint a synthetic file at a given (real) path with a given source.
// The path is required so the flat-config file-pattern matchers fire.
async function lintAs(filePath: string, source: string) {
  const results = await eslint.lintText(source, { filePath });
  return results[0];
}

describe('T12 — banned network imports in src/', () => {
  const bannedNetwork = [
    'http',
    'https',
    'node:http',
    'node:https',
    'undici',
    'axios',
    'node-fetch',
    'cross-fetch',
    'got',
  ];

  for (const mod of bannedNetwork) {
    it(`flags "import ... from '${mod}'" inside src/`, async () => {
      const result = await lintAs(
        join(repoRoot, 'src', '_fake.ts'),
        `import x from '${mod}';\nexport const v = x;\n`,
      );
      expect(result.errorCount).toBeGreaterThanOrEqual(1);
      const restricted = result.messages.find((m) => m.ruleId === 'no-restricted-imports');
      expect(restricted).toBeDefined();
      expect(restricted!.message).toContain('No network in src/');
    });
  }
});

describe('T6 — child_process banned in src/', () => {
  for (const mod of ['child_process', 'node:child_process']) {
    it(`flags "import ... from '${mod}'" inside src/`, async () => {
      const result = await lintAs(
        join(repoRoot, 'src', '_fake.ts'),
        `import cp from '${mod}';\nexport const v = cp;\n`,
      );
      expect(result.errorCount).toBeGreaterThanOrEqual(1);
      const restricted = result.messages.find((m) => m.ruleId === 'no-restricted-imports');
      expect(restricted).toBeDefined();
      expect(restricted!.message).toContain('No child_process in src/');
    });
  }
});

describe('Looser rules in tests/ and scripts/', () => {
  it('allows child_process inside tests/ (subprocess test needs it)', async () => {
    const result = await lintAs(
      join(repoRoot, 'tests', '_fake.test.ts'),
      `import cp from 'child_process';\nexport const v = cp;\n`,
    );
    const restricted = result.messages.find((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toBeUndefined();
  });

  it('allows child_process inside scripts/', async () => {
    const result = await lintAs(
      join(repoRoot, 'scripts', '_fake.mjs'),
      `import cp from 'child_process';\nexport const v = cp;\n`,
    );
    const restricted = result.messages.find((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toBeUndefined();
  });
});

describe('Normal imports in src/ pass clean', () => {
  it('allows internal imports in src/', async () => {
    const result = await lintAs(
      join(repoRoot, 'src', '_fake.ts'),
      `import { join } from 'node:path';\nexport const v = join('a', 'b');\n`,
    );
    const restricted = result.messages.find((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toBeUndefined();
  });
});
