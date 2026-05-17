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
- Test suite (12 tests, vitest)

### Pending

- Call-edge extraction
- MCP server with `gp_index`, `gp_recall`, `gp_callers` tools
- Interaction log (`interactions.jsonl`)
- Outcome benchmark vs baseline Claude Code

[Unreleased]: https://github.com/codeakki/graphpilot/commits/main
