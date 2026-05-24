/**
 * `lwr project versions <id-or-identifier>`
 *
 * Lists project versions (a.k.a. milestones / target releases). Pretty
 * mode renders a status-coloured table; JSON returns the full row.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { listVersions, resolveProjectRef } from '../../api/projects';
import { writeLine } from '../../foundation/output';
import { renderTable, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';
import type { RedmineVersion } from '../../api/types';

export interface ProjectVersionsFlags extends GlobalFlags {
  project?: string;
}

interface Row {
  id: number;
  name: string;
  status: string;
  dueDate: string | null;
  description: string;
}
interface Payload {
  total: number;
  versions: Row[];
}

const cmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const f = flags as ProjectVersionsFlags;
  if (!f.project) {
    throw new ValidationError(
      'Project id or identifier is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr project versions <id-or-identifier>`.',
    );
  }

  const session = await openSession(flags);
  const ref = await resolveProjectRef(session.client, f.project);
  const { versions, total } = await listVersions(session.client, ref.id);
  const rows = versions.map(toRow);

  return {
    json: { total, versions: rows },
    pretty: ctx => {
      if (rows.length === 0) {
        writeLine(dim(ctx, '(no versions)'));
        return;
      }
      writeLine(
        renderTable(ctx, {
          head: ['ID', 'Name', 'Status', 'Due'],
          rows: rows.map(r => [r.id, r.name, r.status, r.dueDate ?? '-']),
          colWidths: [8, 30, 12, 14],
        }),
      );
      writeLine(dim(ctx, `${rows.length} version(s)`));
    },
  };
};

function toRow(v: RedmineVersion): Row {
  return {
    id: v.id,
    name: v.name,
    status: v.status,
    dueDate: v.due_date ?? null,
    description: v.description ?? '',
  };
}

export function versions(flags: ProjectVersionsFlags): Promise<never> {
  return runCommand('project.versions', flags, cmd);
}
