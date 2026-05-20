# Architecture

How GraphPilot turns a folder of source files into structural memory an
agent can query in milliseconds.

This doc is for contributors and evaluators. If you just want to use it,
see [quickstart.md](quickstart.md).

## Top-level view

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Your TypeScript / JS repo                        │
└───────────────────────────────────┬─────────────────────────────────┘
                                    │
                  ┌─────────────────▼──────────────────┐
                  │  indexer.ts                        │
                  │  walk dir, ignore node_modules,    │
                  │  followSymbolicLinks: false        │
                  └─────────────────┬──────────────────┘
                                    │
                  ┌─────────────────▼──────────────────┐
                  │  parser.ts                         │
                  │  tree-sitter → AST                 │
                  │  (5 MB file cap, iterative walk)   │
                  └─────────────────┬──────────────────┘
                                    │
              ┌─────────────────────┴──────────────────────┐
              │                                            │
   ┌──────────▼──────────┐                      ┌──────────▼──────────┐
   │  symbols.ts         │                      │  edges.ts           │
   │  extract            │                      │  call sites +       │
   │  func/class/method/ │                      │  same-file > global │
   │  iface/type/enum    │                      │  resolver           │
   └──────────┬──────────┘                      └──────────┬──────────┘
              │                                            │
              └─────────────────────┬──────────────────────┘
                                    │
                  ┌─────────────────▼──────────────────┐
                  │  storage.ts                        │
                  │  ~/.graphpilot/<repo-id>/          │
                  │    graph.json        (mode 0600)   │
                  │    interactions.jsonl (mode 0600)  │
                  └─────────────────┬──────────────────┘
                                    │
                  ┌─────────────────▼──────────────────┐
                  │  query.ts (GraphIndex)             │
                  │  4 pre-computed maps:              │
                  │  byName, byId, callers, callees    │
                  └─────────────────┬──────────────────┘
                                    │
                  ┌─────────────────▼──────────────────┐
                  │  mcp.ts                            │
                  │  5 tools over stdio JSON-RPC       │
                  │  validators.ts + interactions log  │
                  └─────────────────┬──────────────────┘
                                    │
                            [MCP protocol]
                                    │
                  ┌─────────────────▼──────────────────┐
                  │  Claude Code / Cursor / Cline /    │
                  │  Windsurf / Continue / ...         │
                  └────────────────────────────────────┘
