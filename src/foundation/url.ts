/**
 * Base-URL allow-list + bootstrap resolution.
 *
 * Every Redmine HTTP call sends `X-Redmine-API-Key` in the headers, so the
 * base URL is privileged: a `file://`, `gopher://`, or arbitrary internal
 * hostname coerced into the active profile (or via `--base-url`) would
 * cause the API key to leak to that target. We restrict to https:// and
 * permit http:// only for loopback hosts — anything else is rejected at
 * config-load *and* per-invocation.
 *
 * `resolveBaseUrl` is the single source of truth for the bootstrap
 * resolution chain — every call site (session.openSession, auth/login,
 * doctor) consults it instead of repeating the `??` fallback ladder.
 */

import { LwrError, ValidationError } from './errors';
import { ENV, ERROR_CODES, EXIT, DEFAULT_BASE_URL } from '../constants';
import type { Profile } from './config';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isAllowedRedmineUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return true;
  return false;
}

export function assertAllowedRedmineUrl(raw: string, source: 'flag' | 'env' | 'config'): string {
  if (isAllowedRedmineUrl(raw)) return raw;
  throw new ValidationError(
    `Refusing base URL from ${source}: ${raw}`,
    ERROR_CODES.VALIDATION_BAD_VALUE,
    'lwr only allows https:// (or http:// for localhost). file://, gopher://, and arbitrary schemes are blocked to prevent API-key leaks.',
  );
}

export interface ResolveBaseUrlInput {
  /** Per-invocation `--base-url` flag value (highest precedence). */
  flagBaseUrl?: string;
  /** Active profile's `baseUrl` field, if a profile exists. */
  profileBaseUrl?: string;
  /** Top-level `config.defaultBaseUrl` — bootstrap value set by `lwr config base-url`. */
  configDefaultBaseUrl?: string;
}

/**
 * Resolve the effective Redmine base URL or throw a structured error.
 *
 * Resolution chain (top wins):
 *   1. flag           — `--base-url <url>`
 *   2. env            — `LWR_BASE_URL`
 *   3. profile        — `profile.baseUrl` (set by `auth login`)
 *   4. config default — `config.defaultBaseUrl` (set by `lwr config base-url`)
 *   5. compile-time   — `DEFAULT_BASE_URL` constant (empty in public repo,
 *                       populated in forks like Linways for zero-setup UX)
 *
 * Each layer that produces a value runs through `assertAllowedRedmineUrl`
 * (https-only / http://localhost) so a malicious URL at any layer is
 * rejected before it ever reaches the HTTP client.
 *
 * Throws `CONFIG_BASE_URL_MISSING` (exit code = VALIDATION) when every
 * layer is empty. The hint guides the agent to ask the user once and
 * call `lwr config base-url <url>` to persist.
 */
export function resolveBaseUrl(input: ResolveBaseUrlInput): string {
  if (input.flagBaseUrl) return assertAllowedRedmineUrl(input.flagBaseUrl, 'flag');
  const fromEnv = process.env[ENV.BASE_URL];
  if (fromEnv) return assertAllowedRedmineUrl(fromEnv, 'env');
  if (input.profileBaseUrl) return assertAllowedRedmineUrl(input.profileBaseUrl, 'config');
  if (input.configDefaultBaseUrl) return assertAllowedRedmineUrl(input.configDefaultBaseUrl, 'config');
  if (DEFAULT_BASE_URL) return assertAllowedRedmineUrl(DEFAULT_BASE_URL, 'config');

  throw new LwrError({
    message: 'No Redmine base URL configured.',
    code: ERROR_CODES.CONFIG_BASE_URL_MISSING,
    exit: EXIT.VALIDATION,
    hint:
      'Ask the user for their Redmine URL (e.g. https://redmine.yourcompany.com — not sensitive) ' +
      'and run `lwr config base-url <url>`. After that, the user runs `lwr auth login` in a separate terminal.',
  });
}

/** Profile-shaped overload: spares the call sites the field unpacking. */
export function resolveBaseUrlFromProfile(opts: {
  flagBaseUrl?: string;
  profile?: Pick<Profile, 'baseUrl'>;
  configDefaultBaseUrl?: string;
}): string {
  return resolveBaseUrl({
    flagBaseUrl: opts.flagBaseUrl,
    profileBaseUrl: opts.profile?.baseUrl,
    configDefaultBaseUrl: opts.configDefaultBaseUrl,
  });
}
