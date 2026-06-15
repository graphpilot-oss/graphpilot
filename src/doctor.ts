import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp.js';
import { loadGraph, storageRoot, type Graph } from './storage.js';
import { getRepoSha } from './git.js';
import { CLIENTS, detectInstalledClients, type ClientId } from './init.js';

/**
 * `graphpilot doctor` — one command that answers "why can't my agent see the
 * gp_ tools?". Each check is a standalone, dependency-injected function so it
 * can be unit-tested in isolation; runDoctor() composes them with real
 * implementations and the CLI formats the report.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** Actionable next step — shown only for warn/fail. */
  fix?: string;
}

export interface DoctorReport {
  /** false if any check is a hard failure. Drives the process exit code. */
  ok: boolean;
  checks: CheckResult[];
}

const MIN_NODE_MAJOR = 20;
const EXPECTED_TOOLS = ['gp_index', 'gp_recall', 'gp_callers', 'gp_impact'] as const;
const HANDSHAKE_TIMEOUT_MS = 5000;

// ----------------------------------------------------------------------------
// Individual checks
// ----------------------------------------------------------------------------

export function checkNode(version: string = process.versions.node): CheckResult {
  const major = Number(version.split('.')[0]);
  if (Number.isNaN(major)) {
    return {
      id: 'node',
      title: 'Node.js version',
      status: 'warn',
      detail: `Could not parse Node version "${version}".`,
    };
  }
  if (major >= MIN_NODE_MAJOR) {
    return {
      id: 'node',
      title: 'Node.js version',
      status: 'ok',
      detail: `Node ${version} (>= ${MIN_NODE_MAJOR}).`,
    };
  }
  return {
    id: 'node',
    title: 'Node.js version',
    status: 'fail',
    detail: `Node ${version} is below the required v${MIN_NODE_MAJOR}.`,
    fix: `Upgrade to Node >= ${MIN_NODE_MAJOR} — https://nodejs.org`,
  };
}

export function checkPathBin(env: NodeJS.ProcessEnv = process.env): CheckResult {
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  const dirs = pathVar.split(delimiter).filter(Boolean);
  // On Windows the launcher shims carry an extension; on POSIX it's bare.
  const names =
    process.platform === 'win32'
      ? ['graphpilot.cmd', 'graphpilot.exe', 'graphpilot']
      : ['graphpilot'];
  for (const dir of dirs) {
    for (const name of names) {
      if (existsSync(join(dir, name))) {
        return {
          id: 'path',
          title: 'graphpilot on PATH',
          status: 'ok',
          detail: `Found graphpilot in ${dir}.`,
        };
      }
    }
  }
  // Warn, not fail: running via `npx` or `node dist/cli.js` is legitimate.
  return {
    id: 'path',
    title: 'graphpilot on PATH',
    status: 'warn',
    detail: 'graphpilot was not found on your PATH.',
    fix: 'Add your global npm bin (`npm config get prefix` → `<prefix>/bin`) to PATH, or use the `npx @graphpilot-oss/graphpilot` form.',
  };
}

export function checkStorageHome(root: string = storageRoot()): CheckResult {
  if (!existsSync(root)) {
    return {
      id: 'storage',
      title: '~/.graphpilot storage',
      status: 'warn',
      detail: `No GraphPilot storage at ${root} yet — nothing has been indexed.`,
      fix: 'Run `graphpilot index <path>` to build your first index.',
    };
  }
  // T7: the index dir must not be group/other-readable on shared machines.
  // Windows ignores POSIX modes (relies on NTFS profile ACLs) — skip there.
  if (process.platform !== 'win32') {
    try {
      const mode = statSync(root).mode & 0o777;
      if (mode & 0o077) {
        return {
          id: 'storage',
          title: '~/.graphpilot storage',
          status: 'warn',
          detail: `${root} is mode 0${mode.toString(8)} — other users on this machine can read your index.`,
          fix: `chmod 700 ${root}`,
        };
      }
    } catch {
      // Stat raced with a delete — treat as healthy; the index check covers content.
    }
  }
  return {
    id: 'storage',
    title: '~/.graphpilot storage',
    status: 'ok',
    detail: `Storage present at ${root} with safe permissions.`,
  };
}

export interface IndexCheckDeps {
  loadGraph: (root: string) => Graph | null;
  getRepoSha: (somePath: string) => string | null;
}

