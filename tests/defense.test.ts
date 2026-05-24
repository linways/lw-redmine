/**
 * Defense-in-depth checks for `lwr user import` size bound (M5) and
 * the cache file mode invariant (M6).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWithinUserImportLimit } from '../src/commands/user';
import { writeStatusesCache, writeManualUsers } from '../src/foundation/cache';
import {
  cacheStatusesPath,
  cacheUsersManualPath,
} from '../src/foundation/paths';
import { LwrError } from '../src/foundation/errors';
import { ENV, USER_IMPORT_MAX_BYTES } from '../src/constants';

describe('assertWithinUserImportLimit (M5)', () => {
  it('accepts payloads up to and including the limit', () => {
    expect(() => assertWithinUserImportLimit(0)).not.toThrow();
    expect(() => assertWithinUserImportLimit(1024)).not.toThrow();
    expect(() => assertWithinUserImportLimit(USER_IMPORT_MAX_BYTES)).not.toThrow();
  });

  it('throws ValidationError beyond the limit', () => {
    try {
      assertWithinUserImportLimit(USER_IMPORT_MAX_BYTES + 1);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LwrError);
      expect((e as LwrError).code).toBe('VALIDATION_BAD_VALUE');
      // Hint guides the agent toward a fix.
      expect((e as LwrError).hint).toMatch(/trim|split/i);
    }
  });

  it('error message names the offending byte count and the cap', () => {
    const huge = USER_IMPORT_MAX_BYTES * 2;
    try {
      assertWithinUserImportLimit(huge);
    } catch (e) {
      const msg = (e as LwrError).message;
      expect(msg).toContain(String(huge));
      expect(msg).toContain(String(USER_IMPORT_MAX_BYTES));
    }
  });
});

describe('cache file mode (M6)', () => {
  // Skip on Windows — POSIX permission bits don't translate.
  const skip = process.platform === 'win32';
  let tmpRoot: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    if (skip) return;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-cache-mode-'));
    originalEnv = process.env[ENV.CONFIG_DIR];
    process.env[ENV.CONFIG_DIR] = tmpRoot;
  });

  afterEach(() => {
    if (skip) return;
    if (originalEnv === undefined) delete process.env[ENV.CONFIG_DIR];
    else process.env[ENV.CONFIG_DIR] = originalEnv;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.skipIf(skip)('writes the statuses cache with explicit mode 0644', () => {
    writeStatusesCache([{ id: 1, name: 'New', is_closed: false }]);
    const stat = fs.statSync(cacheStatusesPath());
    // Mask off the type bits — only the permission triplet matters here.
    expect(stat.mode & 0o777).toBe(0o644);
  });

  it.skipIf(skip)('writes the manual-users file with explicit mode 0644', () => {
    writeManualUsers([{ id: 1, name: 'Alice' }], 'test');
    const stat = fs.statSync(cacheUsersManualPath());
    expect(stat.mode & 0o777).toBe(0o644);
  });
});
