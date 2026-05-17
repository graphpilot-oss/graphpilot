# GraphPilot — Project Context for Claude

This file tells AI assistants (Claude Code, Cursor, etc.) the non-obvious rules of
this project. **Read it before making changes.**

## What this project is

**Structural memory for coding agents.** Indexes a TypeScript/JavaScript repo and
exposes structural facts (symbols, callers, callees) over the Model Context Protocol
so coding agents can answer questions without re-reading files every conversation.

The full plan + business context lives in `.notes/` (gitignored, private). Refer
to it when planning multi-day work.

## Hard rules

1. **Security first.** Before implementing any feature that touches file I/O, input
   parsing, MCP tool inputs, persistent storage, or process spawning, **read
   `.notes/security.md`** and confirm the checklist for that category. If `.notes/`
   isn't available (e.g. fresh clone), at minimum review `SECURITY.md` and
   `CONTRIBUTING.md` § Security before proceeding.

2. **No network code in `src/`.** GraphPilot is local-first. No `http`, `fetch`,
   `axios`, telemetry, update checks, or analytics. This is a user-promise, not a
   technical preference. If you think you need network, open a Discussion first.

3. **No `child_process` / `exec` / `spawn`.** We never shell out. If a future
   feature seems to need it, that's a sign the design is wrong.

4. **Scope discipline.** v1 is intentionally tiny: 3 MCP tools (`gp_index`,
   `gp_recall`, `gp_callers`), TypeScript/JavaScript only, single repo, JSON
   storage, no semantic search, no DSL, no web viewer, no watch mode. **Resist
   feature creep.** If a request would add anything not on this list, push back
   and ask the user to confirm.

5. **Outcome over infrastructure.** When deciding tradeoffs, prefer the option
   that makes the *agent's answer* better. Latency benchmarks are vanity; task
   success on real refactors is the only metric that matters.

## Code conventions

- TypeScript strict mode; no `any` without a `// reason:` comment
- 2-space indent, single quotes, LF line endings (`.editorconfig`)
- One thing per file; files over ~300 lines get split
- Tests next to code in `tests/`, fixtures in `tests/fixtures/`
- Imports: `node:`-prefixed for built-ins (`import { join } from 'node:path'`)
- Commit messages: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`)
- Default to writing no comments; add them only when *why* is non-obvious

## Architecture summary

```
parser.ts    tree-sitter wrappers (parse a file → AST)
symbols.ts   walk the AST → SymbolRecord[]
indexer.ts   walk a directory → aggregate SymbolRecord[]
storage.ts   persist to ~/.graphpilot/<repo-id>/graph.json
cli.ts       command-line entry point
(coming)     edges.ts, query.ts, mcp.ts, interactions.ts
```

Data flow is one-way: source code → tree → symbols → JSON → query. We never
modify user code.

## Status

| Phase | Status |
|---|---|
| Parser + symbol extraction | ✅ Done (Day 2–3) |
| Directory indexer + JSON storage | ✅ Done (Day 4–5) |
| Security audit + threat model | ✅ Done (Day 5.5) |
| Security hardening (5 concrete fixes) | 🚧 Open — see `.notes/security.md` §6 |
| Call-edge extraction | ⏭ Day 6 |
| Query layer (in-memory indexes) | ⏭ Day 7 |
| MCP server skeleton | ⏭ Day 8 |
| Three tools + interaction log | ⏭ Day 9 |
| End-to-end test in Claude Code | ⏭ Day 10 |

## When in doubt

- For *what* to build: ask the user. Never expand scope autonomously.
- For *how* to build it: prefer the simpler option; we're not building an ecosystem.
- For *whether* something is safe: read `.notes/security.md` and use the §5 checklist.

## Files & directories that AI assistants must not touch

- `.notes/` — private planning notes. May be read; never committed or referenced
  from public files. If `.notes/` doesn't exist (because this is a fresh clone),
  proceed without it.
- `~/.graphpilot/` — runtime state. Don't write test code that pollutes the real
  user's index; use a temp dir.
- `LICENSE` — Apache-2.0 text is canonical; don't paraphrase.
