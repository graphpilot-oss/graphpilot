# Troubleshooting

Something not working? **Start here: run `graphpilot doctor`** in your repo.

```bash
graphpilot doctor          # ✓/⚠/✗ checklist with a one-line fix per failure
graphpilot doctor --json   # machine-readable — paste into a bug report
```

`doctor` checks the whole chain in one shot: Node ≥ 20, `graphpilot` on your
`PATH`, the `~/.graphpilot` store and its permissions, whether this repo has a
fresh index, whether the MCP server actually starts and lists its four tools,
and whether `graphpilot` is registered in each detected client's config. Most
problems below are something `doctor` will point straight at.

This guide is organized by **symptom**. Find yours, then check the
[client-specific notes](#client-specific-notes) at the bottom — every client
fails a little differently.

---

## Tools missing / the agent doesn't call `gp_*`

The agent acts like GraphPilot isn't there — no `gp_recall`, `gp_callers`,
`gp_impact`, or `gp_index` in its tool list.

1. **Confirm the server is registered.** `graphpilot doctor` reports, per
   client, whether `graphpilot` is present in the MCP config. If it says
   "detected but not registered," add the `mcpServers.graphpilot` block — copy
   the ready-made config for your client from [`examples/`](../examples/) or
   follow [`docs/mcp-setup.md`](mcp-setup.md).
2. **Restart the client — fully.** Every supported client reads its MCP config
   only at launch; edits don't hot-reload. "Restart" means _quit and relaunch
   the app_, not just closing the window (see per-client notes below).
3. **Check the config is valid JSON.** Clients silently ignore a config with a
   syntax error. `doctor` flags an unparseable client config.
4. **Make sure `graphpilot` is runnable.** If the command isn't found, see
   [`command not found: graphpilot`](#command-not-found-graphpilot).

→ If `doctor` shows all ✓ but the agent still won't call the tools, prompt it
explicitly once: _"use the `gp_` MCP tools."\_ Some models need the nudge the
first time.

---

## Tool calls hang or time out

The tools appear, but a call never returns — or the client drops the server
mid-session.

1. **Run the server by hand and read stderr:**
   ```bash
   graphpilot mcp           # or: node /abs/path/to/dist/cli.js mcp
   ```
   It should print `MCP server ready (stdio)`. A stack trace instead tells you
   what's wrong (most often a native-module problem — see below).
2. **`graphpilot doctor`** runs the same `initialize` + `tools/list` handshake
   in-process and fails loudly if the server can't reach "ready," so it isolates
   a startup hang from a client-side issue.
3. **Native bindings failed to load** (`Failed to load native bindings` in
   stderr): `tree-sitter` didn't compile. Run
   `pnpm approve-builds --all && pnpm rebuild`. On Node 23+, drop to Node 22 LTS
   — tree-sitter is finicky there.
4. **A huge repo on first index** can take seconds (see the performance table in
   [`docs/limitations.md`](limitations.md)). Pre-build the index once with
   `graphpilot index <path>` so the agent's first call hits a warm graph instead
   of triggering a cold index.

→ Still hanging? Capture `graphpilot doctor --json` and the server's stderr and
[open an issue](https://github.com/graphpilot-oss/graphpilot/issues).

---

## Results look stale / out of date

`gp_*` answers don't match the code in front of you — a renamed symbol still
shows its old callers, a deleted function still resolves.

- The graph reflects the **last index**. After sweeping edits or a
  `git checkout` that changes many files, refresh it: call the **`gp_index`**
  tool, or run `graphpilot index <path>` in a terminal.
- Keep it fresh automatically while you work:
  ```bash
  graphpilot watch <path>   # ~3–10 ms incremental update per save
  ```
- **Branch switches:** with `git worktree` you get a separate graph per
  worktree automatically. On a single working copy switched via `git checkout`,
  re-run `gp_index` after the switch.
- `graphpilot doctor` reports the indexed commit vs your current `HEAD`, so it
  tells you when the index is behind.

→ If a call returns **"index … is corrupt"** (not "no index found"), the
on-disk graph failed validation — just re-run `graphpilot index <path>` to
rebuild it.

---

## `command not found: graphpilot`

Your global npm bin directory isn't on `PATH`.

```bash
npm config get prefix      # → e.g. /usr/local  (bin is <prefix>/bin)
```

Add `<prefix>/bin` to your shell's `PATH`, or skip the global install and use
the one-shot form everywhere:

```bash
npx @graphpilot-oss/graphpilot <command>
```

If you wired your MCP config to `"command": "graphpilot"` but the client can't
find it, switch the config to the `npx` form (or an absolute
`node /abs/path/to/dist/cli.js` path) — see [`docs/mcp-setup.md`](mcp-setup.md).

→ `graphpilot doctor` checks `PATH` and tells you exactly which case you're in.

---

## Client-specific notes

The four tools are identical everywhere; only _how you register and restart_
differs. Full paste-ready configs live in [`examples/`](../examples/).

| Client      | Config file                           | "Restart" means                        | Where to verify           |
| ----------- | ------------------------------------- | -------------------------------------- | ------------------------- |
| Claude Code | `~/.claude.json`                      | **Quit** the app (not just the window) | `/mcp` lists 4 tools      |
| Cursor      | `~/.cursor/mcp.json`                  | Reload window, or click the ↻ refresh  | Settings → MCP: Connected |
| Cline       | `…/cline_mcp_settings.json`           | Reopen the Cline panel                 | Green dot in MCP Servers  |
| Windsurf    | `~/.codeium/windsurf/mcp_config.json` | Restart Windsurf                       | Cascade panel tool list   |
| Continue    | `~/.continue/config.json`             | Restart the IDE                        | Settings → MCP Servers    |

### Claude Code

`~/.claude.json` is read **only at launch**. Edits never hot-reload — fully quit
and relaunch, then type `/mcp` and expect `graphpilot — 4 tools`.
→ `graphpilot doctor` confirms the entry is present before you restart.

### Cursor

If `graphpilot` shows **red** after a config change, click the refresh icon next
to it in Settings → MCP; Cursor caches server state. A project
`.cursor/mcp.json` with `"env": { "GRAPHPILOT_ROOT": "${workspaceFolder}" }`
fixes "tools work but every call says no index."
→ `graphpilot doctor` confirms registration + index presence.

### Cline (VS Code)

Edit via the Cline panel → "MCP Servers" → gear → "Edit MCP Settings", and make
sure `"disabled": false`. A green status dot = connected.
→ `graphpilot doctor` confirms the config path and entry.

### Windsurf

Config lives at `~/.codeium/windsurf/mcp_config.json`; restart Windsurf and
check the Cascade panel's tool list for the four `gp_*` tools.
→ `graphpilot doctor` confirms registration.

### Continue.dev

Continue's MCP support is experimental and its config schema varies by version —
it uses `experimental.modelContextProtocolServers`, **not** the plain
`mcpServers` block the other clients use. If the key is unrecognized, check your
Continue version against their docs. (For this reason `graphpilot init` does not
auto-edit Continue configs.)
→ `graphpilot doctor` checks whether Continue is installed; follow
[`examples/continue/`](../examples/continue/) for the exact block.

---

## Still stuck?

[Open an issue](https://github.com/graphpilot-oss/graphpilot/issues) with:

- `graphpilot doctor --json` output,
- the server's stderr from running `graphpilot mcp` directly, and
- your client + OS.

"Undocumented limitation" and "doctor missed my case" are both valid issue
types — they help keep this guide honest.
