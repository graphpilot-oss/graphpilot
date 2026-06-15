#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { indexDirectory } from './indexer.js';
import { saveGraph, loadGraph, graphPath, repoIdFor, type Graph } from './storage.js';
import { validateRootPath } from './validation.js';
import { startMcpServer } from './mcp.js';
import { GraphWatcher } from './watcher.js';
import { resolveIndexRoot } from './git.js';

const HELP = `graphpilot — structural memory for coding agents

Usage:
  graphpilot index <path>     Index a TypeScript/JavaScript repo
  graphpilot status <path>    Show info about an indexed repo
  graphpilot watch <path>     Watch the repo and update the index on save
  graphpilot mcp              Start the MCP server (stdio)
  graphpilot init             Drop routing-rules files for detected editors
  graphpilot doctor [path]    Diagnose why an agent can't see the gp_ tools
  graphpilot version          Print the installed version
  graphpilot help             Show this help

Examples:
  graphpilot index .
  graphpilot status .
  graphpilot watch .          # keeps the index fresh as you edit
  graphpilot mcp              # used by MCP clients (Claude Code, Cursor, ...)
  graphpilot init             # auto-detect editors and write routing rules
  graphpilot init --all       # write rules for all supported editors
  graphpilot init --client cursor --path /my/repo
  graphpilot init --dry-run   # preview what would be written
  graphpilot doctor           # health check; add --json for a bug report
`;

async function cmdIndex(pathArg: string, opts: { noWorktree?: boolean } = {}): Promise<number> {
  const requested = resolve(pathArg);
  // Worktree-scope: by default, if the user pointed inside a git worktree
  // we re-root to the worktree top so the index covers the full branch.
  // Pass --no-worktree to disable.
  const { root: absRoot, redirected } = resolveIndexRoot(requested, { disable: opts.noWorktree });
  if (redirected) {
    process.stdout.write(
      `[graphpilot] Re-rooting index to git worktree top: ${absRoot}\n` +
        `             (Pass --no-worktree to index ${requested} directly.)\n`,
    );
  }
  // T10 defence: refuse `/`, `/etc`, `~`, and friends before walking.
  const refusal = validateRootPath(absRoot);
  if (refusal) {
    process.stderr.write(`Error: ${refusal}\n`);
    return 2;
  }
  process.stdout.write(`Indexing ${absRoot} ...\n`);
  const result = await indexDirectory(absRoot);
  const graph: Graph = {
    version: 1,
    repoId: repoIdFor(absRoot),
    rootPath: absRoot,
    indexedAt: new Date().toISOString(),
    filesIndexed: result.filesIndexed,
    symbolCount: result.symbols.length,
    edgeCount: result.edges.length,
    symbols: result.symbols,
    edges: result.edges,
    indexedSha: result.git.sha,
    indexedBranch: result.git.branch,
  };
  const saved = saveGraph(graph);
  const resolved = result.edges.filter((e) => e.toId !== null).length;
  // Build the git stamp line lazily — only printed when we're in a git repo.
  let gitLine = '';
  if (result.git.shortSha || result.git.branch) {
    const parts: string[] = [];
    if (result.git.branch) parts.push(`branch ${result.git.branch}`);
    if (result.git.shortSha) parts.push(`sha ${result.git.shortSha}`);
    gitLine = `  Git:        ${parts.join(' @ ')}\n`;
  }
  process.stdout.write(
    `\n✓ Remembered ${result.symbols.length} symbols, ${result.edges.length} calls ` +
      `(${resolved} resolved) across ${result.filesIndexed} files in ${result.durationMs}ms.\n` +
      `  Repo id:    ${graph.repoId}\n` +
      gitLine +
      `  Graph file: ${saved}\n` +
      (result.filesFailed ? `  Failed:     ${result.filesFailed} file(s)\n` : ''),
  );
  return 0;
}

