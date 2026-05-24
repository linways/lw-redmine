/**
 * `lwr project resolve <name-or-id-or-identifier>`
 *
 * Debugging helper for the project resolver. Confirms how an agent's
 * `--project` argument will be interpreted (and which match path won —
 * exact name, substring, identifier, numeric) without performing a real
 * mutation.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { resolveProjectRef, type ResolvedProject } from '../../api/projects';
import { writeLine } from '../../foundation/output';
import { header, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';

export interface ProjectResolveFlags extends GlobalFlags {
  query?: string;
  noCache?: boolean;
}

const cmd: CommandFn<ResolvedProject> = async (flags): Promise<CommandResult<ResolvedProject>> => {
  const f = flags as ProjectResolveFlags;
  if (!f.query) {
    throw new ValidationError(
      'Query is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr project resolve <name-or-id-or-identifier>`.',
    );
  }
  const session = await openSession(flags);
  const resolved = await resolveProjectRef(session.client, f.query, { noCache: f.noCache });
  return {
    json: resolved,
    pretty: ctx => {
      writeLine(header(ctx, `${resolved.name}`));
      writeLine(`id:         ${resolved.id}`);
      writeLine(`identifier: ${resolved.identifier}`);
      writeLine(dim(ctx, `match:      ${resolved.source}`));
    },
  };
};

export function resolve(flags: ProjectResolveFlags): Promise<never> {
  return runCommand('project.resolve', flags, cmd);
}
