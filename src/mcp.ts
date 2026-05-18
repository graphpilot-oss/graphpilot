import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import { loadGraph } from './storage.js';
import { GraphIndex } from './query.js';

const SERVER_NAME = 'graphpilot';
const SERVER_VERSION = '0.0.1';

/**
 * Cache loaded GraphIndex instances by absolute path. A typical Claude Code
 * session queries the same repo many times in a row, so loading + indexing
 * once per repo is a big win.
 */
const indexCache = new Map<string, GraphIndex>();

function getIndex(rawPath: string | undefined): GraphIndex | { error: string } {
  const root = resolve(rawPath ?? process.cwd());
  const cached = indexCache.get(root);
  if (cached) return cached;

  const graph = loadGraph(root);
  if (!graph) {
    return {
      error:
        `No GraphPilot index found for ${root}.\n` +
        `Run \`graphpilot index ${rawPath ?? '.'}\` first.`,
    };
  }
  const idx = new GraphIndex(graph);
  indexCache.set(root, idx);
  return idx;
}

/**
 * Build an MCP server configured with GraphPilot's tools. Caller wires the
 * transport (stdio in production, in-memory in tests).
 *
 * IMPORTANT: when running over stdio, stdout is reserved for the JSON-RPC
 * protocol. All diagnostic messages MUST go to stderr or they'll corrupt
 * the wire.
 */
export function buildMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // Tool catalog. Day 8 ships only the stub `gp_stats` so we can confirm
  // wiring end-to-end. Day 9 adds gp_recall and gp_callers.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'gp_stats',
        description:
          'Show GraphPilot index health for a repo (symbol count, edge count, ' +
          'when indexed). Use this to confirm the index is fresh before asking ' +
          'structural questions.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Absolute path to the repo. Defaults to the working directory.',
            },
          },
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const argObj = (args ?? {}) as Record<string, unknown>;

    if (name === 'gp_stats') {
      const idxOrErr = getIndex(
        typeof argObj.path === 'string' ? argObj.path : undefined,
      );
      if ('error' in idxOrErr) {
        return {
          content: [{ type: 'text', text: idxOrErr.error }],
          isError: true,
        };
      }
      const s = idxOrErr.stats;
      const g = idxOrErr.graph;
      const text = [
        `Repo:        ${g.rootPath}`,
        `Repo id:     ${g.repoId}`,
        `Indexed at:  ${g.indexedAt}`,
        `Files:       ${g.filesIndexed}`,
        `Symbols:     ${s.symbols}`,
        `Calls:       ${s.edges} (${s.resolvedEdges} resolved)`,
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}

/**
 * Start the MCP server over stdio. Used by `graphpilot mcp` from the CLI.
 * Runs until stdin closes (i.e., the MCP client disconnects).
 */
export async function startMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[graphpilot] MCP server ready (stdio).\n`);
}
