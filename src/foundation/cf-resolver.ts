/**
 * Custom-field setter resolver — `--cf <key>=<value>` for `issue edit`
 * and `issue create`.
 *
 * Wire it up by collecting one or more `--cf` strings off the CLI,
 * then calling `resolveCustomFieldPairs(...)` to turn them into the
 * `{ id, value }[]` shape the api layer's `customFields` field accepts.
 *
 * Resolution pipeline (per pair, key=value):
 *
 *   KEY (cf name → id)
 *     1. Pure integer  → use as cf id directly (escape hatch).
 *     2. Otherwise     → look up in `~/.lwr/cache/custom-fields.json`,
 *                        which is populated opportunistically from every
 *                        issue payload that already passes through the
 *                        client (no /custom_fields.json needed — that
 *                        endpoint is admin-only on most Redmine installs).
 *
 *   VALUE (string → typed)
 *     1. `raw:<x>`     → strip prefix, pass through literally. Use this
 *                        when a value happens to look like a user name
 *                        but should be stored as a string (list-type cf
 *                        whose option collides with a real user name).
 *     2. `id:<n>`      → strip prefix; if numeric, pass through as id.
 *     3. Pure integer  → pass through as id (user/version/enum cfs).
 *     4. Otherwise     → try the user resolver against the issue's
 *                        project (same chain `--assignee` uses:
 *                        project members cache → /users.json → manual
 *                        list). On a match, use the resolved id.
 *                        On VALIDATION_USER_NOT_FOUND, fall back to the
 *                        literal string (covers list/text-type cfs).
 *                        VALIDATION_AMBIGUOUS_USER re-throws — the
 *                        caller needs to disambiguate.
 *
 * Phase A scope: we don't know each cf's `field_format` (would need
 * /custom_fields.json), so the pipeline tries user resolution first and
 * gracefully falls back. This handles every user-type cf at Linways
 * (Developer / Tester / QA / Assigned Team etc.) and every list-type cf
 * whose options don't collide with real user names. The `raw:` prefix
 * is the escape hatch for the collision case.
 */

import { ERROR_CODES } from '../constants';
import { LwrError, ValidationError } from './errors';
import { readCustomFieldsCatalog, type CustomFieldEntry } from './cache';
import { resolveUserId } from '../api/users';
import type { RedmineClient } from './client';
import { EXIT } from '../constants';

/** Hard cap on cf ids — same as the list-filter cap. */
const MAX_CF_ID = 10_000;

export interface ResolvedCustomField {
  id: number;
  value: string | number;
  /** Original `--cf` string for error messages / dry-run echo. */
  raw: string;
  /** Provenance of the value: how we landed on it. */
  source: 'literal' | 'raw-prefix' | 'id-prefix' | 'numeric' | 'user-resolved';
  /** When name → id used the catalog, the matched entry. */
  matchedCf?: CustomFieldEntry;
}

export interface ResolveCfOptions {
  /** Anchor user resolution to this issue's project (preferred). */
  issueId?: number | string;
  /** Anchor user resolution to this project explicitly. */
  projectId?: number | string;
}

interface ParsedPair {
  key: string;
  value: string;
}

/**
 * Split `<key>=<value>` at the first `=`. Values may contain `=`.
 * Whitespace is trimmed off the key and the value's outer edges only —
 * internal whitespace in a value (e.g. `"Tester=Alex Biju"`) is preserved.
 */
