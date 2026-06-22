import type Parser from 'tree-sitter';
import { walk, type ParsedFile } from './parser.js';
import { redactSecrets } from './redact.js';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'getter'
  | 'setter'
  | 'interface'
  | 'type'
  | 'variable'
  | 'enum'
  // Synthetic per-file scope. Lets module-level / top-level calls have a valid
  // `fromId` so `gp_callers` can attribute them (see edges.ts). Never emitted by
  // extractSymbols directly — synthesized in extractRawCalls when a file has
  // calls outside any named function.
  | 'module';

export interface SymbolRecord {
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  column: number;
  endLine: number;
  signature: string;
  exported: boolean;
  parent?: string;
  /** Set on `static` class members. */
  static?: boolean;
  /** Superclass(es) / extended interfaces of a class or interface. */
  extends?: string[];
  /** Interfaces a class implements. */
  implements?: string[];
}

/**
 * Extract every symbol-defining node from a parsed file.
 * Covers: function/generator decls (incl. anonymous `export default`),
 * arrow/function-expr consts (and consts with a function-type annotation),
 * classes (+ methods, getters, setters, statics, extends/implements),
 * interfaces, type aliases, enums, namespace members, and object-literal
 * methods / function-valued properties.
 */
export function extractSymbols(parsed: ParsedFile): SymbolRecord[] {
  const out: SymbolRecord[] = [];
  for (const node of walk(parsed.tree.rootNode)) {
    extractFromNode(node, parsed, out);
  }
  disambiguateIds(out);
  return out;
}

/**
 * Symbol ids (v2) are `path#[parent.]name`, deliberately position-free so a
 * line-shifting edit doesn't rotate every id in the file (the evidence-anchor
 * pitch depends on ids being stable across unrelated edits — see #20). That
 * means two symbols can share a base id: function overloads, or a get/set
 * accessor pair on the same property. We append an occurrence suffix (`#2`,
 * `#3`, …) to the 2nd-and-later in source order so every id stays unique. The
 * suffix is stable under line shifts (order and count don't change); it only
 * moves if an actual overload is added/removed/reordered.
 */
function disambiguateIds(syms: SymbolRecord[]): void {
  const seen = new Map<string, number>();
  for (const s of syms) {
    const n = (seen.get(s.id) ?? 0) + 1;
    seen.set(s.id, n);
    if (n > 1) s.id = `${s.id}#${n}`;
  }
}

