# Tier-B Agent Benchmark — Spec

> The launch headline ("Claude Code with GraphPilot succeeded on X/10
> refactor tasks vs Y/10 without") lives here. This is the **manual
> turn-the-crank session** that produces those numbers.
>
> **Status:** spec only. Numbers not yet produced. Tier A (in
> [README.md](README.md)) covers the deterministic, tool-only
> comparison. Tier B adds an LLM in the loop.

## Why Tier B is separate

Tier A measures _whether the tools return the right info_. Tier B
measures _whether the agent reaches the right conclusion using those
tools_. Both matter; they answer different questions.

Tier A is automatable. Tier B is not — it requires:

1. Running real Claude Code sessions
2. Scoring "did the agent reach the right answer?" by hand
3. Recording token usage from the agent's logs

That's ~4–6 hours of focused human work. Out of scope for a single
benchmark commit; in scope for a separate launch-prep session.

## Method

### Setup

- A test repo (preferably `microsoft/TypeScript` — large enough to
  matter, recognizable to readers)
- Three Claude Code configurations:
  - **Baseline:** vanilla Claude Code, no MCP servers
  - **With GraphPilot:** Claude Code with the graphpilot MCP server
    configured + a CLAUDE.md routing rule pointing structural questions
    at the gp\_\* tools
  - **With CodeGraphContext** (optional but punchy): the closest OSS
    competitor, same setup

### The 10 tasks

These mirror the Tier-A corpus but are phrased as natural-language
refactor prompts:

1. Rename `createSourceFile` everywhere it's called
2. Find every function that catches but ignores errors
3. List the public API exported from `src/compiler/` (or pick one module)
4. Find the shortest call path from `parser.ts` to a syscall (`fs.write*`)
5. Find functions never called by any test
6. Which functions take `Diagnostic` as a parameter?
7. Find all callers of a function flagged `@deprecated`
8. Locate the function that emits a specific error message text
9. Trace a value from CLI input to where it's logged (expect agents to
   fail this — taint analysis isn't our beat)
10. Find HTTP routes without auth middleware (expect failure — no
    framework-aware tooling in v1)

Tasks 9 and 10 are **deliberate "graphpilot loses" tasks**. Including
them is what keeps the result believable.

### Metrics per task

For each `(task, condition)` cell:

| Metric                  | How                                                |
| ----------------------- | -------------------------------------------------- |
| **Task success** (0/1)  | Human eval against a hand-written rubric           |
| **Hallucination count** | Manual count of fabricated names / paths / imports |
| **Token cost**          | Sum of input+output tokens from Claude Code's log  |
| **Wall-clock**          | Stopwatch from prompt-submit to final answer       |
| **Clean patch apply**   | Did the proposed diff apply without conflict?      |

### Scoring

Aggregate the per-task numbers into the headline:

```
Claude Code alone:        N/10 tasks succeeded
Claude Code + GraphPilot: M/10 tasks succeeded
Token cost:               −X%
Hallucinations:           −Y%
```

If reality comes back at 5/10 vs 4/10, publish that — don't fake it.

## Runbook (when the session happens)

1. Clone the corpus repo (e.g. `microsoft/TypeScript`) to a clean dir
2. Configure Claude Code three ways (vanilla / + graphpilot / + CGC)
3. For each task: open a fresh session in each config, paste the prompt,
   run until Claude produces an answer or gives up, score the result
4. Tally totals; write the per-task table into
   `bench/results/agent-tier-<date>.md`
5. Drop the headline into the project README

## Why we haven't done this yet

- Tier A produces real, publishable numbers in <1 minute and locks in
  the methodology. Better to have that floor than to launch with no
  numbers because Tier B is half-done.
- Running Tier B costs real money (~$10–20 per pass in Claude tokens)
  and ~4–6 hours of attention. Worth doing right, in a focused session,
  not interleaved with development.
- The Tier-A bytes-reduction number (99.9 %) is _already_ sufficient
  for a Show HN headline: _"99% fewer tokens needed to answer
  structural questions in your TypeScript codebase."_

## Estimated effort

- Setup: 30 min
- Run + score: 3–4 hours (10 tasks × 3 conditions × ~6 min)
- Writeup + numbers into README: 30 min

Total: half a working day.

## What to do if Tier-B numbers are mediocre

If "Claude Code + GraphPilot" comes back at 6/10 vs 5/10 baseline, the
honest move is:

1. Publish the real number
2. Reframe the launch around Tier A (where the win is huge)
3. Investigate WHY the agent didn't translate tool quality into answer
   quality (probably: tool descriptions not aggressive enough, or
   CLAUDE.md routing not strong enough). Fix and re-run before launch.