export function checkIndex(
  repoPath: string,
  deps: IndexCheckDeps = { loadGraph, getRepoSha },
): CheckResult {
  const graph = deps.loadGraph(repoPath);
  if (!graph) {
    return {
      id: 'index',
      title: 'Index for this repo',
      status: 'warn',
      detail: `No valid index found for ${repoPath}.`,
      fix: `Run \`graphpilot index ${repoPath}\`.`,
    };
  }
  const currentSha = deps.getRepoSha(repoPath);
  if (currentSha && graph.indexedSha && currentSha !== graph.indexedSha) {
    return {
      id: 'index',
      title: 'Index for this repo',
      status: 'warn',
      detail: `Index is stale: built at ${graph.indexedSha.slice(0, 7)} but HEAD is now ${currentSha.slice(0, 7)}.`,
      fix: `Run \`graphpilot index ${repoPath}\` (or keep \`graphpilot watch\` running).`,
    };
  }
  return {
    id: 'index',
    title: 'Index for this repo',
    status: 'ok',
    detail: `Index present: ${graph.symbolCount} symbols, ${graph.edgeCount} calls, built ${graph.indexedAt}.`,
  };
}

export interface ClientCheckDeps {
  detect: () => ClientId[];
  readConfig: (id: ClientId) => string | null;
}

function defaultReadConfig(id: ClientId): string | null {
  try {
    return readFileSync(CLIENTS[id].configPath, 'utf8');
  } catch {
    return null;
  }
}

export function checkClients(
  deps: ClientCheckDeps = { detect: detectInstalledClients, readConfig: defaultReadConfig },
): CheckResult {
  const installed = deps.detect();
  if (installed.length === 0) {
    return {
      id: 'clients',
      title: 'MCP client configuration',
      status: 'warn',
      detail: 'No supported MCP clients detected (Cursor, Claude Code, Cline, Windsurf, Continue).',
      fix: 'Install a supported client, then register GraphPilot — see docs/mcp-setup.md.',
    };
  }
  const registered: string[] = [];
  const missing: string[] = [];
  for (const id of installed) {
    const cfg = deps.readConfig(id);
    if (cfg && cfg.includes('graphpilot')) registered.push(CLIENTS[id].name);
    else missing.push(CLIENTS[id].name);
  }
  if (missing.length === 0) {
    return {
      id: 'clients',
      title: 'MCP client configuration',
      status: 'ok',
      detail: `GraphPilot is registered in: ${registered.join(', ')}.`,
    };
  }
  return {
    id: 'clients',
    title: 'MCP client configuration',
    status: 'warn',
    detail:
      `Detected but GraphPilot not registered in: ${missing.join(', ')}` +
      (registered.length ? ` (already registered in: ${registered.join(', ')})` : '') +
      '.',
    fix: 'Add the graphpilot MCP server entry to each client config — see examples/ or run `graphpilot init`.',
  };
}

export interface HandshakeDeps {
  listTools: () => Promise<string[]>;
  timeoutMs?: number;
}

/**
 * Real in-process handshake: build the server, connect it to a linked
 * in-memory transport pair, and drive a genuine MCP client through
 * initialize + tools/list. No child_process (CLAUDE.md rule 3), no stdio.
 */
export async function defaultListTools(): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer();
  const client = new Client({ name: 'graphpilot-doctor', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.listTools();
    return res.tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

export async function checkHandshake(
  deps: HandshakeDeps = { listTools: defaultListTools },
): Promise<CheckResult> {
  const timeoutMs = deps.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  try {
    const names = await withTimeout(deps.listTools(), timeoutMs);
    const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
    if (missing.length > 0) {
      return {
        id: 'handshake',
        title: 'MCP server handshake',
        status: 'fail',
        detail: `Server started but tools are missing: ${missing.join(', ')} (got: ${names.join(', ') || 'none'}).`,
        fix: 'This is a bug — please file an issue with `graphpilot doctor --json` output.',
      };
    }
    return {
      id: 'handshake',
      title: 'MCP server handshake',
      status: 'ok',
      detail: `Server responds; all ${EXPECTED_TOOLS.length} tools listed.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: 'handshake',
      title: 'MCP server handshake',
      status: 'fail',
      detail: `MCP handshake failed: ${msg}.`,
      fix: 'The server failed to start within the budget. Re-run with `graphpilot doctor --json` and file an issue.',
    };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// ----------------------------------------------------------------------------
// Composition + formatting
// ----------------------------------------------------------------------------

export interface DoctorOptions {
  repoPath?: string;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const repoPath = opts.repoPath ?? process.cwd();
  const checks: CheckResult[] = [
    checkNode(),
    checkPathBin(),
    checkStorageHome(),
    checkIndex(repoPath),
    checkClients(),
    await checkHandshake(),
  ];
  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}

const GLYPH: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };

export function formatReport(report: DoctorReport): string {
  const lines: string[] = ['graphpilot doctor', ''];
  for (const c of report.checks) {
    lines.push(`${GLYPH[c.status]} ${c.title} — ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(`    ↳ ${c.fix}`);
  }
  lines.push('');
  lines.push(
    report.ok
      ? 'All critical checks passed.'
      : 'Some checks failed — fix the ✗ items above, then re-run `graphpilot doctor`.',
  );
  return lines.join('\n') + '\n';
}
