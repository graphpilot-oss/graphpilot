# Benchmarks

Reproducible measurements of GraphPilot's correctness and efficiency for agent-assisted refactoring.

```bash
pnpm bench
```

Runs both tiers in under 10 seconds and writes Markdown + JSON results to [`results/`](./results).

## Two tiers

| Tier   | What it measures             | Method                                            | Runtime |
| ------ | ---------------------------- | ------------------------------------------------- | ------- |
| Tier A | Tool correctness             | 10 structural queries scored against ground truth | < 1 s   |
| Tier B | Simulated agent task success | 13 refactor tasks, GraphPilot tools vs grep       | ~ 5 s   |

Tier A asks "does the index return the right answer?" Tier B asks "would an agent reach the right conclusion using it?"

## Headline results

Latest run (`bench/results/baseline.json`, 2026-05-22, GraphPilot indexing itself: 42 files, 205 symbols):

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

Tier B is an _automated_ simulation. A manual "real-LLM" Tier B variant is spec'd in [`run-agent-tier.md`](./run-agent-tier.md) for periodic full launches.

## Reproducing

```bash
git clone https://github.com/graphpilot-oss/graphpilot.git
cd graphpilot
pnpm install
pnpm build
node dist/cli.js index .
pnpm bench
```

Per-run results land in `bench/results/bench-<timestamp>.{json,md}` (gitignored). The checked-in `baseline.{json,md}` is the canonical reference run.

## Methodology

### Tier A — per task

1. **GraphPilot side** — calls the natural primitive:
   - `callers` → `idx.callers(...)`
   - `recall` / `recall-substring` → `idx.findByName(...)`
   - `kind-filter` → filter `idx.graph.symbols` by `kind`
   - `impact` → `analyzeImpact(...)`
   - `tests-affected` → `analyzeImpact(...).testsAffected`
2. **grep baseline** — scans every source file for the query as a literal substring, then heuristically extracts identifier names near each hit. Counts **total bytes of every file containing a hit** — the cost an agent without a structural index would pay.
3. **Score** — set comparison against ground truth. F1 = harmonic mean of precision and recall.
4. **Winner** — higher F1 (tie if delta < 0.001).

### Tier B — per task

Each task is scored on:

- Task success (did the simulated agent reach the right conclusion?)
- Hallucination count (false positives)
- Evidence anchor rate (`file:line @ sha` citations on returned results)

### Why bytes-read is the headline cost metric

For coding agents, **tokens are dollars**. Bytes-read is a conservative proxy:

- We count file bytes containing a hit, not the wider context window an agent typically requests around each hit (±20 lines)
- Real agents grep + read iteratively before answering; we measure a single pass
- A more realistic baseline would put grep at **5–10×** our published byte cost

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

## When to refresh ground truth

Refresh `tasks.ts` ground truth if:

1. Core index logic changes (`parser.ts`, `symbols.ts`, `edges.ts`, `query.ts`)
2. Task descriptions in `tasks.ts` are updated
3. The corpus repo's structure changes materially (renames, splits)

Probe the live index, eyeball the new symbol sets, and update the constants. Document the rationale in the commit message.

## Limitations of this benchmark

Be honest about what these numbers do and don't prove:

1. **Self-test corpus.** GraphPilot indexing GraphPilot is the easiest case: small, well-named, recently authored. A `microsoft/TypeScript`-scale corpus would be more credible. Self-test is the floor, not the ceiling.
2. **No real LLM in the loop.** Tier A measures tool quality; Tier B simulates agent reasoning. The manual Tier-B spec in `run-agent-tier.md` closes that gap but is not run continuously.
3. **grep is a simulator baseline, not a real agent.** It can't disambiguate, ask follow-ups, or iterate. Real `grep + agent` workflows typically do worse on structural tasks than this simulator suggests.
4. **Ground truth is hand-curated.** Refactors in the corpus repo can drift the truth set.

## Files

```
bench/
├── README.md                  ← this file
├── tasks.ts                   ← corpus + hand-curated ground truth
├── runner-graphpilot.ts       ← runs each task through GraphPilot primitives
├── runner-baseline.ts         ← grep-simulator baseline
├── score.ts                   ← precision/recall/F1 helpers
├── run.ts                     ← main entrypoint
├── run-agent-tier.md          ← spec for manual real-LLM Tier B
└── results/
    ├── baseline.{json,md}     ← canonical reference run
    └── bench-<ts>.{json,md}   ← per-user runs (gitignored)
```

To verify the claims: `pnpm bench`, read `bench/results/`, judge for yourself.
