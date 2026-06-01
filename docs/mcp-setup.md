# MCP Setup per Client

GraphPilot is an [MCP](https://modelcontextprotocol.io) server that
speaks JSON-RPC over **stdio**. Any MCP-compatible client can use it.

This doc covers the five most common clients. The pattern is the same
everywhere: tell the client to launch `graphpilot mcp` (or
`node /path/to/dist/cli.js mcp`) when it starts.

## Two ways to invoke GraphPilot

| Mode        | Command + args                                 | When to use                          |
| ----------- | ---------------------------------------------- | ------------------------------------ |
| Local build | `node /abs/path/to/graphpilot/dist/cli.js mcp` | Pre-v0.1.0, contributors, dev mode   |
| `npx`       | `npx graphpilot mcp`                           | Once v0.1.0 ships to npm (preferred) |

Examples below show both. Pick whichever matches your install.

---

## Claude Code (Anthropic)

**Config file:** `~/.claude.json` (macOS, Linux) or
`%USERPROFILE%\.claude.json` (Windows).

```jsonc
{
  "mcpServers": {
    "graphpilot": {
      "command": "node",
      "args": ["/Users/you/code/graphpilot/dist/cli.js", "mcp"],
    },
  },
}
```

Or post-v0.1.0:

```jsonc
{
  "mcpServers": {
    "graphpilot": {
      "command": "npx",
      "args": ["graphpilot", "mcp"],
    },
  },
}
```

**Verify:** fully restart Claude Code (quit, don't just close the
window). Type `/mcp` — you should see:

```
graphpilot
  4 tools: gp_index, gp_recall, gp_callers, gp_impact
```

**Common gotcha:** `~/.claude.json` is read only on launch. Edits don't
hot-reload — you must relaunch.

---

## Cursor

**Settings UI:** `Cmd/Ctrl + ,` → search "MCP" → "Edit MCP config".

**File path:** `~/.cursor/mcp.json`.

```jsonc
{
  "mcpServers": {
    "graphpilot": {
      "command": "node",
      "args": ["/Users/you/code/graphpilot/dist/cli.js", "mcp"],
    },
  },
}
```

**Verify:** Settings → MCP — `graphpilot` should show as **Connected**
with 4 tools listed underneath.

**Common gotcha:** Cursor sometimes caches MCP server state. If the
server shows red after a config change, click the refresh icon next to
it.

---

## Cline (VS Code extension)

Cline reads MCP config from a per-OS path:

- macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Linux: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`

Easier: open the Cline panel in VS Code → "MCP Servers" → click the gear
icon → "Edit MCP Settings". Then add:

```jsonc
{
  "mcpServers": {
    "graphpilot": {
      "command": "node",
      "args": ["/Users/you/code/graphpilot/dist/cli.js", "mcp"],
      "disabled": false,
      "autoApprove": [],
    },
  },
}
```

**Verify:** the Cline panel's "MCP Servers" section lists `graphpilot`
with a green status dot.

---

## Windsurf (Codeium)

**Config file:** `~/.codeium/windsurf/mcp_config.json`.

```jsonc
{
  "mcpServers": {
    "graphpilot": {
      "command": "node",
      "args": ["/Users/you/code/graphpilot/dist/cli.js", "mcp"],
    },
  },
}
```

**Verify:** restart Windsurf → open the Cascade panel → MCP tools list
should include the four `gp_*` tools.

---

## Continue.dev

Continue uses `~/.continue/config.json` (global) or
`<repo>/.continue/config.json` (per-project).

```jsonc
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "node",
          "args": ["/Users/you/code/graphpilot/dist/cli.js", "mcp"],
        },
      },
    ],
  },
}
```

**Verify:** Continue → Settings → "MCP Servers" panel should list
graphpilot.

**Common gotcha:** Continue's MCP support is still flagged as
experimental — versions vary. If `modelContextProtocolServers` is
unrecognized, check the Continue version + their docs for the current
config key.

---

## Any other MCP-capable client

Generic pattern works anywhere the client supports stdio MCP:

- **Transport:** `stdio`
- **Command:** `node` (or `npx`)
- **Args:** `["/abs/path/to/graphpilot/dist/cli.js", "mcp"]`
  (or `["graphpilot", "mcp"]` once on npm)
- **Protocol version:** `2024-11-05` (matches
  `@modelcontextprotocol/sdk@1.29.x`)

### Use the MCP Inspector to verify the wire

```bash
npx @modelcontextprotocol/inspector node dist/cli.js mcp
```

Opens a browser-based UI listing the 4 tools with their schemas. Lets
you fire a test call and see the JSON-RPC frames.

---

## Environment variables

| Variable              | Effect                                                                |
| --------------------- | --------------------------------------------------------------------- |
| `GRAPHPILOT_NO_LOG=1` | Disable the interaction log (`~/.graphpilot/<id>/interactions.jsonl`) |

There are intentionally **no other env vars**. No API keys, no telemetry
endpoints, no remote URLs. If a future feature needs one, it'll be
opt-in and documented.

---

## End-to-end smoke test

```bash
# In your project's terminal
node /abs/path/to/graphpilot/dist/cli.js index .

# Then in your agent:
# "Use graphpilot's gp_recall tool to list symbols in this repo."
```

If the response includes repo id, file/symbol/edge counts, and an
`indexedAt` timestamp — the wire is healthy.

---

## Troubleshooting

| Symptom                                            | Likely cause                                                                               | Fix                                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Server connects then immediately disconnects       | Server crashing on startup, or you're on a build predating the current stdio transport fix | Run `node dist/cli.js mcp` in a terminal — inspect stderr for the error. Rebuild from `main`.                                                  |
| Client shows no servers                            | Config file has a JSON syntax error                                                        | Validate JSON; clients often silently ignore broken configs                                                                                    |
| Tools list but every call returns "No index found" | Path mismatch — MCP `cwd` is often your home dir, not the open workspace                   | Use project `.cursor/mcp.json` with `"env": { "GRAPHPILOT_ROOT": "${workspaceFolder}" }`, or rely on MCP roots (Cursor) / pass explicit `path` |
| Some `gp_*` tools missing from the catalog         | Stale build cached by the client                                                           | `pnpm build` then fully restart the client                                                                                                     |
| stderr says "Failed to load native bindings"       | `tree-sitter` native module didn't compile                                                 | `pnpm approve-builds --all && pnpm rebuild`. If on Node 23+, drop to Node 22 LTS.                                                              |
| Tool returns "Invalid input: Unknown field(s)"     | Caller passed an unrecognized argument                                                     | Schemas are strict — only the documented fields are allowed                                                                                    |

Anything not in this table → please file an
[issue](https://github.com/graphpilot-oss/graphpilot/issues) with the agent's
stderr + the failing JSON-RPC payload.
