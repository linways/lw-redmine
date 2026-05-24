/**
 * `lwr time log <issue> --hours N`
 *
 * Append a single time entry to the issue's spent-hours roll-up.
 *
 * Resolution flow:
 *   1. Parse + validate `--hours` (decimal, > 0).
 *   2. If `--activity` is a name, resolve via the cached activities list.
 *   3. If neither `--activity` nor `--activity-id` is given, fall back to
 *      the instance's default activity.
 *   4. POST `/time_entries.json` with `issue_id`, `hours`, `activity_id`,
 *      and (optionally) `spent_on`, `comments`.
 *
 * Linways notes: the activity list is short (typically Development /
 * Testing / Documentation) — agents almost always want to pass `--activity
 * Development`. The default fallback exists so a smoke-test `lwr time log
 * <id> --hours 0.25` works without picking one.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags, dryRunPreview, type DryRunPreview } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { createTimeEntry } from '../../api/time-entries';
import { defaultActivity, listActivities, resolveActivityId } from '../../api/activities';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES, REDMINE_PATHS } from '../../constants';
import type { RedmineTimeEntry } from '../../api/types';

export interface TimeLogFlags extends GlobalFlags {
  /** Issue id, positional. */
  id?: string | number;
  /** Hours as a decimal, e.g. 2.5. Required. */
  hours?: number;
  /** Activity by name (resolved against `lwr time activities`). */
  activity?: string;
  /** Activity by numeric id (escape hatch — bypasses name resolution). */
  activityId?: number;
  /** Date the work was done. Defaults to today (server-side). */
  date?: string;
  /** Free-text note that ends up in the time-entry's `comments`. */
  comments?: string;
}

const cmd: CommandFn<RedmineTimeEntry | DryRunPreview> = async (flags): Promise<CommandResult<RedmineTimeEntry | DryRunPreview>> => {
  const f = flags as TimeLogFlags;
  const issueId = normaliseIssueId(f.id);
  const hours = normaliseHours(f.hours);

  if (f.activity !== undefined && f.activityId !== undefined) {
    throw new ValidationError(
      'Pass either --activity (name) or --activity-id (number), not both.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  if (f.date !== undefined) assertIsoDate(f.date);

  const session = await openSession(flags);

  const activities = await listActivities(session.client);
  let activityId: number;
  let activityName: string | undefined;
  if (f.activityId !== undefined) {
    activityId = f.activityId;
    activityName = activities.find(a => a.id === activityId)?.name;
  } else if (f.activity !== undefined) {
    try {
      activityId = resolveActivityId(activities, f.activity);
      activityName = activities.find(a => a.id === activityId)?.name ?? f.activity;
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? err.message : String(err),
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
  } else {
    const def = defaultActivity(activities);
    if (!def) {
      throw new ValidationError(
        'No time-entry activities are defined on this Redmine instance.',
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Ask an admin to add an activity, or pass --activity-id explicitly.',
      );
    }
    activityId = def.id;
    activityName = def.name;
  }

  const payload = {
    time_entry: {
      issue_id: issueId,
      hours,
      activity_id: activityId,
      ...(f.date !== undefined ? { spent_on: f.date } : {}),
      ...(f.comments !== undefined ? { comments: f.comments } : {}),
    },
  };

  // --dry-run: stop here. Resolution + activity-id lookup ran; everything
  // is decided. The agent gets the exact body that would be POSTed plus
  // the activity name we resolved against.
  if (flags.dryRun) {
    const preview = dryRunPreview({
      method: 'POST',
      path: REDMINE_PATHS.TIME_ENTRIES,
      payload,
      resolved: {
        issueId,
        activity: { id: activityId, name: activityName ?? null },
        hours,
      },
    });
    return {
      json: preview,
      pretty: ctx => writeLine(dim(ctx, `[dry-run] would POST ${REDMINE_PATHS.TIME_ENTRIES} — ${hours}h on #${issueId} (${activityName ?? activityId})`)),
    };
  }

  const entry = await createTimeEntry(session.client, {
    issueId,
    hours,
    activityId,
    spentOn: f.date,
    comments: f.comments,
  });

  return {
    json: entry,
    pretty: ctx =>
      writeLine(
        success(
          ctx,
          `Logged ${entry.hours}h on #${entry.issue?.id ?? issueId} (${entry.activity.name}, ${entry.spent_on})`,
        ),
      ),
  };
};

function normaliseIssueId(input: string | number | undefined): number {
  if (input === undefined || input === null || input === '') {
    throw new ValidationError(
      'Issue id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr time log <id> --hours N`.',
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

function normaliseHours(input: number | undefined): number {
  if (input === undefined || input === null) {
    throw new ValidationError(
      '--hours is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'e.g. `--hours 2.5`. Decimal hours are accepted.',
    );
  }
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(
      `Invalid hours: ${input}. Pass a positive decimal, e.g. 2.5.`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return n;
}

function assertIsoDate(s: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new ValidationError(
      `Invalid --date "${s}". Expected YYYY-MM-DD.`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
}

export function log(flags: TimeLogFlags): Promise<never> {
  return runCommand('time.log', flags, cmd);
}
