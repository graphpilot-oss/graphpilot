# Tier-B Benchmark Results (Automated)

Timestamp: 2026-05-22T15:31:41.639Z

## Per-Task Metrics

| Task | Description | Success | Recall | Precision | F1 | Halluc | Anchors |
|---|---|---|---|---|---|---|---|
| t01-callers-analyzeImpact | Find every function that calls analyzeImpact | ✗ | 1 | 0.5 | 0.67 | 1 | ✓ |
| t02-callers-extractSymbols | Find every direct caller of extractSymbols | ✓ | 1 | 1 | 1 | 0 | ✓ |
| t03-callers-validateRootPath | Find every direct caller of validateRootPath | ✓ | 1 | 1 | 1 | 0 | ✓ |
| t04-recall-substring-parse | Find every symbol whose name contains "parse" | ✓ | 1 | 1 | 1 | 0 | ✓ |
| t05-kind-filter-interfaces | Enumerate all TypeScript interfaces under src/ | ✗ | 0 | 1 | 0 | 0 | ✓ |
| t06-impact-extractSymbols-depth2 | Compute blast radius of changing extractSymbols (depth 2) | ✗ | 1 | 0.67 | 0.8 | 3 | ✓ |
| t07-tests-affected-parseFile | Identify test files that exercise parseFile (directly) | ✗ | 0 | 0 | 0 | 1 | ✗ |
| t08-recall-substring-args | Find every MCP-tool input-args interface | ✓ | 1 | 1 | 1 | 0 | ✓ |
| t09-recall-miss | Look up a symbol that does not exist (negative test) | ✓ | 1 | 1 | 1 | 0 | ✓ |
| t10-string-literal-MAX_FILE_BYTES | Find every literal occurrence of the constant name "MAX_FILE_BYTES" | ✗ | 0 | 1 | 0 | 0 | ✓ |
| t11-impact-since-indexDirectory | Differential impact: callers of indexDirectory changed since HEAD~1 | ✓ | 1 | 1 | 1 | 0 | ✓ |
| t12-evidence-anchor-resolution | Evidence anchors: every tool response carries file:line @ sha citations | ✗ | 1 | 0.5 | 0.67 | 1 | ✓ |
| t13-recall-nonexistent-with-anchor | Anti-hallucination: looking up a symbol that does not exist returns citation proof | ✓ | 1 | 1 | 1 | 0 | ✓ |

## Summary

- **Tasks passed:** 7/13
- **Total hallucinations:** 6
- **Evidence anchors:** 12/12 (excluding string-search)
- **Mean F1 across tasks:** 0.70
