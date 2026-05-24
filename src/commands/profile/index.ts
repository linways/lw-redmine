/**
 * `lwr profile {add|use|list|remove}`
 *
 * Profiles wrap a Redmine instance + per-instance defaults. Each profile
 * has its own API key (managed by `auth login`) so users can switch
 * between Redmine instances or accounts without re-logging-in.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import {
  useProfile,
  listProfiles,
  removeProfile,
} from '../../foundation/profiles';
import { writeLine } from '../../foundation/output';
import { success, header, dim, renderTable } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';

// --- list -----------------------------------------------------------------

const listCmd: CommandFn<{ profiles: { name: string; baseUrl: string; active: boolean }[] }> = async () => {
  const profiles = listProfiles().map(({ name, profile, active }) => ({
    name,
    baseUrl: profile.baseUrl,
    active,
  }));
  return {
    json: { profiles },
    pretty: ctx => {
      if (profiles.length === 0) {
        writeLine(dim(ctx, '(no profiles configured — run `lwr auth login` to create one)'));
        return;
      }
      writeLine(
        renderTable(ctx, {
          head: ['', 'Name', 'Base URL'],
          rows: profiles.map(p => [p.active ? '*' : ' ', p.name, p.baseUrl]),
          colWidths: [3, 20, 60],
        }),
      );
    },
  };
};

export function list(flags: GlobalFlags): Promise<never> {
  return runCommand('profile.list', flags, listCmd);
}

// `profile add` was removed. New profiles are created in one step by
// `lwr auth login --profile <name> --base-url <url>` — that command runs
// the auth + profile-build pipeline atomically, so a profile never lands
// on disk in a half-initialised state.

// --- use ------------------------------------------------------------------

export interface UseFlags extends GlobalFlags {
  name?: string;
}

export function use(flags: UseFlags): Promise<never> {
  const cmd: CommandFn<{ activeProfile: string }> = async (): Promise<CommandResult<{ activeProfile: string }>> => {
    if (!flags.name) {
      throw new ValidationError(
        'Profile name is required.',
        ERROR_CODES.VALIDATION_MISSING_FLAG,
        'Pass it as `lwr profile use <name>`.',
      );
    }
    const next = useProfile(flags.name);
    return {
      json: { activeProfile: next.activeProfile },
      pretty: ctx => writeLine(success(ctx, `Active profile is now "${next.activeProfile}"`)),
    };
  };
  return runCommand('profile.use', flags, cmd);
}

// --- remove ---------------------------------------------------------------

export interface RemoveFlags extends GlobalFlags {
  name?: string;
}

export function remove(flags: RemoveFlags): Promise<never> {
  const cmd: CommandFn<{ removed: string }> = async (): Promise<CommandResult<{ removed: string }>> => {
    if (!flags.name) {
      throw new ValidationError(
        'Profile name is required.',
        ERROR_CODES.VALIDATION_MISSING_FLAG,
        'Pass it as `lwr profile remove <name>`.',
      );
    }
    removeProfile(flags.name);
    return {
      json: { removed: flags.name },
      pretty: ctx => writeLine(success(ctx, `Removed profile "${flags.name}"`)),
    };
  };
  return runCommand('profile.remove', flags, cmd);
}

// Re-export header so the section header isn't unused if needed later.
export { header };
