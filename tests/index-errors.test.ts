import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, indexErrorMessage } from '../src/mcp.js';
import { loadGraphResult, saveGraph, repoDir, type Graph } from '../src/storage.js';
import { indexDirectory } from '../src/indexer.js';

function minimalGraph(root: string): Graph {
  return {
    version: 2,
    repoId: 'idxerr0000000000',
    rootPath: root,
    indexedAt: '2026-06-17T00:00:00.000Z',
    filesIndexed: 1,
    symbolCount: 1,
    edgeCount: 0,
    symbols: [
      {
        id: 'a.ts#alpha@1',
        name: 'alpha',
        kind: 'function',
        file: 'a.ts',
        line: 1,
        column: 1,
        endLine: 1,
        signature: 'function alpha() {}',
        exported: true,
      },
    ],
    edges: [],
  };
}

// ---------------------------------------------------------------------------
// #67 + #69 — pure error-message policy (no FS, no cache)
// ---------------------------------------------------------------------------

describe('indexErrorMessage', () => {
  const req = '/x';
  const root = '/x';

  it('missing index → "no index" message naming the remedy', () => {
    const m = indexErrorMessage(req, root, undefined, 'missing');
    expect(m).toMatch(/No GraphPilot index found/);
    expect(m).toMatch(/graphpilot index/);
  });

  it('corrupt reasons → a distinct "corrupt" message, never "no index"', () => {
    for (const reason of ['schema-invalid', 'invalid-json', 'root-mismatch'] as const) {
      const m = indexErrorMessage(req, root, undefined, reason);
      expect(m, reason).toMatch(/corrupt/i);
      expect(m, reason).not.toMatch(/No GraphPilot index found/);
    }
  });

  it('#69: a non-ENOENT stat error → "unreadable" (transient), never "no index"', () => {
    const m = indexErrorMessage(req, root, 'EACCES', null);
    expect(m).toMatch(/unreadable/i);
    expect(m).not.toMatch(/No GraphPilot index found/);
  });

  it('#20: a stale-version graph → "older version" re-index message, not "is corrupt"', () => {
    const m = indexErrorMessage(req, root, undefined, 'stale-version');
    expect(m).toMatch(/older version/i);
    expect(m).not.toMatch(/exists but is corrupt/i); // distinct from the corrupt-index message
    expect(m).not.toMatch(/No GraphPilot index found/);
  });

  it('#69: ENOENT stat + missing load → treated as a normal missing index', () => {
    expect(indexErrorMessage(req, root, 'ENOENT', 'missing')).toMatch(/No GraphPilot index found/);
  });

  it('successful load → null (no error to report)', () => {
    expect(indexErrorMessage(req, root, undefined, null)).toBeNull();
    expect(indexErrorMessage(req, root, 'ENOENT', null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #67 — loadGraphResult reports *why* a graph failed to load
// ---------------------------------------------------------------------------

describe('loadGraphResult reasons', () => {
  let workRoot: string;

  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), 'gp-idxerr-'));
  });
  afterEach(() => {
    if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
    const d = repoDir(workRoot);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  });

  it('missing when no graph.json exists', () => {
    expect(loadGraphResult(workRoot)).toEqual({ ok: false, reason: 'missing' });
  });

  it('invalid-json when the file is not JSON', () => {
    mkdirSync(repoDir(workRoot), { recursive: true });
    writeFileSync(join(repoDir(workRoot), 'graph.json'), '{ not json ');
    expect(loadGraphResult(workRoot)).toMatchObject({ ok: false, reason: 'invalid-json' });
  });

  it('stale-version when the graph was built by an older schema', () => {
    mkdirSync(repoDir(workRoot), { recursive: true });
    writeFileSync(
      join(repoDir(workRoot), 'graph.json'),
      JSON.stringify({ ...minimalGraph(workRoot), version: 1 }),
    );
    expect(loadGraphResult(workRoot)).toMatchObject({ ok: false, reason: 'stale-version' });
  });

  it('schema-invalid when structurally malformed (version ok)', () => {
    mkdirSync(repoDir(workRoot), { recursive: true });
    writeFileSync(
      join(repoDir(workRoot), 'graph.json'),
      JSON.stringify({ ...minimalGraph(workRoot), symbols: 'not-an-array' }),
    );
    expect(loadGraphResult(workRoot)).toMatchObject({ ok: false, reason: 'schema-invalid' });
  });

  it('root-mismatch when the stored rootPath belongs to another repo', () => {
    mkdirSync(repoDir(workRoot), { recursive: true });
    writeFileSync(
      join(repoDir(workRoot), 'graph.json'),
      JSON.stringify(minimalGraph('/some/other/repo')),
    );
    expect(loadGraphResult(workRoot)).toMatchObject({ ok: false, reason: 'root-mismatch' });
  });

  it('ok round-trips a valid graph', () => {
    saveGraph(minimalGraph(workRoot));
    const r = loadGraphResult(workRoot);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.graph.symbols[0].name).toBe('alpha');
  });

  it('loadGraph wrapper still returns null on any failure', () => {
    // sanity: existing callers (CLI status, doctor) keep their Graph | null contract
    const r = loadGraphResult(workRoot);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #67 — end to end: the three response shapes are distinguishable by the agent
// ---------------------------------------------------------------------------

describe('gp_recall response shape: missing vs corrupt vs zero-result', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let validDir: string;
  let missingDir: string;
  let corruptDir: string;

  beforeAll(async () => {
    validDir = mkdtempSync(join(tmpdir(), 'gp-idxerr-valid-'));
    writeFileSync(join(validDir, 'a.ts'), 'export function alpha() { return 1; }\n');
    const result = await indexDirectory(validDir);
    saveGraph({
      version: 2,
      repoId: 'validdir00000000',
      rootPath: validDir,
      indexedAt: '2026-06-17T00:00:00.000Z',
      filesIndexed: result.filesIndexed,
      symbolCount: result.symbols.length,
      edgeCount: result.edges.length,
      symbols: result.symbols,
      edges: result.edges,
    });

    missingDir = mkdtempSync(join(tmpdir(), 'gp-idxerr-missing-'));

    corruptDir = mkdtempSync(join(tmpdir(), 'gp-idxerr-corrupt-'));
    mkdirSync(repoDir(corruptDir), { recursive: true });
    writeFileSync(join(repoDir(corruptDir), 'graph.json'), '{ corrupt not json ');

    server = buildMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'idxerr-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    for (const d of [validDir, missingDir, corruptDir]) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
      const rd = repoDir(d);
      if (existsSync(rd)) rmSync(rd, { recursive: true, force: true });
    }
  });

  const call = async (path: string): Promise<{ isError: boolean; text: string }> => {
    const res = await client.callTool({ name: 'gp_recall', arguments: { query: 'nope', path } });
    const content = res.content as Array<{ type: string; text: string }>;
    return { isError: res.isError === true, text: content[0]?.text ?? '' };
  };

  it('missing index → isError + "No GraphPilot index"', async () => {
    const r = await call(missingDir);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No GraphPilot index found/);
  });

  it('corrupt index → isError + "corrupt" (distinct from missing)', async () => {
    const r = await call(corruptDir);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/corrupt/i);
    expect(r.text).not.toMatch(/No GraphPilot index found/);
  });

  it('valid index, no match → NOT isError (a normal empty result)', async () => {
    const r = await call(validDir);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/No symbols match/);
  });
});
