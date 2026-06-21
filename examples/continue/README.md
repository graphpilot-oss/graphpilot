# Continue.dev + GraphPilot

Step-by-step install of GraphPilot as an MCP server inside Continue.

> Continue's MCP support is flagged **experimental** at the time of writing. If the config key below isn't recognized, check the [Continue docs](https://docs.continue.dev) for the current schema.

## 1. Build GraphPilot

```bash
git clone https://github.com/graphpilot-oss/graphpilot.git
cd graphpilot && pnpm install && pnpm build
```

## 2. Edit Continue's config

Two scopes — pick one:

- **Global:** `~/.continue/config.json`
- **Per-project:** `<your-repo>/.continue/config.json`

Create the file if it doesn't exist. Paste the contents of [`config.json`](./config.json) and replace `/absolute/path/to/graphpilot/` with the real path:

```jsonc
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/graphpilot/dist/cli.js", "mcp"],
        },
      },
    ],
  },
}
```

Post-npm:

```jsonc
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["graphpilot", "mcp"],
        },
      },
    ],
  },
}
```

## 3. Restart Continue

Reload the VS Code / JetBrains window after editing the config.

## 4. Verify

Continue → Settings → **MCP Servers** panel. `graphpilot` should be listed with 5 tools.

## 5. Index a repo

```bash
node /abs/path/to/graphpilot/dist/cli.js index .
```

## 6. Try it

```text
Use graphpilot's gp_recall to find parseToken.

Use gp_impact to compute the blast radius of renaming authenticate.
```

## 7. Keep the index fresh

```bash
node /abs/path/to/graphpilot/dist/cli.js watch .
```

## Troubleshooting

> Quickest path: run `graphpilot doctor`. Full symptom-indexed guide: [`docs/troubleshooting.md`](../../docs/troubleshooting.md).

| Symptom                                                 | Fix                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `modelContextProtocolServers` reported as "unknown key" | Your Continue version is on an older schema. Check the current docs for the new key name. |
| Server appears but tools aren't called                  | Continue's MCP autorouting is conservative. Be explicit: _"Use graphpilot's gp_callers…"_ |
| `pnpm install` native-module errors                     | `pnpm approve-builds --all && pnpm rebuild`. Drop to Node 22 LTS if on 23+.               |

## Files in this folder

| File                           | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| [`README.md`](./README.md)     | This walkthrough                                             |
| [`config.json`](./config.json) | Sample `~/.continue/config.json` — copy the block into yours |
