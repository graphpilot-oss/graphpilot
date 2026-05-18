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
  it('lists exactly one tool (gp_stats) on Day 8', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['gp_stats']);
  });

  it('gp_stats has a description and an input schema', async () => {
    const { tools } = await client.listTools();
    const stats = tools.find((t) => t.name === 'gp_stats')!;
    expect(stats.description).toMatch(/index/i);
    expect(stats.inputSchema?.type).toBe('object');
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
