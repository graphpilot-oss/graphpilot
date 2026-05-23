# Quickstart

Five-minute path from a fresh clone to Claude Code answering structural
questions about your codebase using GraphPilot.

## Prerequisites

- Node.js **≥ 20** — check with `node --version`
- **pnpm 9+** (or use `npm` if you prefer — examples below default to pnpm)
- An MCP-compatible coding agent: Claude Code, Cursor, Cline, Windsurf,
  or Continue.dev

## 1. Install

Until v0.1.0 is published to npm, build from source:

```bash
git clone https://github.com/graphpilot-oss/graphpilot.git
cd graphpilot
pnpm install
pnpm build
```

The compiled CLI lives at `dist/cli.js`. Verify:

```bash
node dist/cli.js help
```

Once v0.1.0 publishes:

```bash
npx graphpilot --help    # zero-install
# or
npm install -g @graphpilot-oss/graphpilot
```

## 2. Index your first repo

Pick a TypeScript or JavaScript project — preferably a real one with
several hundred files so you can feel the value.

```bash
node dist/cli.js index /path/to/your/repo
```

Expected output:

```
Indexing /path/to/your/repo ...

✓ Remembered 412 symbols, 1138 calls (387 resolved) across 87 files in 320ms.
  Repo id:    a1b2c3d4e5f6abcd
  Graph file: /Users/you/.graphpilot/a1b2c3d4e5f6abcd/graph.json
```

What just happened:

- Every `.ts/.tsx/.js/.jsx/.mjs/.cjs` file got parsed by tree-sitter
- Functions, classes, methods, interfaces, types, enums were extracted
- Every call site inside every function body was captured
- The resolver matched in-repo callees back to their definitions
- Result saved to `~/.graphpilot/<repo-id>/graph.json` (mode 0600)

## 3. Sanity-check the index

```bash
# Re-read what was saved
node dist/cli.js status /path/to/your/repo
```

Or peek at the raw JSON:

```bash
jq '{filesIndexed, symbolCount, edgeCount, indexedAt}' \
  ~/.graphpilot/<repo-id>/graph.json
```

## 4. Wire to Claude Code

Edit `~/.claude.json` (create the file if it doesn't exist):

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

**Restart Claude Code fully** (quit, don't just close the window). Then
type `/mcp` — `graphpilot` should appear with **5 tools** (gp_index,
gp_recall, gp_callers, gp_impact, gp_stats).

For Cursor / Cline / Windsurf / Continue, see
[mcp-setup.md](mcp-setup.md).

## 5. Ask Claude a structural question

In a project where you've already run `gp_index`, try these in Claude
Code. Pick real symbol names from your indexed repo:

```text
"Use graphpilot to find where parseToken is defined."

"Who calls authenticate in this repo? Use graphpilot."

"What does indexDirectory call? Use graphpilot's callees."

"Re-index this repo with graphpilot."

"Use graphpilot to show the current index stats."
```

Watch the response for a `Calling graphpilot/gp_*` line — that's the
tool firing. If you see it, you're done.

## 6. Keep the index fresh while you edit (optional)

By default the index is a snapshot — it grows stale as you edit. Either
re-run `graphpilot index .` after big changes, or just leave watch mode
running in a side terminal:

```bash
node dist/cli.js watch /path/to/your/repo
# [graphpilot:watch] Watching ... (412 symbols, 1138 calls, 87 files).
# [graphpilot:watch] src/auth.ts: 32 (+1) symbols, 89 (+3) calls (4ms).
# [graphpilot:watch] src/auth.ts deleted: 30 (-2) symbols, 84 (-5) calls (3ms).
# Ctrl+C to stop.
```

Each save triggers a sub-10ms incremental update. The on-disk
`graph.json` is rewritten atomically — Claude always sees a consistent
view, even mid-edit.

## 7. Make Claude reach for GraphPilot automatically

You shouldn't have to type "use graphpilot to..." every time. Add a
`CLAUDE.md` to the root of the indexed repo:

```markdown
When asked any of:

- "who calls X" / "what uses X" / "where is X called from"
- "what does X call" / "what does X depend on"
- "rename X — what breaks" / "impact of changing X"
- "find function X" / "where is X defined"

→ Use graphpilot MCP tools (`gp_recall`, `gp_callers`) BEFORE grep or
reading files. Graphpilot is a pre-built code-graph for this repo.

Fall back to grep/read for: comments, string literals, config files,
languages other than TS/JS, git history.

After 10+ file edits, call `gp_index` once before further structural
questions.
```

Restart Claude Code one more time. From here, structural questions route
to GraphPilot automatically.

When `gp_impact` is part of the routing, add this line so it's used too:

```
- "rename X — what breaks" / "impact of changing X" / "what depends on X"
  → use gp_impact (returns direct + transitive callers + tests + public-API flag)
```

## What to do next

- [mcp-setup.md](mcp-setup.md) — per-client configuration
- [architecture.md](architecture.md) — how the pipeline works
- [limitations.md](limitations.md) — what GraphPilot deliberately doesn't do

## Troubleshooting

| Symptom                                               | Fix                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `/mcp` doesn't list graphpilot                        | Run `pnpm build` again, then **fully** quit and reopen Claude Code                  |
| Every tool call returns "No GraphPilot index found"   | Run `node dist/cli.js index /path` first, and pass an absolute `path` to tool calls |
| Tool errors with "Invalid input: Unknown field(s)..." | Schemas are strict — remove extra fields from the tool call                         |
| `pnpm install` fails on native modules                | `pnpm approve-builds --all && pnpm rebuild`                                         |
| Server starts but never responds                      | You're on a build older than the Day-10 stdio fix; rebuild from `main`              |
| The server keeps showing the same stale data          | Call `gp_index` from the agent (or re-run `node dist/cli.js index .`)               |

Issues not in this table → [open an issue](https://github.com/graphpilot-oss/graphpilot/issues).
