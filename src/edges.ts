import type Parser from 'tree-sitter';
import { walk, type ParsedFile } from './parser.js';
import type { SymbolRecord } from './symbols.js';

/** Name of the synthetic per-file module-scope pseudo-symbol. */
export const MODULE_SYMBOL_NAME = '<module>';

/** Stable id for a file's module-scope pseudo-symbol (pre path-rewrite). */
export function moduleSymbolId(path: string): string {
  return `${path}#${MODULE_SYMBOL_NAME}`;
}

/**
 * A resolved call edge.
 *
 * `toId` is null when the call's target couldn't be resolved to a known symbol
 * (e.g. it's a stdlib call like `Array.from`, a third-party import, or a
 * dynamic dispatch we don't track in v1). `toName` is always set, so the agent
 * still knows what was called.
 */
export interface CallEdge {
  fromId: string;
  toId: string | null;
  toName: string;
  file: string;
  line: number;
  column: number;
  /**
   * True when `toId` was resolved from more than one symbol sharing `toName`,
   * so the chosen target is a best-guess (name-only resolver, no import/type
   * info). Absent on confident or unresolved edges. Lets the agent fall back
   * to a more specific query instead of trusting an arbitrary pick.
   */
  ambiguous?: boolean;
  /** Number of symbols that shared `toName`. Only set when `ambiguous`. */
  candidateCount?: number;
}

/**
 * A pre-resolution call site. Same shape as CallEdge minus `toId`. Used during
 * indexing before we have the full symbol table.
 */
export interface RawCall {
  fromId: string;
  toName: string;
  file: string;
  line: number;
  column: number;
}

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
]);

/**
 * Walk a function body, stopping at nested functions that are themselves named
 * symbols (they'll be walked separately). Anonymous callbacks — arrow functions
 * or function expressions passed directly as arguments — are walked through and
 * their calls are attributed to the enclosing named function. This ensures that
 * calls made inside `this.after(() => { foo() })` are attributed to the outer
 * named function rather than silently lost.
 */
function* walkBodyExcludingNestedFns(
  rootNode: Parser.SyntaxNode,
  symByKey: Map<string, SymbolRecord>,
): Generator<Parser.SyntaxNode> {
  const stack: { node: Parser.SyntaxNode; isRoot: boolean }[] = [{ node: rootNode, isRoot: true }];
  while (stack.length > 0) {
    const { node, isRoot } = stack.pop()!;
    if (!isRoot && FUNCTION_NODE_TYPES.has(node.type)) {
      const key = nodeMatchKey(node);
      if (key && symByKey.has(key)) continue;
    }
    yield node;
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push({ node: child, isRoot: false });
    }
  }
}

/**
 * Extract the callee name from a `call_expression` or `new_expression` node.
 * Returns null for dynamic forms we don't try to resolve in v1.
 *
 * Examples handled:
 *   foo()                  -> "foo"
 *   obj.method()           -> "method"
 *   this.helper()          -> "helper"
 *   new Foo()              -> "Foo"
 *
 * Examples not handled (returns null):
 *   arr[x]()
 *   (function(){})()
 *   func.call(this, ...)   (we'd just see "call", which is fine — it's a
 *                           known limitation. Agent can still find the call.)
 */
function calleeName(callNode: Parser.SyntaxNode): string | null {
  const fnField =
    callNode.childForFieldName('function') ?? callNode.childForFieldName('constructor');
  if (!fnField) return null;
  if (fnField.type === 'identifier' || fnField.type === 'type_identifier') {
    return fnField.text;
  }
  if (fnField.type === 'member_expression') {
    const prop = fnField.childForFieldName('property');
    return prop?.text ?? null;
  }
  return null;
}

/**
 * Extract the component name from a JSX element node. Only PascalCase tags are
 * treated as calls into the graph — lowercase tags (`<div>`, `<span>`) are
 * intrinsic HTML, not user-defined symbols.
 *
 *   <Header />        -> "Header"
 *   <Menu.Item />     -> "Item"
 *   <div />           -> null (intrinsic)
 */
