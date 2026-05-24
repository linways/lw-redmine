/**
 * `lwr time delete <entry-id>`
 *
 * Hard-delete a time entry. Cannot be undone — Redmine has no undelete
 * for time entries — so we gate behind the same double-confirm pattern
 * used by `auth logout` / `clear-data` / `uninstall`:
 *   - TTY: type "delete-time-entry", then YES.
 *   - Non-TTY: pass `--confirm "delete-time-entry" --yes`.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags, dryRunPreview, type DryRunPreview } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { deleteTimeEntry, getTimeEntry } from '../../api/time-entries';
import { confirmDestructive, type DoubleConfirmFlags } from '../../foundation/confirm';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES, REDMINE_PATHS } from '../../constants';

export interface TimeDeleteFlags extends GlobalFlags, DoubleConfirmFlags {
  id?: string | number;
}

interface DeletePayload {
  id: number;
  hours: number;
  spent_on: string;
  issueId: number | null;
  projectName: string;
}

const cmd: CommandFn<DeletePayload | DryRunPreview> = async (flags, ctx): Promise<CommandResult<DeletePayload | DryRunPreview>> => {
  const f = flags as TimeDeleteFlags;
  const id = normaliseEntryId(f.id);

  const session = await openSession(flags);
  // Pre-fetch so the confirmation prompt names what's about to disappear.
  // 404 here surfaces as a normal NotFoundError from the http layer.
  const entry = await getTimeEntry(session.client, id);

  // --dry-run runs *before* confirmDestructive — agents/humans get a
  // chance to inspect what would be deleted without committing to the
  // double-confirm dance.
  if (flags.dryRun) {
    const path = REDMINE_PATHS.TIME_ENTRY_BY_ID(id);
    const preview = dryRunPreview({
      method: 'DELETE',
      path,
      payload: null,
      resolved: {
        entryId: entry.id,
        hours: entry.hours,
        spent_on: entry.spent_on,
        issueId: entry.issue?.id ?? null,
        projectName: entry.project.name,
      },
    });
    return {
      json: preview,
      pretty: c => writeLine(dim(c, `[dry-run] would DELETE ${path} — ${entry.hours}h on ${entry.spent_on}${entry.issue ? `, issue #${entry.issue.id}` : ''}`)),
    };
  }

  await confirmDestructive({
    action: 'delete-time-entry',
    description: `delete time entry #${entry.id} (${entry.hours}h on ${entry.spent_on}${entry.issue ? `, issue #${entry.issue.id}` : ''})`,
    ctx,
    flags: f,
  });

  await deleteTimeEntry(session.client, id);

  const payload: DeletePayload = {
    id: entry.id,
    hours: entry.hours,
    spent_on: entry.spent_on,
    issueId: entry.issue?.id ?? null,
    projectName: entry.project.name,
  };

  return {
    json: payload,
    pretty: c =>
      writeLine(
        success(
          c,
          `Deleted time entry #${entry.id} (${entry.hours}h on ${entry.spent_on}).`,
        ),
      ),
  };
};

function normaliseEntryId(input: string | number | undefined): number {
  if (input === undefined || input === null || input === '') {
    throw new ValidationError(
      'Time-entry id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr time delete <entry-id>`. Use `lwr time list` to find the id.',
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

export function del(flags: TimeDeleteFlags): Promise<never> {
  return runCommand('time.delete', flags, cmd);
}
