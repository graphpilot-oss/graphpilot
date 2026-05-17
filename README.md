# GraphPilot

> **Structural memory for coding agents.** Your repo, understood — not just chunked.
> Run once, then Claude Code (or any MCP-compatible agent) remembers every function,
> every call, every import — across sessions.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

---

## Status

Pre-alpha, in active development. Not yet published to npm. Expect breaking changes.

## Quickstart (local dev)

```bash
git clone https://github.com/<your-username>/graphpilot.git
cd graphpilot
pnpm install
pnpm build

# Index a repo
node dist/cli.js index /path/to/your/repo

# See what got indexed
node dist/cli.js status /path/to/your/repo
```

## What it does

Three tools the coding agent can call over MCP (once the server lands):

- `gp_index` — index a TypeScript/JavaScript repo into local memory
- `gp_recall` — look up a function, class, type, or interface by name
- `gp_callers` — find what calls a symbol (or what a symbol calls)

The index lives in `~/.graphpilot/<repo-id>/graph.json`. Everything stays local.

## Roadmap

| Milestone | Status |
|---|---|
| Parser + symbol extraction (TS/JS) | ✅ Done |
| Directory indexer + JSON storage | ✅ Done |
| Call-edge extraction | 🚧 In progress |
| MCP server (`gp_index`, `gp_recall`, `gp_callers`) | ⏭ Next |
| Outcome benchmark vs baseline Claude Code | ⏭ |
| npm publish | ⏭ |
| Python language support | ⏭ |

## Why

Most coding agents (Claude Code, Cursor, Aider) re-grep the codebase every conversation.
That burns tokens, hallucinates function names, and misses structural relationships
("what calls this?", "what breaks if I rename it?").

GraphPilot indexes the structural memory of your repo once. The agent reuses it across
sessions. Token cost drops. Hallucinations drop. Refactors get safer.

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

[Apache-2.0](LICENSE). Copyright 2026 Akshay Sharma.
