# Limitations of v0.1

GraphPilot v0.1 makes deliberate trade-offs to ship a small, sharp tool
fast. Knowing what it doesn't do matters as much as knowing what it does.

The list below is exhaustive as of v0.1.0. Items with a milestone have
a planned fix; unmarked items are out of scope for v1.x.

## Language coverage

- **TypeScript, TSX, JavaScript, JSX only.**
  - Python — deferred to **v0.2 / v0.3** (demand-gated)
  - Rust / Go / Java — deferred to **v1.x**
  - All other languages — not planned for v1
- **`.d.ts` declaration files are skipped.** They mostly express types
  that don't add structural information to the call graph.
- **JSON, YAML, Markdown, configs:** not indexed (we are a _code_
  index, not a project index).

## Resolver accuracy

GraphPilot uses a deliberately simple name-based resolver. The
trade-offs:

- **No import-path resolution.** `import { foo } from "./bar"` does
  not get followed. If `foo` appears in multiple files, the resolver
  picks **same-file first**, then the **first global match** — which
  may be wrong.
- **Re-exports may pick the wrong source.** A chain like
  `index.ts → utils/index.ts → utils/string.ts` resolves to whichever
  file the walker saw first.
- **No type-based method dispatch.** `userRepo.save()` and
  `productRepo.save()` both resolve to whichever `save` we saw first.
- **No `super()` or constructor inheritance tracking** beyond name
  match.
- **Standard library calls show as unresolved.** `JSON.parse`,
  `Date.now`, `console.log`, `Array.from`, fs/path/process — all have
  `toId: null`. The agent still sees the call happened; it just doesn't
  get a jump-to-definition pointer.
- **Expected resolution rate:** roughly **25–35% of edges resolve** to
  an in-repo symbol id; the rest are external. On GraphPilot's own code
  it's 42/155 (27%). That's enough to materially reduce hallucinations
  because the questions agents actually ask (_"who calls X in my
  repo"_) are the ones the dumb resolver answers correctly.

**Planned in v0.2:** import-path tracking, re-export resolution.

## Indexing model

- **Watch mode is per-file incremental.** `graphpilot watch` re-parses
  only the file that changed and re-resolves edges across the symbol
  table in ~3–10ms per save. Full re-index is only needed on first run
  or after a `pnpm install` / branch switch that changes many files.
- **Single-process.** No CPU parallelism in v0.1.
- **No `.graphpilotignore`.** Defaults skip `node_modules`, `dist`,
  `build`, `.git`, `coverage`, `.next`, `.nuxt`, `.cache`, `out`,
  `*.d.ts`. To customize, hand-edit `src/indexer.ts` (and
  `src/watcher.ts` for watch mode).
- **Max 50,000 files per index** (`MAX_FILES_PER_INDEX`). Larger repos
  error out — narrow the path or wait for v0.4 workspaces.
- **Max 5 MB per file** (`MAX_FILE_BYTES`). Larger files (minified
  bundles, generated code) are silently skipped.

**Planned in v0.2:** watch mode. **v0.3+:** incremental updates,
`.graphpilotignore`.

## What we don't index (deliberate)

- **Comments and docstrings.** Use `rg TODO` etc.
- **String literals.** `process.env.FOO`, route paths, embedded SQL.
- **Configuration files.** package.json, tsconfig.json, .env.
- **Git history.** No blame, no diff awareness.

## Scope

- **Single repo per query.** Each `gp_*` tool call operates on one
  indexed repo. For microservices, index each repo separately; the
  agent must coordinate lookups.
- **No workspace abstraction.** Cross-repo namespace resolution (e.g.
  `@org/auth` imported in `@org/payments`) is not native in v0.1. See
  the manual workaround in `quickstart.md`.

**Planned in v0.4 / v1.x:** workspace.yaml-driven cross-repo.

## Agent capabilities

- **No route detection.** Express, Fastify, NestJS, Hono handlers are
  not recognized as routes in v0.1.
- **Heuristic test-to-unit mapping.** `gp_impact` flags tests whose paths
  look related (filename match, `tests/` co-location), but does not
  parse test bodies. Symbol-level "this test exercises that function"
  precision is planned for v0.3.
- **No semantic search.** `gp_recall` is name-only (exact case-insensitive
  or substring). "Find code similar to this snippet" — not supported.
  Deferred until 30+ users request it.
- **Public-API flag is a heuristic.** `gp_impact` returns a `publicApi`
  boolean inferred from `exported: true` symbols; a first-class
  public-surface extractor is not in v0.1.

## Privacy / data handling

- **No telemetry, no remote calls.** Verifiable: `src/` has zero `http`,
  `fetch`, `axios`, or analytics imports — enforced by an ESLint rule
  in the build gate (`eslint.config.js`) plus a meta-test that proves
  the rule fires on every banned import.
- **Source code never leaves your machine.** Only the structured graph
  (names, locations, signatures, call relationships) lives in
  `~/.graphpilot/`.
- **Signatures may contain secrets if your code does.** If you have
  `const API_KEY = "sk-..."` literally in source, that line ends up in
  `graph.json`. Secret-pattern redaction is **shipped** (T3 defence): GraphPilot automatically redacts known
  secret formats — `sk-`, `ghp_`/`ghs_`, AWS `AKIA` keys, JWTs, PEM headers, Slack/Stripe tokens —
  before writing to `graph.json`. No secrets from recognised patterns reach the stored graph.

## Platform support

- **Linux:** tested, CI green
- **macOS** (Intel + Apple Silicon): tested, CI green
- **Windows:** experimental in v0.1. CI green but real-world testing is
  light. The subprocess MCP test is currently skipped on Windows. File
  bugs eagerly.

## Performance ceiling

Rough numbers on Apple Silicon (M1 Pro, 16 GB):

| Repo size | Index time | Resident memory | graph.json |
| --------- | ---------- | --------------- | ---------- |
| 100 files | 80 ms      | ~30 MB          | ~100 KB    |
| 1k files  | 800 ms     | ~80 MB          | ~1 MB      |
| 10k files | 8 s        | ~300 MB         | ~10 MB     |
| 50k files | 40 s       | ~1.2 GB         | ~50 MB     |

Query latency on the pre-computed indexes: sub-millisecond even at 50k
symbols.

## What we deliberately don't build

Not a value judgement — just clarity on scope:

- **Not a coding agent.** Claude Code / Cursor / Aider generate code.
  We provide them context.
- **Not a security scanner.** CodeQL owns taint analysis.
- **Not a build system.** We don't compile.
- **Not a Sourcegraph clone.** No web UI for human browsing — the agent
  is the user.
- **Not a SaaS.** No accounts, no cloud, no enterprise tier in v1.

If your use case needs one of those, GraphPilot is the wrong tool.

## Reporting limits we missed

The list above is intentionally exhaustive. If you hit a real limit
that's not documented here,
[open an issue](https://github.com/graphpilot-oss/graphpilot/issues) —
"undocumented limitation" is a valid issue type and helps us keep this
list honest.
