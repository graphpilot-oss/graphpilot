/**
 * Hand-rolled validation for MCP tool inputs. No external deps — three tools,
 * each with a handful of fields, makes a library overkill.
 *
 * Every tool validator returns a tagged result:
 *   { ok: true,  value: <typed args> }
 *   { ok: false, error: <human-readable> }
 *
 * Rules (defence-in-depth — JSON schema is declared in the tool catalog
 * too; this is the second wall):
 *   - Reject extra unknown keys (defends against agent typos & tampering)
 *   - Type-check every field
 *   - Range-check numbers (limit is bounded, no NaN)
 *   - Length-cap strings (no 10MB symbol names)
 *   - Strict enums (no surprise direction values)
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
function fail<T>(error: string): Result<T> {
  return { ok: false, error };
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const MAX_STRING_LEN = 2_000;

function pickString(
  obj: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; max?: number } = {},
): Result<string | undefined> {
  const raw = obj[key];
  if (raw === undefined) {
    if (opts.required) return fail(`Missing required field: ${key}`);
    return ok(undefined);
  }
  if (typeof raw !== 'string') return fail(`${key} must be a string`);
  const max = opts.max ?? MAX_STRING_LEN;
  if (raw.length > max) return fail(`${key} exceeds max length of ${max}`);
  return ok(raw);
}

function pickNumber(
  obj: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): Result<number | undefined> {
  const raw = obj[key];
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fail(`${key} must be a finite number`);
  }
  if (opts.integer && !Number.isInteger(raw)) {
    return fail(`${key} must be an integer`);
  }
  if (opts.min !== undefined && raw < opts.min) {
    return fail(`${key} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && raw > opts.max) {
    return fail(`${key} must be <= ${opts.max}`);
  }
  return ok(raw);
}

function pickBoolean(obj: Record<string, unknown>, key: string): Result<boolean | undefined> {
  const raw = obj[key];
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'boolean') return fail(`${key} must be a boolean`);
  return ok(raw);
}

function pickEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): Result<T | undefined> {
  const raw = obj[key];
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    return fail(`${key} must be one of: ${allowed.join(', ')}`);
  }
  return ok(raw as T);
}

function rejectExtraKeys(obj: Record<string, unknown>, allowed: readonly string[]): Result<true> {
  const extras = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extras.length > 0) {
    return fail(`Unknown field(s): ${extras.join(', ')}. Allowed: ${allowed.join(', ')}`);
  }
  return ok(true);
}

// ----------------------------------------------------------------------------
// Per-tool validators
// ----------------------------------------------------------------------------

export interface GpIndexArgs {
  path?: string;
}
const GP_INDEX_KEYS = ['path'] as const;

export function validateGpIndex(input: unknown): Result<GpIndexArgs> {
  if (!isPlainObject(input)) return fail('arguments must be an object');
  const extras = rejectExtraKeys(input, GP_INDEX_KEYS);
  if (!extras.ok) return fail(extras.error);
  const path = pickString(input, 'path', { max: 1024 });
  if (!path.ok) return fail(path.error);
  return ok({ path: path.value });
}

export interface GpRecallArgs {
  query: string;
  limit?: number;
  substring?: boolean;
  path?: string;
}
const GP_RECALL_KEYS = ['query', 'limit', 'substring', 'path'] as const;

export function validateGpRecall(input: unknown): Result<GpRecallArgs> {
  if (!isPlainObject(input)) return fail('arguments must be an object');
  const extras = rejectExtraKeys(input, GP_RECALL_KEYS);
  if (!extras.ok) return fail(extras.error);

  const query = pickString(input, 'query', { required: true, max: 200 });
  if (!query.ok) return fail(query.error);
  if (!query.value || query.value.trim() === '') {
    return fail('query must be a non-empty string');
  }

  const limit = pickNumber(input, 'limit', { min: 1, max: 50, integer: true });
  if (!limit.ok) return fail(limit.error);

  const substring = pickBoolean(input, 'substring');
  if (!substring.ok) return fail(substring.error);

  const path = pickString(input, 'path', { max: 1024 });
  if (!path.ok) return fail(path.error);

  return ok({
    query: query.value,
    limit: limit.value,
    substring: substring.value,
    path: path.value,
  });
}

export type CallersDirection = 'callers' | 'callees';

export interface GpCallersArgs {
  symbol: string;
  direction?: CallersDirection;
  limit?: number;
  includeUnresolved?: boolean;
  path?: string;
}
const GP_CALLERS_KEYS = ['symbol', 'direction', 'limit', 'includeUnresolved', 'path'] as const;

export function validateGpCallers(input: unknown): Result<GpCallersArgs> {
  if (!isPlainObject(input)) return fail('arguments must be an object');
  const extras = rejectExtraKeys(input, GP_CALLERS_KEYS);
  if (!extras.ok) return fail(extras.error);

  const symbol = pickString(input, 'symbol', { required: true, max: 500 });
  if (!symbol.ok) return fail(symbol.error);
  if (!symbol.value || symbol.value.trim() === '') {
    return fail('symbol must be a non-empty string');
  }

  const direction = pickEnum(input, 'direction', ['callers', 'callees'] as const);
  if (!direction.ok) return fail(direction.error);

  const limit = pickNumber(input, 'limit', { min: 1, max: 100, integer: true });
  if (!limit.ok) return fail(limit.error);

  const includeUnresolved = pickBoolean(input, 'includeUnresolved');
  if (!includeUnresolved.ok) return fail(includeUnresolved.error);

  const path = pickString(input, 'path', { max: 1024 });
  if (!path.ok) return fail(path.error);

  return ok({
    symbol: symbol.value,
    direction: direction.value,
    limit: limit.value,
    includeUnresolved: includeUnresolved.value,
    path: path.value,
  });
}

// Tool name -> validator dispatcher (for the MCP server)
export type ToolName = 'gp_index' | 'gp_recall' | 'gp_callers' | 'gp_impact' | 'gp_stats';

export interface GpStatsArgs {
  path?: string;
}
export function validateGpStats(input: unknown): Result<GpStatsArgs> {
  if (!isPlainObject(input)) return fail('arguments must be an object');
  const extras = rejectExtraKeys(input, ['path']);
  if (!extras.ok) return fail(extras.error);
  const path = pickString(input, 'path', { max: 1024 });
  if (!path.ok) return fail(path.error);
  return ok({ path: path.value });
}

export interface GpImpactArgs {
  symbol: string;
  depth?: number;
  path?: string;
}
const GP_IMPACT_KEYS = ['symbol', 'depth', 'path'] as const;

export function validateGpImpact(input: unknown): Result<GpImpactArgs> {
  if (!isPlainObject(input)) return fail('arguments must be an object');
  const extras = rejectExtraKeys(input, GP_IMPACT_KEYS);
  if (!extras.ok) return fail(extras.error);

  const symbol = pickString(input, 'symbol', { required: true, max: 500 });
  if (!symbol.ok) return fail(symbol.error);
  if (!symbol.value || symbol.value.trim() === '') {
    return fail('symbol must be a non-empty string');
  }

  // BFS depth: hard-cap at 5. Deeper traversals explode in big repos and
  // rarely add value — depth-3 already covers ~99% of real refactors.
  const depth = pickNumber(input, 'depth', { min: 1, max: 5, integer: true });
  if (!depth.ok) return fail(depth.error);

  const path = pickString(input, 'path', { max: 1024 });
  if (!path.ok) return fail(path.error);

  return ok({
    symbol: symbol.value,
    depth: depth.value,
    path: path.value,
  });
}
