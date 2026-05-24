/**
 * Preferences engine — cross-agent shared brain for user facts.
 *
 * Loads `~/.lwr/facts/preferences.json`, evaluates rules against the
 * resolved CF state of the command in flight, and produces the merged
 * `customFields` payload + `meta.appliedDefaults[]` audit trail.
 *
 * One rule's shape:
 *   when:  single equality on a custom field id (cf_X == value)
 *   set:   one or more (cf_Y, value) pairs to inject
 *
 * Apply semantics (deterministic, contract-stable):
 *   1. User-supplied --cf for a target cf ALWAYS wins (skip injection).
 *   2. Existing non-blank value on the issue ALWAYS wins (skip injection).
 *   3. Rules fire in array order; first non-skipped injection per cf wins.
 *
 * Failures on load are non-fatal — the apply-path proceeds with no rules
 * and surfaces the reason in `meta.warnings[]`. Failures on write are
 * fatal — the agent must know its teach didn't land.
 */

import fs from 'node:fs';
import { z } from 'zod';
import { preferencesFilePath, assistantFactsDir } from '../foundation/paths';
import { ERROR_CODES, EXIT, PREFERENCES_SCHEMA } from '../constants';
import type { ResolvedCustomField } from '../foundation/cf-resolver';
import { LwrError } from '../foundation/errors';

/** Wire shape Redmine returns for a single custom_field value. */
type RedmineCfValueOnRead = string | string[] | null;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const WhenSchema = z
  .object({
    cf: z.number().int().positive(),
    cfName: z.string().optional(),
    equals: z.union([z.number(), z.string()]),
    equalsLabel: z.string().optional(),
  })
  .strict();

const SetItemSchema = z
  .object({
    cf: z.number().int().positive(),
    cfName: z.string().optional(),
    value: z.union([z.number(), z.string()]),
    valueLabel: z.string().optional(),
  })
  .strict();

const RuleSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, {
        message: 'Rule id must be kebab- or snake-case ([a-z0-9_-], starting with [a-z0-9]).',
      }),
    when: WhenSchema,
    set: z.array(SetItemSchema).min(1),
    reason: z.string().min(1),
    addedBy: z.string().min(1),
    addedAt: z.string().datetime(),
    lastTriggeredAt: z.string().datetime().nullable(),
    triggerCount: z.number().int().nonnegative(),
  })
  .strict();

const PreferencesFileSchema = z
  .object({
    schema: z.literal(PREFERENCES_SCHEMA),
    updatedAt: z.string().datetime(),
    rules: z.array(RuleSchema),
  })
  .strict();

export type PreferenceWhen = z.infer<typeof WhenSchema>;
export type PreferenceSetItem = z.infer<typeof SetItemSchema>;
export type PreferenceRule = z.infer<typeof RuleSchema>;
export type PreferencesFile = z.infer<typeof PreferencesFileSchema>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PreferenceWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AppliedDefault {
  rule: string;
  cf: number;
  cfName?: string;
  value: string | number;
  valueLabel?: string;
  reason: string;
  source: 'preferences';
}

/**
 * A `set` entry that wanted to fire but got skipped. Two reasons:
 *   - user-cf-override: the user explicitly passed `--cf X=<their-value>`
 *                       and that wins over the rule. High-signal: the rule
 *                       may no longer match the user's behaviour.
 *   - issue-non-blank : the target cf is already set on the issue. Mostly
 *                       benign — rule is for blank fields only.
 */
export interface SkippedDefault {
  rule: string;
  cf: number;
  reason: 'user-cf-override' | 'issue-non-blank';
  ruleValue: string | number;
  /** Set when `reason === 'user-cf-override'`. */
  userValue?: string | number;
  /** Set when `reason === 'issue-non-blank'`. */
  issueValue?: string | number;
}

export interface LoadResult {
  file: PreferencesFile;
  warnings: PreferenceWarning[];
}

