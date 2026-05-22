# Baseline Tier-B (grep)

| Task | Description | Success | Recall | Precision | F1 | Halluc |
|---|---|---|---|---|---|---|
| t01-callers-analyzeImpact | Find every function that calls analyzeImpact | ✗ | 0 | 1 | 0 | 0 |
| t02-callers-extractSymbols | Find every direct caller of extractSymbols | ✗ | 0 | 1 | 0 | 0 |
| t03-callers-validateRootPath | Find every direct caller of validateRootPath | ✗ | 0 | 1 | 0 | 0 |
| t04-recall-substring-parse | Find every symbol whose name contains "parse" | ✗ | 1 | 0.02 | 0.04 | 271 |
| t05-kind-filter-interfaces | Enumerate all TypeScript interfaces under src/ | ✗ | 0 | 1 | 0 | 0 |
| t06-impact-extractSymbols-depth2 | Compute blast radius of changing extractSymbols (depth 2) | ✗ | 0 | 1 | 0 | 0 |
| t07-tests-affected-parseFile | Identify test files that exercise parseFile (directly) | ✗ | 0 | 0 | 0 | 169 |
| t08-recall-substring-args | Find every MCP-tool input-args interface | ✗ | 1 | 0.11 | 0.2 | 40 |
| t09-recall-miss | Look up a symbol that does not exist (negative test) | ✓ | 1 | 1 | 1 | 0 |
| t10-string-literal-MAX_FILE_BYTES | Find every literal occurrence of the constant name "MAX_FILE_BYTES" | ✓ | 1 | 1 | 1 | 0 |
| t11-impact-since-indexDirectory | Differential impact: callers of indexDirectory changed since HEAD~1 | ✓ | 1 | 1 | 1 | 0 |
| t12-evidence-anchor-resolution | Evidence anchors: every tool response carries file:line @ sha citations | ✗ | 0 | 1 | 0 | 0 |
| t13-recall-nonexistent-with-anchor | Anti-hallucination: looking up a symbol that does not exist returns citation proof | ✓ | 1 | 1 | 1 | 0 |

## Summary

- **Tasks passed:** 4/13
- **Total hallucinations:** 480
- **Mean F1:** 0.33
