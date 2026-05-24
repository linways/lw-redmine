/**
 * `lwr auth logout`
 *
 * Logs out the active (or named) profile. Removes:
 *   - the API key from both keychain and the file fallback,
 *   - the profile entry from `~/.lwr/config.json` (identity, roles,
 *     fieldMap, memberships, activeProject — everything user-bound),
 *   - the rendered `~/.lwr/me.md` snippet,
 *   - the `activeProfile` pointer if it was this profile.
 *
 * Preserves:
 *   - other profiles (multi-instance setups stay intact),
 *   - shared caches (statuses, projects-index, per-project members) —
 *     those are instance-wide, not user-bound,
 *   - downloaded issues under `~/.lwr/issues/` — agnostic of who fetched
 *     them,
 *   - the user-supplied manual users list (sacred — `cache clear --type
 *     users` is the only way to drop it).
 *
 * Logout is destructive (re-auth required to use lwr again), so it
 * requires double confirmation: TTY users type `logout` then `YES`;
 * agents pass `--confirm "logout" --yes`.
 */

import fs from 'node:fs';
import { deleteApiKey } from '../../foundation/auth';
import { resolveProfileName } from '../../foundation/profiles';
import { loadConfig, saveConfig } from '../../foundation/config';
import { meMarkdownPath } from '../../foundation/paths';
import { confirmDestructive, type DoubleConfirmFlags } from '../../foundation/confirm';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';

export interface LogoutFlags extends GlobalFlags, DoubleConfirmFlags {}

interface LogoutPayload {
  profile: string;
  removed: {
    keychain: boolean;
    file: boolean;
    profileEntry: boolean;
    meMarkdown: boolean;
    activeProfileReset: boolean;
  };
}

const cmd: CommandFn<LogoutPayload> = async (flags, ctx): Promise<CommandResult<LogoutPayload>> => {
  const flgs = flags as LogoutFlags;
  const profile = resolveProfileName(flags.profile);

  const cfg = loadConfig();
  const targetProfile = cfg.profiles[profile];
  const userLabel = targetProfile?.me?.user?.name ?? targetProfile?.me?.user?.login ?? profile;

  await confirmDestructive({
    action: 'logout',
    description: `log out profile "${profile}" (${userLabel}). API key, identity, roles, memberships and active project will be removed; caches and downloaded issues stay`,
    affectedPaths: [
      `~/.lwr/config.json (profile "${profile}" entry)`,
      '~/.lwr/me.md',
      'OS keychain entry / ~/.lwr/auth.json',
    ],
    ctx,
    flags: { confirm: flgs.confirm, yes: flgs.yes },
  });

  // 1. Drop the API key.
  const removed = await deleteApiKey(profile);

  // 2. Drop the profile entry + reset activeProfile if it pointed here.
  let profileEntryRemoved = false;
  let activeProfileReset = false;
  if (cfg.profiles[profile]) {
    const next = { ...cfg.profiles };
    delete next[profile];
    const newActive = cfg.activeProfile === profile ? '' : cfg.activeProfile;
    saveConfig({ ...cfg, profiles: next, activeProfile: newActive });
    profileEntryRemoved = true;
    activeProfileReset = newActive !== cfg.activeProfile;
  }

  // 3. Remove me.md (best-effort — it's just a rendered file).
  let meMarkdownRemoved = false;
  const mePath = meMarkdownPath();
  if (fs.existsSync(mePath)) {
    try {
      fs.unlinkSync(mePath);
      meMarkdownRemoved = true;
    } catch {
      // best-effort
    }
  }

  return {
    json: {
      profile,
      removed: {
        keychain: removed.keychain,
        file: removed.file,
        profileEntry: profileEntryRemoved,
        meMarkdown: meMarkdownRemoved,
        activeProfileReset,
      },
    },
    pretty: c => {
      const where = [removed.keychain ? 'keychain' : null, removed.file ? 'file' : null].filter(Boolean);
      const detail = where.length ? `(${where.join(', ')})` : '(no key was stored)';
      writeLine(success(c, `Logged out of profile "${profile}" ${detail}`));
      if (profileEntryRemoved) writeLine(`  ${dim(c, 'profile entry removed:')} ${profile}`);
      if (meMarkdownRemoved) writeLine(`  ${dim(c, 'me.md removed:')} ${mePath}`);
      if (activeProfileReset) writeLine(`  ${dim(c, 'active profile reset')}`);
    },
  };
};

export function logout(flags: LogoutFlags): Promise<never> {
  return runCommand('auth.logout', flags, cmd);
}
