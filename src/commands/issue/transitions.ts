/**
 * `lwr issue transitions <id>`
 *
 * Returns the statuses the *current user* is allowed to transition this
 * issue to right now. Authoritative answer: Redmine computes it from
 * (tracker × current status × role × workflow), which we can't fully
 * replicate locally.
 *
 * Agents should call this before mutating with `lwr issue status` /
 * `lwr issue edit --status` to know what's valid. The same allowed list
 * is also surfaced in the `WORKFLOW_NOT_ALLOWED` error envelope when a
 * forbidden transition is attempted.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { getIssue } from '../../api/issues';
import { writeLine } from '../../foundation/output';
import { renderTable, dim, header } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';
import type { IssueAllowedStatus } from '../../api/types';

export interface IssueTransitionsFlags extends GlobalFlags {
  id?: string | number;
}

interface Payload {
  issueId: number;
  currentStatus: { id: number; name: string };
  allowed: { id: number; name: string; isClosed: boolean }[];
}

const cmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const f = flags as IssueTransitionsFlags;
  const id = normaliseId(f.id);

  const session = await openSession(flags);
  const issue = await getIssue(session.client, id, { allowedStatuses: true });

  const allowed = (issue.allowed_statuses ?? []).map(toRow);

  return {
    json: {
      issueId: issue.id,
      currentStatus: { id: issue.status.id, name: issue.status.name },
      allowed,
    },
    pretty: ctx => {
      writeLine(header(ctx, `#${issue.id} — ${issue.subject}`));
      writeLine(dim(ctx, `currently: ${issue.status.name}`));
      writeLine('');
      if (allowed.length === 0) {
        writeLine(dim(ctx, '(no transitions allowed for the current user)'));
        return;
      }
      writeLine(
        renderTable(ctx, {
          head: ['ID', 'Allowed status', 'Closed?'],
          rows: allowed.map(a => [a.id, a.name, a.isClosed ? 'yes' : 'no']),
          colWidths: [8, 36, 10],
        }),
      );
      writeLine(dim(ctx, `${allowed.length} transition(s)`));
    },
  };
};

function toRow(s: IssueAllowedStatus): { id: number; name: string; isClosed: boolean } {
  return { id: s.id, name: s.name, isClosed: Boolean(s.is_closed) };
}

function normaliseId(input: string | number | undefined): number {
  if (input === undefined || input === null || input === '') {
    throw new ValidationError('Issue id is required.', ERROR_CODES.VALIDATION_MISSING_FLAG);
  }
  const s = String(input).trim().replace(/^#/, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`Invalid issue id: ${input}`, ERROR_CODES.VALIDATION_BAD_VALUE);
  }
  return n;
}

export function transitions(flags: IssueTransitionsFlags): Promise<never> {
  return runCommand('issue.transitions', flags, cmd);
}
