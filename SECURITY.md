# Security Policy

## Reporting a Vulnerability

If you discover a security issue, **please do not open a public GitHub issue.**

Email: `codewithakki@gmail.com`

Include:

- A description of the issue
- Steps to reproduce
- Affected version(s)
- Any proof-of-concept code

We will:

- Acknowledge your report within **72 hours**
- Investigate and confirm the issue
- Ship a fix within **14 days** for high-severity issues
- Credit you in the release notes (unless you ask us not to)

## Supported Versions

GraphPilot is pre-1.0; only the latest release receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

Once we hit 1.0, this table will be expanded to cover the last two minor versions.

## Scope

In scope:
- The `graphpilot` npm package itself
- The MCP server implementation
- Any data written to `~/.graphpilot/`

Out of scope:
- Third-party MCP clients (Claude Code, Cursor, etc.) — report those upstream
- Tree-sitter grammar bugs — report to the relevant tree-sitter-* repo
