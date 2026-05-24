/**
 * Unit + e2e coverage for Tier 2: behaviour observation.
 *
 * Three layers covered:
 *   1. redactFlags()                — pure function, no I/O
 *   2. appendCommandEvent / status — file-system layer, isolated via $LWR_CONFIG_DIR
 *   3. runCommand observer hook    — drive a real command via runCommand,
 *                                    spy stdout/exit, assert observer firing
 *
 * The plug-and-play contract is verified by the third group: with the
 * observer registered, events land; with it cleared, no append happens.
 * (`bootstrapAssistantObserver()` itself is a thin wrapper around
 * `setCommandObserver()` + the persisted flag, exercised separately.)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  runCommand,
  setCommandObserver,
  type CommandObserver,
  type CommandEvent,
} from '../src/foundation/run';
import { redactFlags } from '../src/assistant/redact';
import {
  appendCommandEvent,
  getCommandsLogStatus,
} from '../src/assistant/events';
import { buildEventRecord } from '../src/assistant/observer';
import { ENV } from '../src/constants';
import { ValidationError } from '../src/foundation/errors';

function isolatedConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-events-test-'));
  process.env[ENV.CONFIG_DIR] = dir;
  return dir;
}

// ===========================================================================
// 1. redactFlags
// ===========================================================================

describe('redactFlags', () => {
  it('drops secret-class keys entirely', () => {
    const out = redactFlags({
      apiKey: 'sk-secret',
      password: 'hunter2',
      token: 't',
      secret: 's',
      profile: 'default',
    });
    expect(out).not.toHaveProperty('apiKey');
    expect(out).not.toHaveProperty('password');
    expect(out).not.toHaveProperty('token');
    expect(out).not.toHaveProperty('secret');
    expect(out.profile).toBe('default');
  });

  it('replaces prose keys with `<name>Length` integers', () => {
    const out = redactFlags({
      message: 'tested in UAT, working as expected',
      description: 'long body…',
      notes: 'private note',
      comments: 'time-entry comment',
      messageFile: '/path/to/file.txt',
      id: 12345,
    });
    expect(out).not.toHaveProperty('message');
    expect(out).not.toHaveProperty('description');
    expect(out).not.toHaveProperty('notes');
    expect(out).not.toHaveProperty('comments');
    expect(out).not.toHaveProperty('messageFile');
    expect(out.messageLength).toBe(34);
    expect(out.descriptionLength).toBe(10);
    expect(out.notesLength).toBe(12);
    expect(out.commentsLength).toBe(18);
    expect(out.messageFileLength).toBe(17);
    expect(out.id).toBe(12345);
  });

  it('keeps numbers, booleans, and short scalar strings verbatim', () => {
    const out = redactFlags({
      project: 51,
      private: false,
      activity: 'Development',
      hours: 1.5,
      sort: 'priority:desc',
    });
    expect(out).toEqual({
      project: 51,
      private: false,
      activity: 'Development',
      hours: 1.5,
      sort: 'priority:desc',
    });
  });

  it('drops undefined values', () => {
    const out = redactFlags({ a: undefined, b: 1 });
    expect(out).not.toHaveProperty('a');
    expect(out.b).toBe(1);
  });
});

// ===========================================================================
// 2. appendCommandEvent + getCommandsLogStatus
// ===========================================================================

describe('events filesystem layer', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = isolatedConfigDir();
  });

  afterEach(() => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    delete process.env[ENV.CONFIG_DIR];
  });

  it('createCommands log file lazily on first append', () => {
    expect(getCommandsLogStatus().exists).toBe(false);
    appendCommandEvent({ at: '2026-05-10T00:00:00Z', cmd: 'issue.note' });
    const after = getCommandsLogStatus();
    expect(after.exists).toBe(true);
    expect(after.totalLines).toBe(1);
    expect(after.sizeBytes).toBeGreaterThan(0);
  });

  it('appends one line per call', () => {
    appendCommandEvent({ at: '2026-05-10T00:00:00Z', cmd: 'issue.note' });
    appendCommandEvent({ at: '2026-05-10T00:00:01Z', cmd: 'time.log' });
    appendCommandEvent({ at: '2026-05-10T00:00:02Z', cmd: 'issue.list' });
    const status = getCommandsLogStatus();
    expect(status.totalLines).toBe(3);
    expect(status.oldestAt).toBe('2026-05-10T00:00:00Z');
    expect(status.newestAt).toBe('2026-05-10T00:00:02Z');
  });

  it('writes valid NDJSON (one JSON object per line)', () => {
    appendCommandEvent({ at: '2026-05-10T00:00:00Z', cmd: 'issue.note', flags: { id: 1 } });
    const raw = fs.readFileSync(getCommandsLogStatus().path, 'utf8');
    const lines = raw.split('\n').filter(l => l.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ at: '2026-05-10T00:00:00Z', cmd: 'issue.note' });
  });

  it('swallows write errors silently (best-effort)', () => {
    // Make the parent directory un-creatable by pre-creating it as a file.
    const dir = process.env[ENV.CONFIG_DIR]!;
    fs.writeFileSync(path.join(dir, 'events'), 'I am a file, not a directory');
    // Should not throw.
    expect(() => appendCommandEvent({ at: 'x', cmd: 'y' })).not.toThrow();
  });

  it('status returns empty defaults when the file is absent', () => {
    const status = getCommandsLogStatus();
    expect(status).toMatchObject({
      exists: false,
      totalLines: 0,
      sizeBytes: 0,
      oldestAt: null,
      newestAt: null,
    });
  });
});

// ===========================================================================
// 3. runCommand observer hook
// ===========================================================================

/** Drive a runCommand call to completion, capturing exit + stdout. */
async function driveRunCommand(
  cmdName: string,
  fn: () => Promise<unknown> | unknown,
): Promise<void> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    void code;
    return undefined as never;
  }) as unknown as typeof process.exit);
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((): boolean => true);
  try {
    await runCommand(cmdName, { json: true, noInteractive: true }, async () => {
      const result = await fn();
      return { json: result };
    });
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  }
}

