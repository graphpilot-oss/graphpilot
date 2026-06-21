---
name: Bug report
about: Something is broken or behaving unexpectedly
title: 'bug: '
labels: bug
---

## Type

- [ ] **Connect/startup failure** — the agent can't connect to or start the GraphPilot MCP server (the `gp_*` tools don't appear, calls hang, or the server drops)

> Check the box above if this is a connection/startup problem — it routes the issue to the P0 fast lane. See [`docs/troubleshooting.md`](../../docs/troubleshooting.md) for self-serve fixes first.

## Describe the bug

A clear description of what's wrong.

## Reproduction

Steps to reproduce:

1. Run `...`
2. ...
3. ...

## Expected behavior

What you expected to happen instead.

## Environment

- OS: [macOS / Linux / Windows + version]
- Node version: output of `node -v`
- GraphPilot version: output of `node dist/cli.js --version` (or commit SHA)
- MCP client (if relevant): [Claude Code / Cursor / Windsurf / ...]

## Diagnostics

Run `graphpilot doctor --json` and paste the output below. It captures Node, `PATH`, the index state, the MCP handshake, and per-client config in one shot — and is the fastest way for us to triage (especially connect/startup failures).

```json
(paste `graphpilot doctor --json` output here)
```

## Additional context

Logs, screenshots, or a minimal repo that reproduces the issue.
