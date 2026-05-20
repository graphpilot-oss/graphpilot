/**
 * Secret-pattern redaction for symbol signatures before they're stored.
 *
 * Code occasionally contains literal secrets — `const API_KEY = "sk-..."`,
 * embedded JWTs, AWS access keys, GitHub tokens. When we extract a symbol's
 * signature line into graph.json, those literals come with it. We redact
 * them here so:
 *   1. The on-disk graph.json doesn't carry plaintext secrets
 *   2. The MCP tool output sent to the agent doesn't expose them either
 *
 * This is NOT a full secret scanner — it covers well-known fixed-prefix
 * formats. Determined leakage (custom-format secrets) will still escape,
 * but the common ones are covered.
 *
 * Pattern coverage and replacement tokens are intentionally short so a
 * signature stays readable after redaction.
 */

interface SecretPattern {
  pattern: RegExp;
  replacement: string;
  label: string;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // PEM private-key headers — match the BEGIN line before generic long-token
  // catches it, so we get the precise label.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    replacement: '-----BEGIN ***REDACTED*** PRIVATE KEY-----',
    label: 'pem-private-key',
  },
  // JSON Web Tokens: three base64url segments separated by dots.
  {
    pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: '***JWT-REDACTED***',
    label: 'jwt',
  },
  // OpenAI / Anthropic style API keys: `sk-` then 20+ alphanumerics.
  // Also covers `sk-ant-...`, `sk-proj-...` etc.
  {
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: 'sk-***REDACTED***',
    label: 'sk-token',
  },
  // GitHub personal access tokens.
  { pattern: /\bghp_[A-Za-z0-9]{30,}\b/g, replacement: 'ghp_***REDACTED***', label: 'github-pat' },
  // GitHub server tokens.
  {
    pattern: /\bghs_[A-Za-z0-9]{30,}\b/g,
    replacement: 'ghs_***REDACTED***',
    label: 'github-server',
  },
  // GitHub user / OAuth tokens.
  {
    pattern: /\bgho_[A-Za-z0-9]{30,}\b/g,
    replacement: 'gho_***REDACTED***',
    label: 'github-oauth',
  },
  // GitHub refresh tokens.
  {
    pattern: /\bghr_[A-Za-z0-9]{30,}\b/g,
    replacement: 'ghr_***REDACTED***',
    label: 'github-refresh',
  },
  // AWS access key IDs.
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: 'AKIA***REDACTED***', label: 'aws-akia' },
  // AWS short-term session tokens (less specific, but the leading prefix is unique).
  { pattern: /\bASIA[0-9A-Z]{16}\b/g, replacement: 'ASIA***REDACTED***', label: 'aws-asia' },
  // Slack tokens.
  {
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: 'xox*-***REDACTED***',
    label: 'slack',
  },
  // Stripe live secret keys.
  {
    pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/g,
    replacement: 'sk_live_***REDACTED***',
    label: 'stripe-live',
  },
  // Generic long high-entropy token inside a string literal.
  // Heuristic: 32+ chars of alphanumeric / underscore / hyphen / equals,
  // immediately surrounded by matching quotes. Keeps false positives down
  // because random function names rarely live inside quotes.
  {
    pattern: /(["'])([A-Za-z0-9_+/=-]{40,})\1/g,
    replacement: '$1***REDACTED-LONG-TOKEN***$1',
    label: 'long-token-in-string',
  },
];

/**
 * Run every secret pattern over the input string. Returns the redacted text.
 * Safe for any input length: regex operations are linear in input size.
 *
 * Order matters — more specific patterns run first so a JWT doesn't get
 * eaten by the generic long-token catch-all.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Test helper / introspection: which patterns matched in this input?
 * Useful for diagnostics; not on a hot path.
 */
export function detectSecrets(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const { pattern, label } of SECRET_PATTERNS) {
    // Build a fresh regex from the source to avoid lastIndex state on /g.
    const fresh = new RegExp(pattern.source, pattern.flags);
    if (fresh.test(text)) hits.push(label);
  }
  return hits;
}
