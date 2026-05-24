/**
 * `lwr time list`
 *
 * Read path for time entries. Filters mirror Redmine's `/time_entries.json`:
 *   --issue, --user, --project, --activity (name or id),
 *   --from, --to (YYYY-MM-DD), --sort, --limit/--offset/--all.
 *
 * Common agent uses:
 *   "what did I log last week?"  → --user me --from --to
 *   "everyone's time on issue X"  → --issue X
 *   "my Testing time this month"  → --user me --activity Testing --from --to
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { listTimeEntries } from '../../api/time-entries';
import { listActivities, resolveActivityId } from '../../api/activities';
import { writeLine } from '../../foundation/output';
import { renderTable, dim, header } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';
import type { RedmineTimeEntry } from '../../api/types';

export interface TimeListFlags extends GlobalFlags {
  issue?: string | number;
  user?: string;
  project?: string | number;
  activity?: string;
  activityId?: number;
  from?: string;
  to?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
}

interface TimeRow {
  id: number;
  spent_on: string;
  hours: number;
  user: string;
  activity: string;
  issue: number | null;
  project: string;
  comments: string | null;
}

interface ListPayload {
  total: number;
  entries: TimeRow[];
  query: { from?: string; to?: string; user?: string | number; issue?: number; project?: string | number; activityId?: number };
}

const cmd: CommandFn<ListPayload> = async (flags): Promise<CommandResult<ListPayload>> => {
  const f = flags as TimeListFlags;
  if (f.from !== undefined) assertIsoDate('from', f.from);
  if (f.to !== undefined) assertIsoDate('to', f.to);
  if (f.activity !== undefined && f.activityId !== undefined) {
    throw new ValidationError(
      'Pass either --activity (name) or --activity-id (number), not both.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }

  const session = await openSession(flags);

  let activityId: number | undefined = f.activityId;
  if (activityId === undefined && f.activity !== undefined) {
    const activities = await listActivities(session.client);
    try {
      activityId = resolveActivityId(activities, f.activity);
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? err.message : String(err),
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
  }

  const issueIdNum = f.issue === undefined ? undefined : normaliseIssueId(f.issue);
  const userId: number | 'me' | undefined =
    f.user === undefined ? undefined : f.user === 'me' ? 'me' : Number(f.user);
  if (userId !== undefined && userId !== 'me' && (!Number.isFinite(userId) || userId <= 0)) {
    throw new ValidationError(
      `Invalid --user "${f.user}" — pass "me" or a numeric user id.`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }

  const result = await listTimeEntries(session.client, {
    issueId: issueIdNum,
    projectId: f.project,
    userId,
    activityId,
    spentOnFrom: f.from,
    spentOnTo: f.to,
    sort: f.sort ?? 'spent_on:desc',
    limit: f.limit,
    offset: f.offset,
    all: f.all,
  });

  const rows: TimeRow[] = result.entries.map(toRow);
  const payload: ListPayload = {
    total: result.total,
    entries: rows,
    query: {
      from: f.from,
      to: f.to,
      user: userId,
      issue: issueIdNum,
      project: f.project,
      activityId,
    },
  };

  return {
    json: payload,
    pretty: c => {
      if (rows.length === 0) {
        writeLine(dim(c, 'No time entries match.'));
        return;
      }
      writeLine(
        renderTable(c, {
          head: ['ID', 'Date', 'Hours', 'User', 'Activity', 'Issue', 'Project', 'Comments'],
          rows: rows.map(r => [
            r.id,
            r.spent_on,
            r.hours,
            r.user,
            r.activity,
            r.issue ?? '—',
            r.project,
            r.comments ?? '',
          ]),
          colWidths: [8, 12, 7, 18, 14, 8, 26, 32],
        }),
      );
      const totalHours = rows.reduce((acc, r) => acc + r.hours, 0);
      writeLine('');
      writeLine(header(c, `${rows.length}/${result.total} entries — ${totalHours.toFixed(2)}h`));
    },
  };
};

function toRow(e: RedmineTimeEntry): TimeRow {
  return {
    id: e.id,
    spent_on: e.spent_on,
    hours: e.hours,
    user: e.user.name,
    activity: e.activity.name,
    issue: e.issue?.id ?? null,
    project: e.project.name,
    comments: e.comments && e.comments.length > 0 ? e.comments : null,
  };
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

function assertIsoDate(name: string, s: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new ValidationError(
      `Invalid --${name} "${s}". Expected YYYY-MM-DD.`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
}

export function list(flags: TimeListFlags): Promise<never> {
  return runCommand('time.list', flags, cmd);
}
