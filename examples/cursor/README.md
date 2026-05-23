# Cursor + GraphPilot

Step-by-step install of GraphPilot as an MCP server inside Cursor.

## 1. Build GraphPilot

```bash
git clone https://github.com/graphpilot-oss/graphpilot.git
cd graphpilot && pnpm install && pnpm build
```

## 2. Open Cursor's MCP config

Two ways:

- **UI:** Press `Cmd/Ctrl + ,` → search "MCP" → "Edit MCP config"
- **File:** open `~/.cursor/mcp.json` directly (create it if it doesn't exist)

Paste the contents of [`mcp.json`](./mcp.json) and replace `/absolute/path/to/graphpilot/` with the real path on your machine:

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

## 3. Verify

Settings → MCP. `graphpilot` should show as **Connected** with 5 tools listed.

If it shows red after the config change, click the refresh icon next to it — Cursor sometimes caches MCP server state.

## 4. Index a repo

```bash
node /abs/path/to/graphpilot/dist/cli.js index .
```

## 5. Auto-routing via `.cursorrules`

Drop [`.cursorrules`](./.cursorrules) into the root of the repo you indexed. It tells Cursor's agent to reach for GraphPilot on structural questions automatically. Re-open the workspace to pick it up.

Try:

```text
Who calls authenticate in this repo?

What breaks if I rename parseFile?
```

You should see Cursor invoke `gp_callers` / `gp_impact` in its tool-use trace.

## 6. Keep the index fresh

In a side terminal:

```bash
node /abs/path/to/graphpilot/dist/cli.js watch .
```

## Troubleshooting

| Symptom                            | Fix                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Server shows red in Settings → MCP | Click the refresh icon. If still red, run `node dist/cli.js mcp` in a terminal — inspect stderr.       |
| `.cursorrules` ignored             | Cursor reads it on workspace open. Close and reopen the folder.                                        |
| Tool calls return "no index"       | Pass an explicit `path: "/abs/repo"` to the tool, or `cd` to the indexed repo before launching Cursor. |

## Files in this folder

| File                             | Purpose                                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| [`README.md`](./README.md)       | This walkthrough                                                     |
| [`mcp.json`](./mcp.json)         | Sample `~/.cursor/mcp.json` — copy the `mcpServers` block into yours |
| [`.cursorrules`](./.cursorrules) | Routing template — copy to your indexed repo's root for auto-routing |
