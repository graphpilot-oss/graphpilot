# Contributing to GraphPilot

Thanks for your interest! GraphPilot is young — every contribution helps shape it.

## Before you start

- For non-trivial changes, **open an issue first** so we can discuss the approach before
  you spend time writing code.
- Look for the [`good first issue`](../../labels/good%20first%20issue) label.
- Read the [README](README.md) to understand the project shape.

## Development setup

```bash
git clone https://github.com/codeakki/graphpilot.git
cd graphpilot
pnpm install
pnpm build
pnpm test
```

You need Node.js 20+ and pnpm 9+.

## Running locally against Claude Code

Once the MCP server is in (it's not yet, as of this writing), point Claude Code at
your local build by adding to `~/.claude.json`:

```jsonc
{
  "mcpServers": {
    "graphpilot-dev": {
      "command": "node",
      "args": ["/absolute/path/to/graphpilot/dist/cli.js", "mcp"],
    },
  },
}
```

Restart Claude Code.

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org):

- `feat: add gp_callers tool`
- `fix: handle empty TS files gracefully`
- `docs: clarify mcp setup for Cursor`
- `test: add fixture for re-exports`
- `chore: bump deps`
- `refactor: simplify symbol id format`

One topic per commit. Commit messages explain the _why_, not just the _what_.

## Pull requests

1. Fork the repo.
2. Create a branch: `git checkout -b feat/your-feature`.
3. Make your changes; add tests for any new behavior.
4. Run `pnpm test` and `pnpm build` — both must pass.
5. Update [CHANGELOG.md](CHANGELOG.md) under the `[Unreleased]` section.
6. Open a PR with a clear description (what + why; link the issue).
7. CI must pass. At least one maintainer review is required before merge.

## Code style

- TypeScript strict mode, no `any` unless commented why.
- 2-space indent, single quotes, trailing commas where valid (matches `.editorconfig`).
- One thing per file. If a file passes ~300 lines, consider splitting it.
- Tests next to code in `tests/`. Fixtures in `tests/fixtures/`.

## Security

GraphPilot reads code from people's repos and exposes a memory layer to AI agents.
That means it's an attractive target for both supply-chain attacks and prompt-injection
via crafted code. Before you contribute:

- **Read [SECURITY.md](SECURITY.md)** for how to report vulnerabilities privately.
- **No network code in `src/`.** Local-first is a user promise. If a feature seems to
  need the network, open a Discussion first.
- **No `child_process` / `exec` / `spawn`.** We don't shell out, ever.
- **Validate every input that crosses a trust boundary.** Files on disk, CLI args, and
  (when the MCP server lands) tool arguments are all untrusted by default.
- **No telemetry, analytics, or "anonymous usage stats."** Not by default, not behind
  a flag, not at all in v1.

PRs that introduce network calls, child processes, eval, dynamic require, or unvalidated
file-path arguments will be rejected unless there's a written threat-model justification
in the PR description.

## What we are NOT doing in v1

Please don't open PRs that add:

- Cross-repo indexing
- A query DSL
- A web visualization
- Watch mode (manual re-index is fine for v1)
- Stack Graphs / production-grade name resolution
- Languages other than TS/JS

These are explicitly deferred. Keeping v1 small is the only way it ships.

## Code of Conduct

By participating you agree to [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Questions

Open a [Discussion](../../discussions) for general questions; open an
[Issue](../../issues) for bugs.
