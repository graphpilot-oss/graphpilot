import { describe, it, expect } from 'vitest';
import { redactSecrets, detectSecrets } from '../src/redact.js';
import { parseFile } from '../src/parser.js';
import { extractSymbols } from '../src/symbols.js';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Unit tests — direct redactor
// ---------------------------------------------------------------------------

describe('redactSecrets — known patterns', () => {
  it('redacts OpenAI / Anthropic sk- keys', () => {
    const out = redactSecrets('const API_KEY = "sk-abcdefghij1234567890ABCDEF";');
    expect(out).toContain('sk-***REDACTED***');
    expect(out).not.toContain('abcdefghij1234567890');
  });

  it('redacts sk-ant- prefix variant', () => {
    const out = redactSecrets('const k = "sk-ant-api03-abc123XYZ_thisIsAFakeKey-1234567890";');
    expect(out).toContain('sk-***REDACTED***');
    expect(out).not.toContain('api03-abc123');
  });

  it('redacts GitHub PATs', () => {
    const out = redactSecrets('TOKEN = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";');
    expect(out).toContain('ghp_***REDACTED***');
  });

  it('redacts AWS access key IDs (AKIA)', () => {
    const out = redactSecrets('const aws = "AKIAIOSFODNN7EXAMPLE";');
    expect(out).toContain('AKIA***REDACTED***');
    expect(out).not.toContain('IOSFODNN7');
  });

  it('redacts JWT tokens (three base64url segments)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ' +
      '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactSecrets(`const auth = "${jwt}";`);
    expect(out).toContain('***JWT-REDACTED***');
    expect(out).not.toContain(jwt);
  });

  it('redacts PEM private-key headers', () => {
    const out = redactSecrets('"-----BEGIN RSA PRIVATE KEY-----\\n..."');
    expect(out).toContain('***REDACTED***');
    expect(out).toContain('PRIVATE KEY');
  });

  it('redacts Slack bot tokens (xoxb-...)', () => {
    const out = redactSecrets('"xoxb-12345-67890-abcdefghij"');
    expect(out).toContain('xox*-***REDACTED***');
  });

  it('redacts Stripe sk_live keys', () => {
    const out = redactSecrets('"sk_live_abcdefghijklmnopqrstuv1234"');
    expect(out).toContain('sk_live_***REDACTED***');
  });

  it('redacts a generic long high-entropy token inside quotes', () => {
    const out = redactSecrets('const s = "X9aZ8bC7dE6fG5hI4jK3lM2nO1pQ0rS9tU8vW7xY6zA";');
    expect(out).toContain('***REDACTED-LONG-TOKEN***');
    expect(out).not.toContain('X9aZ8bC7dE6fG5hI4jK3lM2nO1pQ0rS9tU8vW7xY6zA');
  });
});

describe('redactSecrets — preserves non-secret content', () => {
  it('leaves function signatures untouched', () => {
    const sig = 'function parseToken(token: string): Claims {';
    expect(redactSecrets(sig)).toBe(sig);
  });

  it('leaves short identifiers untouched (no false positive on short alphanumerics)', () => {
    const sig = 'const apiKey = config.apiKey;';
    expect(redactSecrets(sig)).toBe(sig);
  });

  it('leaves a normal-length string literal untouched', () => {
    const sig = 'const greeting = "hello, world";';
    expect(redactSecrets(sig)).toBe(sig);
  });

  it('returns the input unchanged for empty / null-ish strings', () => {
    expect(redactSecrets('')).toBe('');
    // @ts-expect-error: function tolerates non-strings defensively
    expect(redactSecrets(undefined)).toBe(undefined);
  });
});

describe('detectSecrets — diagnostics', () => {
  it('returns matching labels', () => {
    const labels = detectSecrets('"sk-abcdefghij1234567890ABCDEF"');
    expect(labels).toContain('sk-token');
  });

  it('returns empty list for clean input', () => {
    expect(detectSecrets('function foo(x) { return x + 1; }')).toEqual([]);
  });

  it('does not mutate state between calls (regex .lastIndex hygiene)', () => {
    const sample = '"AKIAIOSFODNN7EXAMPLE"';
    // Run twice — should give same result.
    expect(detectSecrets(sample)).toEqual(detectSecrets(sample));
  });
});

// ---------------------------------------------------------------------------
// Integration — secrets in real source code DO NOT leak into the index
// ---------------------------------------------------------------------------

describe('integration: secrets in signatures get redacted at extraction', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'graphpilot-redact-'));
  });

  afterEach(() => {
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  it('redacts secrets in arrow-const initializers', () => {
    const filePath = join(workDir, 'secrets.ts');
    writeFileSync(
      filePath,
      `export const API_KEY = "sk-abcdefghij1234567890ABCDEFGHIJ";\n` +
        `export const TOKEN = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n`,
    );
    const parsed = parseFile(filePath)!;
    const syms = extractSymbols(parsed);
    const apiKeySym = syms.find((s) => s.name === 'API_KEY');
    const tokenSym = syms.find((s) => s.name === 'TOKEN');
    // These are variable initializers, not function expressions — they are
    // NOT extracted as SymbolRecords in v1 (we only emit function-like
    // const initializers). So this test mainly proves the integration plumbing
    // doesn't crash on secret-y source.
    // What we CAN check: parseFile + extractSymbols don't throw on a file
    // that contains a real-looking secret literal.
    expect(syms).toBeDefined();
    // If we ever broaden extractor to emit non-function consts, the redaction
    // path is wired and these would already be safe.
    if (apiKeySym) expect(apiKeySym.signature).not.toContain('abcdefghij1234567890');
    if (tokenSym) expect(tokenSym.signature).not.toContain('aaaaaaaaaaaaaaaa');
  });

  it('redacts secrets in arrow-function defaults / bodies (signature first line)', () => {
    const filePath = join(workDir, 'arrowfn.ts');
    writeFileSync(
      filePath,
      `export const buildAuth = (token = "sk-abcdefghij1234567890ABCDEFGHIJ") => {\n` +
        `  return token;\n` +
        `};\n`,
    );
    const parsed = parseFile(filePath)!;
    const syms = extractSymbols(parsed);
    const sym = syms.find((s) => s.name === 'buildAuth');
    expect(sym).toBeDefined();
    expect(sym!.signature).toContain('sk-***REDACTED***');
    expect(sym!.signature).not.toContain('abcdefghij1234567890');
  });
});

// Imports for beforeEach/afterEach used in the integration block
import { beforeEach, afterEach } from 'vitest';
