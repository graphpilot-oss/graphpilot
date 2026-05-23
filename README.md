<p align="center">
  <img src="assets/logo.png" alt="GraphPilot" width="120" />
</p>

<h1 align="center">GraphPilot</h1>

<p align="center">
  <strong>Structural memory for coding agents.</strong><br />
  A refactor-safe, branch-aware, evidence-backed code graph that runs entirely on your machine.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node ≥20" /></a>
  <img src="https://img.shields.io/badge/version-0.1.0-blue.svg" alt="v0.1.0" />
  <img src="https://img.shields.io/badge/status-alpha-orange.svg" alt="alpha" />
  <img src="https://img.shields.io/badge/tests-239%20passing-brightgreen.svg" alt="239 tests" />
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#the-five-tools">Tools</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#editor-setup">Editor setup</a> ·
  <a href="docs/limitations.md">Limitations</a> ·
  <a href="bench/README.md">Benchmarks</a>
</p>

---

## What it is

Coding agents like Claude Code, Cursor, and Cline re-`grep` your codebase every conversation. That burns tokens, hallucinates function names, and misses structural relationships ("what calls this?", "what breaks if I rename it?").

GraphPilot indexes the structural memory of your repo once and exposes it over the [Model Context Protocol](https://modelcontextprotocol.io). The agent reuses the same graph across sessions. **Token cost drops. Hallucinations drop. Refactors get safer.**

On 10 standardized structural questions about a real TypeScript codebase, GraphPilot reaches **F1 0.89 vs grep's 0.42** while the agent reads **99.9 % fewer bytes** (721 B vs 528 KB) to reach the same conclusion. [Reproduce in 30 seconds →](bench/README.md)

## What makes it different

Other code-graph tools treat your repo as a static blob: index once, query forever, no branch awareness, no proof of where an answer came from. GraphPilot is built around three properties none of them ship:

- 🔍 **Evidence anchors.** Every tool response carries `file:line @ sha` on every symbol and call site. The agent can quote the anchor verbatim and you can verify it instantly — hallucinations get exposed the moment you jump to the line.
- 🌿 **Differential impact.** Pass `since: <commit|branch>` to `gp_impact` and the result is filtered to files your branch actually touches. PR-scoped refactor analysis in one call instead of `git diff | xargs grep`.
- 🪵 **Worktree-aware by default.** Two `git worktree add`-ed branches naturally produce two separate indexes — no manual config. Run `graphpilot index ./src/feature` from a subdir and it transparently re-roots to the worktree top. Opt out with `--no-worktree`.

Add to that: **local-first** (no telemetry, no remote calls, enforced by an ESLint policy on `src/` itself), **deterministic** (same repo → same graph), **sub-second incremental** updates via watch mode.

## Quickstart

```bash
# Until v0.1.0 ships to npm — build from source
git clone https://github.com/graphpilot-oss/graphpilot.git
cd graphpilot && pnpm install && pnpm build

# Index a repo (your own TS/JS project)
node dist/cli.js index /path/to/your/repo

# Wire it into your agent — see examples/ for the config
```

Then point your MCP client at `graphpilot mcp`. Pre-made configs for the five most common agents live in [`examples/`](examples/) — pick yours and copy the snippet.

```bash
# Keep the index fresh as you edit (optional, recommended)
node dist/cli.js watch /path/to/your/repo
```

Full 5-minute walkthrough: [`docs/quickstart.md`](docs/quickstart.md).

## The five tools

GraphPilot exposes five MCP tools. Each one answers a structural question your agent would otherwise solve by grepping and reading files.

### `gp_recall` — find a symbol by name

Use this when the agent asks "where is X defined?" or needs to locate a function before reasoning about it.

- **Input:** `{ query, limit?, substring?, path? }`
- **Returns:** symbols matching the name (exact case-insensitive by default; `substring: true` for partial matches), each with `file:line @ sha`.
- **Replaces:** `grep -rn "function X"` plus reading each hit to find the real definition.

```text
Agent: gp_recall({ query: "parseToken" })
→ parseToken (function) — src/auth.ts:42 @ a1b2c3d
  export function parseToken(raw: string): Token | null
```

### `gp_callers` — list callers (or callees)

Use this when the agent needs to know "who calls X?" or "what does X call?" — the two fundamental questions of refactoring.

- **Input:** `{ symbol, direction?: 'callers' | 'callees', limit?, includeUnresolved?, path? }`
- **Returns:** every call edge where the symbol is target (callers) or source (callees), with anchors.
- **Replaces:** `grep -rn "X("` followed by manual filtering of comments, strings, and renamed shadows.

```text
Agent: gp_callers({ symbol: "authenticate", direction: "callers" })
→ login → authenticate — src/routes/login.ts:18 @ a1b2c3d
→ refreshSession → authenticate — src/session.ts:64 @ a1b2c3d
```

### `gp_impact` — blast radius in one call

Use this when the agent asks "what breaks if I rename X?" or "what depends on this?" — the single most expensive question an agent normally solves.

- **Input:** `{ symbol, depth? (1–5, default 3), since?, path? }`
- **Returns:** direct callers, transitive callers grouped by BFS depth, tests likely affected, public-API flag, summary stats.
- **Killer feature:** pass `since: 'main'` and the result is scoped to files your branch actually touches — PR-scoped refactor review without `git diff` gymnastics.

```text
Agent: gp_impact({ symbol: "extractSymbols", depth: 2, since: "main" })
→ Direct callers (2):    indexDirectory, applyUpdate
→ Depth-2 callers (1):   cmdIndex
→ Tests affected (3):    tests/indexer.test.ts, tests/symbols.test.ts, tests/cli.test.ts
→ Public API:            no
```

### `gp_index` — refresh from inside the agent

Use this after the agent (or the user) has made a batch of structural edits and wants the graph to reflect them without dropping to a shell.

- **Input:** `{ path? }`
- **Returns:** re-indexes the repo and invalidates the per-path query cache.
- **Pairs with:** `graphpilot watch` for sub-10 ms incremental updates between explicit re-indexes.

### `gp_stats` — index health probe

Use this as a smoke test: "is the index alive? when was it last refreshed?"

- **Input:** `{ path? }`
- **Returns:** repo id, `indexedAt`, file/symbol/edge counts, indexed branch + sha when available.

## How it works

```
┌────────────────────────────────────────────────────────────────┐
│                  Your TypeScript / JS repo                     │
└──────────────────────────────┬─────────────────────────────────┘
                               │
                ┌──────────────▼──────────────┐
                │  indexer.ts                 │
                │  walk dir · skip ignores ·  │
                │  symlink-safe · 50k cap     │
                └──────────────┬──────────────┘
                               │
                ┌──────────────▼──────────────┐
                │  parser.ts                  │
                │  tree-sitter → AST          │
                │  5 MB cap · iterative walk  │
                └──────────────┬──────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            │                                     │
   ┌────────▼────────┐                   ┌────────▼────────┐
   │  symbols.ts     │                   │  edges.ts       │
   │  funcs · classes│                   │  call sites +   │
   │  methods · ifs  │                   │  resolver       │
   │  types · enums  │                   │ (same-file→glb) │
   └────────┬────────┘                   └────────┬────────┘
            │                                     │
            └──────────────────┬──────────────────┘
                               │
                ┌──────────────▼──────────────┐
                │  storage.ts                 │
                │  ~/.graphpilot/<repo-id>/   │
                │  graph.json · mode 0600     │
                └──────────────┬──────────────┘
                               │
                ┌──────────────▼──────────────┐
                │  query.ts (GraphIndex)      │
                │  byName · byId · callers ·  │
                │  callees — sub-ms lookups   │
                └──────────────┬──────────────┘
                               │
                ┌──────────────▼──────────────┐
                │  mcp.ts                     │
                │  5 tools · stdio JSON-RPC   │
                └──────────────┬──────────────┘
                               │
                       [MCP protocol]
                               │
                ┌──────────────▼──────────────┐
                │  Claude Code · Cursor ·     │
                │  Cline · Windsurf · …       │
                └─────────────────────────────┘
```

Data flow is one-way: source → tree → symbols + edges → JSON → query → agent. GraphPilot never modifies your code.

Full pipeline writeup with file references: [`docs/architecture.md`](docs/architecture.md).

## When to use which tool

| If the agent is about to…                          | Reach for…                     | Why                                                   |
| -------------------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| `grep` for a function by name                      | `gp_recall`                    | One call, no false positives from comments or strings |
| Read 20 files looking for "who calls X"            | `gp_callers`                   | Pre-computed reverse index, sub-millisecond           |
| Plan a rename or signature change                  | `gp_impact`                    | Direct + transitive + tests + public-API in one call  |
| Review a PR's structural blast radius              | `gp_impact({ since: 'main' })` | Differential — only callers your branch touches       |
| Re-grep after editing several files                | `gp_index`                     | Incremental: lets the next call see your edits        |
| Sanity-check whether the index is loaded and fresh | `gp_stats`                     | One-liner health probe                                |

For string literals, error messages, config values, or anything in a language other than TS/JS: **stay with grep.** GraphPilot indexes code structure, not text.

## Editor setup

GraphPilot speaks MCP over stdio, so it works with any MCP-capable client. Ready-to-paste configs live in `examples/`:

| Client                        | Folder                                           |
| ----------------------------- | ------------------------------------------------ |
| **Claude Code** (Anthropic)   | [`examples/claude-code/`](examples/claude-code/) |
| **Cursor**                    | [`examples/cursor/`](examples/cursor/)           |
| **Cline** (VS Code extension) | [`examples/cline/`](examples/cline/)             |
| **Windsurf** (Codeium)        | [`examples/windsurf/`](examples/windsurf/)       |
| **Continue.dev**              | [`examples/continue/`](examples/continue/)       |
| Any other MCP client          | See [`docs/mcp-setup.md`](docs/mcp-setup.md)     |

Each folder contains: a `README.md` walkthrough, a sample config file with the exact JSON to paste, and (where the client supports it) a routing template so the agent automatically reaches for GraphPilot on structural questions.

## Privacy & security

GraphPilot is **local-first by promise and by build gate**.

- **No telemetry, no remote calls, ever.** Verifiable: `src/` has zero `http`, `fetch`, `axios`, or analytics imports — enforced by an ESLint rule plus a meta-test that proves the rule fires on every banned import.
- **No `child_process`, no `exec`, no `spawn`.** Git facts are read directly from `.git/` via pure-JS helpers.
- **Source code never leaves your machine.** Only structural metadata (names, locations, signatures, call relationships) lives in `~/.graphpilot/`.
- **Signatures are redacted** for common secret patterns (OpenAI/Anthropic `sk-`, GitHub `ghp_`/`ghs_`, AWS `AKIA`, JWTs, PEM headers, Slack/Stripe tokens) before they're written to disk.
- **Strict file permissions:** dir `0o700`, files `0o600`.
- **Schema validation on load:** tampered or corrupt `graph.json` falls back to "no index" rather than poisoning the agent.
- **Hand-rolled input validators** on every MCP tool — unknown fields are rejected, every field type-checked, numbers range-checked, strings length-capped.

Threat model and per-defence test references live in [`docs/architecture.md`](docs/architecture.md). Report security issues per [`SECURITY.md`](SECURITY.md).

## Vs alternatives

| Tool               | Branch-aware | Evidence anchors | Local-first | Languages    |
| ------------------ | ------------ | ---------------- | ----------- | ------------ |
| **GraphPilot**     | ✅           | ✅               | ✅          | TS/JS        |
| CodeGraphContext   | ❌           | ❌               | ✅          | TS/JS/Python |
| Serena             | ❌           | ❌               | ✅          | Multi        |
| Sourcegraph (SaaS) | ⚠ partial    | ✅               | ❌          | Multi        |
| Plain grep + read  | n/a          | ❌               | ✅          | All          |

GraphPilot is not trying to be the universal code-graph. It's trying to be the one that makes refactors in TypeScript/JavaScript repos **safe to delegate to an agent** — which means branch awareness and verifiable citations are non-negotiable.

## Limitations

GraphPilot v0.1 makes deliberate trade-offs to ship small and sharp:

- **TS/JS only.** Python, Rust, Go, Java are out of scope for v1. Python is demand-gated for v0.2 / v0.3.
- **Name-based resolver** (no import-path tracking, no type-based method dispatch). Expected resolution rate: ~25–35 % of edges resolve to in-repo symbols; the rest are stdlib / third-party. That's enough because the questions agents actually ask (_"who calls X in my repo?"_) are the ones the dumb resolver answers correctly.
- **No semantic search.** `gp_recall` is name-only. "Find code similar to this snippet" is deferred until 30+ users ask for it.
- **No `.graphpilotignore`** yet (defaults skip `node_modules`, `dist`, `build`, `.git`, `coverage`, `.next`, `.nuxt`, `.cache`, `out`, `*.d.ts`).
- **Single repo per query.** Workspace abstraction is on the v1.x roadmap.

Full list with mitigations: [`docs/limitations.md`](docs/limitations.md).

## FAQ

**Does it send my code anywhere?**
No. There is no network code in `src/`, no telemetry, no update check. An ESLint rule blocks adding any of those at the build gate.

**Will it slow down my editor?**
The MCP server is idle until your agent calls a tool. Tool calls are sub-millisecond after the first lazy load. Watch mode adds ~3–10 ms per file save.

**What happens to the graph when I switch branches?**
If you use `git worktree`, you automatically get a separate graph per worktree. On a single working copy that you switch with `git checkout`, the graph reflects the last `gp_index` (or watch-mode updates). Run `gp_index` after a branch switch to refresh.

**Do I need to re-index every session?**
No. The graph persists at `~/.graphpilot/<repo-id>/graph.json`. Re-index after sweeping changes; otherwise, watch mode keeps it fresh incrementally.

**Why TypeScript/JavaScript first?**
That's where the maintainer's pain was, and tree-sitter-typescript covers TS, TSX, JSX, and JS in a single grammar. Python is the next likely addition; vote with a GitHub Discussion.

**How does this compare to LSP?**
LSPs are scoped to one editor and one buffer at a time, and they re-compute on each query. GraphPilot is editor-agnostic, persists across sessions, and answers structural questions (who-calls, blast-radius) that LSPs don't expose uniformly.

## Documentation

- [`docs/quickstart.md`](docs/quickstart.md) — 5-minute walkthrough
- [`docs/mcp-setup.md`](docs/mcp-setup.md) — per-client config reference
- [`docs/architecture.md`](docs/architecture.md) — pipeline writeup with file refs
- [`docs/limitations.md`](docs/limitations.md) — v1 caveats (read this)
- [`bench/README.md`](bench/README.md) — benchmark methodology + results
- [`examples/`](examples/) — ready-to-paste configs for every supported client

## Contributing

GraphPilot is small, opinionated, and accepting contributions. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) — especially the _"What we are NOT doing in v1"_ section before you propose a feature.

Found a security issue? Please follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## License

[Apache-2.0](LICENSE). Copyright 2026 Akshay Sharma.
