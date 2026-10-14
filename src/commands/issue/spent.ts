/**
 * Shared `--spent <duration>` support for issue mutations
 * (`issue resolve`, `issue status`, `issue edit`).
 *
 * Why: the command log showed agents running `issue edit/status` and then a
 * separate `time log` on the same issue (~8s of agent turn each time).
 * Folding the time entry into the mutation makes that one call.
 *
 * Order contract: `planSpent` runs BEFORE the issue PUT (so a bad
 * `--activity` fails with nothing changed); `logSpent` runs AFTER the PUT
 * lands. If the PUT fails, nothing is logged and the whole command is safe
 * to retry. If only the time-entry POST fails, the error says the issue
 * update already landed and hands back the exact `time log` retry.
 */

import type { RedmineClient } from '../../foundation/client';
import { createTimeEntry } from '../../api/time-entries';
import { defaultActivity, listActivities, resolveActivityId } from '../../api/activities';
import { roundHours } from '../../foundation/numbers';
import { LwrError, ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';
import type { RedmineIssue } from '../../api/types';

export interface SpentPlan {
  hours: number;
  activityId: number;
  activityName: string;
}

export interface LoggedSpent {
  id: number;
  hours: number;
  activity: string;
}

/**
 * Parse `--spent` into rounded decimal hours. `undefined` / `none` → null
 * (no time entry). Accepts `5m`, `1h`, `1h30m`, or a bare decimal (`0.25`).
 */
export function parseSpent(input: string | undefined): number | null {
  if (input === undefined || input === 'none') return null;
  const h = parseDuration(input);
  return roundHours(h) ?? h;
}

/**
 * Resolve the activity for a pending time entry. `activity` omitted →
 * `fallbackActivity` if given, else the instance default (same as `time log`).
 */
export async function planSpent(
  client: RedmineClient,
  hours: number | null,
  activity: string | undefined,
  fallbackActivity?: string,
): Promise<SpentPlan | null> {
  if (hours === null) return null;
  const activities = await listActivities(client);
  const requested = activity ?? fallbackActivity;
  if (requested === undefined) {
    const def = defaultActivity(activities);
    if (!def) {
      throw new ValidationError(
        'No time-entry activities are defined on this Redmine instance.',
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Pass --activity explicitly, or ask an admin to add an activity.',
      );
    }
    return { hours, activityId: def.id, activityName: def.name };
  }
  let activityId: number;
  try {
    activityId = resolveActivityId(activities, requested);
  } catch (err) {
    throw new ValidationError(
      err instanceof Error ? err.message : String(err),
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'See `lwr time activities` for valid names.',
    );
  }
  const activityName = activities.find(a => a.id === activityId)?.name ?? requested;
  return { hours, activityId, activityName };
}

/**
 * Redmine refuses time entries on closed issues ("Issue is a closed issue").
 * Fail before any PUT when the issue would END in a closed status, instead of
 * landing the status change and then failing the time entry. `allowed_statuses`
 * (fetched with the issue) carries `is_closed` for the current status and every
 * legal target.
 */
export function assertSpentAllowed(issue: RedmineIssue, finalStatusId: number): void {
  const closed = issue.allowed_statuses?.find(s => s.id === finalStatusId)?.is_closed ?? false;
  if (!closed) return;
  throw new ValidationError(
    `--spent can't be used here: #${issue.id} would end in a closed status, and Redmine refuses time entries on closed issues.`,
    ERROR_CODES.VALIDATION_BAD_VALUE,
    `While the issue is still open, log the time first (\`lwr time log ${issue.id} --hours N\`), then change the status without --spent.`,
  );
}

/** POST the planned time entry. Call only after the issue PUT has landed. */
export async function logSpent(
  client: RedmineClient,
  issueId: number,
  plan: SpentPlan,
  comments?: string,
): Promise<LoggedSpent> {
  try {
    const entry = await createTimeEntry(client, {
      issueId,
      hours: plan.hours,
      activityId: plan.activityId,
      comments,
    });
    return { id: entry.id, hours: entry.hours, activity: plan.activityName };
  } catch (err) {
    if (!(err instanceof LwrError)) throw err;
    throw new LwrError({
      code: err.code,
      exit: err.exit,
      message: `Issue #${issueId} was updated, but logging ${plan.hours}h failed: ${err.message}`,
      hint: `Do NOT re-run the issue command. Log the time alone: \`lwr time log ${issueId} --hours ${plan.hours} --activity "${plan.activityName}"\``,
      details: { ...err.details, issueUpdated: true },
      cause: err,
    });
  }
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
  const minOnly = /^(\d+(?:\.\d+)?)m$/.exec(s);
  const hOnly = /^(\d+(?:\.\d+)?)h$/.exec(s);
  const dec = /^(\d+(?:\.\d+)?)$/.exec(s);
  let h = NaN;
  if (both) h = Number(both[1]) + Number(both[2]) / 60;
  else if (minOnly) h = Number(minOnly[1]) / 60;
  else if (hOnly) h = Number(hOnly[1]);
  else if (dec) h = Number(dec[1]);
  if (!(h > 0)) {
    throw new ValidationError(
      `Invalid --spent "${input}".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Accepted forms: `5m`, `10m`, `15m`, `1h`, `1h30m`, or a bare decimal like `0.25` (hours).',
    );
  }
  return h;
}
