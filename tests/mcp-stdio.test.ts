/**
 * Real-subprocess test of the MCP server over stdio. The other mcp.test.ts
 * uses InMemoryTransport which would not have caught the
 * "process.exit() kills the server before initialize completes" regression
 * that bit us during Day-10 testing.
 *
 * Each test spawns `node dist/cli.js mcp`, drives it via JSON-RPC over its
 * stdin/stdout, and tears it down by closing stdin.
 */

import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');

const isWindows = process.platform === 'win32';

// These tests require the built artifact. Skip locally before the first
// build; CI runs `pnpm build` before tests so this is fine there.
const shouldSkip = !existsSync(cli) || isWindows;

interface Driver {
  proc: ChildProcessWithoutNullstreams;
  send: (method: string, params?: unknown) => void;
  awaitReplies: (n: number, timeoutMs?: number) => Promise<any[]>;
  replies: any[];
  stderr: string;
  close: () => Promise<void>;
}

function spawnMcp(): Driver {
  const proc = spawn('node', [cli, 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const replies: any[] = [];
  let stderr = '';
  let buffer = '';

  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        replies.push(JSON.parse(trimmed));
      } catch {
        // ignore
      }
    }
  });

  let nextId = 1;
  function send(method: string, params: unknown = {}) {
    const isNotif = method.startsWith('notifications/');
    const msg = isNotif
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: nextId++, method, params };
    proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  async function awaitReplies(n: number, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (replies.length < n) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${n} replies; got ${replies.length}. ` + `STDERR was:\n${stderr}`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return replies.slice(0, n);
  }

  async function close() {
    proc.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 1000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  return {
    proc,
    send,
    awaitReplies,
    replies,
    get stderr() {
      return stderr;
    },
    close,
  } as Driver;
}

describe.skipIf(shouldSkip)('MCP server over real stdio (subprocess)', () => {
  it('responds to initialize within 4s', async () => {
    const d = spawnMcp();
    try {
      d.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      });
      const [init] = await d.awaitReplies(1);
      expect(init.id).toBe(1);
      expect(init.result?.serverInfo?.name).toBe('graphpilot');
    } finally {
      await d.close();
    }
  });

  it('completes initialize → tools/list → tools/call without exiting', async () => {
    const d = spawnMcp();
    try {
      d.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      });
      await d.awaitReplies(1);
      d.send('notifications/initialized');
      d.send('tools/list');
      const replies = await d.awaitReplies(2);
      const list = replies[1];
      const names = (list.result?.tools ?? []).map((t: any) => t.name).sort();
      expect(names).toEqual(['gp_callers', 'gp_impact', 'gp_index', 'gp_recall']);

      // Now call a tool — proves the process is still alive after tools/list
      d.send('tools/call', {
        name: 'gp_recall',
        arguments: { query: 'ping', path: '/tmp/graphpilot-definitely-not-indexed' },
      });
      const replies2 = await d.awaitReplies(3);
      const call = replies2[2];
      // We expect isError true (no index) but the IMPORTANT thing is that
      // the server replied at all — i.e., didn't exit after initialize.
      expect(call.result?.isError).toBe(true);
    } finally {
      await d.close();
    }
  });

  it('exits cleanly when stdin closes', async () => {
    const d = spawnMcp();
    d.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    await d.awaitReplies(1);
    d.proc.stdin.end();
    const exitCode: number | null = await new Promise((resolve) => {
      d.proc.once('exit', (code) => resolve(code));
    });
    // 0 or null are both acceptable (different platforms, different SIGPIPE behaviour)
    expect(exitCode === 0 || exitCode === null).toBe(true);
  });
});
