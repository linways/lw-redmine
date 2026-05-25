/**
 * `lwr issue resolve <id> [--spent <duration>] [--activity <name>] [--note <text>]`
 *
 * At Linways, "Resolved" = **deployed to production** (not "dev finished").
 * The typical case: an issue that QA has finished testing (status =
 * "Testing completed") has been deployed, and the developer flips it to
 * "Resolved" along with a short time entry recording the deploy effort.
 *
 * Two atomic steps from the agent's perspective; up to three Redmine
 * calls under the hood:
 *   1. PUT the target issue's status → "Resolved" (with optional --note).
 *   2. POST a time entry (default activity "Configurations") when
 *      --spent is provided. Omit to skip.
 *
 * Interrupt auto-pause: when the target ISN'T the active pointer AND the
 * active pointer is currently in `DEV_ACTIVE_STATUS_NAMES`, lwr PUTs the
 * active to "Paused" BEFORE the resolve. The active pointer stays SET so
 * the dev resumes via `lwr issue use <prev-id>` + a status PUT to re-enter
 * dev-active. Honors the systematic-logging rule: every work mutation on a
 * non-active issue must pause the active one first (no transient-interrupt
 * exceptions). For backfilling forgotten dev hours from a past day, use
 * `lwr time log --date YYYY-MM-DD` — it's purpose-built for backfill and
 * doesn't trigger the interrupt-pause.
 *
 * If the target IS the currently-active pointer, the interrupt-pause is a
 * no-op (you're finishing the thing you were on), and the pointer is unset
 * after the resolve.
 *
 * Single-id per call (no bulk mode); the agent loops if pushing multiple
 * in a row.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags, dryRunPreview, type DryRunPreview } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { getIssue, updateIssue } from '../../api/issues';
import { assertTransitionAllowed, listStatuses, resolveStatusId } from '../../api/statuses';
import { listActivities, resolveActivityId } from '../../api/activities';
import { createTimeEntry } from '../../api/time-entries';
import { saveConfig, loadConfig } from '../../foundation/config';
import { resolveProfileName } from '../../foundation/profiles';
import { writeMeMarkdown } from '../../workflow/me';
import {
  pauseActivePointerIfDevActive,
  previewInterruptPause,
  type InterruptPauseResult,
} from '../../workflow/auto-pause';
import {
  loadPreferences,
  applyPreferences,
  currentCfValuesFromIssue,
  bumpTriggerCounts,
  type AppliedDefault,
} from '../../assistant/preferences';
import { recordDecision } from '../../assistant/decisions';
import { roundHours } from '../../foundation/numbers';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES, REDMINE_PATHS, RESOLVED_STATUS_NAME } from '../../constants';

/** Linways default — see [[lwr-resolve-defaults]] memory. */
const DEFAULT_ACTIVITY_NAME = 'Configurations';

export interface IssueResolveFlags extends GlobalFlags {
  /** Positional issue id. */
  id?: string | number;
  /**
   * Time spent on the deploy work. Accepts `5m`, `10m`, `15m`, `30m`,
   * `1h`, `1h30m`, or a bare decimal like `0.25` (hours). Omit to skip
   * the time entry entirely.
   *
   * No `--date` flag: a resolve is a real-time deploy action; the
   * status PUT is always "now" (Redmine doesn't backdate status
   * changes anyway). To backfill forgotten dev hours from a past day,
   * use `lwr time log <id> --hours N --date YYYY-MM-DD --activity ...`.
   */
  spent?: string;
  /** Override the default activity ("Configurations"). */
  activity?: string;
  /** Optional resolve comment, added to the Redmine journal. */
  note?: string;
}

