# Claude Code (Anthropic) + GraphPilot

Step-by-step install of GraphPilot as an MCP server inside Claude Code.

## 1. Build GraphPilot

```bash
git clone https://github.com/graphpilot-oss/graphpilot.git
cd graphpilot && pnpm install && pnpm build
```

The compiled CLI lands at `dist/cli.js`. Verify:

```bash
node dist/cli.js --help
```

## 2. Edit `~/.claude.json`

Create the file if it doesn't exist. Add the `mcpServers` block:

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

A copy-paste-ready sample is in [`claude_config.json`](./claude_config.json). Replace `/absolute/path/to/graphpilot/` with the real path on your machine.

Once v0.1.0 ships to npm, you can simplify to:

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

## 3. Fully restart Claude Code

Quit completely — don't just close the window. `~/.claude.json` is read on launch only.

## 4. Verify the wire

In any Claude Code session, type:

```text
/mcp
```

You should see:

```
graphpilot
  4 tools: gp_index, gp_recall, gp_callers, gp_impact
```

If the server doesn't appear, run `node /abs/path/to/graphpilot/dist/cli.js mcp` in a terminal and check stderr for the error — most config bugs surface immediately.

## 5. Index a repo

From the terminal of any TS/JS project:

```bash
node /abs/path/to/graphpilot/dist/cli.js index .
```

Or ask Claude:

```text
Use graphpilot's gp_index tool on this repo.
```

## 6. Make Claude reach for GraphPilot automatically

Copy [`CLAUDE.md`](./CLAUDE.md) (the routing template in this folder) into the **root of the repo you indexed**. Restart Claude one more time. From that point on, structural questions route to GraphPilot without you having to say _"use graphpilot to…"_.

Try:

```text
Who calls authenticate in this repo?

What breaks if I rename parseFile?

Find every function whose name contains 'parse'.
```

You should see a `Calling graphpilot/gp_*` line in the response — that's the tool firing.

## 7. Keep the index fresh (optional)

In a side terminal:

```bash
node /abs/path/to/graphpilot/dist/cli.js watch /path/to/your/repo
```

Sub-10 ms incremental updates on every save. Ctrl+C to stop.

## Troubleshooting

> Quickest path: run `graphpilot doctor`. Full symptom-indexed guide: [`docs/troubleshooting.md`](../../docs/troubleshooting.md).

| Symptom                                   | Fix                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/mcp` doesn't list `graphpilot`          | Edits to `~/.claude.json` don't hot-reload. Fully quit Claude Code and relaunch.                              |
| Tools list but every call says "no index" | Path mismatch — pass an explicit `path: "/abs/repo"` argument, or index from the same `cwd` Claude uses.      |
| `pnpm install` fails on native modules    | `pnpm approve-builds --all && pnpm rebuild`. On Node 23+, drop to Node 22 LTS — tree-sitter is finicky on 23. |

Anything not listed: [open an issue](https://github.com/graphpilot-oss/graphpilot/issues) with the stderr from `node dist/cli.js mcp`.

## Files in this folder

| File                                         | Purpose                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`README.md`](./README.md)                   | This walkthrough                                                                           |
| [`claude_config.json`](./claude_config.json) | Sample `~/.claude.json` content — copy the `mcpServers` block into yours                   |
| [`CLAUDE.md`](./CLAUDE.md)                   | Drop-in routing template — copy to your indexed repo's root so Claude auto-uses GraphPilot |
