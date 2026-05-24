/**
 * `lwr time edit <entry-id>`
 *
 * Mutate an existing time entry. Pass any subset of:
 *   --hours, --activity / --activity-id, --date, --comments,
 *   --issue (move entry to a different issue),
 *   --project (move to a project, when not anchored to an issue).
 *
 * No field passed → 422 from Redmine; we pre-flight that and surface a
 * clean validation error.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags, dryRunPreview, type DryRunPreview } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { toTimeEntryUpdateBody, updateTimeEntry, type UpdateTimeEntryInput } from '../../api/time-entries';
import { listActivities, resolveActivityId } from '../../api/activities';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES, REDMINE_PATHS } from '../../constants';
import type { RedmineTimeEntry } from '../../api/types';

export interface TimeEditFlags extends GlobalFlags {
  id?: string | number;
  hours?: number;
  activity?: string;
  activityId?: number;
  date?: string;
  comments?: string;
  issue?: string | number;
  project?: string | number;
}

const cmd: CommandFn<RedmineTimeEntry | DryRunPreview> = async (flags): Promise<CommandResult<RedmineTimeEntry | DryRunPreview>> => {
  const f = flags as TimeEditFlags;
  const id = normaliseEntryId(f.id);

  if (f.activity !== undefined && f.activityId !== undefined) {
    throw new ValidationError(
      'Pass either --activity (name) or --activity-id (number), not both.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  if (f.date !== undefined) assertIsoDate(f.date);
  if (f.hours !== undefined) {
    const n = Number(f.hours);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ValidationError(
        `Invalid --hours "${f.hours}". Pass a positive decimal.`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
  }

  const session = await openSession(flags);

  const update: UpdateTimeEntryInput = {};
  let activityName: string | undefined;
  if (f.hours !== undefined) update.hours = Number(f.hours);
  if (f.activityId !== undefined) {
    update.activityId = f.activityId;
    const activities = await listActivities(session.client);
    activityName = activities.find(a => a.id === f.activityId)?.name;
  }
  if (f.activity !== undefined) {
    const activities = await listActivities(session.client);
    try {
      update.activityId = resolveActivityId(activities, f.activity);
      activityName = activities.find(a => a.id === update.activityId)?.name ?? f.activity;
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? err.message : String(err),
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
  }
  if (f.date !== undefined) update.spentOn = f.date;
  if (f.comments !== undefined) update.comments = f.comments;
  if (f.issue !== undefined) update.issueId = normaliseIssueId(f.issue);
  if (f.project !== undefined) update.projectId = f.project;

  if (Object.keys(update).length === 0) {
    throw new ValidationError(
      'Nothing to update.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass at least one field flag, e.g. `--hours 1.5` or `--comments "..."`.',
    );
  }

  if (flags.dryRun) {
    const payload: Record<string, unknown> = { time_entry: toTimeEntryUpdateBody(update) };
    const path = REDMINE_PATHS.TIME_ENTRY_BY_ID(id);
    const preview = dryRunPreview({
      method: 'PUT',
      path,
      payload,
      resolved: {
        entryId: id,
        ...(update.activityId !== undefined ? { activity: { id: update.activityId, name: activityName ?? null } } : {}),
        ...(update.issueId !== undefined ? { issueId: update.issueId } : {}),
      },
    });
    return {
      json: preview,
      pretty: ctx => writeLine(dim(ctx, `[dry-run] would PUT ${path} — ${Object.keys(update).length} field(s) on entry #${id}`)),
    };
  }

  const entry = await updateTimeEntry(session.client, id, update);

  return {
    json: entry,
    pretty: ctx => writeLine(success(ctx, `Updated time entry #${entry.id} — ${entry.hours}h on ${entry.spent_on}`)),
  };
};

function normaliseEntryId(input: string | number | undefined): number {
  if (input === undefined || input === null || input === '') {
    throw new ValidationError(
      'Time-entry id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr time edit <entry-id> ...`. Use `lwr time list` to find the id.',
    );
  }
  const n = Number(String(input).trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(
      `Invalid time-entry id: ${input}`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return n;
}

function normaliseIssueId(input: string | number): number {
  const s = String(input).trim().replace(/^#/, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(
      `Invalid --issue "${input}".`,
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

export function edit(flags: TimeEditFlags): Promise<never> {
  return runCommand('time.edit', flags, cmd);
}