function cmdStatus(pathArg: string): number {
  const absRoot = resolve(pathArg);
  const graph = loadGraph(absRoot);
  if (!graph) {
    process.stderr.write(`No index found for ${absRoot}\n` + `Run: graphpilot index ${pathArg}\n`);
    return 1;
  }
  // Compose a git line if the indexed repo had provenance at the time.
  let gitLine = '';
  if (graph.indexedSha || graph.indexedBranch) {
    const parts: string[] = [];
    if (graph.indexedBranch) parts.push(`branch ${graph.indexedBranch}`);
    if (graph.indexedSha) parts.push(`sha ${graph.indexedSha.slice(0, 7)}`);
    gitLine = `Git:          ${parts.join(' @ ')}\n`;
  }
  process.stdout.write(
    `Repo id:      ${graph.repoId}\n` +
      `Root:         ${graph.rootPath}\n` +
      `Indexed at:   ${graph.indexedAt}\n` +
      gitLine +
      `Files:        ${graph.filesIndexed}\n` +
      `Symbols:      ${graph.symbolCount}\n` +
      `Calls:        ${graph.edgeCount ?? 0}\n` +
      `Graph file:   ${graphPath(absRoot)}\n`,
  );
  return 0;
}

function getVersion(): string {
  // dist/cli.js and src/cli.ts both sit one level under the package root,
  // so ../package.json resolves in both the built and dev layouts.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${getVersion()}\n`);
      return 0;
    case 'index': {
      const noWorktree = rest.includes('--no-worktree');
      const path = rest.find((a) => !a.startsWith('--')) ?? '.';
      return cmdIndex(path, { noWorktree });
    }
    case 'status': {
      const path = rest[0] ?? '.';
      return cmdStatus(path);
    }
    case 'mcp': {
      // Server runs until stdin closes (MCP client disconnect). Never
      // returns under normal operation.
      await startMcpServer();
      return 0;
    }
    case 'watch': {
      const noWorktree = rest.includes('--no-worktree');
      const path = rest.find((a) => !a.startsWith('--')) ?? '.';
      const requested = resolve(path);
      const { root: absRoot, redirected } = resolveIndexRoot(requested, { disable: noWorktree });
      if (redirected) {
        process.stderr.write(`[graphpilot:watch] Re-rooting to worktree top: ${absRoot}\n`);
      }
      const refusal = validateRootPath(absRoot);
      if (refusal) {
        process.stderr.write(`Error: ${refusal}\n`);
        return 2;
      }
      const watcher = new GraphWatcher(absRoot);
      await watcher.start();
      process.stderr.write(`[graphpilot:watch] Ctrl+C to stop.\n`);
      // Hold the process open until SIGINT or stdin EOF.
      await new Promise<void>((res) => {
        const finish = (): void => res();
        process.once('SIGINT', finish);
        process.once('SIGTERM', finish);
        process.stdin.once('end', finish);
        process.stdin.once('close', finish);
      });
      await watcher.stop();
      return 0;
    }
    case 'init': {
      const { runInit } = await import('./init.js');
      const allFlag = rest.includes('--all');
      const dryRun = rest.includes('--dry-run');
      const pathIdx = rest.indexOf('--path');
      const pathArg = pathIdx !== -1 ? rest[pathIdx + 1] : undefined;
      const clientIdx = rest.indexOf('--client');
      const clientArg = clientIdx !== -1 ? rest[clientIdx + 1] : undefined;
      const repoPath = resolve(pathArg ?? '.');
      const clients = clientArg
        ? ([clientArg] as Parameters<typeof runInit>[0]['clients'])
        : undefined;
      await runInit({ repoPath, clients, all: allFlag, dryRun });
      return 0;
    }
    case 'doctor': {
      const { runDoctor, formatReport } = await import('./doctor.js');
      const json = rest.includes('--json');
      const path = rest.find((a) => !a.startsWith('--')) ?? '.';
      const report = await runDoctor({ repoPath: resolve(path) });
      if (json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        process.stdout.write(formatReport(report));
      }
      return report.ok ? 0 : 1;
    }
    case undefined: {
      // Some MCP hosts and directory inspectors (Glama, registry scanners)
      // launch the bin with no subcommand and drive it over a stdio pipe,
      // expecting it to *be* the MCP server. Detect that (stdin is not a
      // TTY) and start the server. A human running `graphpilot` in a
      // terminal still gets the help text below.
      if (!process.stdin.isTTY) {
        await startMcpServer();
        return 0;
      }
      process.stdout.write(HELP);
      return 0;
    }
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`Error: ${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
