import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  logInteraction,
  sanitizeInput,
  withInteractionLog,
} from '../src/interactions.js';
import { repoDir, repoIdFor } from '../src/storage.js';

const isWindows = process.platform === 'win32';

/**
 * The interactions log lives under ~/.graphpilot/<id>/. We use a fresh fake
 * "repo path" per test so we can locate the resulting file deterministically
 * without touching real indexed repos.
 */
let fakeRepoRoot: string;

function logPath(repoRoot: string): string {
  return join(repoDir(repoRoot), 'interactions.jsonl');
}

beforeEach(() => {
  // A path that won't collide with the user's real graphpilot dirs.
  fakeRepoRoot = mkdtempSync(join(tmpdir(), 'graphpilot-log-fake-'));
  // Make sure no stale log exists for this path's repoId.
  const dir = repoDir(fakeRepoRoot);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  // Clean both the source tmpdir and the ~/.graphpilot/<id>/ dir we created.
  if (existsSync(fakeRepoRoot)) rmSync(fakeRepoRoot, { recursive: true, force: true });
  const dir = repoDir(fakeRepoRoot);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  // Reset env between tests
  delete process.env.GRAPHPILOT_NO_LOG;
});

// ---------------------------------------------------------------------------
// sanitizeInput
// ---------------------------------------------------------------------------

describe('sanitizeInput', () => {
  it('passes through plain primitives', () => {
    expect(sanitizeInput({ a: 1, b: 'hi', c: true })).toEqual({
      a: 1,
      b: 'hi',
      c: true,
    });
  });

  it('strips control characters from strings', () => {
    const raw = `before\n\tafter`;
    const out = sanitizeInput({ s: raw });
    // Newlines become spaces — defends against forged JSONL lines.
    expect(out.s).not.toContain('\n');
    expect(out.s).not.toContain('');
  });

  it('caps long strings', () => {
    const raw = 'x'.repeat(2000);
    const out = sanitizeInput({ s: raw });
    expect((out.s as string).length).toBeLessThan(2000);
  });

  it('replaces unloggable types with a marker', () => {
    const out = sanitizeInput({ fn: () => 1, obj: { nested: true } });
    expect(out.fn).toMatch(/unloggable/);
    expect(out.obj).toMatch(/unloggable/);
  });

  it('drops keys with pathologically long names', () => {
    const out = sanitizeInput({ ['x'.repeat(100)]: 1 });
    expect(Object.keys(out).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// logInteraction
// ---------------------------------------------------------------------------

describe('logInteraction', () => {
  it('appends a single JSONL line per call', () => {
    logInteraction(fakeRepoRoot, {
      ts: '2026-05-17T20:00:00Z',
      tool: 'gp_recall',
      input: { query: 'parseToken' },
      results: 1,
      durationMs: 4,
    });
    logInteraction(fakeRepoRoot, {
      ts: '2026-05-17T20:00:01Z',
      tool: 'gp_callers',
      input: { symbol: 'parseToken' },
      results: 3,
      durationMs: 7,
    });

    const text = readFileSync(logPath(fakeRepoRoot), 'utf8');
    const lines = text.trim().split('\n');
    expect(lines.length).toBe(2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    expect(a.tool).toBe('gp_recall');
    expect(b.tool).toBe('gp_callers');
    expect(a.input.query).toBe('parseToken');
  });

  it('writes the log file with mode 0600', { skip: isWindows }, () => {
    logInteraction(fakeRepoRoot, {
      ts: '2026-05-17T20:00:00Z',
      tool: 'gp_stats',
      input: {},
      results: 1,
      durationMs: 1,
    });
    const mode = statSync(logPath(fakeRepoRoot)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('respects GRAPHPILOT_NO_LOG=1', () => {
    process.env.GRAPHPILOT_NO_LOG = '1';
    logInteraction(fakeRepoRoot, {
      ts: '2026-05-17T20:00:00Z',
      tool: 'gp_stats',
      input: {},
      results: 1,
      durationMs: 1,
    });
    expect(existsSync(logPath(fakeRepoRoot))).toBe(false);
  });

  it('records errors in the entry', () => {
    logInteraction(fakeRepoRoot, {
      ts: '2026-05-17T20:00:00Z',
      tool: 'gp_recall',
      input: { query: 'x' },
      results: 0,
      durationMs: 2,
      error: 'something broke',
    });
    const entry = JSON.parse(
      readFileSync(logPath(fakeRepoRoot), 'utf8').trim(),
    );
    expect(entry.error).toBe('something broke');
  });
});

// ---------------------------------------------------------------------------
// withInteractionLog
// ---------------------------------------------------------------------------

describe('withInteractionLog', () => {
  it('logs a successful call and returns the value', async () => {
    const out = await withInteractionLog(
      fakeRepoRoot,
      'gp_recall',
      { query: 'parseToken' },
      async () => ({
        value: { content: [{ type: 'text', text: 'ok' }] },
        results: 1,
      }),
    );
    expect(out).toEqual({ content: [{ type: 'text', text: 'ok' }] });

    const entry = JSON.parse(
      readFileSync(logPath(fakeRepoRoot), 'utf8').trim(),
    );
    expect(entry.tool).toBe('gp_recall');
    expect(entry.results).toBe(1);
    expect(typeof entry.durationMs).toBe('number');
  });

  it('logs a thrown error and re-throws', async () => {
    await expect(
      withInteractionLog(fakeRepoRoot, 'gp_recall', { query: 'x' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const entry = JSON.parse(
      readFileSync(logPath(fakeRepoRoot), 'utf8').trim(),
    );
    expect(entry.error).toBe('boom');
    expect(entry.results).toBe(0);
  });
});
