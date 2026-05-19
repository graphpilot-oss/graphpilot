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
- Full threat model in `.notes/security.md` (private)

### Pending

- End-to-end test in Claude Code (manual setup)
- Outcome benchmark vs baseline Claude Code
- Graph-schema validation on load (T4)
- Secret-pattern redaction in signatures/previews (T3)

[Unreleased]: https://github.com/codeakki/graphpilot/commits/main
