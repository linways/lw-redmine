/**
 * `lwr project members <id-or-identifier>`
 *
 * Lists project memberships (users + groups, with their roles). Pretty
 * mode renders a table; JSON mode returns full structured rows.
 */

import { DEFAULT_PAGE_SIZE } from '../../constants';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { listMemberships, resolveProjectRef } from '../../api/projects';
import { writeLine } from '../../foundation/output';
import { renderTable, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';
import type { RedmineMembership } from '../../api/types';

export interface ProjectMembersFlags extends GlobalFlags {
  project?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
}

interface Row {
  id: number;
  kind: 'user' | 'group';
  memberId: number;
  memberName: string;
  roles: string[];
}
interface Payload {
  total: number;
  memberships: Row[];
}

const cmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const f = flags as ProjectMembersFlags;
  if (!f.project) {
    throw new ValidationError(
      'Project id or identifier is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr project members <id-or-identifier>`.',
    );
  }

  const session = await openSession(flags);
  const ref = await resolveProjectRef(session.client, f.project);
  const { memberships, total } = await listMemberships(session.client, ref.id, {
    limit: f.limit ?? DEFAULT_PAGE_SIZE,
    offset: f.offset,
    all: f.all,
  });

  const rows = memberships.map(toRow);

  return {
    json: { total, memberships: rows },
    pretty: ctx => {
      if (rows.length === 0) {
        writeLine(dim(ctx, '(no members)'));
        return;
      }
      writeLine(
        renderTable(ctx, {
          head: ['ID', 'Kind', 'Member', 'Roles'],
          rows: rows.map(r => [r.memberId, r.kind, r.memberName, r.roles.join(', ')]),
          colWidths: [8, 8, 30, 40],
        }),
      );
      writeLine(dim(ctx, `${rows.length} of ${total} member(s)`));
    },
  };
};

function toRow(m: RedmineMembership): Row {
  if (m.user) {
    return { id: m.id, kind: 'user', memberId: m.user.id, memberName: m.user.name, roles: m.roles.map(r => r.name) };
  }
  if (m.group) {
    return { id: m.id, kind: 'group', memberId: m.group.id, memberName: m.group.name, roles: m.roles.map(r => r.name) };
  }
  return { id: m.id, kind: 'user', memberId: 0, memberName: '(unknown)', roles: m.roles.map(r => r.name) };
}

export function members(flags: ProjectMembersFlags): Promise<never> {
  return runCommand('project.members', flags, cmd);
}
