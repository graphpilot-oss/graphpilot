#!/usr/bin/env node
import { resolve } from 'node:path';
import { indexDirectory } from './indexer.js';
import { saveGraph, loadGraph, graphPath, repoIdFor, type Graph } from './storage.js';
import { validateRootPath } from './validation.js';
import { startMcpServer } from './mcp.js';
import { GraphWatcher } from './watcher.js';

const HELP = `graphpilot — structural memory for coding agents

Usage:
  graphpilot index <path>     Index a TypeScript/JavaScript repo
  graphpilot status <path>    Show info about an indexed repo
  graphpilot watch <path>     Watch the repo and update the index on save
  graphpilot mcp              Start the MCP server (stdio)
  graphpilot help             Show this help

Examples:
  graphpilot index .
  graphpilot status .
  graphpilot watch .          # keeps the index fresh as you edit
  graphpilot mcp              # used by MCP clients (Claude Code, Cursor, ...)
`;

async function cmdIndex(pathArg: string): Promise<number> {
  const absRoot = resolve(pathArg);
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
  };
  const saved = saveGraph(graph);
  const resolved = result.edges.filter((e) => e.toId !== null).length;
  process.stdout.write(
    `\n✓ Remembered ${result.symbols.length} symbols, ${result.edges.length} calls ` +
      `(${resolved} resolved) across ${result.filesIndexed} files in ${result.durationMs}ms.\n` +
      `  Repo id:    ${graph.repoId}\n` +
      `  Graph file: ${saved}\n` +
      (result.filesFailed ? `  Failed:     ${result.filesFailed} file(s)\n` : ''),
  );
  return 0;
}

function cmdStatus(pathArg: string): number {
  const absRoot = resolve(pathArg);
  const graph = loadGraph(absRoot);
  if (!graph) {
    process.stderr.write(
      `No index found for ${absRoot}\n` +
        `Run: graphpilot index ${pathArg}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `Repo id:      ${graph.repoId}\n` +
      `Root:         ${graph.rootPath}\n` +
      `Indexed at:   ${graph.indexedAt}\n` +
      `Files:        ${graph.filesIndexed}\n` +
      `Symbols:      ${graph.symbolCount}\n` +
      `Calls:        ${graph.edgeCount ?? 0}\n` +
      `Graph file:   ${graphPath(absRoot)}\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'index': {
      const path = rest[0] ?? '.';
      return cmdIndex(path);
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
      const path = rest[0] ?? '.';
      const absRoot = resolve(path);
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
    case 'help':
    case '--help':
    case '-h':
    case undefined:
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
