import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Max bytes per source file we will read. Anything larger is skipped. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

/** Max number of files we will index in one run. Hard fail above this. */
export const MAX_FILES_PER_INDEX = 50_000;

/**
 * System paths we refuse to index. Indexing these by accident would walk the
 * whole machine, fill disk, and leak system files into ~/.graphpilot/.
 *
 * Each entry must match the *realpath* form (after `fs.realpathSync`). macOS
 * symlinks /etc, /var, /tmp to /private/*, so we include both forms here.
 */
const DANGEROUS_PATHS = new Set([
  '/',
  '/bin',
  '/sbin',
  '/usr',
  '/usr/bin',
  '/usr/local',
  '/etc',
  '/var',
  '/tmp',
  '/private',
  '/private/etc',
  '/private/var',
  '/private/tmp',
  '/Library',
  '/System',
  '/Applications',
  '/Volumes',
  '/Users',
  '/home',
  'C:\\Windows',
  'C:\\Windows\\System32',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
]);

/**
 * Returns null if the path is safe to index, or a human-readable reason string
 * if it should be refused.
 */
export function validateRootPath(rawPath: string): string | null {
  const abs = resolve(rawPath);

  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return `Path does not exist or is not accessible: ${abs}`;
  }

  // Reject any bare Windows drive root (C:\, D:\, etc.) — not just C:\
  if (process.platform === 'win32' && /^[A-Za-z]:\\?$/.test(real)) {
    return `Refusing to index system path: ${real}`;
  }
  if (DANGEROUS_PATHS.has(real)) {
    return `Refusing to index system path: ${real}`;
  }
  if (real === homedir()) {
    return `Refusing to index your home directory directly (${real}). Pass a specific project subdirectory instead.`;
  }
  return null;
}
