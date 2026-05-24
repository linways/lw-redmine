/**
 * `lwr issue note <id>`
 *
 * Add a note to an issue. Note text from --message, --message-file, or
 * (when interactive) a prompt. `--private` flags it as private.
 */

import fs from 'node:fs';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags, dryRunPreview, type DryRunPreview } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { addNote } from '../../api/issues';
import { syncActiveIssueFromPayload } from '../../workflow/active-issue';
import { resolveProfileName } from '../../foundation/profiles';
import { askInput } from '../../foundation/prompt';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES, REDMINE_PATHS } from '../../constants';
import type { RedmineIssue } from '../../api/types';

export interface IssueNoteFlags extends GlobalFlags {
  id?: string | number;
  message?: string;
  messageFile?: string;
  private?: boolean;
}

const cmd: CommandFn<RedmineIssue | DryRunPreview> = async (flags, ctx): Promise<CommandResult<RedmineIssue | DryRunPreview>> => {
  const flgs = flags as IssueNoteFlags;
  if (flgs.id === undefined || flgs.id === null || flgs.id === '') {
    throw new ValidationError(
      'Issue id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr issue note <id> --message "..."`.',
    );
  }
  const id = normaliseId(flgs.id);

  let body: string;
  if (flgs.message !== undefined) body = flgs.message;
  else if (flgs.messageFile !== undefined)
    body = flgs.messageFile === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(flgs.messageFile, 'utf8');
  else body = await askInput({ ctx, message: 'Note', flagHint: '--message or --message-file' });

  if (body.trim().length === 0) {
    throw new ValidationError(
      'Note body is empty.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }

  if (flags.dryRun) {
    const path = REDMINE_PATHS.ISSUE_BY_ID(id);
    const preview = dryRunPreview({
      method: 'PUT',
      path,
      payload: { issue: { notes: body, ...(flgs.private ? { private_notes: true } : {}) } },
      resolved: { issueId: id, noteLength: body.length, private: Boolean(flgs.private) },
    });
    return {
      json: preview,
      pretty: c => writeLine(dim(c, `[dry-run] would PUT ${path} — append note (${body.length} chars${flgs.private ? ', private' : ''})`)),
    };
  }

  const session = await openSession(flags);
  const issue = await addNote(session.client, id, body, { privateNotes: flgs.private });

  syncActiveIssueFromPayload(issue, resolveProfileName(flags.profile));

  return {
    json: issue,
    pretty: c => writeLine(success(c, `Added note to #${issue.id}`)),
  };
};

function normaliseId(input: string | number): number {
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

export function note(flags: IssueNoteFlags): Promise<never> {
  return runCommand('issue.note', flags, cmd);
}