export function parseCfPair(raw: string): ParsedPair {
  const trimmed = raw.trim();
  const eq = trimmed.indexOf('=');
  if (eq <= 0) {
    throw new ValidationError(
      `Bad --cf value: "${raw}".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Use the form `--cf <name-or-id>=<value>`, e.g. `--cf "Tester=Alex Biju"` or `--cf 88=42`.',
    );
  }
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (value.length === 0) {
    throw new ValidationError(
      `Bad --cf value: "${raw}" — empty value.`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Pass the cf value after `=`. To clear a cf, use `raw:` with an empty string explicitly, e.g. `--cf "Tester=raw:"` is not allowed — pass the literal you want.',
    );
  }
  return { key, value };
}

/**
 * Resolve the cf key (name → id) using the opportunistic catalog.
 * Pure integers short-circuit straight to that id.
 */
export function resolveCfKey(key: string): { id: number; matched?: CustomFieldEntry } {
  if (/^\d+$/.test(key)) {
    const id = Number(key);
    if (id <= 0 || id > MAX_CF_ID) {
      throw new ValidationError(
        `--cf id out of range: ${id} (must be 1..${MAX_CF_ID}).`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Custom-field ids on Redmine are small positive integers; check `lwr cache list` or your instance admin.',
      );
    }
    return { id };
  }

  const catalog = readCustomFieldsCatalog();
  const fields = catalog?.fields ?? {};
  const lower = key.toLowerCase();

  // Exact case-insensitive match on cf name.
  const matches: CustomFieldEntry[] = [];
  for (const entry of Object.values(fields)) {
    if (entry.name.toLowerCase() === lower) matches.push(entry);
  }

  if (matches.length === 1) {
    return { id: matches[0].id, matched: matches[0] };
  }

  if (matches.length > 1) {
    throw new LwrError({
      message: `Custom-field name "${key}" matches ${matches.length} catalog entries.`,
      code: ERROR_CODES.VALIDATION_AMBIGUOUS_CF,
      exit: EXIT.VALIDATION,
      hint: 'Pass the numeric id (e.g. `--cf 88=…`) to disambiguate.',
      details: {
        query: key,
        candidates: matches.map(m => ({ id: m.id, name: m.name })),
      },
    });
  }

  // No catalog match. Build a hint listing what we *do* know, sorted by
  // recency so the most relevant names show first. Cap at 12 entries
  // to keep the error envelope small.
  const known = Object.values(fields)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, 12)
    .map(e => ({ id: e.id, name: e.name }));

  throw new LwrError({
    message: `Custom-field "${key}" not found in catalog.`,
    code: ERROR_CODES.VALIDATION_CF_NOT_FOUND,
    exit: EXIT.VALIDATION,
    hint:
      known.length > 0
        ? `Known cfs (most-recent first): ${known.map(k => `${k.name} (id ${k.id})`).join(', ')}. ` +
          'Or pass the numeric id directly: `--cf 88=…`.'
        : 'Catalog is empty — fetch any issue first (e.g. `lwr issue view <id>`) so the cf names get recorded, then retry. Or pass the numeric id directly: `--cf 88=…`.',
    details: { query: key, known },
  });
}

/**
 * Resolve the cf value through the type-aware pipeline. Returns the
 * canonical value (string or number) plus how we arrived at it.
 */
export async function resolveCfValue(
  client: RedmineClient,
  rawValue: string,
  opts: ResolveCfOptions,
): Promise<{ value: string | number; source: ResolvedCustomField['source'] }> {
  // 1. Escape hatches.
  if (rawValue.startsWith('raw:')) {
    return { value: rawValue.slice(4), source: 'raw-prefix' };
  }
  if (rawValue.startsWith('id:')) {
    const rest = rawValue.slice(3).trim();
    if (/^\d+$/.test(rest)) {
      return { value: Number(rest), source: 'id-prefix' };
    }
    return { value: rest, source: 'id-prefix' };
  }

  // 2. Pure integer — pass through as id (user/version/enum cfs).
  if (/^\d+$/.test(rawValue)) {
    return { value: Number(rawValue), source: 'numeric' };
  }

  // 3. Try user resolution against the issue's project. If it lands
  // unambiguously, use that id (covers user-type cfs by name). If it
  // can't find anyone, fall back to the literal string (covers list /
  // text cfs whose value happens to be a plain name like "Mobile" or
  // "High Priority"). Ambiguity re-throws — the caller must pick.
  try {
    const resolved = await resolveUserId(client, rawValue, {
      issueId: opts.issueId,
      projectId: opts.projectId,
    });
    if (resolved.source === 'none') {
      // The literal token "none" was passed — fall back to literal.
      return { value: rawValue, source: 'literal' };
    }
    return { value: resolved.id, source: 'user-resolved' };
  } catch (err) {
    if (err instanceof LwrError && err.code === ERROR_CODES.VALIDATION_USER_NOT_FOUND) {
      return { value: rawValue, source: 'literal' };
    }
    throw err;
  }
}

/**
 * Resolve every `--cf` pair in one go. Each pair becomes one entry in
 * the returned array, in input order. Duplicate cf ids in the same call
 * are an error — Redmine would silently take the last one and the
 * dry-run preview wouldn't reflect the precedence cleanly.
 */
export async function resolveCustomFieldPairs(
  client: RedmineClient,
  raws: string[],
  opts: ResolveCfOptions,
): Promise<ResolvedCustomField[]> {
  if (raws.length === 0) return [];
  const out: ResolvedCustomField[] = [];
  const seen = new Set<number>();
  for (const raw of raws) {
    const { key, value } = parseCfPair(raw);
    const { id, matched } = resolveCfKey(key);
    if (seen.has(id)) {
      throw new ValidationError(
        `Duplicate --cf id: ${id}. Each custom field can only appear once per call.`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Remove the duplicate `--cf` flag or merge the values.',
      );
    }
    seen.add(id);
    const { value: resolvedValue, source } = await resolveCfValue(client, value, opts);
    out.push({
      id,
      value: resolvedValue,
      raw,
      source,
      ...(matched ? { matchedCf: matched } : {}),
    });
  }
  return out;
}
