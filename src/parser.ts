import Parser from 'tree-sitter';
// @ts-ignore — tree-sitter-typescript ships JS, has no types
import TS from 'tree-sitter-typescript';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { MAX_FILE_BYTES } from './validation.js';

export interface ParsedFile {
  path: string;
  lang: 'typescript' | 'tsx' | 'javascript' | 'jsx';
  tree: Parser.Tree;
  source: string;
}

const PARSER_CACHE = new Map<string, Parser>();

function getParser(lang: ParsedFile['lang']): Parser {
  if (PARSER_CACHE.has(lang)) return PARSER_CACHE.get(lang)!;
  const p = new Parser();
  // Cast around the peer-dep type-version skew between tree-sitter and
  // tree-sitter-typescript. Runtime is fine; only the .d.ts files disagree.
  const langs = TS as { typescript: Parser.Language; tsx: Parser.Language };
  switch (lang) {
    case 'typescript':
      p.setLanguage(langs.typescript);
      break;
    case 'tsx':
      p.setLanguage(langs.tsx);
      break;
    case 'javascript':
    case 'jsx':
      p.setLanguage(langs.typescript);
      break;
  }
  PARSER_CACHE.set(lang, p);
  return p;
}

export function detectLang(path: string): ParsedFile['lang'] | null {
  switch (extname(path).toLowerCase()) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'jsx';
    default:
      return null;
  }
}

export function parseFile(path: string): ParsedFile | null {
  const lang = detectLang(path);
  if (!lang) return null;
  // Defence against T1 (resource exhaustion): skip oversized files rather than
  // OOM the process. 5 MB is enough for any real source file.
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size > MAX_FILE_BYTES) return null;
  const source = readFileSync(path, 'utf8');
  return parseSource(path, source, lang);
}

export function parseSource(
  path: string,
  source: string,
  lang: ParsedFile['lang'],
): ParsedFile {
  const tree = getParser(lang).parse(source);
  return { path, lang, tree, source };
}

/**
 * Walk the tree and yield every node. Depth-first, pre-order.
 *
 * Iterative (not recursive) so a deeply-nested AST can't blow the JS stack.
 * Tree-sitter trees on real codebases hit ~50–80 depth; pathological generated
 * code can go much deeper. Defence against T1.
 */
export function* walk(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  const stack: Parser.SyntaxNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    yield cur;
    // Push children in reverse so they pop in original order (preserves
    // pre-order traversal — matters for callers that rely on source ordering).
    for (let i = cur.childCount - 1; i >= 0; i--) {
      const child = cur.child(i);
      if (child) stack.push(child);
    }
  }
}

/**
 * Day-2 deliverable: list every function name in a parsed file.
 * Catches: function declarations, arrow functions assigned to consts,
 * class methods, function expressions assigned to variables.
 */
export function listFunctions(parsed: ParsedFile): string[] {
  const names: string[] = [];
  for (const node of walk(parsed.tree.rootNode)) {
    const name = functionNameOf(node);
    if (name) names.push(name);
  }
  return names;
}

function functionNameOf(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'method_definition':
    case 'function_signature': {
      const nameNode = node.childForFieldName('name');
      return nameNode?.text ?? null;
    }
    case 'variable_declarator': {
      // const foo = () => ... | const foo = function() {}
      const valueNode = node.childForFieldName('value');
      if (
        valueNode &&
        (valueNode.type === 'arrow_function' ||
          valueNode.type === 'function_expression' ||
          valueNode.type === 'function')
      ) {
        const nameNode = node.childForFieldName('name');
        return nameNode?.text ?? null;
      }
      return null;
    }
    default:
      return null;
  }
}