function jsxComponentName(node: Parser.SyntaxNode): string | null {
  const tag = node.childForFieldName('name');
  if (!tag) return null;
  if (tag.type === 'member_expression') {
    const prop = tag.childForFieldName('property')?.text;
    return prop && /^[A-Z]/.test(prop) ? prop : null;
  }
  return /^[A-Z]/.test(tag.text) ? tag.text : null;
}

/**
 * Unified callee-name extraction across plain calls, `new`, and JSX element
 * usages. Returns null for nodes that aren't a call or for dynamic forms we
 * don't resolve.
 */
function callTargetName(node: Parser.SyntaxNode): string | null {
  if (node.type === 'call_expression' || node.type === 'new_expression') {
    return calleeName(node);
  }
  if (node.type === 'jsx_self_closing_element' || node.type === 'jsx_opening_element') {
    return jsxComponentName(node);
  }
  return null;
}

/**
 * True if `node` sits inside the body of a named function symbol (so the call
 * is already attributed in pass 1). Walks ancestors; anonymous functions are
 * transparent — a call in `arr.map(() => foo())` is owned by the nearest
 * *named* function, exactly mirroring walkBodyExcludingNestedFns.
 */
function isInsideNamedFunction(
  node: Parser.SyntaxNode,
  symByKey: Map<string, SymbolRecord>,
): boolean {
  let cur = node.parent;
  while (cur) {
    if (FUNCTION_NODE_TYPES.has(cur.type)) {
      const key = nodeMatchKey(cur);
      if (key && symByKey.has(key)) return true;
    }
    cur = cur.parent;
  }
  return false;
}

/** Build the synthetic module-scope pseudo-symbol for a file. */
function makeModuleSymbol(parsed: ParsedFile): SymbolRecord {
  const endLine = parsed.tree.rootNode.endPosition.row + 1;
  return {
    id: moduleSymbolId(parsed.path),
    name: MODULE_SYMBOL_NAME,
    kind: 'module',
    file: parsed.path,
    line: 1,
    column: 1,
    endLine: Math.max(1, endLine),
    signature: '<module scope>',
    exported: false,
  };
}

/**
 * Match the AST node a SymbolRecord was extracted from. We use line+name as
 * the key; collisions are vanishingly rare (would need two same-named symbols
 * on the same line, which TS would reject).
 */
function nodeMatchKey(node: Parser.SyntaxNode): string | null {
  if (
    node.type === 'function_declaration' ||
    node.type === 'generator_function_declaration' ||
    node.type === 'method_definition'
  ) {
    const name = node.childForFieldName('name')?.text;
    if (!name) return null;
    return `${node.startPosition.row + 1}:${name}`;
  }
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    const parent = node.parent;
    if (parent?.type === 'variable_declarator') {
      // `const foo = () => {}` — stored under the variable declarator's line.
      const name = parent.childForFieldName('name')?.text;
      if (!name) return null;
      return `${parent.startPosition.row + 1}:${name}`;
    }
    if (node.type === 'function_expression') {
      // `module.exports = function foo() {}` — named function expression not
      // assigned via variable_declarator; stored under its own name + line.
      const name = node.childForFieldName('name')?.text;
      if (!name) return null;
      return `${node.startPosition.row + 1}:${name}`;
    }
  }
  return null;
}

/**
 * For every function-like symbol in `fileSymbols`, walk its body and emit a
 * RawCall for every call/new expression directly inside it.
 *
 * Returns calls keyed by *line+name lookup* so resolution can happen later.
 */