function extractFromNode(node: Parser.SyntaxNode, parsed: ParsedFile, out: SymbolRecord[]): void {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name =
        node.childForFieldName('name')?.text ?? (isExportDefault(node) ? 'default' : undefined);
      if (!name) return;
      out.push(record(node, parsed, name, 'function', enclosingNamespace(node)));
      return;
    }
    case 'class_declaration': {
      const name =
        node.childForFieldName('name')?.text ?? (isExportDefault(node) ? 'default' : undefined);
      if (!name) return;
      out.push(record(node, parsed, name, 'class', undefined, heritageOf(node)));
      extractClassMembers(node, parsed, name, out);
      return;
    }
    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      out.push(record(node, parsed, name, 'interface', undefined, heritageOf(node)));
      return;
    }
    case 'type_alias_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      out.push(record(node, parsed, name, 'type'));
      return;
    }
    case 'enum_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      out.push(record(node, parsed, name, 'enum'));
      return;
    }
    case 'variable_declarator': {
      // Emit when the value is a function literal, OR when the declarator
      // carries an inline function-type annotation (e.g.
      // `const foo: () => void = bar`) — a strong, low-false-positive signal
      // that the binding is callable even when the value is an identifier.
      const valueNode = node.childForFieldName('value');
      const isFnValue =
        !!valueNode &&
        (valueNode.type === 'arrow_function' ||
          valueNode.type === 'function_expression' ||
          valueNode.type === 'function');
      if (!isFnValue && !hasFunctionTypeAnnotation(node)) return;
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      out.push(record(node, parsed, name, 'variable'));
      return;
    }
    case 'function_expression': {
      // Named function expression not assigned to a variable, e.g. `module.exports = function foo() {}`.
      // The variable_declarator case already covers `const foo = function() {}`.
      if (node.parent?.type === 'variable_declarator') return;
      const name =
        node.childForFieldName('name')?.text ?? (isExportDefault(node) ? 'default' : undefined);
      if (!name) return;
      out.push(record(node, parsed, name, 'function'));
      return;
    }
    case 'method_definition': {
      // Class members are emitted by extractClassMembers; only object-literal
      // methods (`const o = { foo() {} }`) reach here unhandled.
      if (node.parent?.type !== 'object') return;
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const { isStatic, accessor } = modifiersOf(node);
      out.push(
        record(
          node,
          parsed,
          name,
          accessorKind(accessor),
          enclosingObjectBinding(node),
          isStatic ? { static: true } : undefined,
        ),
      );
      return;
    }
    case 'pair': {
      // Object-literal properties. Two cases we index for gp_recall:
      //  1. function-valued props: `{ foo: () => {} }`
      //  2. Symbol-keyed constants: `{ kFoo: Symbol('...') }` (common in fastify-style JS)
      const key = node.childForFieldName('key');
      if (!key || key.type !== 'property_identifier') return;
      const valueNode = node.childForFieldName('value');
      if (!valueNode) return;
      if (
        valueNode.type === 'arrow_function' ||
        valueNode.type === 'function_expression' ||
        valueNode.type === 'function'
      ) {
        out.push(record(node, parsed, key.text, 'variable', enclosingObjectBinding(node)));
        return;
      }
      if (
        valueNode.type === 'call_expression' &&
        valueNode.childForFieldName('function')?.text === 'Symbol'
      ) {
        out.push(record(node, parsed, key.text, 'variable'));
      }
      return;
    }
    default:
      return;
  }
}

function extractClassMembers(
  classNode: Parser.SyntaxNode,
  parsed: ParsedFile,
  className: string,
  out: SymbolRecord[],
): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member) continue;
    if (member.type === 'method_definition' || member.type === 'method_signature') {
      const name = member.childForFieldName('name')?.text;
      if (!name) continue;
      const { isStatic, accessor } = modifiersOf(member);
      out.push(
        record(
          member,
          parsed,
          name,
          accessorKind(accessor),
          className,
          isStatic ? { static: true } : undefined,
        ),
      );
    }
  }
}

/** Map a get/set accessor to a SymbolKind; plain methods stay 'method'. */
function accessorKind(accessor: 'get' | 'set' | null): SymbolKind {
  if (accessor === 'get') return 'getter';
  if (accessor === 'set') return 'setter';
  return 'method';
}

/**
 * Read the leading modifier tokens of a method/accessor node. Modifiers
 * (`static`, `get`, `set`, ...) precede the property name, so we stop scanning
 * once we reach the name or parameter list.
 */
function modifiersOf(member: Parser.SyntaxNode): {
  isStatic: boolean;
  accessor: 'get' | 'set' | null;
} {
  let isStatic = false;
  let accessor: 'get' | 'set' | null = null;
  for (let i = 0; i < member.childCount; i++) {
    const t = member.child(i)?.type;
    if (t === 'static') isStatic = true;
    else if (t === 'get') accessor = 'get';
    else if (t === 'set') accessor = 'set';
    else if (
      t === 'property_identifier' ||
      t === 'formal_parameters' ||
      t === 'computed_property_name'
    )
      break;
  }
  return { isStatic, accessor };
}

/** Collect type names from a class/interface `extends`/`implements` clause. */
function heritageOf(node: Parser.SyntaxNode): { extends?: string[]; implements?: string[] } {
  const ext: string[] = [];
  const impl: string[] = [];
  for (const n of walk(node)) {
    // Don't descend into the body — only the heritage header.
    if (n.type === 'class_body' || n.type === 'interface_body' || n.type === 'object_type') break;
    if (n.type === 'extends_clause' || n.type === 'extends_type_clause') {
      collectTypeNames(n, ext);
    } else if (n.type === 'implements_clause') {
      collectTypeNames(n, impl);
    }
  }
  const result: { extends?: string[]; implements?: string[] } = {};
  if (ext.length) result.extends = ext;
  if (impl.length) result.implements = impl;
  return result;
}

