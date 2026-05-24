/**
 * `lwr issue clear`
 *
 * Unsets the active-issue pointer in profile config. Used when the user
 * signals "done for now" without naming a follow-up issue.
 *
 * No-op if no issue is active. Returns a clean `{ profile, cleared: false }`
 * envelope so the agent can branch.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { saveConfig, loadConfig } from '../../foundation/config';
import { resolveProfileName } from '../../foundation/profiles';
import { writeMeMarkdown } from '../../workflow/me';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';

interface Payload {
  profile: string;
  cleared: boolean;
  previousActiveId: number | null;
}

const cmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const profileName = resolveProfileName(flags.profile);
  const cfg = loadConfig();
  const profile = cfg.profiles[profileName];
  const previousActive = profile?.activeIssue;

  if (!previousActive) {
    return {
      json: { profile: profileName, cleared: false, previousActiveId: null },
      pretty: ctx => writeLine(dim(ctx, 'No active issue — nothing to clear.')),
    };
  }

  const next = { ...cfg };
  const p = { ...profile! };
  delete p.activeIssue;
  next.profiles = { ...cfg.profiles, [profileName]: p };
  saveConfig(next);
  writeMeMarkdown(p.me, p.baseUrl, p.activeProject, undefined);

  return {
    json: { profile: profileName, cleared: true, previousActiveId: previousActive.id },
    pretty: ctx => writeLine(success(ctx, `Cleared active issue (was #${previousActive.id}).`)),
  };
};

export function clearIssue(flags: GlobalFlags): Promise<never> {
  return runCommand('issue.clear', flags, cmd);
}
