import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runInit,
  detectInstalledClients,
  CLIENTS,
  EXAMPLES_DIR,
  type ClientId,
} from '../src/init.js';

const SKIP_PROMPT = async (): Promise<'overwrite' | 'skip'> => 'skip';
const OVERWRITE_PROMPT = async (): Promise<'overwrite' | 'skip'> => 'overwrite';

describe('detectInstalledClients', () => {
  it('returns only clients whose config file exists', () => {
    const fakeConfigDir = mkdtempSync(join(tmpdir(), 'gp-detect-'));
    try {
      // Cursor config exists → detected. Others absent.
      const cursorCfg = join(fakeConfigDir, 'cursor-mcp.json');
      writeFileSync(cursorCfg, '{}');

      // Temporarily patch CLIENTS.cursor.configPath
      const orig = CLIENTS.cursor.configPath;
      (CLIENTS.cursor as { configPath: string }).configPath = cursorCfg;

      const claudeOrig = CLIENTS['claude-code'].configPath;
      (CLIENTS['claude-code'] as { configPath: string }).configPath = join(
        fakeConfigDir,
        'nonexistent.json',
      );

      try {
        const detected = detectInstalledClients();
        expect(detected).toContain('cursor');
        expect(detected).not.toContain('claude-code');
      } finally {
        (CLIENTS.cursor as { configPath: string }).configPath = orig;
        (CLIENTS['claude-code'] as { configPath: string }).configPath = claudeOrig;
      }
    } finally {
      rmSync(fakeConfigDir, { recursive: true, force: true });
    }
  });
});

describe('runInit', () => {
  let repoDir: string;
  let fakeExamplesDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'gp-init-repo-'));
    fakeExamplesDir = mkdtempSync(join(tmpdir(), 'gp-init-examples-'));
    // Populate fake examples dir with template files
    mkdirSync(join(fakeExamplesDir, 'cursor'));
    mkdirSync(join(fakeExamplesDir, 'claude-code'));
    mkdirSync(join(fakeExamplesDir, 'cline'));
    mkdirSync(join(fakeExamplesDir, 'windsurf'));
    mkdirSync(join(fakeExamplesDir, 'continue'));
    writeFileSync(join(fakeExamplesDir, 'cursor', '.cursorrules'), '# cursor routing rules\n');
    writeFileSync(
      join(fakeExamplesDir, 'claude-code', 'claude-routing.md'),
      '# claude routing rules\n',
    );
    writeFileSync(join(fakeExamplesDir, 'cline', '.clinerules'), '# cline routing rules\n');
    writeFileSync(
      join(fakeExamplesDir, 'windsurf', '.windsurfrules'),
      '# windsurf routing rules\n',
    );
    writeFileSync(
      join(fakeExamplesDir, 'continue', '.continuerules'),
      '# continue routing rules\n',
    );
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(fakeExamplesDir, { recursive: true, force: true });
  });

  it('writes template to target repo when --client is specified', async () => {
    const results = await runInit({
      repoPath: repoDir,
      clients: ['cursor'],
      examplesDir: fakeExamplesDir,
      prompt: SKIP_PROMPT,
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('written');
    expect(existsSync(join(repoDir, '.cursorrules'))).toBe(true);
    expect(readFileSync(join(repoDir, '.cursorrules'), 'utf8')).toBe('# cursor routing rules\n');
  });

  it('writes all 5 files when --all is passed', async () => {
    const results = await runInit({
      repoPath: repoDir,
      all: true,
      examplesDir: fakeExamplesDir,
      prompt: SKIP_PROMPT,
    });

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.action === 'written')).toBe(true);
    const allClients = Object.keys(CLIENTS) as ClientId[];
    for (const id of allClients) {
      expect(existsSync(join(repoDir, CLIENTS[id].outputFile))).toBe(true);
    }
  });

  it('skips existing file when prompt returns skip', async () => {
    const dest = join(repoDir, '.cursorrules');
    writeFileSync(dest, '# existing content\n');

    const results = await runInit({
      repoPath: repoDir,
      clients: ['cursor'],
      examplesDir: fakeExamplesDir,
      prompt: SKIP_PROMPT,
    });

    expect(results[0].action).toBe('skipped');
    expect(readFileSync(dest, 'utf8')).toBe('# existing content\n');
  });

  it('overwrites existing file when prompt returns overwrite', async () => {
    const dest = join(repoDir, '.cursorrules');
    writeFileSync(dest, '# old content\n');

    const results = await runInit({
      repoPath: repoDir,
      clients: ['cursor'],
      examplesDir: fakeExamplesDir,
      prompt: OVERWRITE_PROMPT,
    });

    expect(results[0].action).toBe('written');
    expect(readFileSync(dest, 'utf8')).toBe('# cursor routing rules\n');
  });

  it('dry-run does not write any files', async () => {
    const results = await runInit({
      repoPath: repoDir,
      clients: ['cursor', 'cline'],
      dryRun: true,
      examplesDir: fakeExamplesDir,
      prompt: SKIP_PROMPT,
    });

    expect(results.every((r) => r.action === 'dry-run')).toBe(true);
    expect(existsSync(join(repoDir, '.cursorrules'))).toBe(false);
    expect(existsSync(join(repoDir, '.clinerules'))).toBe(false);
  });

  it('returns empty array and no writes when no clients detected and no flags', async () => {
    // Patch CLIENTS so none are detected
    const origPaths: Record<string, string> = {};
    for (const id of Object.keys(CLIENTS) as ClientId[]) {
      origPaths[id] = CLIENTS[id].configPath;
      (CLIENTS[id] as { configPath: string }).configPath = join(repoDir, 'nonexistent-cfg.json');
    }
    try {
      const results = await runInit({
        repoPath: repoDir,
        examplesDir: fakeExamplesDir,
        prompt: SKIP_PROMPT,
      });
      expect(results).toHaveLength(0);
    } finally {
      for (const id of Object.keys(CLIENTS) as ClientId[]) {
        (CLIENTS[id] as { configPath: string }).configPath = origPaths[id]!;
      }
    }
  });

  it('EXAMPLES_DIR resolves to the real examples directory', () => {
    // Sanity: the package's own examples dir exists and has templates
    expect(existsSync(join(EXAMPLES_DIR, 'cursor', '.cursorrules'))).toBe(true);
    expect(existsSync(join(EXAMPLES_DIR, 'claude-code', 'claude-routing.md'))).toBe(true);
    expect(existsSync(join(EXAMPLES_DIR, 'cline', '.clinerules'))).toBe(true);
    expect(existsSync(join(EXAMPLES_DIR, 'windsurf', '.windsurfrules'))).toBe(true);
    expect(existsSync(join(EXAMPLES_DIR, 'continue', '.continuerules'))).toBe(true);
  });
});
