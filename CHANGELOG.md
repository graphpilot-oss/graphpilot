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
- CLI: `graphpilot index <path>` and `graphpilot status <path>`
- Call-edge extraction (`gp_callers` precursor): captures every call/new
  expression inside a function body, attributes it to the immediate enclosing
  function, and resolves the target across the indexed symbol table.
- Outputs include both resolved (`toId` set) and unresolved (`toName` only) edges
  so the agent can still see stdlib/external calls.

### Security

- 5 MB per-file size cap (`MAX_FILE_BYTES`)
- Iterative `walk()` (no stack overflow on deep ASTs)
- Symlink-escape protection: `followSymbolicLinks: false` + realpath bounds check
- 50,000 file hard cap per index (`MAX_FILES_PER_INDEX`)
- Refuses to index `/`, `/etc`, `~`, `/Users`, Windows system paths, and macOS
  resolved aliases (`/private/etc`, etc.)
- Graph dir/file written with mode `0o700` / `0o600`
- Full threat model in `.notes/security.md` (private)

### Pending

- MCP server with `gp_index`, `gp_recall`, `gp_callers` tools
- Interaction log (`interactions.jsonl`)
- Outcome benchmark vs baseline Claude Code

[Unreleased]: https://github.com/codeakki/graphpilot/commits/main
