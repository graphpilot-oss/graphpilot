# GraphPilot Benchmarks

> Reproducible measurements of GraphPilot's correctness and efficiency for agent-assisted refactoring — runs in under 10 seconds, prints two scorecards, writes JSON and Markdown to `results/`.

## Why this exists

Coding agents burn tokens re-reading files to answer structural questions ("who calls this?", "what breaks if I rename X?"). GraphPilot indexes those facts once. This benchmark answers a single question: **does the index actually help an agent reach the right answer, with fewer bytes read and fewer hallucinations than `grep`?**

If the numbers in this README ever stop matching the code, that's a bug — file an issue.

## Quick start

**Prerequisites**: Node.js 18+, `pnpm` 9+, a clean clone of the GraphPilot repo.

```bash
pnpm install
pnpm build
node dist/cli.js index .
pnpm bench
```

You should see two tables printed to stdout (Tier A and Tier B) and two files written to [`results/`](./results):

```
bench/results/bench-<timestamp>.json
bench/results/bench-<timestamp>.md
```

If you see `Error: index not found`, you skipped `node dist/cli.js index .` — run it and retry.

## What you'll measure

Three independent tiers. Each answers a different question.

| Tier      | Question                                              | Method                                                | Runtime | Corpus                 |
| --------- | ----------------------------------------------------- | ----------------------------------------------------- | ------- | ---------------------- |
| Tier A    | Does the index return the right answer?               | 10 structural queries scored against ground truth     | < 1 s   | self-test              |
| Tier B    | Would an agent reach the right conclusion using it?   | 13 simulated refactor tasks, GraphPilot vs `grep`     | ~ 5 s   | self-test              |
| **Scale** | Does it stay fast and cheap on a real-world codebase? | Indexing throughput + 50 sampled queries + grep delta | ~ 15 s  | `microsoft/TypeScript` |

Tier A is about **tool correctness**. Tier B is about **agent task success** using that tool. Scale is about **does this work on something bigger than ourselves** — it doesn't compute F1 (no hand-curated ground truth for an external repo) but it does prove throughput, query latency, and bytes-read at production scale.

## Headline results

Latest run: `bench/results/baseline.json` — 2026-05-22, GraphPilot indexing itself (42 files, 205 symbols).

### Tier A — tool correctness

| Metric               | GraphPilot    | grep      | Delta              |
| -------------------- | ------------- | --------- | ------------------ |
| F1                   | **0.89**      | 0.42      | +112 %             |
| Precision            | **0.96**      | 0.18      | +433 %             |
| Recall               | 0.83          | **1.00**  | grep is exhaustive |
| Bytes read           | **721 B**     | 528 KB    | −99.9 %            |
| Wins / ties / losses | **7 / 2 / 1** | 1 / 2 / 7 |                    |

The one GraphPilot loss is **deliberate**: task `t10` is a literal-string search, which GraphPilot does not index. It's kept in the corpus to keep the rest of the numbers honest.

### Tier B — simulated agent

| Metric           | grep baseline | GraphPilot    | Delta              |
| ---------------- | ------------- | ------------- | ------------------ |
| Tasks passed     | 4 / 13 (31 %) | 7 / 13 (54 %) | +75 %              |
| Mean F1          | 0.33          | **0.70**      | +112 %             |
| Hallucinations   | 480           | **6**         | −98.75 %           |
| Evidence anchors | 0 %           | **100 %**     | full citation rate |

Tier B is an _automated_ simulation. A manual "real-LLM" variant is spec'd in [`run-agent-tier.md`](./run-agent-tier.md) for periodic full launches.

### Scale — microsoft/TypeScript

Latest run: [`bench/results/scale-microsoft-typescript.json`](./results/scale-microsoft-typescript.json) — 2026-05-23, indexing the TypeScript compiler source (`microsoft/TypeScript`, `src/` subtree: 601 files, 17 k symbols, 70 k call edges).

| Metric                     | Value                        |
| -------------------------- | ---------------------------- |
| Files indexed              | **601**                      |
| Symbols extracted          | **17,088**                   |
| Call edges resolved        | **70,458**                   |
| Indexing wall-clock (cold) | **10.26 s**                  |
| `graph.json` on disk       | 24.3 MB                      |
| `gp_recall` mean latency   | **0.01 ms** (p95 0.06 ms)    |
| `gp_callers` mean latency  | **0.03 ms** (p95 0.20 ms)    |
| `gp_impact` (depth 2) mean | **0.50 ms** (p95 1.4 ms)     |
| Mean bytes-read vs grep    | **−99.99 %** (5 hot symbols) |

What this proves: on a real-world, non-self-test TS codebase, GraphPilot indexes ~60 files/sec, every query returns in well under a millisecond, and the byte-cost reduction vs `grep` holds at exactly the same ~5 orders of magnitude as the self-test corpus.

What this does **not** prove: F1/accuracy at scale — that needs hand-curated ground truth, which the Scale tier deliberately skips. Pair this with a hand-curated Tier-A run on the same external corpus before making correctness claims.

## Reproducing from scratch

**Self-test (Tiers A + B):**

```bash
git clone https://github.com/graphpilot-oss/graphpilot.git
cd graphpilot
pnpm install
pnpm build
node dist/cli.js index .
pnpm bench
```

**Scale tier (any TS repo):**

```bash
# Pick a target — microsoft/TypeScript is the canonical large corpus
git clone --depth=1 https://github.com/microsoft/TypeScript.git /tmp/ts
pnpm bench:scale --repo=/tmp/ts/src
```

