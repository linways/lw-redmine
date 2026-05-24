/**
 * `lwr project use <id-or-identifier>`
 *
 * Sets the profile's sticky `activeProject` — the implicit project for
 * commands that don't pass `--project`. Persists across sessions and
 * only changes when the user explicitly adopts a different one.
 *
 * Verifies the project exists (single GET) before persisting — fail fast
 * rather than silently storing a typo.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { getProject, resolveProjectRef } from '../../api/projects';
import { updateConfig } from '../../foundation/config';
import { resolveProfileName } from '../../foundation/profiles';
import { writeMeMarkdown } from '../../workflow/me';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';

export interface ProjectUseFlags extends GlobalFlags {
  project?: string;
}

interface Payload {
  profile: string;
  project: { id: number; identifier: string; name: string };
}

const cmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const f = flags as ProjectUseFlags;
  if (!f.project) {
    throw new ValidationError(
      'Project id or identifier is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr project use <id-or-identifier>`.',
    );
  }

  const session = await openSession(flags);
  // Resolve any of {id, identifier, human name} via the cached index,
  // then re-fetch by canonical id so we get full project metadata back.
  const ref = await resolveProjectRef(session.client, f.project);
  const project = await getProject(session.client, ref.id);

  const profileName = resolveProfileName(flags.profile);
  const activeProject = {
    id: project.id,
    identifier: project.identifier,
    name: project.name,
    setAt: new Date().toISOString(),
  };
  const updated = updateConfig(cfg => {
    const p = cfg.profiles[profileName];
    if (!p) return cfg;
    return { ...cfg, profiles: { ...cfg.profiles, [profileName]: { ...p, activeProject } } };
  });

  // Keep `me.md` in sync — agents read it as the source of truth for the
  // user's working context, so a stale rendering after a change would
  // route subsequent questions at the wrong project.
  const refreshed = updated.profiles[profileName];
  if (refreshed) {
    writeMeMarkdown(refreshed.me, refreshed.baseUrl, refreshed.activeProject, refreshed.activeIssue);
  }

  return {
    json: { profile: profileName, project: { id: project.id, identifier: project.identifier, name: project.name } },
    pretty: ctx => {
      writeLine(success(ctx, `Active project for "${profileName}" is now "${project.identifier}"`));
      writeLine(`  ${dim(ctx, project.name)}`);
    },
  };
};

export function useProject(flags: ProjectUseFlags): Promise<never> {
  return runCommand('project.use', flags, cmd);
}
