/**
 * Test fixture: a valid `~/.lwr/` directory with one configured profile.
 *
 * Used by the per-command dry-run tests so they can drive `runCommand`
 * end-to-end (including `openSession()`) without depending on a real
 * keychain entry or a live Redmine. The API key is supplied via the
 * `--api-key` flag in the test, so no auth.json or keytar is needed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveConfig, type LwrConfig } from '../../src/foundation/config';
import { ENV } from '../../src/constants';

export interface FixtureHandle {
  /** Absolute path to the temp ~/.lwr/. */
  dir: string;
  /** baseUrl used by the profile — tests should `nock(baseUrl)` against this. */
  baseUrl: string;
  /** Profile name the active profile is set to. */
  profileName: string;
  /** Tear down the env override and remove the temp directory. */
  cleanup: () => void;
}

/**
 * Create a temp config dir, override LWR_CONFIG_DIR for this process,
 * and seed it with a minimum-viable LwrConfig.
 */
export function setupTestProfile(): FixtureHandle {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-cmd-test-'));
  const previousEnv = process.env[ENV.CONFIG_DIR];
  process.env[ENV.CONFIG_DIR] = dir;

  const profileName = 'test';
  const baseUrl = 'https://test.redmine';

  const cfg: LwrConfig = {
    version: 1,
    activeProfile: profileName,
    profiles: {
      [profileName]: {
        baseUrl,
        me: {
          user: { id: 1, login: 'tester', name: 'Tester' },
          roles: ['developer'],
          fieldMap: { developer: { cfId: 79, name: 'Developer' } },
          memberships: [],
          detectedAt: '2026-05-09T00:00:00.000Z',
        },
      },
    },
    ui: { theme: 'auto', color: 'auto', table: 'rounded', markdown: true, images: 'auto' },
    tui: { refreshIntervalMs: 30_000, defaultView: 'inbox' },
  };
  saveConfig(cfg);

  return {
    dir,
    baseUrl,
    profileName,
    cleanup: () => {
      if (previousEnv === undefined) delete process.env[ENV.CONFIG_DIR];
      else process.env[ENV.CONFIG_DIR] = previousEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Drive a command function (e.g. `note(flags)`) to completion, capturing
 * the JSON envelope it writes to stdout and the exit code without
 * actually killing the test process. Mirrors the pattern used in
 * tests/run-error-envelope.test.ts.
 */
import { vi } from 'vitest';

export interface CapturedRun {
  envelope: Record<string, unknown>;
  exitCode: number;
}

export async function runCommandAndCapture(
  fn: (flags: Record<string, unknown>) => Promise<never>,
  flags: Record<string, unknown>,
): Promise<CapturedRun> {
  const stdoutChunks: string[] = [];
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  let captured = 0;
  // The spy must NOT throw: if it does, runCommand's catch block fires
  // and writes a *second* JSON envelope, leaving us with two-on-a-line.
  // Returning undefined lets runCommand finish normally; the typed
  // return is `never`, which we satisfy via cast.
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      captured = code ?? 0;
      return undefined as never;
    }) as unknown as typeof process.exit);

  try {
    await fn({ json: true, noInteractive: true, apiKey: 'test-key', ...flags });
  } finally {
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }

  // runCommand writes exactly one JSON envelope per invocation. Take
  // the first non-empty line so any stray whitespace doesn't trip
  // JSON.parse.
  const joined = stdoutChunks.join('').trim();
  const firstLine = joined.split('\n').find(l => l.length > 0) ?? joined;
  return { envelope: JSON.parse(firstLine), exitCode: captured };
}
