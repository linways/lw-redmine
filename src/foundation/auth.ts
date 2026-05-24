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
 *   3. Keychain         (keytar)
 *   4. File fallback    (~/.lwr/auth.json)
 */

import fs from 'node:fs';
import { ENV, KEYTAR_SERVICE, KEYTAR_ACCOUNT } from '../constants';
import { AuthMissingError, ConfigError } from './errors';
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

/**
 * Resolve the API key for a profile, honouring the precedence order.
 * Throws AuthMissingError if no key is found in any source.
 */
export async function getApiKey(profile: string, flagApiKey?: string): Promise<string> {
  if (flagApiKey && flagApiKey.length > 0) return flagApiKey;

  const fromEnv = process.env[ENV.API_KEY];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const keytar = await loadKeytar();
  if (keytar) {
    try {
      const k = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT(profile));
      if (k && k.length > 0) return k;
    } catch (e) {
      logger.debug('keytar.getPassword failed; trying file fallback', e);
    }
  }

  const file = readFileAuth();
  const fromFile = file.keys[profile];
  if (fromFile && fromFile.length > 0) return fromFile;

  throw new AuthMissingError();
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
