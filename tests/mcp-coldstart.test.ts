import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp.js';

/**
 * #68 — Cold-start budget.
 *
 * Agent clients silently kill an MCP server that's slow to answer the
 * `initialize` handshake; to the user the gp_ tools just "disappear" with no
 * error. This is a regression guard: a fresh server must reach "ready to
 * serve" (initialize + tools/list) well inside the window clients tolerate.
 *
 * 500 ms is deliberately generous for CI noise — the point is to catch a
 * future change that makes startup pathologically slow (e.g. eager indexing
 * or a heavy import landing in the hot path), not to micro-benchmark.
 */
const COLD_START_BUDGET_MS = 500;

describe('MCP cold start', () => {
  it(`answers initialize + tools/list under ${COLD_START_BUDGET_MS}ms`, async () => {
    const start = performance.now();

    const server = buildMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'coldstart-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();

    const elapsed = performance.now() - start;

    await client.close();
    await server.close();

    expect(tools.length).toBe(4);
    expect(elapsed).toBeLessThan(COLD_START_BUDGET_MS);
  });
});
