# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **MCP workspace roots** — on connect, GraphPilot calls `roots/list` (when the client supports it) and uses workspace folders as the default repo path for tool calls.
- **Default path discovery** — when `path` is omitted, resolution tries `GRAPHPILOT_ROOT`, MCP roots, walking parents of `cwd`, a unique index under `~/.graphpilot`, then `cwd`. Errors list known indexes on the machine.
- Project-level **`.cursor/mcp.json`** template with `${workspaceFolder}` for local development.

### Changed

- MCP tool schemas document the new default path behaviour instead of “Default: cwd”.

## [0.1.0] — 2026-05-23

Initial public release. GraphPilot is a local-first, refactor-safe code graph for coding agents over the Model Context Protocol.

### Added

#### Core engine

- Tree-sitter parser for **TypeScript, TSX, JavaScript, JSX** with a 5 MB per-file size cap and an iterative AST walk (safe on deeply-nested generated code).
- Symbol extraction for functions, classes, methods, interfaces, type aliases, and enums. Stable symbol ids of the form `<file>#<parent>.<name>@<line>`.
- Call-edge extraction with a two-pass name resolver — same-file first, then first global match. Unresolved external calls (`JSON.parse`, stdlib, third-party) keep their `toName` so the agent still sees the call site.
- Directory indexer with sensible default ignores (`node_modules`, `dist`, `build`, `.git`, `coverage`, `.next`, `.nuxt`, `.cache`, `out`, `*.d.ts`), a 50 000-file hard cap, and symlink-escape protection.
- Query layer (`GraphIndex`) with four pre-computed maps (`byName`, `byId`, `callers`, `callees`). Sub-millisecond lookups on indexed repos.
- JSON storage at `~/.graphpilot/<repo-id>/graph.json` (mode `0600`) with versioned schema and atomic writes.
- Worktree-aware indexing: subdirectory invocations auto-resolve to the git worktree top, so two `git worktree add`-ed branches naturally produce two separate indexes. Opt out with `--no-worktree`.

#### MCP server (four tools)

- `gp_index` — re-index a repo from inside the agent.
- `gp_recall` — find symbols by name (exact case-insensitive by default, substring opt-in).
- `gp_callers` — list callers or callees of a symbol, with a `direction` parameter.
- `gp_impact` — blast-radius analysis: direct + transitive callers (BFS, depth 1–5), tests likely affected, public-API flag, summary stats. Accepts `since: <commit|tag|branch>` for PR-scoped impact via `isomorphic-git` (pure JS, no shell-out).

#### Evidence anchors

Every MCP tool response includes `file:line @ <short-sha>` provenance on each symbol and call edge, so the agent can quote a verifiable reference. Old graphs without `indexedSha` continue to load (the field is optional in the schema).

#### Watch mode

`graphpilot watch <path>` keeps the index fresh as you edit. Uses `chokidar` with editor-save debouncing; each save triggers an incremental update (re-parse one file, re-resolve edges, atomic save) at 3–10 ms per save on small repos. Updates serialize through an internal chain to prevent torn graphs during chokidar bursts.

#### CLI

- `graphpilot index <path>` — index a repo
- `graphpilot status <path>` — show what's indexed
- `graphpilot watch <path>` — keep the index fresh
- `graphpilot mcp` — start the MCP server over stdio

### Security

- Hand-rolled input validators on every MCP tool (zero deps): reject unknown fields, type-check every field, range-check numbers, length-cap strings, strict enums.
- Refuses to index dangerous roots: `/`, `/etc`, `/var`, `~`, `/Users`, `/home`, Windows system paths, macOS-resolved aliases (`/private/etc`, etc.).
- Symlink-escape protection: `followSymbolicLinks: false` + per-file realpath bounds check.
- File-size cap (5 MB) and file-count cap (50 000) per index.
- Storage permissions: directories `0o700`, files `0o600`.
- Pattern-based secret redaction at signature-extraction time (`src/redact.ts`): OpenAI/Anthropic `sk-`, GitHub `ghp_`/`ghs_`, AWS `AKIA`, JWTs, PEM private-key headers, Slack tokens, Stripe live keys, plus a defensive long-token catch-all.
- Schema validation on `graph.json` load: strict shape check, version enforcement, per-entry sanitization, recomputed counts (attacker-supplied counts are ignored). Falls back to "no index" on rejection.
- ESLint policy enforcing **no network in `src/`** at the build gate. Bans `http`, `https`, `undici`, `axios`, `node-fetch`, `cross-fetch`, `got`, `request`, `superagent`, plus `child_process`. Meta-tests in `tests/lint-policy.test.ts` prove the rule fires on every banned import.

### Observability

- Interaction log at `~/.graphpilot/<repo-id>/interactions.jsonl` (mode `0600`): every tool call records sanitized inputs, result count, duration, and any error. Disable with `GRAPHPILOT_NO_LOG=1`. v0.1 does not read this log — it exists so future ranking and personalization have local-only training data.

### Benchmarks

Reproducible Tier-A and Tier-B benchmarks (see [`bench/README.md`](bench/README.md)). On GraphPilot's own codebase:

- Tier A: F1 **0.89** vs grep **0.42**, 99.9 % fewer bytes read (721 B vs 528 KB), 7 wins / 2 ties / 1 deliberate loss.
- Tier B (simulated): 7/13 tasks vs grep 4/13 (+75 %), mean F1 0.70 vs 0.33, 6 hallucinations vs 480, 100 % evidence-anchor citation rate.

### Documentation

- README, [quickstart](docs/quickstart.md), [MCP setup](docs/mcp-setup.md), [architecture](docs/architecture.md), [limitations](docs/limitations.md), CONTRIBUTING, SECURITY, CODE_OF_CONDUCT.

[Unreleased]: https://github.com/graphpilot-oss/graphpilot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/graphpilot-oss/graphpilot/releases/tag/v0.1.0
