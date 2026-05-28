# GraphPilot Token Savings Benchmark

Measures how many tokens a coding agent saves when it has GraphPilot tools
available vs falling back to raw file reads only. Runs against **fastify v4.28.1**
— a real-world Node.js web framework with ~300 JS/TS source files.

---

## Quick start

```bash
cd benchmark

# 1. Set your API key
cp .env.example .env
#    → edit .env and fill in ANTHROPIC_API_KEY

# 2. Install deps (already done if you ran pnpm install at repo root)
pnpm install

# 3. Run everything in one command
pnpm all
```

`pnpm all` runs four steps in sequence and writes a report to `results/`.

---

## Step-by-step

```bash
pnpm setup        # clone fastify, build GraphPilot, index the repo
pnpm generate     # read 30 fastify files → ask Claude for 40 questions → compute GP ground truth
pnpm bench        # run 40 tasks × 2 modes, print live progress, save results
pnpm report       # re-generate markdown report from the most recent run
```

Each step is idempotent — you can re-run `pnpm run` as many times as you want
against the same question set, or `pnpm generate` to get a fresh question set.

---

## Partial runs

```bash
# Run only specific tasks
pnpm bench -- --tasks=T01,T05,T10

# Run only one mode (useful for comparing or re-running half)
pnpm bench -- --mode=baseline
pnpm bench -- --mode=gp


pnpm bench -- --mode=gp --baseline-from=2026-05-27T16-38-29
```

`--baseline-from` accepts a results timestamp directory name or a full path to
`raw.json`. The baseline results are merged into the new run before saving, so
the report generator has both modes for comparison.

---

## Environment variables

| Variable            | Default             | Description                                         |
| ------------------- | ------------------- | --------------------------------------------------- |
| `ANTHROPIC_API_KEY` | **required**        | Anthropic API key                                   |
| `BENCHMARK_MODEL`   | `claude-sonnet-4-5` | Model used for both modes                           |
| `FASTIFY_SHA`       | `v4.28.1`           | Git tag to clone                                    |
| `MAX_TOOL_TURNS`    | `15`                | Max agentic turns per task (prevents runaway reads) |

---

## What is measured

Each task runs in two **isolated** modes against the same fastify codebase:

| Mode           | Tools available                                                        |
| -------------- | ---------------------------------------------------------------------- |
| **Baseline**   | `read_file`, `list_directory` only                                     |
| **GraphPilot** | `read_file`, `list_directory` + `gp_recall`, `gp_callers`, `gp_impact` |

Same model, same system prompt, same question — the only difference is tool availability.

### Metrics captured per task

| Metric         | Source                         | Description                                            |
| -------------- | ------------------------------ | ------------------------------------------------------ |
| `inputTokens`  | `response.usage.input_tokens`  | Context fed to model per turn, summed across all turns |
| `outputTokens` | `response.usage.output_tokens` | Model output tokens per turn, summed                   |
| `totalTokens`  | sum                            | inputTokens + outputTokens                             |
| `filesRead`    | `read_file` call count         | Primary cost driver for baseline mode                  |
| `toolCalls`    | all tool invocations           | Total calls including GP tools                         |
| `correct`      | keyword rubric                 | Answer contains ≥60% of expected keywords              |
| `score`        | 0.0–1.0                        | Exact keyword hit-rate                                 |
| `durationMs`   | wall clock                     | End-to-end task time                                   |
| `peakHeapMb`   | `process.memoryUsage()`        | Heap delta during task                                 |

---

## Task distribution (40 total)

Questions are generated fresh by Claude reading fastify source — they are specific
to real symbols and files in that codebase.

| Type         | Count | Example question                                                       |
| ------------ | ----- | ---------------------------------------------------------------------- |
| `navigation` | 10    | "Where is `buildErrorObject` defined and what does it return?"         |
| `callers`    | 10    | "What functions call `handleRequest`?"                                 |
| `impact`     | 8     | "What would break if I changed the `buildReply` function signature?"   |
| `trace`      | 7     | "Trace how a request flows from `fastify.route()` to the user handler" |
| `dependency` | 5     | "Does `lib/reply.js` depend on `lib/request.js`?"                      |

---

## How ground truth is computed

During `pnpm generate`, after Claude produces 40 questions, each question's
**expected keywords** are computed by running GP tools against the indexed fastify
repo — not guessed. This means:

- Navigation: `gp_recall` on each hint symbol → file + line numbers become keywords
- Callers: `gp_callers` → actual caller names become keywords
- Impact: `gp_impact` → affected function names at each BFS depth become keywords
- Trace/dependency: `gp_recall` on all hint symbols

The correctness rubric therefore checks whether the agent's answer mentions the
same symbol names that GP's structural index reports — grounded in real code.

---

## Output files

```
results/
  2026-05-27T10-30-00/
    raw.json      ← full structured data (all tokens, tool calls, answers, scores)
    report.md     ← human-readable markdown report
```

### report.md sections

1. **Top-line results** — total tokens baseline vs GP, files read, tool calls, correctness, avg time
2. **Savings by task type** — which query type saves the most
3. **Per-task table** — one row per question, tokens + correct for each mode
4. **Question details** — for every question: ground truth, baseline answer, GP answer, exact tool call chains used

---

## Live progress output

```
ID    Type         Mode      Tokens(in+out)   Files  Score  Time
────────────────────────────────────────────────────────────────────────
T01   navigation   baseline  18.2k+1.1k=19.3k  14    ✓ 92%  4821ms
T01   navigation   gp        1.2k+0.4k=1.6k     0    ✓ 100% 1203ms
T02   callers      baseline  ...
```

---

## Known limitations

### Structural queries only

GraphPilot indexes symbols and call edges — it only helps with structural questions
("who calls X?", "what breaks if Y changes?"). For questions requiring reading actual
logic or business rules, token savings are smaller because the agent still needs
`read_file` to understand the code body.

### JavaScript/TypeScript only

fastify is a JS/TS project. GraphPilot v0.1 only indexes JS/TS files. The savings
numbers here do not apply to Python, Go, or other languages.

### Keyword rubric is approximate

The correctness score checks keyword presence (≥60% of expected keywords). It can
mark a correct but differently-worded answer as wrong, or a partially-correct answer
as passing. Use the detailed answers in `report.md` for manual review.

### Single-shot questions

Each task is a single question. Real coding sessions chain many questions together —
the actual per-session savings are likely higher because GP's context (the graph)
doesn't grow with each question, while baseline context accumulates file contents.

### Model non-determinism

Temperature is 0 but model outputs can vary slightly across API calls. Run `pnpm run`
twice to see variance; typical token count swings are ±5% for baseline, ±2% for GP.

### Index not included in token count

The time and tokens spent on `graphpilot index` are excluded from the benchmark.
In practice, you index once and query thousands of times — the amortized cost is
negligible. The benchmark measures query-time savings only.

### Max 15 turns per task

`MAX_TOOL_TURNS=15` caps how deep the baseline agent can explore. Without this cap,
baseline token counts would be even higher for complex trace questions where the
agent keeps reading files. The cap slightly understates baseline costs.

---

## Re-running & reproducibility

The same question set (`tasks/generated.json`) is reused across multiple `pnpm run`
invocations. Delete it and run `pnpm generate` to get a fresh set.

To reproduce exactly:

1. Pin `FASTIFY_SHA=v4.28.1` (default)
2. Keep `tasks/generated.json` from your first generate run
3. Run `pnpm run` — results will differ slightly due to model non-determinism but
   should be within ±5%
