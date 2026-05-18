import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import type { SymbolRecord } from './symbols.js';

const isWindows = process.platform === 'win32';

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
  // T7 defence: 0700 dir + 0600 file so other users on shared machines can't
  // read the index. The mkdir/writeFileSync `mode` option only applies on
  // creation, so we explicitly chmod afterwards to fix permissions on any
  // pre-existing files (e.g. an index written before this protection landed).
  // On Windows these modes are silently ignored, which is fine — NTFS ACLs
  // are handled by the user profile boundary.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isWindows) chmodSync(dir, 0o700);
  const path = graphPath(graph.rootPath);
  writeFileSync(path, JSON.stringify(graph, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (!isWindows) chmodSync(path, 0o600);
  return path;
}

export function loadGraph(absRootPath: string): Graph | null {
  const path = graphPath(absRootPath);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as Graph;
}
