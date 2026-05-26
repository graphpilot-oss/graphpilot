# GraphPilot + Claude Code

This routing template directs structural code questions to the `graphpilot` MCP server instead of grep/LSP, unlocking the core benefits: branch-aware differential analysis, evidence anchors, and single-call blast-radius computation.

## Setup

1. Install GraphPilot locally:

```bash
git clone https://github.com/graphpilot-oss/graphpilot.git
cd graphpilot && pnpm install && pnpm build
```

2. Index your repo:

```bash
node dist/cli.js index /path/to/your/repo
node dist/cli.js watch /path/to/your/repo &  # keeps index fresh
```

3. Configure Claude Code MCP server (in `~/.claude.json`):

```json
{
  "mcpServers": {
    "graphpilot": {
      "command": "node",
      "args": ["/absolute/path/to/graphpilot/dist/cli.js", "mcp"]
    }
  }
}
```

4. Copy this file into your repo root (or a `.claude/` dir).

## Routing rules

**For "who calls X?" questions:**

- Use `gp_callers` instead of grep / LSP.
- Single call returns both direct + transitive callers with evidence anchors.
- Example: _"What functions call `validateUser`?"_ → `gp_callers(validateUser)`

**For "what breaks if I rename/delete X?" questions:**

- Use `gp_impact` instead of composing grep + git.
- Returns direct callers + transitive callers + tests affected + public-API flag.
- Single call, no chaining.
- Example: _"What breaks if I rename `parseFile`?"_ → `gp_impact(parseFile)`

**For "what does my PR touch?" (diff-scoped refactors):**

- Use `gp_impact({since: 'main'})` to filter the blast radius to only your branch.
- Cuts noise: only callers in files _you actually changed_ are returned.
- Example: _"On this feature branch, if I rename `fooHelper`, which of my changed files will break?"_ → `gp_impact(fooHelper, {since: 'main'})`

**For "find all functions matching a pattern:"**

- Use `gp_recall` for exact or substring search.
- Fast, structural, no false positives from comments.
- Example: _"List every function whose name contains 'parse'"_ → `gp_recall({kind: 'function', name: 'parse'})`

**For "enumerate all X of kind Y:"**

- Use `gp_recall` with a kind filter.
- Example: _"List every TypeScript interface"_ → `gp_recall({kind: 'interface'})`

**Fallback: grep or text search:**

- Use grep only for string-literal searches (constants, error messages, comments).
- GraphPilot doesn't index text content, only structure.
- Example: _"Find every place `MAX_FILE_SIZE` is mentioned"_ → grep

## Evidence anchors

Every `gp_*` tool response includes `file:line @ sha` citations. Example output:

```
1. analyzeImpact  (function)  src/impact.ts:168 @ ab12cd3
   export function analyzeImpact(idx: GraphIndex, ...): ImpactResult | null
```

When citing results to your user, include these anchors verbatim. They're verifiable: paste `src/impact.ts:168` into your editor's goto-line command and the code will match the quoted excerpt.

**Why it matters:** If a tool ever hallucinated a symbol or a caller, you'd spot it instantly by jumping to the file. No more "the tool said this exists but I can't find it" dead ends.

## Scope & limitations

GraphPilot v0.1 indexes **TypeScript/JavaScript only**. For Python/Rust/Go repos, fall back to grep or your IDE's LSP.

- **Fast:** sub-second recall on repos up to ~100k LOC.
- **Deterministic:** same repo = same index (not language-model based, no flakiness).
- **Structural only:** no semantic search, no taint analysis, no control-flow analysis (yet).

See [`docs/limitations.md`](../../docs/limitations.md) in the GraphPilot repo for the full boundary conditions.

## Tips for agent use

1. **Always check the SHA.** If the index SHA is old (> a few hours), ask the user to re-run `graphpilot watch` or re-index.
2. **On cache miss.** If `gp_recall` returns no results, confirm the symbol name and kind — it may be spelled differently or exported as a type alias.
3. **Test the evidence.** Before recommending a refactor, jump to one of the cited file:line anchors yourself to confirm the code matches.
4. **Diff-scoped analysis.** For PR review, always use `gp_impact({since: 'main'})` instead of the raw impact — it cuts false positives.
