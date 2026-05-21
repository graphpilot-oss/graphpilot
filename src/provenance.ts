/**
 * Provenance / evidence anchors for tool responses.
 *
 * Why this exists: agents hallucinate. The most common Cursor / Claude
 * Code failure pattern is "the model called a function that doesn't
 * exist" — and the user has no quick way to verify a tool's claim
 * before acting on it.
 *
 * Solution: every result we return carries an evidence anchor — a
 * structured `{file, line, sha, excerpt}` reference that the agent
 * can include verbatim in its reply. The user (or the agent itself)
 * can then jump to the file/line and confirm the cited code matches
 * the claim. If we ever fabricate, the anchor exposes us instantly.
 *
 * Format design:
 *   - Path is relative to the indexed root (portable).
 *   - Line is 1-indexed (matches editor convention).
 *   - SHA is optional — null when the indexed repo isn't a git repo.
 *     When present, it's the 7-char short SHA of the index time.
 *   - Excerpt is optional and short (~200 chars) — for symbol records
 *     it's the signature line. For edges it's the call expression.
 *
 * Per the differentiation research, this is the SINGLE feature no
 * competitor in the 15+ landscape has shipped. See
 * .notes/differentiation-research-2026-05-21.md §1.3.
 */

import type { SymbolRecord } from './symbols.js';
import type { CallEdge } from './edges.js';

/** A single evidence anchor pointing at a specific location in the repo. */
export interface Provenance {
  /** Relative path from the indexed repo root, e.g. "src/auth.ts". */
  file: string;
  /** 1-indexed line number. */
  line: number;
  /** Optional 1-indexed column. */
  column?: number;
  /** End line, when the entity spans multiple lines. */
  endLine?: number;
  /** Short git SHA (7 chars) at index time. Null if not a git repo. */
  sha?: string | null;
  /** Short text excerpt — symbol signature, call expression, etc. */
  excerpt?: string;
}

const MAX_EXCERPT_LEN = 200;

function clipExcerpt(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_EXCERPT_LEN ? trimmed.slice(0, MAX_EXCERPT_LEN - 1) + '…' : trimmed;
}

/**
 * Make provenance for a symbol. Excerpt is the symbol's stored
 * signature (already secret-redacted by T3).
 */
export function symbolProvenance(s: SymbolRecord, sha: string | null): Provenance {
  return {
    file: s.file,
    line: s.line,
    column: s.column,
    endLine: s.endLine,
    sha: sha ?? null,
    excerpt: clipExcerpt(s.signature),
  };
}

/**
 * Make provenance for a call edge. Points at the CALL SITE (where the
 * call happens), not the callee's definition. The callee's own
 * provenance is available via `symbolProvenance(idx.findById(edge.toId))`
 * when toId is non-null.
 */
export function edgeProvenance(e: CallEdge, sha: string | null): Provenance {
  return {
    file: e.file,
    line: e.line,
    column: e.column,
    sha: sha ?? null,
    // No excerpt for edges — we don't store the call line text.
    // (Future v0.2: capture the call line at index time so the agent
    // sees the actual call expression.)
  };
}

/**
 * Format a Provenance as a single-line human/agent-readable string.
 * Used inline in tool text responses.
 *
 * Examples:
 *   src/auth.ts:42                    (no sha — not a git repo)
 *   src/auth.ts:42 @ ab12cd3          (with sha)
 *   src/auth.ts:42:5 @ ab12cd3        (with column)
 */
export function formatProvenance(p: Provenance): string {
  let out = p.file + ':' + p.line;
  if (p.column !== undefined) out += ':' + p.column;
  if (p.sha) out += ' @ ' + p.sha;
  return out;
}

/**
 * Format a Provenance as a verifiable evidence tag the agent can
 * include in its reply. The agent's user (or a downstream tool) can
 * paste this directly into a search.
 *
 * Example:
 *   [evidence: src/auth.ts:42 @ ab12cd3]
 */
export function formatEvidenceTag(p: Provenance): string {
  return `[evidence: ${formatProvenance(p)}]`;
}
