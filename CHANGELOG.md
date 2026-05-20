# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial project scaffold (Node.js + TypeScript)
- Tree-sitter-based parser for TS/TSX/JS/JSX
- Symbol extraction for functions, classes, methods, interfaces, type aliases, enums
- Directory indexer with sensible default ignores (node_modules, dist, .d.ts, etc.)
- JSON storage at `~/.graphpilot/<repo-id>/graph.json`
- CLI: `graphpilot index <path>`, `graphpilot status <path>`, `graphpilot mcp`
- Call-edge extraction (`gp_callers` precursor): captures every call/new
  expression inside a function body, attributes it to the immediate enclosing
  function, and resolves the target across the indexed symbol table.
- Outputs include both resolved (`toId` set) and unresolved (`toName` only) edges
  so the agent can still see stdlib/external calls.
- Query layer (`GraphIndex`): pre-computed lookup tables for findByName,
  findById, callers, callees. Sub-millisecond lookups on indexed repos.
- MCP server over stdio (`@modelcontextprotocol/sdk`). Tool surface:
  - `gp_stats` — index health probe
  - `gp_index` — re-index a repo from the agent
  - `gp_recall` — find symbols by name (exact CI by default, substring opt-in)
  - `gp_callers` — list callers or callees (with direction param)
  - `gp_impact` — blast-radius analysis: direct callers, transitive
    callers (BFS, depth 1–5), tests likely affected (heuristic on file
    paths), and a public-API flag derived from `exported`. Answers "what
    breaks if I rename X?" in a single tool call. Pure-function core in
    `src/impact.ts`; cycle-safe; per-level cap with `truncated` flag.
- Watch mode: `graphpilot watch <path>` keeps the index fresh as you
  edit. Uses `chokidar` (fsevents/inotify/RDCW) with editor-save
  debouncing. Each file save triggers an incremental update — re-parse
  one file, drop its old contribution, re-resolve edges across the
  whole symbol table, save atomically. Real-world 3–5 ms per save on
  small repos. Updates serialize through an internal chain so chokidar
  bursts can't race into a torn graph. Storage writes are atomic
  (`.tmp` + rename) so a crash never leaves a half-written graph.json.
  CLI runs until SIGINT.
- Reproducible benchmark (Tier A): `pnpm bench` runs 10 hand-curated
  structural tasks against GraphPilot's own codebase (the corpus) and
  scores precision/recall/F1 + bytes processed vs a grep-simulator
  baseline. Anyone with `pnpm install` can reproduce. First run:
  **F1 0.89 vs grep 0.42, 99.9 % byte reduction (721 B vs 528 KB),
  7 wins / 2 ties / 1 expected loss** (the string-literal task,
  deliberately included as the honest "grep wins" case). Spec for the
  agent-eval Tier B is in `bench/run-agent-tier.md`.
- Contributor Covenant 2.1 code of conduct (closes GitHub Community
  Standards check). Reporting email is `codewithakki@gmail.com`;

### Dev workflow

- Pre-commit hooks via `lefthook` (added 2026-05-20):
  - `pre-commit`: `pnpm typecheck` + ESLint + `prettier --check` on
    staged source files (parallel). Hits sub-second on small changes.
  - `commit-msg`: Conventional Commits regex enforcement. Bad messages
    get a friendly error pointing at the format spec. Allows
    `Merge`/`Revert`/`fixup!`/`squash!` for ergonomics.
  - `pre-push`: full `pnpm test`. Stops broken builds from reaching
    the remote.
  - Bypass for emergencies: `LEFTHOOK=0 git commit` or
    `LEFTHOOK_EXCLUDE=<jobname> git commit`. Installed automatically by
    `pnpm install`; no manual `lefthook install` required.
- Prettier configured (added 2026-05-20): `.prettierrc.json` + scripts
  `pnpm format` / `pnpm format:check`. Single quotes, trailing commas,
  100-col print width, LF endings. Normalized 31 files in one mechanical
  pass; wired into `pnpm check` and the lefthook pre-commit so future
  drift gets blocked.
- Hand-rolled input validation for every MCP tool (no deps). Rejects unknown
  fields, type errors, out-of-range numbers, oversize strings.
- Interaction log (`~/.graphpilot/<repo-id>/interactions.jsonl`): every tool
  call recorded locally with sanitized inputs. Enables future ranking /
  personalization. Disabled via `GRAPHPILOT_NO_LOG=1`. Mode 0600.

### Security

- 5 MB per-file size cap (`MAX_FILE_BYTES`)
- Iterative `walk()` (no stack overflow on deep ASTs)
- Symlink-escape protection: `followSymbolicLinks: false` + realpath bounds check
- 50,000 file hard cap per index (`MAX_FILES_PER_INDEX`)
- Refuses to index `/`, `/etc`, `~`, `/Users`, Windows system paths, and macOS
  resolved aliases (`/private/etc`, etc.)
- Graph dir/file written with mode `0o700` / `0o600`
- Pattern-based secret redaction at signature-extraction time
  (`src/redact.ts`): OpenAI/Anthropic `sk-`, GitHub `ghp_`/`ghs_`, AWS
  `AKIA`, JWTs, PEM private-key headers, Slack tokens, Stripe live keys,
  plus a defensive long-token catch-all.
- Schema validation on graph.json load (`src/graph-schema.ts`): strict
  shape check, version enforcement, per-entry sanitization (control chars
  stripped, length-capped), and recomputed counts (attacker-supplied
  symbol/edge counts are ignored). Defends against tampered or corrupt
  files; falls back to "no index" on rejection.
- ESLint policy enforcing "no network in `src/`" at the build gate
  (`eslint.config.js`): bans `http`, `https`, `undici`, `axios`,
  `node-fetch`, `cross-fetch`, `got`, `request`, `superagent`, plus
  `child_process`. Looser rules for `tests/` and `scripts/`. CI runs
  `pnpm lint` as a gating job; meta-tests in `tests/lint-policy.test.ts`
  prove the rule fires on every banned import (catches rule-rot in
  future PRs).
- Full threat model in `.notes/security.md` (private)

### Pending

- End-to-end test in Claude Code (manual setup)
- Outcome benchmark vs baseline Claude Code
- Graph-schema validation on load (T4)
- Secret-pattern redaction in signatures/previews (T3)

[Unreleased]: https://github.com/codeakki/graphpilot/commits/main
