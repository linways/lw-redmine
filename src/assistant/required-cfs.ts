/**
 * Required-CF guard — a locally-declared "required CFs per target status" map.
 *
 * Redmine's own required-field metadata is admin-only (there's no API to
 * read "which CFs a workflow transition requires"), so teams declare it
 * here in `~/.lwr/facts/required-cfs.json`. This is the tribal rule
 * "Development Completed requires cf 130 (Root Cause) and cf 88 (Tester)"
 * becoming enforceable from the CLI.
 *
 * Applied by `issue status` / `issue close` AFTER prefs inject their
 * defaults but BEFORE the PUT. A CF counts as satisfied if it's non-empty
 * on the fetched issue OR injected into the outgoing payload by prefs.
 *
 * Failure modes (mirrors the preferences loader's posture):
 *   - file ABSENT       → guard is a silent no-op (the common case)
 *   - file MALFORMED    → guard is skipped, but a REQUIRED_CFS_PARSE_ERROR
 *                         warning surfaces in `meta.warnings[]` + stderr —
 *                         a typo must never silently disable a guard the
 *                         user believes is active
 *   - mode "warn"       → missing-CF strings in `meta.requiredCfWarnings`
 *                         + stderr; mutation proceeds
 *   - mode "block"      → throws LwrError MISSING_REQUIRED_CF (unless
 *                         `force`), so the caller never fires the PUT
 */

import fs from 'node:fs';
import { z } from 'zod';
import { requiredCfsFilePath } from '../foundation/paths';
import { LwrError } from '../foundation/errors';
import { ERROR_CODES, EXIT } from '../constants';

const RequiredCfsFile = z.object({
  version: z.literal(1),
  mode: z.enum(['warn', 'block']).default('warn'),
  rules: z.array(
    z.object({
      status: z.string(),
      requires: z.array(z.object({ cf: z.number(), name: z.string() })),
    }),
  ),
});

export type RequiredCfsConfig = z.infer<typeof RequiredCfsFile>;

/** Same shape as the preferences loader's warnings — flows into `meta.warnings[]`. */
export interface RequiredCfsLoadWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RequiredCfsLoadResult {
  /** `null` when absent (silent) or malformed (warned) — guard is a no-op. */
  config: RequiredCfsConfig | null;
  warnings: RequiredCfsLoadWarning[];
}

/**
 * Load the required-CF map. ABSENT file → `null`, no warnings (most users
 * have no map). A file that EXISTS but fails read / JSON-parse / schema
 * validation → `null` + a warning, so the mutation still proceeds but the
 * user learns their guard isn't active.
 */
export function loadRequiredCfs(): RequiredCfsLoadResult {
  const file = requiredCfsFilePath();
  if (!fs.existsSync(file)) {
    return { config: null, warnings: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (cause) {
    return {
      config: null,
      warnings: [
        {
          code: ERROR_CODES.REQUIRED_CFS_PARSE_ERROR,
          message: `Could not read required-CFs file — guard skipped: ${file}`,
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
      config: null,
      warnings: [
        {
          code: ERROR_CODES.REQUIRED_CFS_PARSE_ERROR,
          message: `Required-CFs file is not valid JSON — guard skipped: ${file}`,
          details: { cause: String(cause) },
        },
      ],
    };
  }

  const result = RequiredCfsFile.safeParse(parsed);
  if (!result.success) {
    return {
      config: null,
      warnings: [
        {
          code: ERROR_CODES.REQUIRED_CFS_PARSE_ERROR,
          message: `Required-CFs file failed validation — guard skipped: ${file}`,
          details: {
            issues: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
          },
        },
      ],
    };
  }

  return { config: result.data, warnings: [] };
}

interface CfValue {
  id: number;
  value?: unknown;
}

function nonEmpty(v: unknown): boolean {
  return v != null && String(Array.isArray(v) ? v.join('') : v).trim() !== '';
}

function satisfied(cfId: number, issueCfs: CfValue[], outgoingCfs: CfValue[]): boolean {
  // Outgoing (prefs-injected) values are checked first — they represent
  // the value the PUT will actually carry — then the issue's current value.
  return [...outgoingCfs, ...issueCfs].some(c => c.id === cfId && nonEmpty(c.value));
}

export interface RequiredCfsCheck {
  /**
   * Missing-CF warnings (warn mode, or block bypassed via `force`) —
   * caller surfaces them under `meta.requiredCfWarnings` + stderr.
   * Empty when nothing is missing, no rule matches, or no map is loaded.
   */
  warnings: string[];
  /**
   * Malformed-file warnings — caller merges them into `meta.warnings[]`
   * (same channel as prefs load warnings) + stderr.
   */
  loadWarnings: RequiredCfsLoadWarning[];
}

/**
 * Returns warnings (warn mode) or throws LwrError (block mode, unless
 * `force`). Call after `applyPreferences`, before the PUT.
 */
export function checkRequiredCfs(opts: {
  targetStatusName: string;
  issueId: number;
  issueCfs: CfValue[];
  outgoingCfs: CfValue[];
  force?: boolean;
}): RequiredCfsCheck {
  const { config, warnings: loadWarnings } = loadRequiredCfs();
  if (!config) return { warnings: [], loadWarnings };

  const rule = config.rules.find(
    r => r.status.toLowerCase() === opts.targetStatusName.toLowerCase(),
  );
  if (!rule) return { warnings: [], loadWarnings };

  const missing = rule.requires.filter(
    r => !satisfied(r.cf, opts.issueCfs, opts.outgoingCfs),
  );
  if (missing.length === 0) return { warnings: [], loadWarnings };

  if (config.mode === 'block' && !opts.force) {
    const list = missing.map(m => `cf ${m.cf} "${m.name}"`).join(', ');
    throw new LwrError({
      message: `Status "${opts.targetStatusName}" requires ${list} — not set on issue ${opts.issueId}.`,
      code: ERROR_CODES.MISSING_REQUIRED_CF,
      exit: EXIT.VALIDATION,
      hint: `Set them first: lwr issue edit ${opts.issueId} --cf <id>=<value> (or add a pref rule). Use --force to bypass.`,
      details: { missing, targetStatus: opts.targetStatusName },
    });
  }

  return {
    warnings: missing.map(
      m => `required cf ${m.cf} "${m.name}" is empty for status "${opts.targetStatusName}"`,
    ),
    loadWarnings,
  };
}
