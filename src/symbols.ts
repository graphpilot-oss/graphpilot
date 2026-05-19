import type Parser from 'tree-sitter';
import { walk, type ParsedFile } from './parser.js';
import { redactSecrets } from './redact.js';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'variable'
  | 'enum';

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
}

/**
 * Extract every symbol-defining node from a parsed file.
 * v1 covers: function decls, arrow/function-expr consts, classes, methods,
 * interfaces, type aliases, enums.
 */
export function extractSymbols(parsed: ParsedFile): SymbolRecord[] {
  const out: SymbolRecord[] = [];
  for (const node of walk(parsed.tree.rootNode)) {
    extractFromNode(node, parsed, out);
  }
  return out;
}

function extractFromNode(
  node: Parser.SyntaxNode,
  parsed: ParsedFile,
  out: SymbolRecord[],
): void {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      out.push(record(node, parsed, name, 'function'));
      return;
    }
    case 'class_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      out.push(record(node, parsed, name, 'class'));
      extractClassMembers(node, parsed, name, out);
      return;
    }
    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      out.push(record(node, parsed, name, 'interface'));
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
      // Only emit if value is a function-like (matches Day-2 listFunctions logic).
      const valueNode = node.childForFieldName('value');
      if (
        !valueNode ||
        !(
          valueNode.type === 'arrow_function' ||
          valueNode.type === 'function_expression' ||
          valueNode.type === 'function'
        )
      ) {
        return;
      }
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      out.push(record(node, parsed, name, 'variable'));
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
      out.push(record(member, parsed, name, 'method', className));
    }
  }
}

function record(
  node: Parser.SyntaxNode,
  parsed: ParsedFile,
  name: string,
  kind: SymbolKind,
  parent?: string,
): SymbolRecord {
  const line = node.startPosition.row + 1;
  const column = node.startPosition.column + 1;
  const endLine = node.endPosition.row + 1;
  const signature = oneLineSignature(node, parsed.source);
  const exported = isExported(node);
  const id = `${parsed.path}#${parent ? parent + '.' : ''}${name}@${line}`;
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
  };
}

/**
 * Extract a single-line signature from the node. Takes the first line of
 * text up to the body/value, capped at 200 chars. Secrets matching known
 * patterns (T3 defence) are redacted before the line is returned.
 */
function oneLineSignature(node: Parser.SyntaxNode, source: string): string {
  // For variable_declarator, climb to the parent lexical/var declaration so we
  // capture "export const foo = ..." rather than just "foo = ...".
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
