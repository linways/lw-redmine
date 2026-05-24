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
 * No auto-pause: "Resolved" isn't in `DEV_ACTIVE_STATUS_NAMES`, so the
 * dev-active mutex doesn't fire here. The dev's previously-active issue
 * (if any) keeps ticking through the brief deploy — acceptable per the
 * "deploys are mostly real-time, single-digit minute interrupts" framing.
 * For longer "I forgot to log yesterday's dev hours" cases, use
 * `lwr time log --date YYYY-MM-DD` instead — it's purpose-built for backfill.
 *
 * If the target IS the currently-active pointer, the pointer is unset
 * after the resolve — the dev just finished the thing they were on.
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
}

const cmd: CommandFn<Payload | DryRunPreview> = async (flags) => {
  const f = flags as IssueResolveFlags;
  const targetId = normaliseIssueId(f.id);
  const hoursRaw = f.spent !== undefined && f.spent !== 'none' ? parseDuration(f.spent) : null;
  const hours = hoursRaw !== null ? (roundHours(hoursRaw) ?? hoursRaw) : null;

  const session = await openSession(flags);

  // Dry-run: don't mutate. Run the resolution work and surface the planned
  // PUT + POST as previews.
  if (flags.dryRun) {
    return await previewResolve(session.client, targetId, hours, f);
  }

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

  const previousStatus = issue.status.name;
  if (issue.status.id !== resolvedId) {
    const updated = await updateIssue(session.client, targetId, {
      statusId: resolvedId,
      notes: f.note,
    });
    void updated;
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

  return {
    json: {
      resolved: { id: targetId, previousStatus, newStatus: resolvedName },
      timeEntry,
      pointerCleared,
    },
    pretty: ctx => {
      writeLine(success(ctx, `✓ #${targetId} → ${resolvedName}${previousStatus !== resolvedName ? ` (was ${previousStatus})` : ' (already resolved)'}`));
      if (timeEntry) {
        writeLine(dim(ctx, `  logged ${timeEntry.hours}h as ${timeEntry.activity}`));
      }
      if (pointerCleared) {
        writeLine(dim(ctx, `  cleared active pointer (you're not working on this anymore)`));
      }
    },
  };
};

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
): Promise<CommandResult<DryRunPreview>> {
  const [issue, statuses] = await Promise.all([
    getIssue(client, targetId, { allowedStatuses: true }),
    listStatuses(client),
  ]);
  const resolvedId = resolveStatusId(statuses, RESOLVED_STATUS_NAME);
  if (issue.status.id !== resolvedId) {
    assertTransitionAllowed(issue, resolvedId);
  }
  const resolvedName = statuses.find(s => s.id === resolvedId)?.name ?? RESOLVED_STATUS_NAME;

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
    },
    guards: ['workflow.allowed_transition'],
  });
  return {
    json: preview,
    pretty: ctx => {
      writeLine(dim(ctx, `[dry-run] would PUT ${path} — ${issue.status.name} → ${resolvedName}`));
      if (hours !== null) {
        writeLine(dim(ctx, `[dry-run] would POST ${REDMINE_PATHS.TIME_ENTRIES} — ${hours}h on #${targetId} (${activityPreview?.name ?? '?'})`));
      }
    },
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
