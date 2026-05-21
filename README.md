# GraphPilot

> **The refactor-safe code graph for coding agents.** Branch-aware. Evidence-backed.
> A structural memory layer that knows what changed since `main`, cites every claim
> with `file:line @ sha`, and re-roots itself to the git worktree automatically.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

---

**On 10 standardized structural questions** about a real TypeScript codebase:
GraphPilot returns the correct answer with **F1 0.89** vs grep's **0.42**, while
the agent reads **99.9 % fewer bytes** (721 B vs 528 KB) to reach the same
conclusion. [Reproduce in 30 s →](bench/README.md)

---

## Status

Pre-alpha, in active development. Not yet published to npm. Expect breaking changes.

## Quickstart (local dev)

```bash
git clone https://github.com/codeakki/graphpilot.git
cd graphpilot
pnpm install
pnpm build

# Index a repo
node dist/cli.js index /path/to/your/repo

# See what got indexed
node dist/cli.js status /path/to/your/repo

# Keep the index fresh as you edit (Ctrl+C to stop)
node dist/cli.js watch /path/to/your/repo
```

Then wire it into Claude Code (or any MCP client): see
[docs/mcp-setup.md](docs/mcp-setup.md).

## What it does

Five MCP tools that any MCP-compatible agent (Claude Code, Cursor, Cline,
Windsurf, Continue) can call:

| Tool         | Use it for                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gp_index`   | Re-index a repo from inside the agent                                                                                                                                                |
| `gp_recall`  | Look up a function/class/type/interface by name                                                                                                                                      |
| `gp_callers` | List callers (or callees) of a symbol                                                                                                                                                |
| `gp_impact`  | Blast radius: direct + transitive callers, tests affected, public-API flag — answers _"what breaks if I rename X?"_ in one call. Pass `since: <commit\|branch>` for PR-scoped impact |
| `gp_stats`   | Index health probe                                                                                                                                                                   |

Plus `graphpilot watch` for sub-second incremental updates on file save.

The index lives in `~/.graphpilot/<repo-id>/graph.json` (mode 0600). Everything
stays local. No accounts, no telemetry, no remote calls — enforced by an
ESLint policy on the codebase itself.

## What's different

Other code-graph tools (CodeGraphContext, Serena, the 15+ existing MCP servers
in this space) treat your repo as a static blob: index once, query forever, no
awareness of branches, no proof of where an answer came from. GraphPilot is
built around three things none of them ship:

- **Evidence anchors.** Every tool response includes `file:line @ sha` for
  every symbol and call site. The agent can quote the anchor verbatim and
  you can verify it instantly — fabrications get exposed the moment the user
  jumps to the line.
- **Differential impact (`gp_impact({since: <ref>})`).** Ask "of all the
  callers of `X`, which ones live in code my PR touches?" — answered in one
  call instead of `git diff | xargs grep`. Branch-scoped refactors without
  the false-positive noise.
- **Worktree-aware by default.** Run `graphpilot index ./src/feature` from a
  subdir and it transparently re-roots to the git worktree top, so two
  `git worktree add`-ed branches naturally get two separate indexes. Opt out
  with `--no-worktree`.

## Roadmap

| Milestone                                        | Status            |
| ------------------------------------------------ | ----------------- |
| Parser + symbol extraction (TS/JS)               | ✅                |
| Directory indexer + JSON storage                 | ✅                |
| Call-edge extraction + resolver                  | ✅                |
| MCP server (5 tools)                             | ✅                |
| Watch mode                                       | ✅                |
| Impact analysis (`gp_impact`)                    | ✅                |
| Tier-A benchmark (this codebase)                 | ✅                |
| Tier-B agent benchmark (Claude Code vs baseline) | ⏭                |
| npm publish                                      | ⏭                |
| Python language support                          | ⏭ (demand-gated) |

## Why

Most coding agents (Claude Code, Cursor, Aider) re-grep the codebase every
conversation. That burns tokens, hallucinates function names, and misses
structural relationships (_"what calls this?"_, _"what breaks if I rename it?"_).

GraphPilot indexes the structural memory of your repo once. The agent reuses
it across sessions. Token cost drops. Hallucinations drop. Refactors get safer.

The benchmark above is the floor: it measures what's reachable via tool calls,
not what the agent does with it. The agent-eval Tier B is spec'd in
[bench/run-agent-tier.md](bench/run-agent-tier.md) and pending a focused
launch-prep session.

## Documentation

- [docs/quickstart.md](docs/quickstart.md) — 5-minute walkthrough
- [docs/mcp-setup.md](docs/mcp-setup.md) — per-client config
- [docs/architecture.md](docs/architecture.md) — how the pipeline works
- [docs/limitations.md](docs/limitations.md) — v1 caveats (read this)
- [bench/README.md](bench/README.md) — benchmark methodology + results

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) before
opening a PR.

## License

[Apache-2.0](LICENSE). Copyright 2026 Akshay Sharma.