function collectTypeNames(clause: Parser.SyntaxNode, into: string[]): void {
  for (let i = 0; i < clause.childCount; i++) {
    const c = clause.child(i);
    if (!c) continue;
    if (c.type === 'identifier' || c.type === 'type_identifier') {
      into.push(c.text);
    } else if (c.type === 'generic_type') {
      const base = c.childForFieldName('name') ?? c.child(0);
      if (base) into.push(base.text);
    }
  }
}

/** Name of the nearest enclosing `namespace`/`module`, if any. */
function enclosingNamespace(node: Parser.SyntaxNode): string | undefined {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'internal_module' || cur.type === 'module') {
      return cur.childForFieldName('name')?.text ?? undefined;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** Best-effort binding name of the object an object-literal member lives in. */
function enclosingObjectBinding(node: Parser.SyntaxNode): string | undefined {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'variable_declarator') return cur.childForFieldName('name')?.text ?? undefined;
    // Stop before escaping the current value scope.
    if (
      cur.type === 'function_declaration' ||
      cur.type === 'class_body' ||
      cur.type === 'arguments'
    ) {
      return undefined;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** True if `node` is the subject of an `export default` statement. */
function isExportDefault(node: Parser.SyntaxNode): boolean {
  const p = node.parent;
  if (p?.type !== 'export_statement') return false;
  for (let i = 0; i < p.childCount; i++) {
    if (p.child(i)?.type === 'default') return true;
  }
  return false;
}

/** True if a variable declarator carries an inline `() => ...` type annotation. */
function hasFunctionTypeAnnotation(declarator: Parser.SyntaxNode): boolean {
  const typeAnn = declarator.childForFieldName('type');
  if (!typeAnn) return false;
  for (const n of walk(typeAnn)) {
    if (n.type === 'function_type') return true;
  }
  return false;
}

function record(
  node: Parser.SyntaxNode,
  parsed: ParsedFile,
  name: string,
  kind: SymbolKind,
  parent?: string,
  extra?: Partial<Pick<SymbolRecord, 'static' | 'extends' | 'implements'>>,
): SymbolRecord {
  const line = node.startPosition.row + 1;
  const column = node.startPosition.column + 1;
  const endLine = node.endPosition.row + 1;
  const signature = oneLineSignature(node, parsed.source);
  const exported = isExported(node);
  // Position-free id (v2). line/column/endLine are still recorded below, but
  // the id no longer embeds @line — see disambiguateIds for why and how
  // same-name collisions are resolved.
  const id = `${parsed.path}#${parent ? parent + '.' : ''}${name}`;
  return {
    id,
    name,
    kind,
    file: parsed.path,
    line,
    column,
    endLine,
    signature,
    exported,
    parent,
    ...extra,
  };
}

/**
 * Extract a single-line signature from the node. Takes the first line of
 * text up to the body/value, capped at 200 chars. Secrets matching known
 * patterns (T3 defence) are redacted before the line is returned.
 */
function oneLineSignature(node: Parser.SyntaxNode, source: string): string {
  let target: Parser.SyntaxNode = node;
  if (node.type === 'variable_declarator' && node.parent) {
    target = node.parent;
  }
  const raw = source.slice(target.startIndex, target.endIndex);
  const firstLine = raw.split('\n')[0].trim();
  const capped = firstLine.length > 200 ? firstLine.slice(0, 197) + '...' : firstLine;
  // T3: redact known-format secrets (API keys, tokens, JWTs, PEM headers).
  return redactSecrets(capped);
}

/**
 * A node is exported if it (or an ancestor variable/lexical decl) is wrapped
 * in an `export_statement`.
 */
function isExported(node: Parser.SyntaxNode): boolean {
  let cur: Parser.SyntaxNode | null = node;
  while (cur) {
    if (cur.type === 'export_statement') return true;
    cur = cur.parent;
  }
  return false;
}
