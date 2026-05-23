# Windsurf (Codeium) + GraphPilot

Step-by-step install of GraphPilot as an MCP server inside Windsurf.

## 1. Build GraphPilot

```bash
git clone https://github.com/graphpilot-oss/graphpilot.git
cd graphpilot && pnpm install && pnpm build
```

## 2. Edit Windsurf's MCP config

```
~/.codeium/windsurf/mcp_config.json
```

Create it if it doesn't exist. Paste the contents of [`mcp_config.json`](./mcp_config.json) and replace `/absolute/path/to/graphpilot/` with the real path:

```jsonc
{
  "mcpServers": {
    "graphpilot": {
      "command": "node",
      "args": ["/absolute/path/to/graphpilot/dist/cli.js", "mcp"],
    },
  },
}
```

Post-npm:

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

## 3. Restart Windsurf

Fully quit and reopen. The Cascade panel reads MCP config on launch.

## 4. Verify

Open the **Cascade** panel — the MCP tools list should include the five `gp_*` tools (`gp_index`, `gp_recall`, `gp_callers`, `gp_impact`, `gp_stats`).

## 5. Index a repo

```bash
node /abs/path/to/graphpilot/dist/cli.js index .
```

## 6. Try it

```text
Use graphpilot to find who calls authenticate.

What breaks if I rename parseFile? Use gp_impact.
```

## 7. Keep the index fresh

```bash
node /abs/path/to/graphpilot/dist/cli.js watch .
```

## Troubleshooting

| Symptom                                     | Fix                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| MCP tools list is empty                     | Verify JSON syntax with `python -m json.tool ~/.codeium/windsurf/mcp_config.json`. Then restart Windsurf. |
| Server shows but tools fail with "no index" | Pass an explicit `path: "/abs/repo"` to the tool, or `gp_index` first.                                    |
| Native module errors on launch              | `pnpm approve-builds --all && pnpm rebuild` in the graphpilot dir. Use Node 22 LTS if on 23+.             |

## Files in this folder

| File                                   | Purpose                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------ |
| [`README.md`](./README.md)             | This walkthrough                                                         |
| [`mcp_config.json`](./mcp_config.json) | Sample `~/.codeium/windsurf/mcp_config.json` — copy the block into yours |
