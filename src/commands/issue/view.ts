/**
 * `lwr issue view <id>`
 *
 * Fetch an issue with full detail (journals, attachments, watchers,
 * relations) and render it. Supports `#123` as well as `123`.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { getIssue } from '../../api/issues';
import { writeLine } from '../../foundation/output';
import { header, dim, statusBadge, priorityBadge, hyperlink } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';
import type { RedmineIssue } from '../../api/types';

export interface IssueViewFlags extends GlobalFlags {
  id?: string | number;
  /** When true, include journals/attachments. Default true. */
  detail?: boolean;
}

const cmd: CommandFn<RedmineIssue> = async (flags): Promise<CommandResult<RedmineIssue>> => {
  const flgs = flags as IssueViewFlags;
  if (flgs.id === undefined || flgs.id === null || flgs.id === '') {
    throw new ValidationError(
      'Issue id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr issue view <id>`.',
    );
  }
  const id = normaliseId(flgs.id);

  const session = await openSession(flags);
  const issue = await getIssue(session.client, id, { detail: flgs.detail !== false });

  return {
    json: issue,
    pretty: ctx => renderIssue(ctx, issue, session.baseUrl),
  };
};

function normaliseId(input: string | number): number {
  const s = String(input).trim().replace(/^#/, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(
      `Invalid issue id: ${input}`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Issue ids are positive integers, optionally prefixed with `#`.',
    );
  }
  return n;
}

function renderIssue(ctx: Parameters<typeof header>[0], i: RedmineIssue, baseUrl: string): void {
  // The `#<id>` token in the header is hyperlinked to its Redmine URL so
  // a ⌘/Ctrl-click jumps straight to the issue. The rest of the header
  // (subject, status, etc.) stays plain text — only the id is the link.
  const idToken = hyperlink(ctx, `${baseUrl}/issues/${i.id}`, `#${i.id}`);
  writeLine(header(ctx, `${idToken}  ${i.subject}`));
  writeLine(
    `  ${dim(ctx, 'project :')} ${i.project.name}    ${dim(ctx, 'tracker :')} ${i.tracker.name}`,
  );
  writeLine(
    `  ${dim(ctx, 'status  :')} ${statusBadge(ctx, i.status.name)}    ${dim(ctx, 'priority:')} ${priorityBadge(ctx, i.priority.name)}`,
  );
  writeLine(
    `  ${dim(ctx, 'assignee:')} ${i.assigned_to?.name ?? '-'}    ${dim(ctx, 'author  :')} ${i.author.name}`,
  );
  if (i.due_date) writeLine(`  ${dim(ctx, 'due     :')} ${i.due_date}`);
  if (i.estimated_hours !== undefined)
    writeLine(`  ${dim(ctx, 'est hrs :')} ${i.estimated_hours}    ${dim(ctx, 'spent :')} ${i.spent_hours ?? 0}`);
  writeLine(`  ${dim(ctx, 'created :')} ${i.created_on}    ${dim(ctx, 'updated :')} ${i.updated_on}`);

  if (i.description && i.description.trim().length > 0) {
    writeLine('');
    writeLine(header(ctx, 'Description'));
    writeLine(i.description.trim());
  }

  if (i.journals && i.journals.length > 0) {
    writeLine('');
    writeLine(header(ctx, `Journal (${i.journals.length})`));
    for (const j of i.journals) {
      const meta = `${j.user.name} · ${j.created_on}`;
      writeLine(`  ${dim(ctx, '·')} ${meta}`);
      if (j.notes && j.notes.trim().length > 0) {
        for (const line of j.notes.trim().split('\n')) writeLine(`    ${line}`);
      }
      if (j.details && j.details.length > 0) {
        for (const d of j.details) {
          writeLine(
            `    ${dim(ctx, `${d.property}.${d.name}:`)} ${d.old_value ?? '-'} → ${d.new_value ?? '-'}`,
          );
        }
      }
    }
  }

  if (i.attachments && i.attachments.length > 0) {
    writeLine('');
    writeLine(header(ctx, `Attachments (${i.attachments.length})`));
    for (const a of i.attachments) {
      writeLine(`  ${a.id}  ${a.filename}  ${dim(ctx, `(${a.filesize} bytes)`)}`);
    }
  }
}

export function view(flags: IssueViewFlags): Promise<never> {
  return runCommand('issue.view', flags, cmd);
}
