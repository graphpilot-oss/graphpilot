import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from '../src/mcp.js';
import { indexDirectory } from '../src/indexer.js';
import { saveGraph, repoIdFor, type Graph } from '../src/storage.js';

/**
 * End-to-end test: spin up the MCP server in-process, paired with an MCP
 * client over an in-memory transport. Exercises the full protocol path
 * (initialize -> tools/list -> tools/call) without spawning a subprocess.
 */

let workDir: string;
let client: Client;

beforeAll(async () => {
  // Make a tiny repo and index it so gp_stats has something to report.
  workDir = mkdtempSync(join(tmpdir(), 'graphpilot-mcp-'));
  writeFileSync(join(workDir, 'hello.ts'), 'export function hello() { return 1; }\n');
  const result = await indexDirectory(workDir);
  const graph: Graph = {
    version: 1,
    repoId: repoIdFor(workDir),
    rootPath: workDir,
    indexedAt: new Date().toISOString(),
    filesIndexed: result.filesIndexed,
    symbolCount: result.symbols.length,
    edgeCount: result.edges.length,
    symbols: result.symbols,
    edges: result.edges,
  };
  saveGraph(graph);

  // Wire client + server over an in-memory pipe.
  const server = buildMcpServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'graphpilot-test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client?.close();
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('MCP server: protocol handshake + tool catalog', () => {
  it('lists the v0.1 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['gp_callers', 'gp_impact', 'gp_index', 'gp_recall', 'gp_stats']);
  });

  it('every tool has a description and an object input schema', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.inputSchema?.type).toBe('object');
    }
  });
});