interface Payload {
  resolved: { id: number; previousStatus: string; newStatus: string };
  timeEntry: { id: number; hours: number; activity: string } | null;
  /** True iff this resolve also unset the active-issue pointer. */
  pointerCleared: boolean;
  /**
   * Interrupt-pause outcome: when the target wasn't the active pointer AND
   * the active pointer was in DEV_ACTIVE, lwr paused it first. The agent
   * uses `paused` to render "⏸ paused #X first" hints; `skipped` explains
   * why no pause happened (no-active / same-issue / not-dev-active / etc).
   */
  interruptPause: InterruptPauseResult;
}

const cmd: CommandFn<Payload | DryRunPreview> = async (flags) => {
  const f = flags as IssueResolveFlags;
  const targetId = normaliseIssueId(f.id);
  const hoursRaw = f.spent !== undefined && f.spent !== 'none' ? parseDuration(f.spent) : null;
  const hours = hoursRaw !== null ? (roundHours(hoursRaw) ?? hoursRaw) : null;
  const profileName = resolveProfileName(flags.profile);

  const session = await openSession(flags);

  // Dry-run: don't mutate. Run the resolution work and surface the planned
  // PUT + POST + interrupt-pause as previews.
  if (flags.dryRun) {
    return await previewResolve(session.client, targetId, hours, f, profileName);
  }

  // Step 0: interrupt-pause. If the active pointer is on a different issue
  // and that issue is currently in DEV_ACTIVE, PUT it → Paused first. Best-
  // effort: a failure surfaces in `interruptPause.skipped='failed'` and the
  // resolve proceeds.
  const interruptPause = await pauseActivePointerIfDevActive(session.client, targetId, profileName);

  // Step 1: PUT the target to Resolved.
  const [issue, statuses] = await Promise.all([
    getIssue(session.client, targetId, { allowedStatuses: true }),
    listStatuses(session.client),
  ]);
  const resolvedId = resolveStatusId(statuses, RESOLVED_STATUS_NAME);
  if (issue.status.id !== resolvedId) {
    assertTransitionAllowed(issue, resolvedId);
  }
  const resolvedName = statuses.find(s => s.id === resolvedId)?.name ?? RESOLVED_STATUS_NAME;

  // Apply cross-agent preferences. The verb itself doesn't accept --cf so
  // userCfs is empty — only rules whose `when` matches the existing issue
  // state can fire (e.g. "default Tester=Lakshmi when blank").
  const { file: prefsFile, warnings: prefsWarnings } = loadPreferences();
  const apply = applyPreferences(prefsFile.rules, {
    userCfs: [],
    currentCfValues: currentCfValuesFromIssue(issue.custom_fields),
  });

  const previousStatus = issue.status.name;
  if (issue.status.id !== resolvedId) {
    await updateIssue(session.client, targetId, {
      statusId: resolvedId,
      notes: f.note,
      ...(apply.customFields.length > 0 ? { customFields: apply.customFields } : {}),
    });
  }
  // If the issue was already Resolved, the previous status equals the new
  // one — caller can detect this in the payload.

  // Step 2: time entry (only when --spent supplied).
  let timeEntry: Payload['timeEntry'] = null;
  if (hours !== null) {
    const activities = await listActivities(session.client);
    const requestedActivity = f.activity ?? DEFAULT_ACTIVITY_NAME;
    let activityId: number;
    try {
      activityId = resolveActivityId(activities, requestedActivity);
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? err.message : String(err),
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
    const activityName = activities.find(a => a.id === activityId)?.name ?? requestedActivity;
    const entry = await createTimeEntry(session.client, {
      issueId: targetId,
      hours,
      activityId,
      comments: f.note ?? `Resolved (deployed to production)`,
    });
    timeEntry = { id: entry.id, hours: entry.hours, activity: activityName };
  }

  // Step 3: if the resolved issue WAS the active pointer, clear it.
  const pointerCleared = maybeClearPointer(targetId, flags);

  bumpTriggerCounts(apply.firedRuleIds);
  recordDecision({
    at: new Date().toISOString(),
    cmd: 'issue.resolve',
    resolvedCfs: [],
    appliedDefaults: apply.applied,
    issueId: targetId,
  });

  return {
    json: {
      resolved: { id: targetId, previousStatus, newStatus: resolvedName },
      timeEntry,
      pointerCleared,
      interruptPause,
    },
    pretty: ctx => {
      if (interruptPause.paused) {
        writeLine(dim(ctx, `⏸ paused #${interruptPause.paused.id} (${interruptPause.paused.previousStatus} → ${interruptPause.paused.newStatus}) before interrupt`));
      } else if (interruptPause.skipped === 'failed' && interruptPause.failureReason) {
        writeLine(dim(ctx, `⚠ could not auto-pause active pointer: ${interruptPause.failureReason}`));
      }
      writeLine(success(ctx, `✓ #${targetId} → ${resolvedName}${previousStatus !== resolvedName ? ` (was ${previousStatus})` : ' (already resolved)'}`));
      if (timeEntry) {
        writeLine(dim(ctx, `  logged ${timeEntry.hours}h as ${timeEntry.activity}`));
      }
      if (pointerCleared) {
        writeLine(dim(ctx, `  cleared active pointer (you're not working on this anymore)`));
      }
      renderAppliedDefaults(ctx, apply.applied);
    },
    meta: buildMeta(apply.applied, prefsWarnings),
  };
};

function buildMeta(
  applied: AppliedDefault[],
  warnings: { code: string; message: string }[],
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (applied.length > 0) meta.appliedDefaults = applied;
  if (warnings.length > 0) meta.warnings = warnings.map(w => ({ code: w.code, message: w.message }));
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function renderAppliedDefaults(ctx: import('../../foundation/output').OutputContext, applied: AppliedDefault[]): void {
  for (const a of applied) {
    const cfLabel = a.cfName ? `${a.cfName} (cf ${a.cf})` : `cf ${a.cf}`;
    const valueLabel = a.valueLabel ? `${a.valueLabel} (${a.value})` : String(a.value);
    writeLine(dim(ctx, `  applied default: ${cfLabel} = ${valueLabel} — rule: ${a.rule}`));
  }
}

// ---------------------------------------------------------------------------
// Pointer cleanup
// ---------------------------------------------------------------------------

function maybeClearPointer(targetId: number, flags: GlobalFlags): boolean {
  const profileName = resolveProfileName(flags.profile);
  const cfg = loadConfig();
  const profile = cfg.profiles[profileName];
  const pointer = profile?.activeIssue;
  if (!pointer || pointer.id !== targetId) return false;

  const next = { ...cfg };
  const p = { ...profile! };
  delete p.activeIssue;
  next.profiles = { ...cfg.profiles, [profileName]: p };
  saveConfig(next);
  writeMeMarkdown(p.me, p.baseUrl, p.activeProject, undefined);
  return true;
}

// ---------------------------------------------------------------------------
// Dry-run preview
// ---------------------------------------------------------------------------

async function previewResolve(
  client: import('../../foundation/client').RedmineClient,
  targetId: number,
  hours: number | null,
  f: IssueResolveFlags,
  profileName: string,
): Promise<CommandResult<DryRunPreview>> {
  const interruptPausePreview = await previewInterruptPause(client, targetId, profileName);

  const [issue, statuses] = await Promise.all([
    getIssue(client, targetId, { allowedStatuses: true }),
    listStatuses(client),
  ]);
  const resolvedId = resolveStatusId(statuses, RESOLVED_STATUS_NAME);
  if (issue.status.id !== resolvedId) {
    assertTransitionAllowed(issue, resolvedId);
  }
  const resolvedName = statuses.find(s => s.id === resolvedId)?.name ?? RESOLVED_STATUS_NAME;

  const { file: prefsFile, warnings: prefsWarnings } = loadPreferences();
  const apply = applyPreferences(prefsFile.rules, {
    userCfs: [],
    currentCfValues: currentCfValuesFromIssue(issue.custom_fields),
  });

  let activityPreview: { id: number; name: string } | null = null;
  if (hours !== null) {
    const activities = await listActivities(client);
    const requestedActivity = f.activity ?? DEFAULT_ACTIVITY_NAME;
    const activityId = resolveActivityId(activities, requestedActivity);
    activityPreview = {
      id: activityId,
      name: activities.find(a => a.id === activityId)?.name ?? requestedActivity,
    };
  }

  const path = REDMINE_PATHS.ISSUE_BY_ID(targetId);
  const body: Record<string, unknown> = { status_id: resolvedId };
  if (f.note !== undefined) body.notes = f.note;
  if (apply.customFields.length > 0) body.custom_fields = apply.customFields;

  const preview = dryRunPreview({
    method: 'PUT',
    path,
    payload: { issue: body },
    resolved: {
      issueId: targetId,
      status: { id: resolvedId, name: resolvedName },
      currentStatus: issue.status,
      timeEntry: hours !== null
        ? { hours, activity: activityPreview }
        : null,
      interruptPause: interruptPausePreview,
    },
    guards: ['workflow.allowed_transition'],
  });
  return {
    json: preview,
    pretty: ctx => {
      if (interruptPausePreview.paused) {
        writeLine(dim(ctx, `[dry-run] would PUT #${interruptPausePreview.paused.id} → ${interruptPausePreview.paused.newStatus} (interrupt-pause of active pointer)`));
      }
      writeLine(dim(ctx, `[dry-run] would PUT ${path} — ${issue.status.name} → ${resolvedName}`));
      if (hours !== null) {
        writeLine(dim(ctx, `[dry-run] would POST ${REDMINE_PATHS.TIME_ENTRIES} — ${hours}h on #${targetId} (${activityPreview?.name ?? '?'})`));
      }
      renderAppliedDefaults(ctx, apply.applied);
    },
    meta: buildMeta(apply.applied, prefsWarnings),
  };
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

function normaliseIssueId(input: string | number | undefined): number {
  if (input === undefined || input === null || input === '') {
    throw new ValidationError(
      'Issue id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr issue resolve <id>`.',
    );
  }
  const s = String(input).trim().replace(/^#/, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(
      `Invalid issue id: ${input}`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return n;
}

/**
 * Parse a duration string into decimal hours.
 *   "5m" → 0.0833…    "1h" → 1     "1h30m" → 1.5     "0.25" → 0.25
 */
function parseDuration(input: string): number {
  const s = input.trim().toLowerCase();
  if (s.length === 0) {
    throw new ValidationError(
      'Empty --spent value.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Pass e.g. `--spent 10m`, `--spent 1h`, or `--spent 0.25`.',
    );
  }
  const both = /^(\d+(?:\.\d+)?)h(\d+(?:\.\d+)?)m$/.exec(s);
  if (both) {
    const h = Number(both[1]) + Number(both[2]) / 60;
    if (h <= 0) throw badDuration(input);
    return h;
  }
  const minOnly = /^(\d+(?:\.\d+)?)m$/.exec(s);
  if (minOnly) {
    const h = Number(minOnly[1]) / 60;
    if (h <= 0) throw badDuration(input);
    return h;
  }
  const hOnly = /^(\d+(?:\.\d+)?)h$/.exec(s);
  if (hOnly) {
    const h = Number(hOnly[1]);
    if (h <= 0) throw badDuration(input);
    return h;
  }
  const dec = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (dec) {
    const h = Number(dec[1]);
    if (h <= 0) throw badDuration(input);
    return h;
  }
  throw badDuration(input);
}

function badDuration(input: string): ValidationError {
  return new ValidationError(
    `Invalid --spent "${input}".`,
    ERROR_CODES.VALIDATION_BAD_VALUE,
    'Accepted forms: `5m`, `10m`, `15m`, `1h`, `1h30m`, or a bare decimal like `0.25` (hours).',
  );
}

export function resolve(flags: IssueResolveFlags): Promise<never> {
  return runCommand('issue.resolve', flags, cmd);
}