describe('runCommand observer hook', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = isolatedConfigDir();
    setCommandObserver(null); // ensure clean slate for every test
  });

  afterEach(() => {
    setCommandObserver(null);
    fs.rmSync(cfgDir, { recursive: true, force: true });
    delete process.env[ENV.CONFIG_DIR];
  });

  it('does NOT invoke any observer when none is registered (vanilla path)', async () => {
    // No observer registered. Run a command. Verify no events directory
    // was created — that's the plug-and-play guarantee.
    await driveRunCommand('issue.list', () => ({ ok: true }));
    expect(fs.existsSync(path.join(cfgDir, 'events'))).toBe(false);
  });

  it('invokes the observer with a CommandEvent on success', async () => {
    const seen: CommandEvent[] = [];
    setCommandObserver({ onComplete: e => seen.push(e) });
    await driveRunCommand('issue.list', () => ({ ok: true, total: 5 }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      cmd: 'issue.list',
      outcome: 'success',
      exitCode: 0,
      safety: 'read',
      network: true,
    });
    expect(typeof seen[0].requestId).toBe('string');
    expect(typeof seen[0].durationMs).toBe('number');
  });

  it('invokes the observer with outcome=error when the command throws', async () => {
    const seen: CommandEvent[] = [];
    setCommandObserver({ onComplete: e => seen.push(e) });
    await driveRunCommand('issue.note', () => {
      throw new ValidationError('Note body is empty.', 'VALIDATION_BAD_VALUE');
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      cmd: 'issue.note',
      outcome: 'error',
      errorCode: 'VALIDATION_BAD_VALUE',
    });
  });

  it('does NOT break the command when the observer throws', async () => {
    setCommandObserver({
      onComplete() {
        throw new Error('observer is buggy');
      },
    });
    // Should complete without re-throwing; the spy was set up at the top.
    await expect(
      driveRunCommand('issue.list', () => ({ ok: true })),
    ).resolves.not.toThrow();
  });

  it('observer sees the full flags object (raw — redaction is observer policy)', async () => {
    const seen: CommandEvent[] = [];
    setCommandObserver({ onComplete: e => seen.push(e) });
    // Drive directly so we control flags shape.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never) as unknown as typeof process.exit);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
    try {
      await runCommand(
        'issue.note',
        { json: true, noInteractive: true, apiKey: 'sk-test', dryRun: true },
        async () => ({ json: { dry_run: true } }),
      );
    } finally {
      exitSpy.mockRestore();
      writeSpy.mockRestore();
    }
    expect(seen[0].flags).toMatchObject({
      apiKey: 'sk-test',
      dryRun: true,
    });
  });
});

// ===========================================================================
// 4. buildEventRecord (the observer's redaction policy in one place)
// ===========================================================================

describe('buildEventRecord', () => {
  it('redacts the flags before they go on disk', () => {
    const event: CommandEvent = {
      at: '2026-05-10T00:00:00Z',
      cmd: 'issue.note',
      requestId: 'r1',
      flags: {
        id: 124847,
        message: 'hello world',
        apiKey: 'sk-secret',
        private: false,
      },
      outcome: 'success',
      exitCode: 0,
      durationMs: 12,
      safety: 'mutate',
      network: true,
    };
    const record = buildEventRecord(event);
    const flags = record.flags as Record<string, unknown>;
    expect(flags.id).toBe(124847);
    expect(flags.private).toBe(false);
    expect(flags).not.toHaveProperty('apiKey'); // dropped
    expect(flags).not.toHaveProperty('message'); // truncated
    expect(flags.messageLength).toBe(11);
  });

  it('omits errorCode/safety/network when not present on the event', () => {
    const event: CommandEvent = {
      at: '2026-05-10T00:00:00Z',
      cmd: 'unknown.verb',
      requestId: 'r1',
      flags: {},
      outcome: 'success',
      exitCode: 0,
      durationMs: 1,
    };
    const record = buildEventRecord(event);
    expect(record).not.toHaveProperty('errorCode');
    expect(record).not.toHaveProperty('safety');
    expect(record).not.toHaveProperty('network');
  });
});
