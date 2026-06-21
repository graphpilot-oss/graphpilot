import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcpServers } from '../src/mcp-register.js';
import type { ClientId } from '../src/init.js';

const WRITE_PROMPT = async (): Promise<'write' | 'skip'> => 'write';
const SKIP_PROMPT = async (): Promise<'write' | 'skip'> => 'skip';

describe('registerMcpServers', () => {
  let dir: string;
  let cfg: string;
  const pathFor = (_id: ClientId): string => cfg;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gp-register-'));
    cfg = join(dir, 'mcp.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a fresh config when none exists', async () => {
    const res = await registerMcpServers({
      clients: ['cursor'],
      prompt: WRITE_PROMPT,
      configPathFor: pathFor,
    });
    expect(res[0].action).toBe('registered');
    const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(parsed.mcpServers.graphpilot).toEqual({ command: 'graphpilot', args: ['mcp'] });
  });

  it('preserves unrelated keys and existing servers, and backs up', async () => {
    writeFileSync(
      cfg,
      JSON.stringify({
        editorTheme: 'dark',
        mcpServers: { other: { command: 'other-tool' } },
      }),
    );
    const res = await registerMcpServers({
      clients: ['cursor'],
      prompt: WRITE_PROMPT,
      configPathFor: pathFor,
    });
    expect(res[0].action).toBe('registered');
    const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(parsed.editorTheme).toBe('dark'); // unrelated top-level key kept
    expect(parsed.mcpServers.other).toEqual({ command: 'other-tool' }); // sibling server kept
    expect(parsed.mcpServers.graphpilot).toEqual({ command: 'graphpilot', args: ['mcp'] });
    expect(existsSync(cfg + '.bak-graphpilot')).toBe(true); // original backed up
  });

  it('is idempotent — an existing graphpilot entry is a no-op', async () => {
    const original = JSON.stringify({ mcpServers: { graphpilot: { command: 'custom' } } });
    writeFileSync(cfg, original);
    const res = await registerMcpServers({
      clients: ['cursor'],
      prompt: WRITE_PROMPT,
      configPathFor: pathFor,
    });
    expect(res[0].action).toBe('already-registered');
    expect(readFileSync(cfg, 'utf8')).toBe(original); // unchanged — user's value preserved
    expect(existsSync(cfg + '.bak-graphpilot')).toBe(false); // no backup, no write
  });

  it('dry-run does not create or modify the config', async () => {
    const res = await registerMcpServers({
      clients: ['cursor'],
      dryRun: true,
      prompt: WRITE_PROMPT,
      configPathFor: pathFor,
    });
    expect(res[0].action).toBe('dry-run');
    expect(existsSync(cfg)).toBe(false);
  });

  it('leaves an invalid-JSON config untouched', async () => {
    const garbage = '{ this is not json ';
    writeFileSync(cfg, garbage);
    const res = await registerMcpServers({
      clients: ['cursor'],
      prompt: WRITE_PROMPT,
      configPathFor: pathFor,
    });
    expect(res[0].action).toBe('error');
    expect(readFileSync(cfg, 'utf8')).toBe(garbage); // not clobbered
  });

  it('does not write when the prompt declines', async () => {
    const res = await registerMcpServers({
      clients: ['cursor'],
      prompt: SKIP_PROMPT,
      configPathFor: pathFor,
    });
    expect(res[0].action).toBe('skipped');
    expect(existsSync(cfg)).toBe(false);
  });

  it('marks Continue as unsupported (different schema, not auto-edited)', async () => {
    const res = await registerMcpServers({
      clients: ['continue'],
      prompt: WRITE_PROMPT,
      configPathFor: pathFor,
    });
    expect(res[0].action).toBe('unsupported');
    expect(existsSync(cfg)).toBe(false);
  });

  it('supports at least Cursor, Claude Code, and Cline', async () => {
    const paths: Record<string, string> = {};
    const multiPathFor = (id: ClientId): string => {
      paths[id] = join(dir, `${id}.json`);
      return paths[id];
    };
    const res = await registerMcpServers({
      clients: ['cursor', 'claude-code', 'cline'],
      prompt: WRITE_PROMPT,
      configPathFor: multiPathFor,
    });
    expect(res.map((r) => r.action)).toEqual(['registered', 'registered', 'registered']);
    for (const id of ['cursor', 'claude-code', 'cline']) {
      const parsed = JSON.parse(readFileSync(paths[id], 'utf8'));
      expect(parsed.mcpServers.graphpilot.command).toBe('graphpilot');
    }
  });
});
