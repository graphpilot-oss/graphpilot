#!/usr/bin/env node
// Spawns the MCP server over stdio exactly like Claude Code would, sends
// initialize -> notifications/initialized -> tools/list -> tools/call, and
// prints every response. Exits non-zero on protocol failure or timeout.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');

const proc = spawn('node', [cli, 'mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
proc.stderr.on('data', (d) => (stderr += d.toString()));

const replies = [];
let buffer = '';
proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  // MCP stdio framing is newline-delimited JSON.
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      replies.push(JSON.parse(trimmed));
    } catch {
      console.error('parse error on line:', JSON.stringify(trimmed));
    }
  }
});

let nextId = 1;
function send(method, params) {
  const isNotif = method.startsWith('notifications/');
  const msg = isNotif
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params };
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

const TIMEOUT_MS = 5000;
async function awaitReplyCount(n) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (replies.length < n) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${n} replies (got ${replies.length}). ` +
          `STDERR was:\n${stderr}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

(async () => {
  // 1. initialize
  send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'graphpilot-smoke', version: '0.0.0' },
  });
  await awaitReplyCount(1);
  const init = replies[0];
  console.log('✓ initialize:', JSON.stringify(init.result?.serverInfo));

  // 2. initialized notification (no reply expected)
  send('notifications/initialized', {});

  // 3. tools/list
  send('tools/list', {});
  await awaitReplyCount(2);
  const list = replies[1];
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  console.log('✓ tools/list:', names.join(', '));

  // 4. tools/call gp_stats on cwd (no index expected — should return isError)
  send('tools/call', { name: 'gp_stats', arguments: { path: process.cwd() } });
  await awaitReplyCount(3);
  const call = replies[2];
  console.log('✓ tools/call gp_stats. isError=', call.result?.isError);
  const firstText = call.result?.content?.[0]?.text ?? '<no text>';
  console.log('  first line:', firstText.split('\n')[0]);

  proc.stdin.end();
  await new Promise((r) => proc.once('exit', r));
  console.log('✓ server exited cleanly after stdin close');
  process.exit(0);
})().catch((err) => {
  console.error('SMOKE FAIL:', err.message);
  proc.kill('SIGKILL');
  process.exit(1);
});
