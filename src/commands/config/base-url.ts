/**
 * `lwr config base-url <url>`
 *
 * Set the bootstrap Redmine base URL. Agent-callable — the URL is not
 * sensitive, so an AI agent can ask the user once ("What's your Redmine
 * URL?") and then call this verb directly to persist their answer.
 *
 * Writes to `LwrConfig.defaultBaseUrl` (a top-level optional field).
 * If an active profile already exists, also updates `profile.baseUrl`
 * for symmetry — keeps both layers in sync so a subsequent profile
 * switch doesn't surprise the user with a stale URL.
 *
 * URL validation goes through the same allow-list every other layer
 * uses (`assertAllowedRedmineUrl`): https:// or http://localhost only.
 *
 * Idempotent: re-running with the same URL is a no-op.
 */

import {
  runCommand,
  type CommandFn,
  type CommandResult,
  type GlobalFlags,
} from '../../foundation/run';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { updateConfig } from '../../foundation/config';
import { assertAllowedRedmineUrl } from '../../foundation/url';
import { ERROR_CODES } from '../../constants';

export interface ConfigBaseUrlFlags extends GlobalFlags {
  url?: string;
}

interface ConfigBaseUrlPayload {
  /** The persisted URL. */
  baseUrl: string;
  /** Where it landed. 'bootstrap' = no profile existed; 'profile' = also updated active profile. */
  target: 'bootstrap' | 'bootstrap+profile';
  /** Active profile name when target includes profile; null otherwise. */
  profileName: string | null;
}

const cmd: CommandFn<ConfigBaseUrlPayload> = async (
  flags,
): Promise<CommandResult<ConfigBaseUrlPayload>> => {
  const f = flags as ConfigBaseUrlFlags;
  if (!f.url || f.url.trim().length === 0) {
    throw new ValidationError(
      'Base URL is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it positionally: `lwr config base-url https://redmine.yourcompany.com`.',
    );
  }
  const url = assertAllowedRedmineUrl(f.url.trim(), 'flag');

  const next = updateConfig(cfg => {
    const updated = { ...cfg, defaultBaseUrl: url };
    // Mirror to the active profile when one exists, so the user's next
    // command doesn't have to re-resolve through the bootstrap layer.
    const activeName = cfg.activeProfile;
    if (activeName && cfg.profiles[activeName]) {
      updated.profiles = {
        ...cfg.profiles,
        [activeName]: { ...cfg.profiles[activeName], baseUrl: url },
      };
    }
    return updated;
  });

  const activeName = next.activeProfile;
  const hadProfile = activeName.length > 0 && next.profiles[activeName] !== undefined;
  const target: ConfigBaseUrlPayload['target'] = hadProfile ? 'bootstrap+profile' : 'bootstrap';

  return {
    json: {
      baseUrl: url,
      target,
      profileName: hadProfile ? activeName : null,
    },
    pretty: ctx => {
      writeLine(success(ctx, `Base URL set to ${url}.`));
      writeLine(`  ${dim(ctx, 'target:')} ${target}`);
      if (hadProfile) {
        writeLine(`  ${dim(ctx, 'profile:')} ${activeName}`);
        writeLine(`  ${dim(ctx, 'next  :')} ready to run Redmine commands.`);
      } else {
        writeLine(`  ${dim(ctx, 'next  :')} run \`lwr auth login\` in a separate terminal to add credentials.`);
      }
    },
  };
};

export function configBaseUrl(flags: ConfigBaseUrlFlags): Promise<never> {
  return runCommand('config.base-url', flags, cmd);
}
