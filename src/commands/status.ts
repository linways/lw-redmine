/**
 * `lwr status list`
 *
 * Dumps every issue status in the Redmine instance with id, name, and
 * is_closed. This is the (statusId ↔ statusName) dictionary agents need
 * to translate between human names and Redmine ids; one HTTP call, never
 * stale, no on-disk cache needed.
 *
 * NOTE: This is the *full* set the instance defines. The subset
 * actually allowed for a specific issue right now lives at
 * `lwr issue transitions <id>` and is workflow-aware.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { openSession } from '../foundation/session';
import { listStatuses, type RedmineIssueStatus } from '../api/statuses';
import { writeLine } from '../foundation/output';
import { renderTable, dim } from '../foundation/format';

interface Row {
  id: number;
  name: string;
  isClosed: boolean;
}
interface Payload {
  total: number;
  statuses: Row[];
}

const listCmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const session = await openSession(flags);
  const statuses = await listStatuses(session.client);
  const rows = statuses.map(toRow);

  return {
    json: { total: rows.length, statuses: rows },
    pretty: ctx => {
      if (rows.length === 0) {
        writeLine(dim(ctx, '(no statuses)'));
        return;
      }
      writeLine(
        renderTable(ctx, {
          head: ['ID', 'Name', 'Closed?'],
          rows: rows.map(r => [r.id, r.name, r.isClosed ? 'yes' : 'no']),
          colWidths: [8, 36, 10],
        }),
      );
      writeLine(dim(ctx, `${rows.length} status(es)`));
    },
  };
};

function toRow(s: RedmineIssueStatus): Row {
  return { id: s.id, name: s.name, isClosed: Boolean(s.is_closed) };
}

export function statusList(flags: GlobalFlags): Promise<never> {
  return runCommand('status.list', flags, listCmd);
}