```

Data flow is one-way: source → tree → symbols + edges → JSON → query →
agent. Nothing flows back. GraphPilot never modifies your code.

## The five-stage pipeline

### Stage 1 — Walk the directory

File: [`src/indexer.ts`](../src/indexer.ts)

- Uses `fast-glob` over `**/*.{ts,tsx,js,jsx,mjs,cjs}`
- Skips `node_modules/`, `dist/`, `build/`, `.git/`, `coverage/`,
  `.next/`, `.nuxt/`, `.cache/`, `out/`, and `*.d.ts`
- `followSymbolicLinks: false` + per-file realpath check — files whose
  realpath escapes the indexed root are skipped (defends against
  symlink-escape attacks)
- Hard cap of `MAX_FILES_PER_INDEX = 50,000`. Throws above that.

### Stage 2 — Parse each file

File: [`src/parser.ts`](../src/parser.ts)

- `tree-sitter` + `tree-sitter-typescript` (covers TS, TSX, JSX, and JS)
- Pre-read stat check: files over `MAX_FILE_BYTES = 5 MB` are skipped
- `walk()` is **iterative** (stack-based), not recursive — protects
  against stack overflow on pathologically deep generated code

### Stage 3 — Extract symbols + raw calls (per file)

Files: [`src/symbols.ts`](../src/symbols.ts) and
[`src/edges.ts`](../src/edges.ts)

Symbols extracted:

- `function_declaration`
- arrow / function expressions assigned to consts → `variable` kind
- `class_declaration` and its `method_definition` children
- `interface_declaration` (TS)
- `type_alias_declaration` (TS)
- `enum_declaration` (TS)

Each gets a stable id of the form:

```
<file>#<parent>.<name>@<line>
```

`<parent>` is the enclosing class name for methods; empty otherwise.

Call extraction:

- For every function-like symbol, walk its body subtree
- **Stop at nested function boundaries** — calls inside an inline arrow
  are attributed to the arrow, not the outer function
- Emit a `RawCall` for every `call_expression` and `new_expression`
- Callee name is the identifier or the `.property` of a member-expression

### Stage 4 — Resolve + save

File: [`src/edges.ts`](../src/edges.ts) (resolver) and
[`src/storage.ts`](../src/storage.ts) (persistence)

After all files are parsed, a second pass resolves each `RawCall`:

1. Prefer a symbol with the matching name in the **same file**
2. Otherwise pick the **first** global match
3. Otherwise leave `toId: null`; preserve `toName` so the agent still
   sees the call happened

Save location:

```
~/.graphpilot/<repo-id>/graph.json
```

Where `<repo-id>` is the first 16 hex chars of
`sha256(absolute_repo_path)`. File permissions: `0o600`. Directory:
`0o700`.

Schema is versioned (`version: 1`) so future migrations are clean.

### Stage 5 — Serve queries

Files: [`src/query.ts`](../src/query.ts) and [`src/mcp.ts`](../src/mcp.ts)

When the MCP server starts, it lazy-loads `graph.json` for whichever
repo path is being queried and builds a `GraphIndex`:

- `byNameLower` — lowercase name → SymbolRecord[]
- `byId` — full id → SymbolRecord
- `callersOf` — target id → CallEdge[] (answers "who calls X")
- `calleesOf` — source id → CallEdge[] (answers "what does X call")

The index is cached per absolute path inside the process so repeated
tool calls don't re-parse the JSON.

Every tool call flows through:

```
MCP request → validator → tool handler → response
                              ↓
                         interaction log
```

## The five MCP tools

| Tool         | Input                                                                               | Output                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `gp_index`   | `{ path? }`                                                                         | Triggers re-indexing + saves graph; invalidates per-path cache                                                                      |
| `gp_recall`  | `{ query, limit?, substring?, path? }`                                              | Symbols matching name (exact case-insensitive by default; `substring: true` opt-in)                                                 |
| `gp_callers` | `{ symbol, direction?: 'callers' \| 'callees', limit?, includeUnresolved?, path? }` | Edges where the symbol is target (callers) or source (callees)                                                                      |
| `gp_impact`  | `{ symbol, depth? (1–5, default 3), path? }`                                        | Blast-radius report: direct callers, transitive callers grouped by BFS depth, tests likely affected, public-API flag, summary stats |
| `gp_stats`   | `{ path? }`                                                                         | Health check: repo id, indexedAt, file/symbol/edge counts                                                                           |

Every input is validated by hand-rolled validators in
[`src/validators.ts`](../src/validators.ts):

- Reject unknown fields (`additionalProperties: false` defence in depth)
- Type-check every field
- Range-check numbers (`limit` capped at 50–100 depending on tool)
- Length-cap strings (no 2 MB symbol names)
- Strict enums for `direction`

If any check fails, the tool returns `{ isError: true, content: ... }`
with a clear message — the request never reaches the handler.

## What lives where on disk

```
~/.graphpilot/
   <repo-id-1>/
      graph.json           ← structural index (mode 0600)
      interactions.jsonl   ← append-only tool-call log (mode 0600)
   <repo-id-2>/
      graph.json
      interactions.jsonl
```

Nothing else is written. Nothing leaves your machine.

## The interaction log

File: [`src/interactions.ts`](../src/interactions.ts)

Every tool call appends one line to `interactions.jsonl`:

```json
{
  "ts": "2026-05-18T20:45:00Z",
  "tool": "gp_recall",
  "input": { "query": "parseToken" },
  "results": 1,
  "durationMs": 3
}
```

**What is logged:** tool name, sanitized input args, result count,
duration, error (if any).

**What is NOT logged:** source code, file contents, user prompts.

**Sanitization** (defends against log-line forgery via crafted symbol
names):

- Strip control characters (e.g. newlines become spaces)
- Cap strings at 500 chars
- Cap whole-line size at 8 KB; oversize entries fall back to a marker
- Disabled entirely with `GRAPHPILOT_NO_LOG=1`

v0.1 doesn't _read_ this log. It exists from day one so future ranking
and personalization have data to train on. Local-only, your data.

## Process model

- One process per MCP session
- stdio transport: reads JSON-RPC from stdin, writes responses to stdout
- Diagnostics go to **stderr** (stdout is reserved for the protocol)
- The process stays alive as long as stdin is open; exits cleanly on
  client disconnect (see the Day-10 stdio fix)
- No daemon mode in v0.1. One process per `~/.claude.json` entry.

## Security model

See [SECURITY.md](../SECURITY.md) for the user-facing policy + how to
report a vulnerability. Active defences in code:

- `validateRootPath` refuses `/`, `/etc`, `/var`, `~`, `/Users`,
  `/home`, Windows system paths, and macOS-resolved aliases like
  `/private/etc`
- File size cap (5 MB) and file count cap (50k)
- Symlink protection (fast-glob `followSymbolicLinks: false` + realpath
  bounds check per file)
- Storage perms (`0o700` dir, `0o600` files)
- No `child_process`, no `exec`, no network code anywhere in `src/`
- Hand-rolled validators on every MCP tool input (zero deps)
- Empty `additionalProperties: false` on every tool's input schema

## Testing strategy

| Test file                    | What it covers                                            | Tests  |
| ---------------------------- | --------------------------------------------------------- | ------ |
| `tests/parser.test.ts`       | Tree-sitter wiring + function detection                   | 3      |
| `tests/symbols.test.ts`      | Per-kind symbol extraction + id format                    | 9      |
| `tests/edges.test.ts`        | Raw call extraction + resolution + nested fns             | 10     |
| `tests/security.test.ts`     | T1/T2/T7/T10 defences                                     | 10     |
| `tests/query.test.ts`        | GraphIndex maps + edge cases                              | 18     |
| `tests/validators.test.ts`   | Per-tool input validators                                 | 20     |
| `tests/interactions.test.ts` | Sanitization + log file + env-var disable                 | 11     |
| `tests/mcp.test.ts`          | Tools through InMemoryTransport                           | 14     |
| `tests/mcp-stdio.test.ts`    | Real subprocess over stdio (catches the Day-10 bug class) | 3      |
| **Total**                    |                                                           | **98** |

`InMemoryTransport` is fast and covers tool logic. `mcp-stdio.test.ts`
spawns the real binary and drives it over stdin/stdout — slower but
catches the "server starts but never responds" regression class.

## Extension points (where v0.2+ work plugs in)

| Feature               | Where it would live                                | Effort |
| --------------------- | -------------------------------------------------- | ------ |
| ~~Watch mode~~        | Shipped: `src/watcher.ts` + `graphpilot watch` CLI | —      |
| ~~`gp_impact` tool~~  | Shipped: `src/impact.ts` + handler in `mcp.ts`     | —      |
| `.graphpilotignore`   | extend `DEFAULT_IGNORE` in indexer + watcher       | small  |
| Cross-repo workspace  | new `src/workspace.ts` + workspace yaml loader     | medium |
| Semantic search       | embedding pipeline + vector index                  | medium |
| Stack-Graphs resolver | replace `resolveCallEdges` algorithm               | large  |
| Python support        | new tree-sitter grammar wired through `parser.ts`  | medium |
