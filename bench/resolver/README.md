# Resolver accuracy baseline

Measures how well the call-edge resolver maps a call to the symbol it actually
targets. This is the yardstick for the precision work (#73 import paths, #74
re-exports, #75 scope-aware binding) and the basis for the CI precision gate
(#76).

```bash
pnpm bench:resolver
```

Always exits 0 — it's a measurement, not a gate.

## Two measurements

### 1. Controlled corpus → precision / recall

`fixtures/` is a small set of hand-authored files where every true call target
is unambiguous ground truth (we wrote both the call and the definition). The
`GOLD` table in `score-resolver.ts` labels each true edge with its expected
definition file.

- **Precision** = correctly-resolved in-repo edges / in-repo edges that resolved to anything.
- **Recall** = correctly-resolved in-repo edges / all true in-repo edges.

The corpus deliberately includes the cases the current name-based resolver gets
wrong, so the suite documents the baseline _and_ will show the improvement when
import-path resolution lands:

| Fixture                                      | What it exercises              | Name-based resolver today                                                                                                                                   |
| -------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `same_file.ts`                               | same-file call                 | ✓ correct                                                                                                                                                   |
| `lib.ts` + `use_helper.ts`                   | cross-file, **unique** name    | ✓ correct (only one `helper`)                                                                                                                               |
| `dup_a.ts` + `dup_b.ts` + `use_save{,_b}.ts` | cross-file, **ambiguous** name | ✗ one of the two is wrong — the resolver can only pick one global `save` for both call sites (flagged `ambiguous`). #73 fixes this by following the import. |
| `external.ts`                                | stdlib call (`Math.max`)       | ✓ correctly left unresolved                                                                                                                                 |

### 2. GraphPilot's own `src/` → resolution rate

No labels needed: **resolution rate** = edges with a non-null `toId` / total
edges. This is the real-world number that replaces the earlier "~25–35%"
estimate in `docs/limitations.md`. **Ambiguity rate** = resolved edges that were
a homonym guess (the resolver's own `ambiguous` flag) — a label-free proxy for
precision risk.

## Baseline (measured at the #72 commit)

| Metric                 | Value                                               |
| ---------------------- | --------------------------------------------------- |
| Corpus precision       | **75%** (3/4 resolved in-repo edges correct)        |
| Corpus recall          | **75%** (3/4 true in-repo edges resolved correctly) |
| `src/` resolution rate | **35.0%** (366 / 1047 edges)                        |
| `src/` ambiguity rate  | **2.5%** (9 / 366 resolved)                         |

Re-run after any resolver change and update this table. The corpus precision is
the number #73/#74/#75 should move toward 100%; the `src/` resolution rate is
the headline coverage figure.

## Scope note

Per #72 this should eventually also run against external corpora (a mid-size OSS
app, a monorepo package). Those aren't vendored here yet; the controlled corpus
gives objective precision/recall now, and the `src/` run gives an objective
real-world resolution rate. Adding external corpora is a follow-up.
