/**
 * API-key storage for Redmine.
 *
 * Primary backend: OS keychain via `keytar`.
 *   service: KEYTAR_SERVICE ("lwr"), account: `${profile}:apiKey`.
 *
 * Fallback: ~/.lwr/auth.json (mode 0600). Used when keytar can't load
 * (headless Linux without libsecret, etc.).
 *
 * `keytar` is loaded lazily so the CLI starts even on machines where the
 * native module fails to build — falling back to file storage.
 *
 * Resolution order for the active key:
 *   1. CLI flag         (--api-key)
 *   2. Env var          ($LWR_API_KEY)
 *   3. Key command      ($LWR_API_KEY_COMMAND — stdout, never persisted)
 *   4. Keychain         (keytar)
 *   5. File fallback    (~/.lwr/auth.json)
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { ENV, KEYTAR_SERVICE, KEYTAR_ACCOUNT, KEY_COMMAND_TIMEOUT_MS } from '../constants';
import { AuthKeyCommandError, AuthMissingError, ConfigError } from './errors';
import { authFallbackPath } from './paths';
import { ensureConfigDir } from './config';
import { logger } from './logger';

// ---- Lazy keytar load -----------------------------------------------------

interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let keytarCache: KeytarLike | null | undefined;

async function loadKeytar(): Promise<KeytarLike | null> {
  if (keytarCache !== undefined) return keytarCache;
  try {
    const mod = (await import('keytar')) as unknown as KeytarLike;
    keytarCache = mod;
  } catch (e) {
    logger.debug('keytar unavailable; falling back to file auth', e);
    keytarCache = null;
  }
  return keytarCache;
}

// ---- Key command ---------------------------------------------------------

/**
 * Run $LWR_API_KEY_COMMAND and take its stdout as the key.
 *
 * ponytail: one shell-out is the whole "dynamic credential" story. Every
 * secret broker already ships a CLI that prints a secret — Muse/Jarvis
 * authd, `op read`, `pass show`, `vault kv get`, `gcloud secrets
 * versions access` — so lwr needs no per-vendor client, no socket
 * protocol, and no credential placement logic (the key goes in the
 * X-Redmine-API-Key header either way). Same shape as git's
 * `credential.helper` and docker's `credsStore`.
 *
 * Memoised per process: a broker round-trip is cheap but not free, and
 * several commands resolve the key more than once.
 */
let keyCommandCache: string | undefined;

function runKeyCommand(cmd: string): string {
  if (keyCommandCache !== undefined) return keyCommandCache;
  let out: string;
  try {
    out = execSync(cmd, {
      encoding: 'utf8',
      // Non-TTY contexts must never hang (agents have no way to ^C).
      timeout: KEY_COMMAND_TIMEOUT_MS,
      // stdin closed: a broker that wants to prompt should fail, not block.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    // Nothing from the command reaches the error surface — not its
    // output (stdout IS the credential, stderr may quote it) and not the
    // command string itself (it can carry a vault path or a token in a
    // flag). The user can echo $LWR_API_KEY_COMMAND themselves.
    throw new AuthKeyCommandError(
      `${ENV.API_KEY_COMMAND} failed (non-zero exit, or timed out after ${KEY_COMMAND_TIMEOUT_MS}ms).`,
      `Run \`echo $${ENV.API_KEY_COMMAND}\` and then that command by hand: it must print the Redmine API key on stdout and exit 0.`,
      cause,
    );
  }
  const key = out.trim();
  if (key.length === 0) {
    throw new AuthKeyCommandError(
      `${ENV.API_KEY_COMMAND} exited 0 but printed nothing on stdout.`,
      `Run \`echo $${ENV.API_KEY_COMMAND}\` and then that command by hand: it must print the Redmine API key on stdout.`,
    );
  }
  keyCommandCache = key;
  return key;
}

/** Whether a key command is configured. Used by `auth login` and `doctor`. */
export function keyCommand(): string | null {
  const cmd = process.env[ENV.API_KEY_COMMAND];
  return cmd && cmd.trim().length > 0 ? cmd : null;
}

// ---- File fallback -------------------------------------------------------

interface FileAuthShape {
  /** profile name → API key */
  keys: Record<string, string>;
}

function readFileAuth(): FileAuthShape {
  const file = authFallbackPath();
  if (!fs.existsSync(file)) return { keys: {} };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.keys && typeof parsed.keys === 'object') {
      return parsed as FileAuthShape;
    }
    return { keys: {} };
  } catch (cause) {
    throw new ConfigError(
      `Failed to read auth fallback file: ${file}`,
      undefined,
      'Delete the file to reset and run `lwr auth login` again.',
      cause,
    );
  }
}