export function extractRawCalls(parsed: ParsedFile, fileSymbols: SymbolRecord[]): RawCall[] {
  const calls: RawCall[] = [];

  // Index symbols by line:name so we can match an AST node back to its record.
  const symByKey = new Map<string, SymbolRecord>();
  for (const s of fileSymbols) {
    symByKey.set(`${s.line}:${s.name}`, s);
  }

  // Pass 1: calls (and JSX usages) inside named function symbols.
  for (const node of walk(parsed.tree.rootNode)) {
    if (!FUNCTION_NODE_TYPES.has(node.type)) continue;
    const key = nodeMatchKey(node);
    if (!key) continue;
    const sym = symByKey.get(key);
    if (!sym) continue;

    const body = node.childForFieldName('body');
    if (!body) continue;

    for (const sub of walkBodyExcludingNestedFns(body, symByKey)) {
      const name = callTargetName(sub);
      if (!name) continue;
      calls.push({
        fromId: sym.id,
        toName: name,
        file: parsed.path,
        line: sub.startPosition.row + 1,
        column: sub.startPosition.column + 1,
      });
    }
  }

  // Pass 2: module-scope calls — anything not owned by a named function
  // (top-level statements, `if`/IIFE bodies, class field initializers,
  // top-level `await`). Attributed to a synthetic per-file <module> symbol so
  // `gp_callers` can surface entry-point usages instead of dropping them.
  const moduleCalls: RawCall[] = [];
  const moduleId = moduleSymbolId(parsed.path);
  for (const node of walk(parsed.tree.rootNode)) {
    const name = callTargetName(node);
    if (!name) continue;
    if (isInsideNamedFunction(node, symByKey)) continue;
    moduleCalls.push({
      fromId: moduleId,
      toName: name,
      file: parsed.path,
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
    });
  }

  if (moduleCalls.length > 0) {
    // Synthesize the module pseudo-symbol so the edges have a resolvable
    // `fromId`. Appended to fileSymbols (not returned separately) so the
    // indexer/watcher pick it up in their existing id-rewrite + aggregate loop.
    fileSymbols.push(makeModuleSymbol(parsed));
    calls.push(...moduleCalls);
  }

  return calls;
}

/**
 * Second-pass resolver. Given the full symbol table and a list of raw calls,
 * fill in `toId` where the callee name matches a known symbol.
 *
 * Resolution strategy (v1 — deliberately dumb):
 *   1. Prefer a symbol with the same name in the same file (likely the right one)
 *   2. Otherwise pick any symbol with that name (first match — non-deterministic
 *      across reruns of ambiguous names, but stable within a single index)
 *   3. Otherwise leave toId null
 *
 * Known limitations (documented as v1 caveats):
 *   - No import resolution: if `parseToken` is imported from another file we'll
 *     still find it globally, but if two files both export `parseToken` we may
 *     pick the wrong one.
 *   - No method-of-class disambiguation: `obj.method()` resolves to the first
 *     symbol named `method`, regardless of receiver type.
 *   - No re-export chains.
 *
 * These are fine for v1; the goal is "better than grep" not "compiler-grade".
 */
/**
 * Build the name→symbols inverted index used by the resolver. Exposed so the
 * watcher can maintain one incrementally across saves (see issue #28) instead
 * of rebuilding O(allSymbols) on every keystroke.
 */
export function buildNameIndex(allSymbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
  const byName = new Map<string, SymbolRecord[]>();
  for (const s of allSymbols) {
    const list = byName.get(s.name);
    if (list) list.push(s);
    else byName.set(s.name, [s]);
  }
  return byName;
}

export function resolveCallEdges(
  rawCalls: RawCall[],
  allSymbols: SymbolRecord[],
  /**
   * Optional prebuilt name index. When supplied, the O(allSymbols) rebuild is
   * skipped — the watcher passes an index it maintains incrementally so a save
   * costs O(symbols-in-changed-file), not O(whole-table). `allSymbols` is then
   * ignored (callers pass `[]`).
   */
  prebuiltIndex?: Map<string, SymbolRecord[]>,
): CallEdge[] {
  const byName = prebuiltIndex ?? buildNameIndex(allSymbols);

  return rawCalls.map((c) => {
    const candidates = byName.get(c.toName);
    if (!candidates || candidates.length === 0) {
      return { ...c, toId: null };
    }
    // Prefer a same-file candidate; otherwise fall back to the first match.
    const sameFile = candidates.find((s) => s.file === c.file);
    const chosen = sameFile ?? candidates[0];
    const edge: CallEdge = { ...c, toId: chosen.id };
    // Signal when the pick was a guess among homonyms so the agent doesn't
    // treat an arbitrary resolution as authoritative (issue #18).
    if (candidates.length > 1) {
      edge.ambiguous = true;
      edge.candidateCount = candidates.length;
    }
    return edge;
  });
}
