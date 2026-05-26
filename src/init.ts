import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export type ClientId = 'cursor' | 'claude-code' | 'cline' | 'windsurf' | 'continue';

export interface ClientSpec {
  name: string;
  /** Path to the client's own MCP config — its existence signals the client is installed. */
  configPath: string;
  /** Relative path inside the package's examples/ dir (the routing template). */
  templateFile: string;
  /** Filename to write at the target repo root. */
  outputFile: string;
}

function clineConfigPath(): string {
  const p = platform();
  const globalStorage = join(
    'Code',
    'User',
    'globalStorage',
    'saoudrizwan.claude-dev',
    'settings',
    'cline_mcp_settings.json',
  );
  if (p === 'darwin') return join(homedir(), 'Library', 'Application Support', globalStorage);
  if (p === 'win32') {
    return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), globalStorage);
  }
  return join(homedir(), '.config', globalStorage);
}

export const CLIENTS: Record<ClientId, ClientSpec> = {
  cursor: {
    name: 'Cursor',
    configPath: join(homedir(), '.cursor', 'mcp.json'),
    templateFile: join('cursor', '.cursorrules'),
    outputFile: '.cursorrules',
  },
  'claude-code': {
    name: 'Claude Code',
    configPath: join(homedir(), '.claude.json'),
    templateFile: join('claude-code', 'CLAUDE.md'),
    outputFile: 'CLAUDE.md',
  },
  cline: {
    name: 'Cline',
    configPath: clineConfigPath(),
    templateFile: join('cline', '.clinerules'),
    outputFile: '.clinerules',
  },
  windsurf: {
    name: 'Windsurf',
    configPath: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    templateFile: join('windsurf', '.windsurfrules'),
    outputFile: '.windsurfrules',
  },
  continue: {
    name: 'Continue',
    configPath: join(homedir(), '.continue', 'config.json'),
    templateFile: join('continue', '.continuerules'),
    outputFile: '.continuerules',
  },
};

export const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');

export function detectInstalledClients(): ClientId[] {
  return (Object.keys(CLIENTS) as ClientId[]).filter((id) => existsSync(CLIENTS[id].configPath));
}

async function defaultPrompt(destPath: string): Promise<'overwrite' | 'skip'> {
  if (!process.stdin.isTTY) return 'skip';
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${destPath} already exists. Overwrite? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' ? 'overwrite' : 'skip');
    });
  });
}

export interface InitOptions {
  repoPath: string;
  clients?: ClientId[];
  all?: boolean;
  dryRun?: boolean;
  examplesDir?: string;
  prompt?: (destPath: string) => Promise<'overwrite' | 'skip'>;
}

export type WriteAction = 'written' | 'skipped' | 'dry-run';

export interface WriteResult {
  client: ClientId;
  action: WriteAction;
  destPath: string;
}

export async function runInit(opts: InitOptions): Promise<WriteResult[]> {
  const {
    repoPath,
    all = false,
    dryRun = false,
    examplesDir: exDir = EXAMPLES_DIR,
    prompt = defaultPrompt,
  } = opts;

  let targets: ClientId[];
  if (opts.clients && opts.clients.length > 0) {
    targets = opts.clients;
  } else if (all) {
    targets = Object.keys(CLIENTS) as ClientId[];
  } else {
    targets = detectInstalledClients();
    if (targets.length === 0) {
      process.stdout.write(
        'No supported clients detected. Pass --all to write all rules files,\n' +
          'or --client <name> for a specific one.\n' +
          'Supported clients: cursor, claude-code, cline, windsurf, continue\n',
      );
      return [];
    }
    process.stdout.write(`Detected: ${targets.join(', ')}\n`);
  }

  const results: WriteResult[] = [];

  for (const id of targets) {
    const spec = CLIENTS[id];
    const templatePath = join(exDir, spec.templateFile);
    const destPath = join(repoPath, spec.outputFile);

    if (!existsSync(templatePath)) {
      process.stdout.write(`  [${spec.name}] skip — template not found: ${templatePath}\n`);
      results.push({ client: id, action: 'skipped', destPath });
      continue;
    }

    const content = readFileSync(templatePath, 'utf8');

    if (dryRun) {
      process.stdout.write(
        `  [dry-run] would write ${spec.outputFile} (${content.length} bytes)\n`,
      );
      results.push({ client: id, action: 'dry-run', destPath });
      continue;
    }

    if (existsSync(destPath)) {
      const decision = await prompt(destPath);
      if (decision === 'skip') {
        process.stdout.write(`  [${spec.name}] skipped (${spec.outputFile} already exists)\n`);
        results.push({ client: id, action: 'skipped', destPath });
        continue;
      }
    }

    writeFileSync(destPath, content, 'utf8');
    process.stdout.write(`  [${spec.name}] wrote ${spec.outputFile}\n`);
    results.push({ client: id, action: 'written', destPath });
  }

  return results;
}
