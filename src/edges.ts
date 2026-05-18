import type Parser from 'tree-sitter';
import { walk, type ParsedFile } from './parser.js';
import type { SymbolRecord } from './symbols.js';

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
 * Walk a function body, but stop descending into nested function definitions.
 * This way a call inside `(_ => foo())` placed inside `outer()` is attributed
 * to the arrow, not to `outer`. (When the arrow itself has a SymbolRecord —
 * because it was assigned to a const — we'll visit it separately.)
 */
function* walkBodyExcludingNestedFns(
  rootNode: Parser.SyntaxNode,
): Generator<Parser.SyntaxNode> {
  const stack: { node: Parser.SyntaxNode; isRoot: boolean }[] = [
    { node: rootNode, isRoot: true },
  ];
  while (stack.length > 0) {
    const { node, isRoot } = stack.pop()!;
    if (!isRoot && FUNCTION_NODE_TYPES.has(node.type)) continue;
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
    callNode.childForFieldName('function') ??
    callNode.childForFieldName('constructor');
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
    // We stored these under their variable name; the variable_declarator is
    // the parent we need. The declarator's startLine matches the SymbolRecord
    // line (we record the declarator, not the value).
    const parent = node.parent;
    if (parent?.type === 'variable_declarator') {
      const name = parent.childForFieldName('name')?.text;
      if (!name) return null;
      return `${parent.startPosition.row + 1}:${name}`;
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
export function extractRawCalls(
  parsed: ParsedFile,
  fileSymbols: SymbolRecord[],
): RawCall[] {
  const calls: RawCall[] = [];

  // Index symbols by line:name so we can match an AST node back to its record.
  const symByKey = new Map<string, SymbolRecord>();
  for (const s of fileSymbols) {
    symByKey.set(`${s.line}:${s.name}`, s);
  }

  for (const node of walk(parsed.tree.rootNode)) {
    if (!FUNCTION_NODE_TYPES.has(node.type)) continue;
    const key = nodeMatchKey(node);
    if (!key) continue;
    const sym = symByKey.get(key);
    if (!sym) continue;

    const body = node.childForFieldName('body');
    if (!body) continue;

    for (const sub of walkBodyExcludingNestedFns(body)) {
      if (sub.type !== 'call_expression' && sub.type !== 'new_expression') {
        continue;
      }
      const name = calleeName(sub);
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
export function resolveCallEdges(
  rawCalls: RawCall[],
  allSymbols: SymbolRecord[],
): CallEdge[] {
  const byName = new Map<string, SymbolRecord[]>();
  for (const s of allSymbols) {
    const list = byName.get(s.name);
    if (list) list.push(s);
    else byName.set(s.name, [s]);
  }

  return rawCalls.map((c) => {
    const candidates = byName.get(c.toName);
    if (!candidates || candidates.length === 0) {
      return { ...c, toId: null };
    }
    // Prefer same-file candidates first.
    const sameFile = candidates.find((s) => s.file === c.file);
    if (sameFile) return { ...c, toId: sameFile.id };
    return { ...c, toId: candidates[0].id };
  });
}
