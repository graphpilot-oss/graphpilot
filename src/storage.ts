import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import type { SymbolRecord } from './symbols.js';

export interface Graph {
  version: 1;
  repoId: string;
  rootPath: string;
  indexedAt: string;
  filesIndexed: number;
  symbolCount: number;
  symbols: SymbolRecord[];
}

export function repoIdFor(absRootPath: string): string {
  return createHash('sha256').update(absRootPath).digest('hex').slice(0, 16);
}

export function repoDir(absRootPath: string): string {
  return join(homedir(), '.graphpilot', repoIdFor(absRootPath));
}

export function graphPath(absRootPath: string): string {
  return join(repoDir(absRootPath), 'graph.json');
}

export function saveGraph(graph: Graph): string {
  const dir = repoDir(graph.rootPath);
  mkdirSync(dir, { recursive: true });
  const path = graphPath(graph.rootPath);
  writeFileSync(path, JSON.stringify(graph, null, 2), 'utf8');
  return path;
}

export function loadGraph(absRootPath: string): Graph | null {
  const path = graphPath(absRootPath);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as Graph;
}
