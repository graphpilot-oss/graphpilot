import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { CLIENTS, detectInstalledClients, type ClientId } from './init.js';

/**
 * Auto-register the GraphPilot MCP server in a client's config file, so a user
 * never has to hand-edit JSON (the step where "agent can't see the gp_ tools"
 * usually begins). We parse → merge → write, never clobbering unrelated keys,
 * and back up the original first. Idempotent: an existing entry is a no-op.
 */

const SERVER_KEY = 'graphpilot';
const SERVER_ENTRY = { command: 'graphpilot', args: ['mcp'] } as const;

/**
 * Clients whose MCP config is a JSON file keyed by `mcpServers`. Continue uses
 * a different schema (experimental.modelContextProtocolServers / YAML), so we
 * don't auto-edit it — point the user at docs/mcp-setup.md instead.
 */
const AUTO_REGISTER: ReadonlySet<ClientId> = new Set<ClientId>([
  'cursor',
  'claude-code',
  'cline',
  'windsurf',
]);

export type RegisterAction =
  | 'registered'
  | 'already-registered'
  | 'dry-run'
  | 'skipped'
  | 'error'
  | 'unsupported';

export interface RegisterResult {
  client: ClientId;
  action: RegisterAction;
  configPath: string;
  detail?: string;
}

export interface RegisterOptions {
  clients?: ClientId[];
  all?: boolean;
  dryRun?: boolean;
  prompt?: (configPath: string) => Promise<'write' | 'skip'>;
  /** Override where each client's config lives — used by tests. */
  configPathFor?: (id: ClientId) => string;
}

async function defaultPrompt(configPath: string): Promise<'write' | 'skip'> {
  if (!process.stdin.isTTY) return 'skip';
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  Register graphpilot MCP server in ${configPath}? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' ? 'write' : 'skip');
    });
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function registerMcpServers(opts: RegisterOptions = {}): Promise<RegisterResult[]> {
  const {
    all = false,
    dryRun = false,
    prompt = defaultPrompt,
    configPathFor = (id: ClientId): string => CLIENTS[id].configPath,
  } = opts;

  let targets: ClientId[];
  if (opts.clients && opts.clients.length > 0) targets = opts.clients;
  else if (all) targets = Object.keys(CLIENTS) as ClientId[];
  else targets = detectInstalledClients();

  const results: RegisterResult[] = [];

  for (const id of targets) {
    const name = CLIENTS[id].name;
    const configPath = configPathFor(id);

    if (!AUTO_REGISTER.has(id)) {
      process.stdout.write(`  [${name}] manual setup needed — see docs/mcp-setup.md\n`);
      results.push({ client: id, action: 'unsupported', configPath });
      continue;
    }

    // Read + validate the existing config. Any failure leaves the file
    // untouched (never half-write or clobber a config we can't parse).
    let config: Record<string, unknown> = {};
    const existed = existsSync(configPath);
    if (existed) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      } catch {
        process.stdout.write(`  [${name}] ${configPath} is not valid JSON — left untouched\n`);
        results.push({ client: id, action: 'error', configPath, detail: 'invalid JSON' });
        continue;
      }
      if (!isPlainObject(parsed)) {
        process.stdout.write(`  [${name}] ${configPath} is not a JSON object — left untouched\n`);
        results.push({ client: id, action: 'error', configPath, detail: 'not an object' });
        continue;
      }
      config = parsed;
    }

    const servers = isPlainObject(config.mcpServers) ? config.mcpServers : {};
    if (SERVER_KEY in servers) {
      process.stdout.write(`  [${name}] already registered\n`);
      results.push({ client: id, action: 'already-registered', configPath });
      continue;
    }

    if (dryRun) {
      process.stdout.write(
        `  [dry-run] [${name}] would add mcpServers.graphpilot to ${configPath}\n`,
      );
      results.push({ client: id, action: 'dry-run', configPath });
      continue;
    }

    const decision = await prompt(configPath);
    if (decision === 'skip') {
      process.stdout.write(`  [${name}] skipped\n`);
      results.push({ client: id, action: 'skipped', configPath });
      continue;
    }

    if (existed) {
      copyFileSync(configPath, configPath + '.bak-graphpilot');
    } else {
      mkdirSync(dirname(configPath), { recursive: true });
    }

    const merged: Record<string, unknown> = {
      ...config,
      mcpServers: { ...servers, [SERVER_KEY]: SERVER_ENTRY },
    };
    writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    process.stdout.write(
      `  [${name}] registered in ${configPath}${existed ? ' (backup: .bak-graphpilot)' : ''}\n`,
    );
    results.push({ client: id, action: 'registered', configPath });
  }

  return results;
}
