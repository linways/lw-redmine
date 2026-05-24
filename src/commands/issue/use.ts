/**
 * `lwr issue use <id>`
 *
 * Sets the profile's sticky `activeIssue` — the implicit issue for
 * commands that don't pass `--issue`. Mirrors `lwr project use`.
 *
 * Pointer-only verb: no Redmine status changes, no mutex enforcement.
 * The dev-active mutex fires later, on the next status PUT that lands
 * an issue in `DEV_ACTIVE_STATUS_NAMES` (see `workflow/auto-pause.ts`).
 * `issue.use` is the intent declaration; `issue.status` /
 * `issue.edit --status` is the work commitment.
 *
 * Side effects:
 *   1. The new issue's metadata is fetched (fail-fast on a bad id) and
 *      persisted to profile config.
 *   2. If the new issue lives in a DIFFERENT project than the current
 *      `activeProject` (or `activeProject` is unset), the active
 *      project is auto-updated to match. The two pointers always stay
 *      in sync — an "active issue" implies "active project = the
 *      issue's project". Unscoped queries (`lwr issue list --as
 *      developer`) then default to where the user is actually working.
 *   3. `me.md` is rewritten so any agent reading it sees the new
 *      working context.
 *
 * Calling `use` on the SAME issue that's already active is a no-op
 * (returns the active issue unchanged).
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { getIssue } from '../../api/issues';
import { saveConfig, loadConfig, type ActiveIssue, type ActiveProject } from '../../foundation/config';
import { resolveProfileName } from '../../foundation/profiles';
import { writeMeMarkdown } from '../../workflow/me';
import { readProjectsIndex } from '../../foundation/cache';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';
import { logger } from '../../foundation/logger';

export interface IssueUseFlags extends GlobalFlags {
  issue?: string;
}

interface Payload {
  profile: string;
  activeIssue: ActiveIssue;
  /**
   * Set when `activeProject` was also auto-updated because the new
   * issue belongs to a different project than the prior active.
   * Carries both the previous and new values so the agent can surface
   * a "switched project too" hint to the user.
   */
  projectSwitched: {
    previous: { id: number; name: string } | null;
    current: ActiveProject;
  } | null;
}

const cmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const f = flags as IssueUseFlags;
  if (!f.issue) {
    throw new ValidationError(
      'Issue id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr issue use <id>`.',
    );
  }
  const newId = Number(String(f.issue).replace(/^#/, ''));
  if (!Number.isFinite(newId) || newId <= 0) {
    throw new ValidationError(
      `Invalid issue id "${f.issue}".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Pass a numeric Redmine issue id, e.g. `lwr issue use 121204`.',
    );
  }

  const session = await openSession(flags);
  const profileName = resolveProfileName(flags.profile);

  // No-op short-circuit: same issue already active.
  const cfgBefore = loadConfig();
  const profileBefore = cfgBefore.profiles[profileName];
  if (profileBefore?.activeIssue?.id === newId) {
    return {
      json: {
        profile: profileName,
        activeIssue: profileBefore.activeIssue,
        projectSwitched: null,
      },
      pretty: ctx => {
        writeLine(success(ctx, `#${newId} is already the active issue.`));
        writeLine(`  ${dim(ctx, profileBefore.activeIssue!.subject)}`);
      },
    };
  }

  // Fail fast on a bad id before touching anything.
  const newIssue = await getIssue(session.client, newId);

  const activeIssue: ActiveIssue = {
    id: newIssue.id,
    subject: newIssue.subject,
    project: { id: newIssue.project.id, name: newIssue.project.name },
    tracker: newIssue.tracker.name,
    status: newIssue.status.name,
    setAt: new Date().toISOString(),
  };

  // Auto-sync activeProject if the new issue is in a different project.
  // Look up the identifier from the cached projects index — if the
  // project isn't in the cache (rare, e.g. created after last index
  // refresh), skip the project update with a debug log. The issue
  // pointer still updates; the user can `lwr cache refresh --type
  // projects` then `lwr project use <name>` to recover.
  const prevActiveProject = profileBefore?.activeProject;
  const needsProjectSync = !prevActiveProject || prevActiveProject.id !== newIssue.project.id;
  let nextActiveProject = prevActiveProject;
  let projectSwitched: Payload['projectSwitched'] = null;
  if (needsProjectSync) {
    const idx = readProjectsIndex();
    const entry = idx?.data.projects.find(p => p.id === newIssue.project.id);
    if (entry) {
      const ap: ActiveProject = {
        id: entry.id,
        identifier: entry.identifier,
        name: entry.name,
        setAt: new Date().toISOString(),
      };
      nextActiveProject = ap;
      projectSwitched = {
        previous: prevActiveProject ? { id: prevActiveProject.id, name: prevActiveProject.name } : null,
        current: ap,
      };
    } else {
      logger.debug(`issue.use: project ${newIssue.project.id} ("${newIssue.project.name}") not in cached index — skipping activeProject sync`);
    }
  }

  const cfgAfter = {
    ...cfgBefore,
    profiles: {
      ...cfgBefore.profiles,
      [profileName]: {
        ...cfgBefore.profiles[profileName]!,
        activeIssue,
        ...(nextActiveProject ? { activeProject: nextActiveProject } : {}),
      },
    },
  };
  saveConfig(cfgAfter);

  const refreshed = cfgAfter.profiles[profileName]!;
  writeMeMarkdown(refreshed.me, refreshed.baseUrl, refreshed.activeProject, refreshed.activeIssue);

  return {
    json: { profile: profileName, activeIssue, projectSwitched },
    pretty: ctx => {
      writeLine(
        success(
          ctx,
          `Active issue for "${profileName}" is now #${newIssue.id} — ${newIssue.subject}`,
        ),
      );
      writeLine(`  ${dim(ctx, `${newIssue.tracker.name} · ${newIssue.project.name} · ${newIssue.status.name}`)}`);
      if (projectSwitched) {
        const from = projectSwitched.previous
          ? `${projectSwitched.previous.name}`
          : '<none>';
        writeLine(`  ${dim(ctx, `↪ active project: ${from} → ${projectSwitched.current.name}`)}`);
      }
    },
  };
};

export function useIssue(flags: IssueUseFlags): Promise<never> {
  return runCommand('issue.use', flags, cmd);
}
