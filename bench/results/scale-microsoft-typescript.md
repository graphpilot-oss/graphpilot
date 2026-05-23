# GraphPilot Scale Benchmark — microsoft/TypeScript (compiler source)

- Corpus: [`microsoft/TypeScript`](https://github.com/microsoft/TypeScript) — `src/` subtree (the TypeScript compiler, services, harness, server)
- Date: 2026-05-23
- Node v23.11.0 on darwin (Apple Silicon)
- Commit: shallow clone, latest `main` at run time

## Indexing

| Metric | Value |
| --- | --- |
| Files indexed | 601 |
| Files failed | 0 |
| Symbols extracted | 17,088 |
| Call edges resolved | 70,458 |
| Indexing wall-clock | 10.26 s |
| Files / second | 59 |
| graph.json on disk | 24.3 MB |
| Repo source size | 16.8 MB |
| Graph as % of source | 145.1% |

## Query latency

| Query type | Samples | Mean | p50 | p95 | Max | Mean output |
| --- | --- | --- | --- | --- | --- | --- |
| recall | 20 | 0.01 ms | 0.00 ms | 0.06 ms | 0.06 ms | 33.1 B |
| callers | 20 | 0.03 ms | 0.02 ms | 0.20 ms | 0.20 ms | 923.55 B |
| impact | 10 | 0.50 ms | 0.40 ms | 1.4 ms | 1.4 ms | 5.5 KB |

## Bytes read — GraphPilot vs grep

Same question ("who calls X?"), two strategies. Bytes-read is a proxy for the tokens the agent would pay.

| Symbol | GraphPilot output | grep file bytes | Reduction |
| --- | --- | --- | --- |
| `push` | 692 B | 17.1 MB | 100.00% |
| `assert` | 1.2 KB | 17.5 MB | 99.99% |
| `forEach` | 1.1 KB | 16.2 MB | 99.99% |
| `map` | 1.1 KB | 16.8 MB | 99.99% |
| `get` | 1023 B | 19.5 MB | 100.00% |

**Mean byte reduction: 99.99%**
