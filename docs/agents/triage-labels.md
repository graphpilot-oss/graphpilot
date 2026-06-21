# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Create any missing role label on first use with `gh label create <name>`.

Edit the right-hand column to match whatever vocabulary you actually use.

## Severity labels

`P0` / `P1` / `P2` mark priority independent of the triage roles above.

## Connect-failure fast lane

`connect-failure` marks an issue where an agent client can't connect to or
start the MCP server — the highest-severity report class, since it makes the
tool look broken on first contact.

**Policy:**

- **`connect-failure` ⇒ `P0`, same-day human response.** Don't leave a
  connection report sitting in `needs-triage`.
- The bug template ([`.github/ISSUE_TEMPLATE/bug_report.md`](../../.github/ISSUE_TEMPLATE/bug_report.md))
  has a **"Connect/startup failure"** checkbox. Checking it auto-applies both
  `connect-failure` and `P0` via
  [`.github/workflows/triage-connect-failure.yml`](../../.github/workflows/triage-connect-failure.yml).
- The template asks reporters to paste `graphpilot doctor --json` — start triage
  there; it usually pinpoints the cause (Node, `PATH`, index, handshake, or a
  missing client config entry).
- Self-serve fixes live in [`docs/troubleshooting.md`](../troubleshooting.md);
  link reporters there while you investigate.
