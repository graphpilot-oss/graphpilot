import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkNode,
  checkPathBin,
  checkStorageHome,
  checkIndex,
  checkClients,
  checkHandshake,
  defaultListTools,
  runDoctor,
  formatReport,
  type CheckResult,
} from '../src/doctor.js';
import type { Graph } from '../src/storage.js';

const isWindows = process.platform === 'win32';

function makeGraph(over: Partial<Graph> = {}): Graph {
  return {
    version: 2,
    repoId: 'abc123',
    rootPath: '/repo',
    indexedAt: '2026-06-11T00:00:00.000Z',
    filesIndexed: 3,
    symbolCount: 10,
    edgeCount: 5,
    symbols: [],
    edges: [],
    ...over,
  };
}

describe('checkNode', () => {
  it('passes on Node >= 20', () => {
    expect(checkNode('20.0.0').status).toBe('ok');
    expect(checkNode('22.11.0').status).toBe('ok');
  });
  it('fails below Node 20', () => {
    const r = checkNode('18.19.1');
    expect(r.status).toBe('fail');
    expect(r.fix).toBeDefined();
  });
  it('warns on an unparseable version', () => {
    expect(checkNode('not-a-version').status).toBe('warn');
  });
});

describe('checkPathBin', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gp-path-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ok when a graphpilot binary is on PATH', () => {
    const binName = isWindows ? 'graphpilot.cmd' : 'graphpilot';
    writeFileSync(join(dir, binName), '');
    const r = checkPathBin({ PATH: dir });
    expect(r.status).toBe('ok');
  });

  it('warns when graphpilot is not on PATH', () => {
    const r = checkPathBin({ PATH: dir });
    expect(r.status).toBe('warn');
    expect(r.fix).toBeDefined();
  });
});

describe('checkStorageHome', () => {
  it('warns when the storage dir does not exist', () => {
    const r = checkStorageHome(join(tmpdir(), 'gp-does-not-exist-xyz'));
    expect(r.status).toBe('warn');
  });

  it('is ok when the dir exists with 0700 perms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gp-home-'));
    try {
      if (!isWindows) chmodSync(dir, 0o700);
      expect(checkStorageHome(dir).status).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns on group/other-readable perms (POSIX only)', () => {
    if (isWindows) return; // NTFS ACLs — modes are ignored
    const dir = mkdtempSync(join(tmpdir(), 'gp-home-loose-'));
    try {
      chmodSync(dir, 0o755);
      expect(checkStorageHome(dir).status).toBe('warn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkIndex', () => {
  it('warns when there is no index', () => {
    const r = checkIndex('/repo', { loadGraph: () => null, getRepoSha: () => null });
    expect(r.status).toBe('warn');
  });

  it('is ok when the index matches HEAD', () => {
    const r = checkIndex('/repo', {
      loadGraph: () => makeGraph({ indexedSha: 'deadbeef00000000' }),
      getRepoSha: () => 'deadbeef00000000',
    });
    expect(r.status).toBe('ok');
  });

  it('warns when the index is stale relative to HEAD', () => {
    const r = checkIndex('/repo', {
      loadGraph: () => makeGraph({ indexedSha: 'aaaaaaa0000' }),
      getRepoSha: () => 'bbbbbbb1111',
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/stale/i);
  });

  it('is ok for a non-git repo (no sha to compare)', () => {
    const r = checkIndex('/repo', {
      loadGraph: () => makeGraph({ indexedSha: null }),
      getRepoSha: () => null,
    });
    expect(r.status).toBe('ok');
  });
});

describe('checkClients', () => {
  it('warns when no clients are detected', () => {
    const r = checkClients({ detect: () => [], readConfig: () => null });
    expect(r.status).toBe('warn');
  });

  it('is ok when graphpilot is registered in every detected client', () => {
    const r = checkClients({
      detect: () => ['cursor'],
      readConfig: () => '{ "mcpServers": { "graphpilot": { "command": "graphpilot" } } }',
    });
    expect(r.status).toBe('ok');
  });

  it('warns when a detected client lacks the graphpilot entry', () => {
    const r = checkClients({
      detect: () => ['cursor'],
      readConfig: () => '{ "mcpServers": {} }',
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/not registered/i);
  });
});

describe('checkHandshake', () => {
  it('is ok when all four tools are listed', async () => {
    const r = await checkHandshake({
      listTools: async () => ['gp_index', 'gp_recall', 'gp_callers', 'gp_impact'],
    });
    expect(r.status).toBe('ok');
  });

  it('fails when a tool is missing', async () => {
    const r = await checkHandshake({
      listTools: async () => ['gp_index', 'gp_recall'],
    });
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/gp_callers/);
  });

  it('fails (does not hang) when the handshake times out', async () => {
    const r = await checkHandshake({
      listTools: () => new Promise<string[]>(() => {}), // never resolves
      timeoutMs: 50,
    });
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/timed out/i);
  });

  it('drives a real in-process handshake exposing the four tools', async () => {
    const names = await defaultListTools();
    for (const t of ['gp_index', 'gp_recall', 'gp_callers', 'gp_impact']) {
      expect(names).toContain(t);
    }
  });
});

describe('runDoctor', () => {
  it('returns all checks and a real-handshake ok on a supported Node', async () => {
    const report = await runDoctor({ repoPath: join(tmpdir(), 'gp-unindexed-repo-xyz') });
    const ids = report.checks.map((c) => c.id);
    expect(ids).toEqual(['node', 'path', 'storage', 'index', 'clients', 'handshake']);
    const handshake = report.checks.find((c) => c.id === 'handshake') as CheckResult;
    expect(handshake.status).toBe('ok');
  });

  it('formats a human-readable report with glyphs', () => {
    const text = formatReport({
      ok: false,
      checks: [
        { id: 'node', title: 'Node.js version', status: 'ok', detail: 'fine' },
        { id: 'x', title: 'Thing', status: 'fail', detail: 'broke', fix: 'do this' },
      ],
    });
    expect(text).toContain('✓ Node.js version');
    expect(text).toContain('✗ Thing');
    expect(text).toContain('↳ do this');
  });
});
