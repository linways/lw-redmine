/**
 * `lwr time activities`
 *
 * List the time-entry activities the Redmine instance defines (cache-first).
 * Agents call this once to learn the catalog of `--activity <name>` values
 * accepted by `lwr time log` / `lwr time edit`.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { listActivities } from '../../api/activities';
import { writeLine } from '../../foundation/output';
import { renderTable, dim } from '../../foundation/format';
import type { RedmineActivity } from '../../api/types';

export interface TimeActivitiesFlags extends GlobalFlags {
  noCache?: boolean;
}

interface ActivitiesPayload {
  activities: { id: number; name: string; is_default: boolean; active: boolean }[];
}

const cmd: CommandFn<ActivitiesPayload> = async (flags): Promise<CommandResult<ActivitiesPayload>> => {
  const f = flags as TimeActivitiesFlags;
  const session = await openSession(flags);
  const list: RedmineActivity[] = await listActivities(session.client, { noCache: f.noCache });

  const payload: ActivitiesPayload = {
    activities: list.map(a => ({
      id: a.id,
      name: a.name,
      is_default: Boolean(a.is_default),
      active: a.active === undefined ? true : Boolean(a.active),
    })),
  };

  return {
    json: payload,
    pretty: ctx => {
      if (payload.activities.length === 0) {
        writeLine(dim(ctx, 'No time-entry activities defined.'));
        return;
      }
      writeLine(
        renderTable(ctx, {
          head: ['ID', 'Name', 'Default', 'Active'],
          rows: payload.activities.map(a => [a.id, a.name, a.is_default ? 'yes' : '', a.active ? 'yes' : 'no']),
          colWidths: [6, 26, 9, 8],
        }),
      );
    },
  };
};

export function activities(flags: TimeActivitiesFlags): Promise<never> {
  return runCommand('time.activities', flags, cmd);
}
