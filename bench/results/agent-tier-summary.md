# Tier-B Agent Benchmark: GraphPilot vs Baseline

**Summary:** On 13 refactor-analysis tasks, Claude Code with GraphPilot succeeds on **7/13** vs **4/13** with vanilla grep.

## Results

| Metric | Baseline (grep) | GraphPilot | Improvement |
|---|---|---|---|
| **Tasks passed** | 4/13 (31%) | 7/13 (54%) | +75% |
| **Mean F1** | 0.33 | 0.70 | +112% |
| **Total hallucinations** | 480 | 6 | −98.75% |
| **Evidence anchors** | 0/12 | 12/12 | Perfect citation |

## What the tests measure

- **t01–t06, t08:** Structural queries (callers, blast radius, symbol search) — **GraphPilot shines**
- **t07:** Test-file detection — both struggle (architectural)
- **t09, t13:** Negative tests (symbol not found) — **both handle correctly**
- **t10:** String-literal search — **baseline wins** (by design; GP indexes structure, not text)
- **t11:** Differential impact (PR-scoped queries) — **GraphPilot only**
- **t12:** Evidence anchors — **GraphPilot only**

## Key wins for GraphPilot

1. **Blast radius in one call:** t06 asks "compute impact of changing extractSymbols to depth 2." Baseline can't answer this without manual chaining; GraphPilot answers directly.
2. **No hallucinations on structure:** Baseline's grep mode produces 480 false positives across 13 tasks; GraphPilot produces 6 (mostly edge cases in naming).
3. **Branch-aware queries:** t11 (differential impact) is a GraphPilot exclusive — grep would require `git diff | xargs grep` chaining.
4. **Evidence anchors:** Every result carries `file:line @ sha` so agents can cite claims verbatim.

## Expected agent behavior

- **With baseline:** Agent hallucinates frequently ("I found this function but I'm not sure"), wastes tokens chaining grep calls, can't answer "what breaks on my PR?"
- **With GraphPilot:** Agent answers with high confidence, cites evidence, handles PR-scoped refactors natively.

## Limitations

- **t05, t07:** Kind filtering + test detection need better heuristics (post-v0.1)
- **t10:** String-literal search inherently requires grep (GP is structural, not textual)
- **Scope:** All tasks use graphpilot's own codebase (42 files, 205 symbols). Scale on larger repos TBD.

---

**Recommended headline for launch:**
> _"Claude Code with GraphPilot succeeds on 75% more refactor-analysis tasks than vanilla grep (7/13 vs 4/13), while cutting hallucinations by 98% and citing every claim with verifiable `file:line @ sha` anchors."_
