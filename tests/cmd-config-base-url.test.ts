/**
 * `lwr config base-url <url>` + the CONFIG_BASE_URL_MISSING resolution
 * path.
 *
 * Three scenarios:
 *   1. Happy path: persists config.defaultBaseUrl + mirrors to profile.baseUrl.
 *   2. Invalid URL (http:// non-loopback) → VALIDATION_BAD_VALUE.
 *   3. resolveBaseUrl with all layers empty → CONFIG_BASE_URL_MISSING with hint.
 */

import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestProfile,
  runCommandAndCapture,
  type FixtureHandle,
} from './_helpers/profile-fixture';
import { configBaseUrl } from '../src/commands/config/base-url';
import { resolveBaseUrl } from '../src/foundation/url';
import { loadConfig } from '../src/foundation/config';
import { configFilePath } from '../src/foundation/paths';
import { ERROR_CODES, ENV } from '../src/constants';
import { LwrError } from '../src/foundation/errors';

describe('config base-url command', () => {
  let fixture: FixtureHandle;

  beforeEach(() => {
    fixture = setupTestProfile();
    // Make sure no env LWR_BASE_URL leaks in from the host.
    delete process.env[ENV.BASE_URL];
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('persists defaultBaseUrl and mirrors to the active profile', async () => {
    const { envelope, exitCode } = await runCommandAndCapture(
      configBaseUrl as (f: Record<string, unknown>) => Promise<never>,
      { url: 'https://redmine.example.com', apiKey: 'dummy' },
    );

    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.baseUrl).toBe('https://redmine.example.com');
    expect(data.target).toBe('bootstrap+profile');
    expect(data.profileName).toBe(fixture.profileName);

    // On disk: both layers updated.
    const onDisk = JSON.parse(fs.readFileSync(configFilePath(), 'utf8')) as Record<string, unknown>;
    expect(onDisk.defaultBaseUrl).toBe('https://redmine.example.com');
    const profile = (onDisk.profiles as Record<string, { baseUrl: string }>)[fixture.profileName];
    expect(profile.baseUrl).toBe('https://redmine.example.com');
  });

  it('rejects an http:// URL on a non-loopback host', async () => {
    const { envelope, exitCode } = await runCommandAndCapture(
      configBaseUrl as (f: Record<string, unknown>) => Promise<never>,
      { url: 'http://redmine.example.com', apiKey: 'dummy' },
    );

    expect(exitCode).not.toBe(0);
    expect(envelope.ok).toBe(false);
    const err = envelope.error as Record<string, unknown>;
    expect(err.code).toBe(ERROR_CODES.VALIDATION_BAD_VALUE);
  });

  it('allows http://localhost (loopback)', async () => {
    const { envelope } = await runCommandAndCapture(
      configBaseUrl as (f: Record<string, unknown>) => Promise<never>,
      { url: 'http://localhost:3000', apiKey: 'dummy' },
    );
    expect(envelope.ok).toBe(true);
    expect(loadConfig().defaultBaseUrl).toBe('http://localhost:3000');
  });
});

describe('resolveBaseUrl', () => {
  beforeEach(() => {
    delete process.env[ENV.BASE_URL];
  });

  it('throws CONFIG_BASE_URL_MISSING with the agent hint when every layer is empty', () => {
    try {
      resolveBaseUrl({});
      expect.fail('should have thrown CONFIG_BASE_URL_MISSING');
    } catch (err) {
      expect(err).toBeInstanceOf(LwrError);
      const lwrErr = err as LwrError;
      expect(lwrErr.code).toBe(ERROR_CODES.CONFIG_BASE_URL_MISSING);
      expect(lwrErr.hint).toMatch(/lwr config base-url/);
    }
  });

  it('prefers --base-url flag over every other layer', () => {
    const url = resolveBaseUrl({
      flagBaseUrl: 'https://flag.example.com',
      profileBaseUrl: 'https://profile.example.com',
      configDefaultBaseUrl: 'https://config.example.com',
    });
    expect(url).toBe('https://flag.example.com');
  });

  it('falls through to configDefaultBaseUrl when flag + env + profile are empty', () => {
    const url = resolveBaseUrl({
      configDefaultBaseUrl: 'https://config.example.com',
    });
    expect(url).toBe('https://config.example.com');
  });
});
