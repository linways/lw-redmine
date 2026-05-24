/**
 * Backup / restore round-trip + the destructive guardrails.
 *
 * Five scenarios:
 *   1. `backup create` writes a bundle whose JSON envelope advertises a
 *      sensible path, file count, and size.
 *   2. `backup list` returns the entry and tags pre-restore correctly.
 *   3. Round-trip: backup → mutate state → restore → state is restored,
 *      and a pre-restore-*.lwr snapshot exists in the backups dir.
 *   4. Credentials (auth.json) and the backups/ dir itself are NEVER
 *      included in a bundle and NEVER wiped on restore.
 *   5. A malformed bundle (truncated bytes) raises BACKUP_BUNDLE_INVALID.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestProfile,
  runCommandAndCapture,
  type FixtureHandle,
} from './_helpers/profile-fixture';
import { backupCreate, backupList, backupPrune, restore } from '../src/commands/backup';
import { backupDir, configDir, authFallbackPath } from '../src/foundation/paths';
import { ERROR_CODES, BACKUP_SCHEMA, BACKUP_FILE_SUFFIX } from '../src/constants';

describe('backup / restore', () => {
  let fixture: FixtureHandle;

  beforeEach(() => {
    fixture = setupTestProfile();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('backup create writes a bundle and returns its metadata', async () => {
    // Seed an extra file so the bundle has more than just config.json.
    fs.writeFileSync(path.join(fixture.dir, 'me.md'), '# me');

    const { envelope, exitCode } = await runCommandAndCapture(
      backupCreate as (f: Record<string, unknown>) => Promise<never>,
      {},
    );

    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(typeof data.path).toBe('string');
    expect(data.fileCount).toBeGreaterThanOrEqual(2); // config + me.md
    expect(data.sizeBytes).toBeGreaterThan(0);

    // File exists on disk and is gzipped (magic bytes 1f 8b).
    const onDisk = fs.readFileSync(data.path as string);
    expect(onDisk[0]).toBe(0x1f);
    expect(onDisk[1]).toBe(0x8b);
  });

  it('backup list returns the entry with the right kind', async () => {
    await runCommandAndCapture(
      backupCreate as (f: Record<string, unknown>) => Promise<never>,
      {},
    );

    const { envelope } = await runCommandAndCapture(
      backupList as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    const data = envelope.data as { backups: { name: string; kind: string }[] };
    expect(data.backups).toHaveLength(1);
    expect(data.backups[0].kind).toBe('user');
    expect(data.backups[0].name.endsWith(BACKUP_FILE_SUFFIX)).toBe(true);
  });

  it('round-trip: backup → mutate state → restore → state matches', async () => {
    // Seed: marker file + a nested directory file. Capture them.
    fs.writeFileSync(path.join(fixture.dir, 'marker.txt'), 'before-restore');
    fs.mkdirSync(path.join(fixture.dir, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(fixture.dir, 'subdir', 'nested.json'), '{"ok":true}');

    const { envelope: backupEnv } = await runCommandAndCapture(
      backupCreate as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    const bundlePath = (backupEnv.data as { path: string }).path;

    // Mutate: change marker, delete nested file. Restore should undo.
    fs.writeFileSync(path.join(fixture.dir, 'marker.txt'), 'after-mutation');
    fs.rmSync(path.join(fixture.dir, 'subdir'), { recursive: true, force: true });

    const { envelope: restoreEnv, exitCode } = await runCommandAndCapture(
      restore as (f: Record<string, unknown>) => Promise<never>,
      { file: bundlePath, confirm: 'restore', yes: true },
    );

    expect(exitCode).toBe(0);
    expect(restoreEnv.ok).toBe(true);
    expect(fs.readFileSync(path.join(fixture.dir, 'marker.txt'), 'utf8')).toBe('before-restore');
    expect(fs.readFileSync(path.join(fixture.dir, 'subdir', 'nested.json'), 'utf8')).toBe('{"ok":true}');

    // Pre-restore snapshot was taken — there are 2 bundles in backups/ now.
    const bundlesAfter = fs
      .readdirSync(backupDir())
      .filter(n => n.endsWith(BACKUP_FILE_SUFFIX));
    expect(bundlesAfter).toHaveLength(2);
    expect(bundlesAfter.some(n => n.startsWith('pre-restore-'))).toBe(true);
  });

  it('excludes auth.json and backups/ from both pack and wipe', async () => {
    // Seed auth.json (the credentials fallback) + an existing backups dir
    // with a stale-looking marker file. Neither should ever round-trip
    // through the bundle, and the restore wipe must leave both untouched.
    fs.writeFileSync(authFallbackPath(), JSON.stringify({ apiKey: 'SENSITIVE' }));
    fs.mkdirSync(backupDir(), { recursive: true });
    fs.writeFileSync(path.join(backupDir(), 'stale-marker.txt'), 'keep-me');
    fs.writeFileSync(path.join(fixture.dir, 'real-data.txt'), 'real');

    const { envelope: backupEnv } = await runCommandAndCapture(
      backupCreate as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    const bundlePath = (backupEnv.data as { path: string }).path;

    // Decode the bundle and prove auth.json + backups/ contents aren't in it.
    const decoded = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(bundlePath)).toString('utf8'),
    ) as { schema: string; files: Record<string, string> };
    expect(decoded.schema).toBe(BACKUP_SCHEMA);
    expect(Object.keys(decoded.files).some(k => k === 'auth.json')).toBe(false);
    expect(Object.keys(decoded.files).some(k => k.startsWith('backups/'))).toBe(false);
    expect(Object.keys(decoded.files)).toContain('real-data.txt');

    // Restore: auth.json + the stale marker survive the wipe.
    const { exitCode } = await runCommandAndCapture(
      restore as (f: Record<string, unknown>) => Promise<never>,
      { file: bundlePath, confirm: 'restore', yes: true },
    );
    expect(exitCode).toBe(0);
    expect(fs.existsSync(authFallbackPath())).toBe(true);
    expect(fs.readFileSync(authFallbackPath(), 'utf8')).toContain('SENSITIVE');
    expect(fs.existsSync(path.join(backupDir(), 'stale-marker.txt'))).toBe(true);
  });

  it('rejects a malformed bundle with BACKUP_BUNDLE_INVALID', async () => {
    const bogus = path.join(backupDir(), '2026-05-23T09-00-00Z_backup.lwr');
    fs.mkdirSync(backupDir(), { recursive: true });
    fs.writeFileSync(bogus, Buffer.from('not gzip at all'));

    const { envelope, exitCode } = await runCommandAndCapture(
      restore as (f: Record<string, unknown>) => Promise<never>,
      { file: bogus, confirm: 'restore', yes: true },
    );

    expect(exitCode).not.toBe(0);
    expect(envelope.ok).toBe(false);
    expect((envelope.error as Record<string, unknown>).code).toBe(
      ERROR_CODES.BACKUP_BUNDLE_INVALID,
    );
  });

  it('rejects a path-traversal payload during restore', async () => {
    // Hand-craft a valid bundle with an unsafe key.
    const bogus = path.join(backupDir(), '2026-05-23T09-00-01Z_backup.lwr');
    fs.mkdirSync(backupDir(), { recursive: true });
    const evil = {
      schema: BACKUP_SCHEMA,
      created: new Date().toISOString(),
      lwrVersion: '0.0.0',
      files: { '../etc-evil.txt': Buffer.from('pwned').toString('base64') },
    };
    fs.writeFileSync(bogus, zlib.gzipSync(Buffer.from(JSON.stringify(evil), 'utf8')));

    const { envelope, exitCode } = await runCommandAndCapture(
      restore as (f: Record<string, unknown>) => Promise<never>,
      { file: bogus, confirm: 'restore', yes: true },
    );

    expect(exitCode).not.toBe(0);
    expect((envelope.error as Record<string, unknown>).code).toBe(
      ERROR_CODES.BACKUP_BUNDLE_INVALID,
    );
    // The path-traversal target must not exist outside the config dir.
    expect(fs.existsSync(path.join(configDir(), '..', 'etc-evil.txt'))).toBe(false);
  });

  it('restore without --confirm fails closed', async () => {
    const { envelope: backupEnv } = await runCommandAndCapture(
      backupCreate as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    const bundlePath = (backupEnv.data as { path: string }).path;

    const { envelope, exitCode } = await runCommandAndCapture(
      restore as (f: Record<string, unknown>) => Promise<never>,
      { file: bundlePath }, // no --confirm, no --yes
    );

    expect(exitCode).not.toBe(0);
    expect(envelope.ok).toBe(false);
  });

  it('backup prune --keep N drops oldest, keeps newest', async () => {
    // Seed three backup bundles with distinct timestamped filenames so
    // listBackups can sort them deterministically.
    fs.mkdirSync(backupDir(), { recursive: true });
    const names = [
      '2026-05-21T08-00-00Z_backup.lwr',
      '2026-05-22T08-00-00Z_backup.lwr',
      '2026-05-23T08-00-00Z_backup.lwr',
    ];
    for (const n of names) {
      fs.writeFileSync(path.join(backupDir(), n), Buffer.from('stub'));
    }

    const { envelope, exitCode } = await runCommandAndCapture(
      backupPrune as (f: Record<string, unknown>) => Promise<never>,
      { keep: 1 },
    );

    expect(exitCode).toBe(0);
    const data = envelope.data as { removed: { name: string }[]; kept: { name: string }[] };
    expect(data.removed.map(r => r.name).sort()).toEqual([
      '2026-05-21T08-00-00Z_backup.lwr',
      '2026-05-22T08-00-00Z_backup.lwr',
    ]);
    expect(data.kept.map(k => k.name)).toEqual(['2026-05-23T08-00-00Z_backup.lwr']);
    // Disk truth matches.
    const left = fs.readdirSync(backupDir()).filter(n => n.endsWith('_backup.lwr'));
    expect(left.sort()).toEqual(['2026-05-23T08-00-00Z_backup.lwr']);
  });

  it('backup prune --kind pre-restore only touches auto-snapshots', async () => {
    fs.mkdirSync(backupDir(), { recursive: true });
    const userBundles = [
      '2026-05-20T08-00-00Z_backup.lwr',
      '2026-05-22T08-00-00Z_backup.lwr',
    ];
    const preRestoreBundles = [
      'pre-restore-2026-05-21T08-00-00Z_backup.lwr',
      'pre-restore-2026-05-23T08-00-00Z_backup.lwr',
    ];
    for (const n of [...userBundles, ...preRestoreBundles]) {
      fs.writeFileSync(path.join(backupDir(), n), Buffer.from('stub'));
    }

    const { envelope, exitCode } = await runCommandAndCapture(
      backupPrune as (f: Record<string, unknown>) => Promise<never>,
      { keep: 1, kind: 'pre-restore' },
    );

    expect(exitCode).toBe(0);
    const data = envelope.data as { removed: { name: string }[]; kept: { name: string }[] };
    expect(data.removed.map(r => r.name)).toEqual(['pre-restore-2026-05-21T08-00-00Z_backup.lwr']);
    // Both user bundles must survive untouched.
    const left = fs.readdirSync(backupDir()).sort();
    expect(left).toContain('2026-05-20T08-00-00Z_backup.lwr');
    expect(left).toContain('2026-05-22T08-00-00Z_backup.lwr');
    expect(left).toContain('pre-restore-2026-05-23T08-00-00Z_backup.lwr');
  });

  it('backup prune is a no-op when nothing exceeds --keep', async () => {
    fs.mkdirSync(backupDir(), { recursive: true });
    fs.writeFileSync(path.join(backupDir(), '2026-05-23T08-00-00Z_backup.lwr'), Buffer.from('x'));

    const { envelope, exitCode } = await runCommandAndCapture(
      backupPrune as (f: Record<string, unknown>) => Promise<never>,
      { keep: 5 },
    );

    expect(exitCode).toBe(0);
    const data = envelope.data as { removed: unknown[]; kept: unknown[] };
    expect(data.removed).toHaveLength(0);
    expect(data.kept).toHaveLength(1);
  });
});
