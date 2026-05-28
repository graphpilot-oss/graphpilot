# GraphPilot — Editor & Agent Examples

Ready-to-paste configurations for every MCP-compatible coding agent we've tested.

Each subfolder follows the same shape:

- `README.md` — step-by-step install for that client (the file you're skimming this for)
- A sample config file (`.claude.json`, `mcp.json`, `cline_mcp_settings.json`, etc.) you can copy verbatim and edit the path in
- Where the client supports it: a `CLAUDE.md` / `.cursorrules` / equivalent routing template that nudges the agent to use GraphPilot tools automatically

## Pick your client

| Client          | Folder                                      | Config file location                                                                                            |
| --------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Claude Code     | [`claude-code/`](claude-code/)              | `~/.claude.json`                                                                                                |
| Cursor          | [`cursor/`](cursor/)                        | `~/.cursor/mcp.json`                                                                                            |
| Cline (VS Code) | [`cline/`](cline/)                          | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Windsurf        | [`windsurf/`](windsurf/)                    | `~/.codeium/windsurf/mcp_config.json`                                                                           |
| Continue.dev    | [`continue/`](continue/)                    | `~/.continue/config.json`                                                                                       |
| Anything else   | [`docs/mcp-setup.md`](../docs/mcp-setup.md) | n/a — generic stdio MCP instructions                                                                            |

## Two ways GraphPilot can be launched

Every example shows both forms. Pick whichever matches how you installed GraphPilot.

### A) Local build (pre-npm, contributors, dev mode)

```bash
git clone https://github.com/graphpilot-oss/graphpilot.git
cd graphpilot && pnpm install && pnpm build
```

Then point your client at:

```jsonc
{
  "command": "node",
  "args": ["/absolute/path/to/graphpilot/dist/cli.js", "mcp"],
}
```

> **Replace `/absolute/path/to/graphpilot/`** with the real path on your machine. Tilde (`~`) is _not_ expanded by most MCP clients — use the full absolute path.

### B) Once v0.1.0 ships to npm

```jsonc
{
  "command": "npx",
  "args": ["graphpilot", "mcp"],
}
```

Or install globally and reference by name:

```bash
npm install -g @graphpilot-oss/graphpilot
```

## Cross-platform notes

| Platform | Path style                                                                      |
| -------- | ------------------------------------------------------------------------------- |
| macOS    | `/Users/<you>/code/graphpilot/dist/cli.js`                                      |
| Linux    | `/home/<you>/code/graphpilot/dist/cli.js`                                       |
| Windows  | `C:\\Users\\<you>\\code\\graphpilot\\dist\\cli.js` (escape backslashes in JSON) |

On Windows in particular, **use double-backslashes in JSON paths** or use forward slashes — both work, single backslashes don't.

## Verifying the connection

After editing the config and **fully restarting** the client (quitting completely, not just closing the window), trigger the client's MCP listing:

- **Claude Code:** type `/mcp` in chat
- **Cursor:** Settings → MCP
- **Cline:** the Cline panel → MCP Servers
- **Windsurf:** Cascade panel → MCP tools
- **Continue:** Settings → MCP Servers

You should see `graphpilot` with **4 tools** (`gp_index`, `gp_recall`, `gp_callers`, `gp_impact`). If not, see [`docs/mcp-setup.md`](../docs/mcp-setup.md#troubleshooting).

## Indexing your first repo

Once the MCP server is connected, ask the agent to index your project — or run it directly:

```bash
node /abs/path/to/graphpilot/dist/cli.js index /path/to/your/repo
```

Then keep the index fresh as you edit:

```bash
node /abs/path/to/graphpilot/dist/cli.js watch /path/to/your/repo
```

Watch mode produces sub-10 ms incremental updates on every save. The on-disk `graph.json` is rewritten atomically — the agent always sees a consistent view, even mid-edit.

## End-to-end smoke test

From inside the agent:

```text
Use graphpilot's gp_recall tool to list symbols in this repo.
```

If the response includes symbol results — the wire is healthy.