describe('MCP server: gp_stats tool', () => {
  it('returns index summary for a known repo', async () => {
    const res = await client.callTool({
      name: 'gp_stats',
      arguments: { path: workDir },
    });
    expect(res.isError).not.toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    expect(text).toContain('Symbols:');
    expect(text).toContain('Calls:');
    expect(text).toContain(workDir);
  });

  it('returns a friendly error for an un-indexed path', async () => {
    const fakePath = join(tmpdir(), `graphpilot-noindex-${Date.now()}`);
    const res = await client.callTool({
      name: 'gp_stats',
      arguments: { path: fakePath },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)
      .map((c) => c.text)
      .join('\n');
    expect(text).toMatch(/No GraphPilot index/i);
  });
});

describe('MCP server: unknown tool', () => {
  it('responds with isError true for tools we did not register', async () => {
    // Call a tool that doesn't exist. The SDK may either throw or surface an
    // error in the response — we accept both shapes.
    let caught = false;
    let res: Awaited<ReturnType<Client['callTool']>> | null = null;
    try {
      res = await client.callTool({ name: 'gp_does_not_exist', arguments: {} });
    } catch {
      caught = true;
    }
    if (!caught) {
      expect(res?.isError).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Day-9 tools
// ---------------------------------------------------------------------------

function textOf(res: Awaited<ReturnType<Client['callTool']>>): string {
  return (res.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

describe('MCP server: gp_recall', () => {
  it('finds the seeded symbol by name', async () => {
    const res = await client.callTool({
      name: 'gp_recall',
      arguments: { query: 'hello', path: workDir },
    });
    expect(res.isError).not.toBe(true);
    const text = textOf(res);
    expect(text).toContain('hello');
    expect(text).toContain('hello.ts');
  });

  it('handles "no match" gracefully', async () => {
    const res = await client.callTool({
      name: 'gp_recall',
      arguments: { query: 'definitelyNotHere', path: workDir },
    });
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toMatch(/no symbols match/i);
  });

  it('rejects empty queries', async () => {
    const res = await client.callTool({
      name: 'gp_recall',
      arguments: { query: '', path: workDir },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Invalid input/i);
  });

  it('rejects unknown fields', async () => {
    const res = await client.callTool({
      name: 'gp_recall',
      arguments: { query: 'hello', shellOut: 'rm -rf', path: workDir },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/shellOut/);
  });

  it('rejects out-of-range limit', async () => {
    const res = await client.callTool({
      name: 'gp_recall',
      arguments: { query: 'hello', limit: 9999, path: workDir },
    });
    expect(res.isError).toBe(true);
  });
});

describe('MCP server: gp_callers', () => {
  it('returns isError when the symbol is unknown', async () => {
    const res = await client.callTool({
      name: 'gp_callers',
      arguments: { symbol: 'doesNotExist', path: workDir },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no symbol found/i);
  });

  it('rejects invalid direction', async () => {
    const res = await client.callTool({
      name: 'gp_callers',
      arguments: { symbol: 'hello', direction: 'sideways', path: workDir },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/direction/i);
  });

  it("returns 'no callers found' when target exists but nothing calls it", async () => {
    const res = await client.callTool({
      name: 'gp_callers',
      arguments: { symbol: 'hello', direction: 'callers', path: workDir },
    });
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toMatch(/no callers/i);
  });
});

describe('MCP server: gp_index', () => {
  it('re-indexes the repo end-to-end', async () => {
    const res = await client.callTool({
      name: 'gp_index',
      arguments: { path: workDir },
    });
    expect(res.isError).not.toBe(true);
    const text = textOf(res);
    expect(text).toContain('Indexed');
    expect(text).toContain('Files:');
    expect(text).toContain('Symbols:');
  });
});

describe('MCP server: gp_impact', () => {
  // Build a richer fixture with a real caller chain so blast-radius output
  // is non-trivial.
  let impactDir: string;

  beforeAll(async () => {
    impactDir = mkdtempSync(join(tmpdir(), 'graphpilot-mcp-impact-'));
    writeFileSync(
      join(impactDir, 'auth.ts'),
      `export function parseToken(t: string): string {\n` +
        `  return t.trim();\n` +
        `}\n` +
        `\n` +
        `export function authenticate(t: string): boolean {\n` +
        `  return parseToken(t).length > 0;\n` +
        `}\n`,
    );
    writeFileSync(
      join(impactDir, 'api.ts'),
      `import { parseToken } from './auth';\n` +
        `\n` +
        `export function handleLogin(t: string): string {\n` +
        `  return parseToken(t);\n` +
        `}\n`,
    );
    writeFileSync(
      join(impactDir, 'auth.test.ts'),
      `import { parseToken } from './auth';\n` +
        `\n` +
        `function testParse() {\n` +
        `  return parseToken('x');\n` +
        `}\n`,
    );

    const r = await indexDirectory(impactDir);
    saveGraph({
      version: 1,
      repoId: repoIdFor(impactDir),
      rootPath: impactDir,
      indexedAt: new Date().toISOString(),
      filesIndexed: r.filesIndexed,
      symbolCount: r.symbols.length,
      edgeCount: r.edges.length,
      symbols: r.symbols,
      edges: r.edges,
    });
  });

  afterAll(() => {
    if (impactDir && existsSync(impactDir)) {
      rmSync(impactDir, { recursive: true, force: true });
    }
  });

  it('returns isError when the symbol is unknown', async () => {
    const res = await client.callTool({
      name: 'gp_impact',
      arguments: { symbol: 'doesNotExist', path: impactDir },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no symbol found/i);
  });

  it('reports direct + transitive callers + public-API flag', async () => {
    const res = await client.callTool({
      name: 'gp_impact',
      arguments: { symbol: 'parseToken', path: impactDir },
    });
    expect(res.isError).not.toBe(true);
    const text = textOf(res);
    // The target line
    expect(text).toMatch(/Impact of changing parseToken/);
    // Direct callers
    expect(text).toMatch(/Direct callers/);
    expect(text).toMatch(/authenticate/);
    expect(text).toMatch(/handleLogin/);
    // Test affected
    expect(text).toMatch(/Tests likely affected/);
    expect(text).toMatch(/auth\.test\.ts/);
    // Public API
    expect(text).toMatch(/Public API: YES/);
    expect(text).toMatch(/BREAKING/i);
    // Summary
    expect(text).toMatch(/Summary:/);
  });

  it('respects the depth argument', async () => {
    const res = await client.callTool({
      name: 'gp_impact',
      arguments: { symbol: 'parseToken', depth: 1, path: impactDir },
    });
    expect(res.isError).not.toBe(true);
    // depth=1 should NOT include a Transitive section header
    const text = textOf(res);
    expect(text).toMatch(/Direct callers/);
    expect(text).not.toMatch(/Transitive callers/);
  });

  it('rejects depth out of range', async () => {
    const res = await client.callTool({
      name: 'gp_impact',
      arguments: { symbol: 'parseToken', depth: 99, path: impactDir },
    });
    expect(res.isError).toBe(true);
  });

  it('rejects unknown fields', async () => {
    const res = await client.callTool({
      name: 'gp_impact',
      arguments: {
        symbol: 'parseToken',
        evilExtra: true,
        path: impactDir,
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/evilExtra/);
  });
});

describe('MCP server: default path via workspace roots', () => {
  let rootsDir: string;
  let rootsClient: Client;

  beforeAll(async () => {
    rootsDir = mkdtempSync(join(tmpdir(), 'graphpilot-mcp-roots-'));
    writeFileSync(join(rootsDir, 'ping.ts'), 'export function ping() { return 1; }\n');
    const result = await indexDirectory(rootsDir);
    saveGraph({
      version: 1,
      repoId: repoIdFor(rootsDir),
      rootPath: rootsDir,
      indexedAt: new Date().toISOString(),
      filesIndexed: result.filesIndexed,
      symbolCount: result.symbols.length,
      edgeCount: result.edges.length,
      symbols: result.symbols,
      edges: result.edges,
    });

    const server = buildMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    rootsClient = new Client(
      { name: 'graphpilot-test-roots', version: '0.0.0' },
      { capabilities: { roots: { listChanged: true } } },
    );
    rootsClient.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(rootsDir).href, name: 'workspace' }],
    }));
    await Promise.all([server.connect(serverTransport), rootsClient.connect(clientTransport)]);
  });

  afterAll(async () => {
    await rootsClient?.close();
    if (rootsDir && existsSync(rootsDir)) {
      rmSync(rootsDir, { recursive: true, force: true });
    }
  });

  it('gp_recall without path resolves via MCP roots/list', async () => {
    const res = await rootsClient.callTool({
      name: 'gp_recall',
      arguments: { query: 'ping' },
    });
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('ping');
    expect(textOf(res)).toContain('ping.ts');
  });

  it('gp_stats without path reports the rooted workspace', async () => {
    const res = await rootsClient.callTool({
      name: 'gp_stats',
      arguments: {},
    });
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain(rootsDir);
  });
});
