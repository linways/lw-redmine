/**
 * `lwr issue active`
 *
 * Live answer to "what is the user actually working on right now?" — read
 * from Redmine status (the source of truth), not from local profile config.
 *
 * Returns the issue(s) currently sitting in any `DEV_ACTIVE_STATUS_NAMES`
 * status with dev-cf=me. By Linways policy this set is mutually exclusive
 * (one issue at a time) — if the query returns more than one, the
 * invariant has been violated (the dev forgot to pause something) and
 * `invariantViolated: true` is surfaced for the agent to ask the user.
 *
 * The set is small today (just "Development in Progress" — "Dev Analysis
 * required" is a *queue* state, not active work). We fan out one query
 * per status name and union by id so the code trivially extends when
 * "Dev Analysis in Progress" or similar gets added to the workflow.
 * Redmine's `status_id` filter is single-valued; the union pattern is
 * the workaround.
 *
 * This command is the live alternative to `lwr issue current`, which
 * reads from local profile config. Eventually one of them goes; for now
 * both coexist while we trust-but-verify the mutex enforcement.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { activeProfile } from '../../foundation/profiles';
import { listIssues } from '../../api/issues';
import { listStatuses, resolveStatusId } from '../../api/statuses';
import { writeLine } from '../../foundation/output';
import { renderTable, dim, header, statusBadge, warn, hyperlink } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { DEV_ACTIVE_STATUS_NAMES, ERROR_CODES } from '../../constants';
import type { RedmineIssue } from '../../api/types';

interface ActiveIssueRow {
  id: number;
  url: string;
  subject: string;
  project: string;
  tracker: string;
  status: string;
  priority: string;
  assignee: string | null;
  college: string | null;
  estimated: number | null;
  spent: number | null;
  updated: string;
}

interface Payload {
  /** Single most-recently-updated row, or null when no issue is active. */
  active: ActiveIssueRow | null;
  /** Every row that matched the mutex query (0, 1, or N rows). */
  issues: ActiveIssueRow[];
  /** True iff `issues.length > 1` — Linways "one active issue" rule broken. */
  invariantViolated: boolean;
  /** The configured status names this query unions over. */
  mutexStatuses: string[];
}

const cmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const { profile } = activeProfile(flags.profile);
  const me = profile.me;
  const devCf = me.fieldMap.developer;
  if (!devCf) {
    throw new ValidationError(
      'Profile has no Developer custom-field binding.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Run `lwr me detect --role developer` to bind it, or `lwr me set field-map developer <cfId> "<name>"` to set it manually.',
    );
  }

  const session = await openSession(flags);
  const statuses = await listStatuses(session.client);

  // Resolve each mutex status name to its id upfront. Failing here means
  // the configured workflow constant is wrong for this Redmine instance.
  const mutexIds = DEV_ACTIVE_STATUS_NAMES.map(name => {
    try {
      return resolveStatusId(statuses, name);
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? err.message : String(err),
        ERROR_CODES.VALIDATION_BAD_VALUE,
        `Edit \`src/constants/workflow.ts\` if your instance uses a different name for "${name}".`,
      );
    }
  });

  // Fan out one query per status id (Redmine's status_id filter is single-valued).
  const pages = await Promise.all(
    mutexIds.map(statusId =>
      listIssues(session.client, {
        statusId,
        customFieldFilters: { [devCf.cfId]: me.user.id },
        include: ['custom_fields'],
        sort: 'updated_on:desc',
      }),
    ),
  );

  // Union by id, keeping the first occurrence (which preserves the
  // updated_on:desc ordering from whichever query returned it first).
  const seen = new Map<number, RedmineIssue>();
  for (const page of pages) {
    for (const i of page.issues) {
      if (!seen.has(i.id)) seen.set(i.id, i);
    }
  }
  const merged = Array.from(seen.values()).sort(
    (a, b) => (a.updated_on > b.updated_on ? -1 : 1),
  );

  const rows = merged.map(i => toRow(i, session.baseUrl));
  const payload: Payload = {
    active: rows[0] ?? null,
    issues: rows,
    invariantViolated: rows.length > 1,
    mutexStatuses: [...DEV_ACTIVE_STATUS_NAMES],
  };

  return {
    json: payload,
    pretty: ctx => {
      if (rows.length === 0) {
        writeLine(dim(ctx, 'No active issue.'));
        writeLine(dim(ctx, `  (no issue sits in any of: ${DEV_ACTIVE_STATUS_NAMES.join(', ')})`));
        return;
      }
      if (rows.length > 1) {
        writeLine(warn(ctx, `${rows.length} active issues — Linways policy is one at a time. Pause all but one.`));
        writeLine('');
      }
      const issueUrl = (id: number) => `${session.baseUrl}/issues/${id}`;
      writeLine(
        renderTable(ctx, {
          head: ['#ID', 'College', 'Subject', 'Status', 'Estimated', 'Spent'],
          rows: rows.map(r => [
            hyperlink(ctx, issueUrl(r.id), String(r.id)),
            r.college ?? '-',
            r.subject,
            statusBadge(ctx, r.status),
            r.estimated !== null ? `${r.estimated}h` : '-',
            r.spent !== null ? `${r.spent}h` : '-',
          ]),
          colWidths: [8, 14, 50, 26, 11, 9],
        }),
      );
      if (rows.length === 1) {
        writeLine('');
        writeLine(dim(ctx, `  ${header(ctx, 'assignee:')} ${rows[0]!.assignee ?? '-'}  ·  tracker: ${rows[0]!.tracker}  ·  updated: ${rows[0]!.updated}`));
      }
    },
  };
};

function toRow(i: RedmineIssue, baseUrl: string): ActiveIssueRow {
  return {
    id: i.id,
    url: `${baseUrl}/issues/${i.id}`,
    subject: i.subject,
    project: i.project.name,
    tracker: i.tracker.name,
    status: i.status.name,
    priority: i.priority.name,
    assignee: i.assigned_to?.name ?? null,
    college: extractCollege(i.custom_fields),
    estimated: typeof i.estimated_hours === 'number' ? i.estimated_hours : null,
    spent: typeof i.spent_hours === 'number' ? i.spent_hours : null,
    updated: i.updated_on,
  };
}

function extractCollege(cfs: RedmineIssue['custom_fields']): string | null {
  if (!cfs || cfs.length === 0) return null;
  const cf = cfs.find(c => c.name.toLowerCase() === 'college');
  if (!cf || cf.value == null) return null;
  if (Array.isArray(cf.value)) {
    const filtered = cf.value.filter(v => typeof v === 'string' && v.trim().length > 0);
    return filtered.length > 0 ? filtered.join(', ') : null;
  }
  const s = String(cf.value).trim();
  return s.length > 0 ? s : null;
}

export function activeIssue(flags: GlobalFlags): Promise<never> {
  return runCommand('issue.active', flags, cmd);
}
