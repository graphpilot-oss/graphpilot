import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
  client = new Client(
    { name: 'graphpilot-test', version: '0.0.0' },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterAll(async () => {
  await client?.close();
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('MCP server: protocol handshake + tool catalog', () => {
  it('lists the four Day-9 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['gp_callers', 'gp_index', 'gp_recall', 'gp_stats']);
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
