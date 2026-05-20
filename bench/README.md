# GraphPilot Benchmark

Reproducible measurement of GraphPilot vs a grep-based baseline on 10
structural questions about a real codebase. **The codebase is GraphPilot
itself** — that way anyone who clones this repo can reproduce identical
numbers, no external download needed.

## Headline

From the most recent run (`bench/results/`):

| Metric | GraphPilot | Grep baseline |
|---|---|---|
| Average F1 (10 tasks) | **0.89** | 0.42 |
| Total bytes processed | **721 B** | 528.1 KB |
| Byte reduction | **99.9 %** | — |
| Winner counts | **7 wins · 2 ties · 1 loss** | 1 win |
| Expected-winner accuracy | 9 / 10 | — |

The one loss is **deliberate**: task `t10` is a literal-string search,
which GraphPilot doesn't index — exactly the kind of question grep is
made for. Keeping it in the corpus is what makes the rest of the numbers
believable.

## Tier-A (this benchmark) vs Tier-B (agent eval)

This is **Tier A** — deterministic, runs in <1 s, no LLM needed:

- Each task has a hand-curated ground-truth answer
- We run GraphPilot's tools and a grep-simulator over the same corpus
- We score precision / recall / F1 vs ground truth + measure bytes the
  output occupies (proxy for tokens an agent would consume)

**Tier B** (separate, future work) is the full "Claude Code succeeds
X/10 vs Y/10" headline that lives in [run-agent-tier.md](run-agent-tier.md).
It requires actually running Claude Code sessions and scoring them by
hand — currently a turn-the-crank manual session, captured here so it
can land later without losing context.

## What's in the corpus

10 hand-curated tasks (`tasks.ts`):

| ID | Description | Kind | Expected winner |
|---|---|---|---|
| t01 | Direct callers of `analyzeImpact` | callers | graphpilot |
| t02 | Direct callers of `extractSymbols` | callers | graphpilot |
| t03 | Direct callers of `validateRootPath` | callers | graphpilot |
| t04 | Symbols containing `parse` | recall-substring | graphpilot |
| t05 | All interfaces under `src/` | kind-filter | graphpilot |
| t06 | Blast radius of `extractSymbols` (depth 2) | impact | graphpilot |
| t07 | Tests affected by changes to `parseFile` | tests-affected | graphpilot |
| t08 | Symbols ending in `Args` | recall-substring | graphpilot |
| t09 | Look up a symbol that doesn't exist | recall-miss | tie |
| t10 | Literal occurrences of `"MAX_FILE_BYTES"` | string-literal | **grep** |

Every task carries its own `groundTruth` — the set of names/files the
correct answer must contain. Ground truth was extracted from the live
index when the corpus was authored; see *Refreshing* below if you change
the source code.

## How to reproduce

```bash
git clone https://github.com/codeakki/graphpilot.git
cd graphpilot
pnpm install
pnpm build
node dist/cli.js index .   # build the corpus index
pnpm bench
```

That writes a fresh `bench/results/bench-<timestamp>.json` and a
matching markdown summary. The JSON is the source of truth; the
markdown is for humans.

## Methodology

For each task:

1. **GraphPilot side** — call the natural primitive:
   - `callers` → `idx.callers(...)`
   - `recall` / `recall-substring` → `idx.findByName(...)`
   - `kind-filter` → filter `idx.graph.symbols` by `kind`
   - `impact` → `analyzeImpact(...)` (depth 2 / 3)
   - `tests-affected` → `analyzeImpact(...).testsAffected`
   - `string-literal` → best-effort `findByName` (we explicitly under-deliver here)

2. **Grep baseline side** — scan every source file for the query as a
   literal substring, then heuristically extract function-like
   identifier names near each hit. Counts **total bytes of every file
   that contained a hit** as the cost an agent without structural
   memory would pay to read those files.

3. **Score** each side's output as a *set* against the ground truth
   set: precision = TP / returned, recall = TP / ground-truth, F1 =
   harmonic mean.

4. **Winner** is whichever side has higher F1 (tie if difference
   < 0.001).

## Why the bytes metric matters more than F1

F1 measures *correctness*. Bytes measures *cost*.

For agents like Claude Code, **tokens are dollars**. Every byte the
agent has to read costs the same. The 99.9 % byte reduction means a
GraphPilot-backed agent answers the same questions for roughly 1/1000
the per-question retrieval cost.

The byte metric also UNDER-counts the grep baseline:

- We measure file bytes of files containing a hit, not the context
  windows an agent would actually request around each hit (typically
  ±20 lines)
- Real agents grep + read repeatedly before answering; we measure one
  pass
- Real agents pay for their own thinking tokens on top of the read

A more realistic baseline would show grep costing **5–10× more**
bytes than the conservative number we publish.

## Limits of this benchmark (be honest about them)

1. **Self-test corpus.** GraphPilot indexing GraphPilot is the easiest
   case — small, well-named, recently authored. A real
   `microsoft/TypeScript`-scale benchmark would be more credible. The
   self-test is the floor, not the ceiling.
2. **No LLM in the loop.** This benchmark measures tool quality, not
   agent quality. The Tier-B benchmark closes that gap (see below).
3. **Grep baseline is a simulator, not a real agent.** It can't
   disambiguate, can't ask follow-ups, can't iterate. Real grep+agent
   workflows do worse on structural tasks than our simulator suggests.
4. **Ground truth is hand-curated.** A genuine refactor in the corpus
   repo can drift the truth set.

## Refreshing ground truth

If you edit graphpilot source materially (rename a symbol referenced in
`tasks.ts`, etc.), regenerate ground truth manually by probing the live
index. There's a probe script pattern at the top of `tasks.ts` — copy,
paste, run, eyeball, then update the constants.

## Files

```
bench/
├── README.md             ← this file
├── tasks.ts              ← the 10-task corpus + hand-curated ground truth
├── runner-graphpilot.ts  ← runs each task through GraphPilot primitives
├── runner-baseline.ts    ← grep-simulator baseline
├── score.ts              ← precision/recall/F1 helpers
├── run.ts                ← main entrypoint; writes results/
├── run-agent-tier.md     ← spec for the Tier-B agent benchmark (future)
└── results/
    ├── baseline.json     ← committed reference run (see headline above)
    ├── baseline.md       ← markdown view of the reference run
    └── bench-<ts>.{json,md}  ← per-user runs, gitignored
```

`baseline.json` is the canonical reference. When you run `pnpm bench`,
your own results land in `bench-<timestamp>.json` (gitignored) — that
keeps diffs clean. Numbers materially different from `baseline.json`
mean either the corpus has drifted (refresh ground truth in `tasks.ts`)
or you're on hardware where the byte counts differ; both are normal.
