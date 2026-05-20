# GraphPilot Benchmark — 2026-05-20T06:13:00.314Z

Corpus: `<graphpilot-repo>`
graphpilot v0.0.1
Node v23.11.0 on darwin

## Aggregate

- Tasks run: **10**
- F1 (avg): graphpilot **0.89** vs grep **0.42**
- Bytes processed (total): graphpilot **721B** vs grep **528.1KB** (99.9% reduction)
- Winner counts: graphpilot **7** · grep **1** · tie **2**
- Expected-winner accuracy: **9/10** (90%)

## Per-task

| # | Task | GP F1 | Grep F1 | GP bytes | Grep bytes | Winner | Expected |
|---|---|---|---|---|---|---|---|
| t01-callers-analyzeImpact | Find every function that calls analyzeImpact | 1.00 | 0.00 | 18B | 48.8KB | graphpilot | graphpilot ✓ |
| t02-callers-extractSymbols | Find every direct caller of extractSymbols | 1.00 | 0.00 | 44B | 43.6KB | graphpilot | graphpilot ✓ |
| t03-callers-validateRootPath | Find every direct caller of validateRootPath | 1.00 | 0.00 | 49B | 48.5KB | graphpilot | graphpilot ✓ |
| t04-recall-substring-parse | Find every symbol whose name contains "parse" | 1.00 | 0.50 | 65B | 148.1KB | graphpilot | graphpilot ✓ |
| t05-kind-filter-interfaces | Enumerate all TypeScript interfaces under src/ | 1.00 | 1.00 | 342B | 88.9KB | tie | graphpilot ✗ |
| t06-impact-extractSymbols-depth2 | Compute blast radius of changing extractSymbols (depth 2) | 0.92 | 0.00 | 99B | 43.6KB | graphpilot | graphpilot ✓ |
| t07-tests-affected-parseFile | Identify test files that exercise parseFile (directly) | 1.00 | 0.33 | 25B | 48.8KB | graphpilot | graphpilot ✓ |
| t08-recall-substring-args | Find every MCP-tool input-args interface | 1.00 | 0.48 | 75B | 33.3KB | graphpilot | graphpilot ✓ |
| t09-recall-miss | Look up a symbol that does not exist (negative test) | 1.00 | 1.00 | 2B | 6.9KB | tie | tie ✓ |
| t10-string-literal-MAX_FILE_BYTES | Find every literal occurrence of the constant name "MAX_FILE_BYTES" | 0.00 | 0.86 | 2B | 17.5KB | grep | grep ✓ |