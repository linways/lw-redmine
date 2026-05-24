/**
 * `lwr project list`
 *
 * Lists projects available to the active user. Pretty mode renders a
 * table; JSON mode returns the raw rows so agents can post-process.
 */

import { DEFAULT_PAGE_SIZE } from '../../constants';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { listProjects } from '../../api/projects';
import { writeLine } from '../../foundation/output';
import { renderTable, dim } from '../../foundation/format';
import type { RedmineProject } from '../../api/types';

export interface ProjectListFlags extends GlobalFlags {
  limit?: number;
  offset?: number;
  all?: boolean;
}

interface ProjectListPayload {
  total: number;
  projects: {
    id: number;
    identifier: string;
    name: string;
    description: string | null;
    isPublic: boolean | null;
  }[];
}

const cmd: CommandFn<ProjectListPayload> = async (flags): Promise<CommandResult<ProjectListPayload>> => {
  const flgs = flags as ProjectListFlags;
  const session = await openSession(flags);
  const { projects, total } = await listProjects(session.client, {
    limit: flgs.limit ?? DEFAULT_PAGE_SIZE,
    offset: flgs.offset,
    all: flgs.all,
  });

  const rows = projects.map(toRow);

  return {
    json: { total, projects: rows },
    pretty: ctx => {
      if (rows.length === 0) {
        writeLine(dim(ctx, '(no projects)'));
        return;
      }
      writeLine(
        renderTable(ctx, {
          head: ['ID', 'Identifier', 'Name'],
          rows: rows.map(p => [p.id, p.identifier, p.name]),
          colWidths: [8, 24, 50],
        }),
      );
      writeLine(dim(ctx, `${rows.length} of ${total} project(s)`));
    },
  };
};

function toRow(p: RedmineProject): ProjectListPayload['projects'][number] {
  return {
    id: p.id,
    identifier: p.identifier,
    name: p.name,
    description: p.description ?? null,
    isPublic: p.is_public ?? null,
  };
}

export function list(flags: ProjectListFlags): Promise<never> {
  return runCommand('project.list', flags, cmd);
}
