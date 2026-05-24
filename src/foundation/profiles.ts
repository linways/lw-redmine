/**
 * Multi-profile (multi-instance) management.
 *
 * A profile = (baseUrl, defaults) + an API key stored separately by `auth.ts`.
 * The active profile is recorded in config.json. CLI flag `--profile` and
 * env var $LWR_PROFILE override it for a single invocation.
 */

import { ENV } from '../constants';
import { ConfigError } from './errors';
import { ERROR_CODES } from '../constants';
import { loadConfig, saveConfig, type LwrConfig, type Profile } from './config';

/**
 * Resolve profile name from flag/env/config.
 *
 * Precedence: CLI flag > $LWR_PROFILE > config.activeProfile. Throws
 * `CONFIG_PROFILE_MISSING` when none of those yields a name — that's
 * the "user has never logged in" state, which agents recognise via
 * exit code 6 and route into `lwr auth login`.
 */
export function resolveProfileName(flagProfile?: string): string {
  if (flagProfile && flagProfile.length > 0) return flagProfile;
  const env = process.env[ENV.PROFILE];
  if (env && env.length > 0) return env;
  const active = loadConfig().activeProfile;
  if (active.length === 0) {
    throw new ConfigError(
      'No active profile.',
      ERROR_CODES.CONFIG_PROFILE_MISSING,
      'Run `lwr auth login` to create one.',
    );
  }
  return active;
}

/** Get a profile by name, or throw a typed ConfigError. */
export function getProfile(name: string, cfg: LwrConfig = loadConfig()): Profile {
  const p = cfg.profiles[name];
  if (!p) {
    throw new ConfigError(
      `Profile "${name}" not found.`,
      ERROR_CODES.CONFIG_PROFILE_MISSING,
      `Available: ${Object.keys(cfg.profiles).join(', ') || '(none)'}. Add one with \`lwr profile add <name> --base-url ...\`.`,
    );
  }
  return p;
}

/** Convenience: resolve and return the active profile in one call. */
export function activeProfile(flagProfile?: string): { name: string; profile: Profile } {
  const name = resolveProfileName(flagProfile);
  return { name, profile: getProfile(name) };
}

export function listProfiles(): { name: string; profile: Profile; active: boolean }[] {
  const cfg = loadConfig();
  return Object.entries(cfg.profiles).map(([name, profile]) => ({
    name,
    profile,
    active: name === cfg.activeProfile,
  }));
}

export function addProfile(name: string, profile: Profile): LwrConfig {
  const cfg = loadConfig();
  if (cfg.profiles[name]) {
    throw new ConfigError(`Profile "${name}" already exists.`, undefined, 'Use `lwr profile use` to switch, or remove it first.');
  }
  const next: LwrConfig = { ...cfg, profiles: { ...cfg.profiles, [name]: profile } };
  saveConfig(next);
  return next;
}

export function useProfile(name: string): LwrConfig {
  const cfg = loadConfig();
  if (!cfg.profiles[name]) {
    throw new ConfigError(
      `Profile "${name}" not found.`,
      ERROR_CODES.CONFIG_PROFILE_MISSING,
      `Available: ${Object.keys(cfg.profiles).join(', ') || '(none)'}.`,
    );
  }
  const next: LwrConfig = { ...cfg, activeProfile: name };
  saveConfig(next);
  return next;
}

export function removeProfile(name: string): LwrConfig {
  const cfg = loadConfig();
  if (!cfg.profiles[name]) {
    throw new ConfigError(`Profile "${name}" not found.`, ERROR_CODES.CONFIG_PROFILE_MISSING);
  }
  if (cfg.activeProfile === name) {
    throw new ConfigError(
      `Cannot remove active profile "${name}".`,
      undefined,
      'Switch first: `lwr profile use <other>`.',
    );
  }
  const { [name]: _drop, ...rest } = cfg.profiles;
  void _drop;
  const next: LwrConfig = { ...cfg, profiles: rest };
  saveConfig(next);
  return next;
}