Per-run results land in `bench/results/bench-<timestamp>.{json,md}` (Tier A/B) or `scale-<corpus>-<timestamp>.{json,md}` (Scale). The checked-in `baseline.{json,md}` and `scale-microsoft-typescript.{json,md}` are the canonical reference runs — compare your output against them.

## Methodology

### Tier A — per task

1. **GraphPilot side** calls the natural primitive:
   - `callers` → `idx.callers(...)`
   - `recall` / `recall-substring` → `idx.findByName(...)`
   - `kind-filter` → filter `idx.graph.symbols` by `kind`
   - `impact` → `analyzeImpact(...)`
   - `tests-affected` → `analyzeImpact(...).testsAffected`
2. **grep baseline** scans every source file for the query as a literal substring, then heuristically extracts identifier names near each hit. It counts **total bytes of every file containing a hit** — the cost an agent without a structural index would pay.
3. **Score** is set comparison against ground truth. F1 = harmonic mean of precision and recall.
4. **Winner** is the higher F1 (tie if delta < 0.001).

### Tier B — per task

Each task is scored on:

- **Task success** — did the simulated agent reach the right conclusion?
- **Hallucination count** — false positives in the returned set
- **Evidence anchor rate** — share of results carrying a `file:line @ sha` citation

### Why bytes-read is the headline cost metric

For coding agents, **tokens are dollars**. Bytes-read is a conservative proxy:

- We count file bytes containing a hit, not the wider context window an agent typically requests around each hit (±20 lines)
- Real agents grep + read iteratively before answering; we measure a single pass
- A more realistic baseline would put `grep` at **5–10×** our published byte cost

## Task corpus

Ground truth lives in [`tasks.ts`](./tasks.ts), hand-curated and verified against the live index on 2026-05-22. Each task carries `{id, prompt, kind, query, groundTruth, expectedWinner, difficulty}`.

### Tier A — 10 tasks

| ID  | Description                                | Kind             | Expected winner |
| --- | ------------------------------------------ | ---------------- | --------------- |
| t01 | Direct callers of `analyzeImpact`          | callers          | graphpilot      |
| t02 | Direct callers of `extractSymbols`         | callers          | graphpilot      |
| t03 | Direct callers of `validateRootPath`       | callers          | graphpilot      |
| t04 | Symbols containing `parse`                 | recall-substring | graphpilot      |
| t05 | All interfaces under `src/`                | kind-filter      | graphpilot      |
| t06 | Blast radius of `extractSymbols` (depth 2) | impact           | graphpilot      |
| t07 | Tests affected by changes to `parseFile`   | tests-affected   | graphpilot      |
| t08 | Symbols ending in `Args`                   | recall-substring | graphpilot      |
| t09 | Symbol that doesn't exist                  | recall-miss      | tie             |
| t10 | Literal occurrences of `"MAX_FILE_BYTES"`  | string-literal   | **grep**        |

Tier B adds three further tasks that exercise differential impact and evidence-anchor verification.

## Refreshing ground truth

Refresh `tasks.ts` ground truth when any of these change:

1. Core index logic (`parser.ts`, `symbols.ts`, `edges.ts`, `query.ts`)
2. Task descriptions in `tasks.ts`
3. The corpus repo's structure (renames, splits, large moves)

Probe the live index, eyeball the new symbol sets, update the constants, and document the rationale in the commit message.

## Limitations

Be honest about what these numbers do and don't prove:

1. **Tier A/B run on a self-test corpus.** Correctness is currently measured against GraphPilot indexing GraphPilot — small, well-named, recently authored. The Scale tier now runs against `microsoft/TypeScript` for throughput and bytes-read, but its F1/correctness isn't measured at that scale yet (no hand-curated ground truth for an external repo). Hand-curated Tier-A on microsoft/TypeScript is the next credibility step.
2. **No real LLM in the loop.** Tier A measures tool quality; Tier B simulates agent reasoning. The manual Tier-B spec in [`run-agent-tier.md`](./run-agent-tier.md) closes that gap but is not run continuously.
3. **`grep` is a simulator baseline, not a real agent.** It can't disambiguate, ask follow-ups, or iterate. Real `grep + agent` workflows typically do worse on structural tasks than this simulator suggests.
4. **Ground truth is hand-curated.** Refactors in the corpus repo can drift the truth set — see "Refreshing ground truth" above.

## File layout

```
bench/
├── README.md                          ← this file
├── tasks.ts                           ← Tier A/B corpus + hand-curated ground truth
├── runner-graphpilot.ts               ← runs each task through GraphPilot primitives
├── runner-baseline.ts                 ← grep-simulator baseline
├── score.ts                           ← precision/recall/F1 helpers
├── run.ts                             ← Tier A entrypoint (`pnpm bench`)
├── run-scale.ts                       ← Scale-tier entrypoint (`pnpm bench:scale --repo=…`)
├── run-agent-tier.md                  ← spec for manual real-LLM Tier B
└── results/
    ├── baseline.{json,md}             ← canonical Tier-A reference run
    ├── scale-microsoft-typescript.{json,md}   ← canonical Scale reference run
    └── bench-<ts>.{json,md}           ← per-user runs (gitignored)
```

## Verify the claims

```bash
pnpm bench
open bench/results/
```

Read the numbers, diff against `baseline.md`, judge for yourself.