export interface ApplyInput {
  /** Already-resolved user --cf pairs. User intent wins over any rule. */
  userCfs: ResolvedCustomField[];
  /**
   * Map of cf id → current value on the issue (after the user's edits in
   * this command have been merged). For `issue create` this is empty
   * except for entries the user passed via --cf. For edit/status/close
   * this is built from the fetched issue's custom_fields plus the user's
   * pending changes.
   */
  currentCfValues: Map<number, string | number | null>;
}

export interface ApplyResult {
  /**
   * The full merged custom_fields list for the outgoing payload —
   * userCfs followed by any injected rule-defaults. Caller passes this
   * straight to the api layer's `customFields` field.
   */
  customFields: { id: number; value: string | number }[];
  /** Audit trail for `meta.appliedDefaults[]`. Empty when no rule fired. */
  applied: AppliedDefault[];
  /**
   * Would-be injections that got skipped (user override or already-set).
   * Caller logs `user-cf-override` rows to `overrides.ndjson` so a
   * future suggester can spot rules the user has stopped following.
   */
  skipped: SkippedDefault[];
  /**
   * The full set of fired rule ids. Caller persists `lastTriggeredAt` /
   * `triggerCount` for these via `bumpTriggerCounts` AFTER the underlying
   * PUT/POST succeeds.
   */
  firedRuleIds: string[];
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const EMPTY_FILE: PreferencesFile = {
  schema: PREFERENCES_SCHEMA,
  updatedAt: '1970-01-01T00:00:00.000Z',
  rules: [],
};

/**
 * Load preferences from disk. Missing file → empty result, no warnings
 * (this is the common case — most users have no rules yet). Malformed
 * file → empty result + warnings. Schema-mismatch (forward-compatible
 * future file) → empty result + warning. Duplicate rule ids → file
 * loaded with the FIRST occurrence kept, duplicates dropped, warning.
 */
export function loadPreferences(): LoadResult {
  const file = preferencesFilePath();
  if (!fs.existsSync(file)) {
    return { file: { ...EMPTY_FILE }, warnings: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    return {
      file: { ...EMPTY_FILE },
      warnings: [
        {
          code: ERROR_CODES.PREFERENCES_PARSE_ERROR,
          message: `Could not read preferences file: ${file}`,
          details: { cause: String(cause) },
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      file: { ...EMPTY_FILE },
      warnings: [
        {
          code: ERROR_CODES.PREFERENCES_PARSE_ERROR,
          message: `Preferences file is not valid JSON: ${file}`,
          details: { cause: String(cause) },
        },
      ],
    };
  }

  // Pre-check the schema field before zod's strict parse so we emit the
  // semantic SCHEMA_MISMATCH code instead of a generic parse error.
  if (typeof parsed === 'object' && parsed !== null) {
    const schemaField = (parsed as Record<string, unknown>).schema;
    if (typeof schemaField === 'string' && schemaField !== PREFERENCES_SCHEMA) {
      return {
        file: { ...EMPTY_FILE },
        warnings: [
          {
            code: ERROR_CODES.PREFERENCES_SCHEMA_MISMATCH,
            message: `Preferences file uses schema "${schemaField}", expected "${PREFERENCES_SCHEMA}".`,
            details: { found: schemaField, expected: PREFERENCES_SCHEMA },
          },
        ],
      };
    }
  }

  const result = PreferencesFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      file: { ...EMPTY_FILE },
      warnings: [
        {
          code: ERROR_CODES.PREFERENCES_PARSE_ERROR,
          message: `Preferences file failed validation: ${file}`,
          details: {
            issues: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
          },
        },
      ],
    };
  }

  // Dedupe rule ids — keep the first occurrence, warn about the rest.
  const seen = new Set<string>();
  const deduped: PreferenceRule[] = [];
  const duplicates: string[] = [];
  for (const rule of result.data.rules) {
    if (seen.has(rule.id)) {
      duplicates.push(rule.id);
      continue;
    }
    seen.add(rule.id);
    deduped.push(rule);
  }

  const warnings: PreferenceWarning[] = [];
  if (duplicates.length > 0) {
    warnings.push({
      code: ERROR_CODES.PREFERENCES_DUPLICATE_RULE_ID,
      message: `Preferences file contains duplicate rule ids: ${duplicates.join(', ')}. Keeping the first occurrence.`,
      details: { duplicates },
    });
  }

  return {
    file: { ...result.data, rules: deduped },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Save (atomic temp+rename, mode 0600 because facts include user behaviour)
// ---------------------------------------------------------------------------

/**
 * Atomically write the preferences file. Stamps `updatedAt` to "now"
 * unless the caller provided one explicitly.
 *
 * Throws on parse/validation errors of the input — callers should
 * never feed an invalid structure here; the schema is enforced.
 */
export function savePreferences(file: PreferencesFile): void {
  const stamped: PreferencesFile = {
    ...file,
    updatedAt: file.updatedAt === EMPTY_FILE.updatedAt ? new Date().toISOString() : file.updatedAt,
  };
  const validated = PreferencesFileSchema.parse(stamped);
  const dir = assistantFactsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = preferencesFilePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * Convenience: load → transform → save. Use for `prefs add/remove` and
 * the bump-counters path. The caller's transformer MUST return a
 * fully-valid `PreferencesFile`; `savePreferences` will throw if not.
 */
export function updatePreferences(fn: (file: PreferencesFile) => PreferencesFile): PreferencesFile {
  const { file } = loadPreferences();
  const next: PreferencesFile = {
    ...fn(file),
    updatedAt: new Date().toISOString(),
  };
  savePreferences(next);
  return next;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Pure function: given userCfs + the issue's current cf state + the
 * loaded rules, decide which defaults to inject. No I/O. The caller is
 * responsible for loading rules (so tests can pass a synthetic file)
 * and for persisting counter bumps AFTER the underlying mutation lands.
 */
export function applyPreferences(rules: readonly PreferenceRule[], input: ApplyInput): ApplyResult {
  const userCfMap = new Map<number, string | number>();
  for (const cf of input.userCfs) userCfMap.set(cf.id, cf.value);

  const merged: Map<number, { id: number; value: string | number }> = new Map();
  for (const cf of input.userCfs) {
    merged.set(cf.id, { id: cf.id, value: cf.value });
  }

  const applied: AppliedDefault[] = [];
  const skipped: SkippedDefault[] = [];
  const firedRuleIds: string[] = [];

  for (const rule of rules) {
    if (!whenMatches(rule.when, input.userCfs, input.currentCfValues)) continue;

    let ruleFired = false;
    for (const target of rule.set) {
      const userValue = userCfMap.get(target.cf);
      if (userValue !== undefined) {
        // The user explicitly passed this cf. Record an override row IFF
        // the user's value differs from the rule's value — same value
        // means the user is just being explicit, not contradicting.
        if (String(userValue) !== String(target.value)) {
          skipped.push({
            rule: rule.id,
            cf: target.cf,
            reason: 'user-cf-override',
            ruleValue: target.value,
            userValue,
          });
        }
        continue;
      }

      const issueValue = input.currentCfValues.get(target.cf);
      if (isNonBlank(issueValue)) {
        skipped.push({
          rule: rule.id,
          cf: target.cf,
          reason: 'issue-non-blank',
          ruleValue: target.value,
          issueValue: issueValue as string | number,
        });
        continue;
      }

      // First non-skipped rule per cf wins. Later rules that target the
      // same cf become no-ops (documented contract; no skipped row for
      // these — they're not "overridden," just "lost the order race").
      if (merged.has(target.cf)) continue;

      merged.set(target.cf, { id: target.cf, value: target.value });
      const entry: AppliedDefault = {
        rule: rule.id,
        cf: target.cf,
        value: target.value,
        reason: rule.reason,
        source: 'preferences',
      };
      if (target.cfName !== undefined) entry.cfName = target.cfName;
      if (target.valueLabel !== undefined) entry.valueLabel = target.valueLabel;
      applied.push(entry);
      ruleFired = true;
    }
    if (ruleFired) firedRuleIds.push(rule.id);
  }

  return {
    customFields: Array.from(merged.values()),
    applied,
    skipped,
    firedRuleIds,
  };
}

/**
 * `when` matches when either:
 *   - the user passed --cf for `when.cf` AND its value equals `when.equals`, OR
 *   - the issue's current state has `when.cf` set to `when.equals`.
 *
 * Comparison is string-coerced because Redmine returns CF values as
 * strings on the wire even for user-id CFs ("57" vs 57). Rules in the
 * file may use either form (zod accepts number | string).
 */
function whenMatches(
  when: PreferenceWhen,
  userCfs: readonly ResolvedCustomField[],
  current: ReadonlyMap<number, string | number | null>,
): boolean {
  const target = String(when.equals);
  for (const cf of userCfs) {
    if (cf.id === when.cf) return String(cf.value) === target;
  }
  const cur = current.get(when.cf);
  if (cur === undefined || cur === null) return false;
  return String(cur) === target;
}

function isNonBlank(v: string | number | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

// ---------------------------------------------------------------------------
// Build the currentCfValues map from a fetched issue
// ---------------------------------------------------------------------------

/**
 * Extract a cf-id → value map from a Redmine issue payload. Multi-value
 * cfs (string[]) keep their first element for the equality check;
 * unsupported (null) values map to `null` so `isNonBlank` rejects them.
 */
export function currentCfValuesFromIssue(
  cfs: readonly { id: number; value: RedmineCfValueOnRead }[] | undefined,
): Map<number, string | number | null> {
  const out = new Map<number, string | number | null>();
  if (!cfs) return out;
  for (const entry of cfs) {
    if (entry.value === null || entry.value === undefined) {
      out.set(entry.id, null);
      continue;
    }
    if (Array.isArray(entry.value)) {
      out.set(entry.id, entry.value.length > 0 ? entry.value[0] : null);
      continue;
    }
    out.set(entry.id, entry.value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bump counters (called AFTER the underlying mutation succeeds)
// ---------------------------------------------------------------------------

/**
 * Increment `triggerCount` + stamp `lastTriggeredAt` for every fired
 * rule id. Best-effort: a failure here does NOT raise — the user's
 * command already succeeded, and a stale counter is harmless. Skips
 * entirely on empty input to avoid touching the file.
 */
export function bumpTriggerCounts(firedRuleIds: readonly string[]): void {
  if (firedRuleIds.length === 0) return;
  try {
    const now = new Date().toISOString();
    updatePreferences(file => ({
      ...file,
      rules: file.rules.map(r =>
        firedRuleIds.includes(r.id)
          ? { ...r, lastTriggeredAt: now, triggerCount: r.triggerCount + 1 }
          : r,
      ),
    }));
  } catch {
    // Counter bumps are diagnostic, not load-bearing. Swallow.
  }
}

// ---------------------------------------------------------------------------
// Helpers for `lwr prefs add/remove`
// ---------------------------------------------------------------------------

/**
 * Deterministic rule id derived from `when` + first `set` target. Two
 * `prefs add` calls describing the same logical rule converge to the
 * same id, so the agent can re-teach without proliferating duplicates.
 *
 * Format: `cf<when.cf>-eq<when.equals>-cf<set[0].cf>` (all lowercased,
 * non-[a-z0-9_-] chars stripped from the equals token).
 */
export function deriveRuleId(when: PreferenceWhen, set: readonly PreferenceSetItem[]): string {
  if (set.length === 0) {
    // Shouldn't reach here — RuleSchema requires set.length >= 1 — but
    // be defensive so we never produce a malformed id.
    throw new LwrError({
      message: 'Cannot derive rule id: empty set[].',
      code: ERROR_CODES.PREFERENCES_PARSE_ERROR,
      exit: EXIT.INTERNAL,
    });
  }
  const eqToken = String(when.equals).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return `cf${when.cf}-eq${eqToken}-cf${set[0].cf}`;
}

export function findRuleById(file: PreferencesFile, id: string): PreferenceRule | undefined {
  return file.rules.find(r => r.id === id);
}
