# Cline (VS Code extension) + GraphPilot

Step-by-step install of GraphPilot as an MCP server inside Cline.

## 1. Build GraphPilot

```bash
git clone https://github.com/graphpilot-oss/graphpilot.git
cd graphpilot && pnpm install && pnpm build
```

## 2. Open Cline's MCP settings

The easy way:

1. Open VS Code
2. Open the **Cline panel** (sidebar icon)
3. Click **MCP Servers**
4. Click the ⚙ gear icon → **Edit MCP Settings**

That opens `cline_mcp_settings.json`. Direct paths if you prefer to edit it manually:

| OS      | Path                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Linux   | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`                     |
| Windows | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`                     |

## 3. Add the GraphPilot block

Paste the contents of [`cline_mcp_settings.json`](./cline_mcp_settings.json) and replace `/absolute/path/to/graphpilot/` with the real path:

```jsonc
{
  "mcpServers": {
    "graphpilot": {
      "command": "node",
      "args": ["/absolute/path/to/graphpilot/dist/cli.js", "mcp"],
      "disabled": false,
      "autoApprove": [],
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
      "disabled": false,
      "autoApprove": [],
    },
  },
}
```

> The `autoApprove` array lets you list tool names that Cline will call without per-call confirmation. Add e.g. `["gp_recall"]` once you're comfortable — leave it empty until then.

## 4. Verify

In the Cline panel → **MCP Servers** section, `graphpilot` should appear with a **green status dot** and 5 tools listed underneath. If it doesn't, restart VS Code.

## 5. Index a repo

From the integrated terminal:

```bash
node /abs/path/to/graphpilot/dist/cli.js index .
```

## 6. Try it

```text
Use graphpilot to find who calls authenticate.

Use gp_impact to show the blast radius of renaming parseFile.
```

Cline will surface a tool-call card with the request → response → "Approve" button. Once approved, the result appears in the chat with `file:line @ sha` evidence anchors.

## 7. Keep the index fresh

```bash
node /abs/path/to/graphpilot/dist/cli.js watch .
```

## Troubleshooting

> Quickest path: run `graphpilot doctor`. Full symptom-indexed guide: [`docs/troubleshooting.md`](../../docs/troubleshooting.md).

| Symptom                                | Fix                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Server shows red / disconnected        | Check `disabled: false`. Then try VS Code: Command Palette → "Developer: Reload Window".                                    |
| Cline can't find tools after a restart | The settings file is JSON-strict — a trailing comma will silently disable the entire `mcpServers` block. Validate the JSON. |
| Tool calls return "no index"           | Pass an explicit `path: "/abs/repo"`, or run `gp_index` first.                                                              |

## Files in this folder

| File                                                   | Purpose                                                |
| ------------------------------------------------------ | ------------------------------------------------------ |
| [`README.md`](./README.md)                             | This walkthrough                                       |
| [`cline_mcp_settings.json`](./cline_mcp_settings.json) | Sample config — copy the `mcpServers` block into yours |