function writeFileAuth(data: FileAuthShape): void {
  ensureConfigDir();
  const file = authFallbackPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // Belt-and-braces: rename preserves the tmp mode on POSIX, but a
  // hostile umask between writeFileSync and renameSync (or a quirk on
  // some filesystems) could leave the wrong bits set. Pin 0600
  // explicitly so the credential file is never world- or group-readable.
  // chmod is a no-op on Windows, where the call still succeeds silently.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore — best-effort hardening
  }
}

// ---- Public API ----------------------------------------------------------

export interface SetApiKeyOptions {
  profile: string;
  apiKey: string;
}

/** Store the API key for a profile. Tries keytar; falls back to file. */
export async function setApiKey({ profile, apiKey }: SetApiKeyOptions): Promise<'keychain' | 'file'> {
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT(profile), apiKey);
      return 'keychain';
    } catch (e) {
      logger.debug('keytar.setPassword failed; using file fallback', e);
    }
  }
  const data = readFileAuth();
  data.keys[profile] = apiKey;
  writeFileAuth(data);
  return 'file';
}

/** Which backend a resolved key came from. Reported by `lwr doctor`. */
export type ApiKeySource = 'flag' | 'env' | 'command' | 'keychain' | 'file';

/**
 * Resolve the API key for a profile, honouring the precedence order, and
 * report which backend produced it. Throws AuthMissingError if no key is
 * found in any source.
 */
export async function resolveApiKey(
  profile: string,
  flagApiKey?: string,
): Promise<{ apiKey: string; source: ApiKeySource }> {
  if (flagApiKey && flagApiKey.length > 0) return { apiKey: flagApiKey, source: 'flag' };

  const fromEnv = process.env[ENV.API_KEY];
  if (fromEnv && fromEnv.length > 0) return { apiKey: fromEnv, source: 'env' };

  const cmd = keyCommand();
  if (cmd) return { apiKey: runKeyCommand(cmd), source: 'command' };

  const keytar = await loadKeytar();
  if (keytar) {
    try {
      const k = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT(profile));
      if (k && k.length > 0) return { apiKey: k, source: 'keychain' };
    } catch (e) {
      logger.debug('keytar.getPassword failed; trying file fallback', e);
    }
  }

  const file = readFileAuth();
  const fromFile = file.keys[profile];
  if (fromFile && fromFile.length > 0) return { apiKey: fromFile, source: 'file' };

  throw new AuthMissingError();
}

/** Resolve the API key for a profile. See {@link resolveApiKey}. */
export async function getApiKey(profile: string, flagApiKey?: string): Promise<string> {
  return (await resolveApiKey(profile, flagApiKey)).apiKey;
}

/**
 * Probe whether `keytar` can be loaded at all (used by `lwr doctor`).
 * Returns `true` only when the native module imported successfully — does
 * not actually call any keychain method.
 */
export async function isKeychainAvailable(): Promise<boolean> {
  return (await loadKeytar()) !== null;
}

/** Remove the API key for a profile from every backend that has it. */
export async function deleteApiKey(profile: string): Promise<{ keychain: boolean; file: boolean }> {
  let keychain = false;
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      keychain = await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT(profile));
    } catch (e) {
      logger.debug('keytar.deletePassword failed', e);
    }
  }
  let file = false;
  const data = readFileAuth();
  if (data.keys[profile]) {
    delete data.keys[profile];
    writeFileAuth(data);
    file = true;
  }
  return { keychain, file };
}
