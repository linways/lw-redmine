/**
 * $LWR_API_KEY_COMMAND backend.
 *
 * The broker path for machines where no static key can be planted: the
 * key is whatever the command prints, resolved per process and never
 * persisted. Isolated tempdir via $LWR_CONFIG_DIR so the file fallback
 * can't reach a real ~/.lwr.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV, ERROR_CODES } from '../src/constants';

let tmpDir: string;
const origEnv = { ...process.env };

/** Fresh module instance per test — the key command is memoised per process. */
async function auth() {
  vi.resetModules();
  return import('../src/foundation/auth');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-keycmd-'));
  process.env[ENV.CONFIG_DIR] = tmpDir;
  delete process.env[ENV.API_KEY];
  delete process.env[ENV.API_KEY_COMMAND];
});

afterEach(() => {
  process.env = { ...origEnv };
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('key command backend', () => {
  it('resolves the key from the command stdout, trimmed', async () => {
    process.env[ENV.API_KEY_COMMAND] = 'printf "hsurr:abc123\\n"';
    const { resolveApiKey } = await auth();
    expect(await resolveApiKey('default')).toEqual({ apiKey: 'hsurr:abc123', source: 'command' });
  });

  it('ranks below an explicit flag and $LWR_API_KEY', async () => {
    process.env[ENV.API_KEY_COMMAND] = 'echo from-command';
    const { resolveApiKey } = await auth();
    expect((await resolveApiKey('default', 'from-flag')).source).toBe('flag');

    process.env[ENV.API_KEY] = 'from-env';
    expect((await resolveApiKey('default')).source).toBe('env');
  });

  it('never writes the resolved key to the file fallback', async () => {
    process.env[ENV.API_KEY_COMMAND] = 'echo secret-surrogate';
    const { getApiKey } = await auth();
    await getApiKey('default');
    const authFile = path.join(tmpDir, 'auth.json');
    // Nothing persisted at all; and if some other code path ever creates
    // the file, the key must not be in it.
    if (fs.existsSync(authFile)) {
      expect(fs.readFileSync(authFile, 'utf8')).not.toContain('secret-surrogate');
    } else {
      expect(fs.existsSync(authFile)).toBe(false);
    }
  });

  it('fails with a stable code when the command exits non-zero', async () => {
    process.env[ENV.API_KEY_COMMAND] = 'exit 3';
    const { getApiKey } = await auth();
    await expect(getApiKey('default')).rejects.toMatchObject({
      code: ERROR_CODES.AUTH_KEY_COMMAND_FAILED,
    });
  });

  it('fails when the command succeeds but prints nothing', async () => {
    process.env[ENV.API_KEY_COMMAND] = 'true';
    const { getApiKey } = await auth();
    await expect(getApiKey('default')).rejects.toMatchObject({
      code: ERROR_CODES.AUTH_KEY_COMMAND_FAILED,
    });
  });

  it('leaks neither the command output nor the command string into the error', async () => {
    process.env[ENV.API_KEY_COMMAND] =
      'echo leaked-stdout; echo leaked-stderr >&2; exit 1 # op://vault/secret-path';
    const { getApiKey } = await auth();
    await expect(getApiKey('default')).rejects.toSatisfy((e: Error & { hint?: string }) => {
      const surface = `${e.message} ${e.hint ?? ''}`;
      return (
        !surface.includes('leaked-stdout') &&
        !surface.includes('leaked-stderr') &&
        !surface.includes('op://vault/secret-path')
      );
    });
  });

  it('is ignored when set to whitespace', async () => {
    process.env[ENV.API_KEY_COMMAND] = '   ';
    const { keyCommand } = await auth();
    expect(keyCommand()).toBeNull();
  });
});
