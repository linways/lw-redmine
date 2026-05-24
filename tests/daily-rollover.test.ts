/**
 * Daily-rollover detector tests.
 *
 * Scenarios covered:
 *   1. No log files yet                                → null
 *   2. No active issue                                 → null
 *   3. Active issue NOT in DEV_ACTIVE_STATUS_NAMES     → null
 *   4. Active issue + last activity today, gap < 4h    → null
 *   5. Active issue + last activity today, gap ≥ 4h    → 'gap-exceeded'
 *   6. Active issue + last activity on a prior day     → 'date-change'
 *   7. Ack marker stamped today                        → null (even with stale activity)
 *   8. Schema-1 (legacy session) line is parsed too
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectRollover,
  acknowledgeRolloverToday,
  _resetRolloverCache,
} from '../src/workflow/daily-rollover';
import { saveConfig, loadConfig, type LwrConfig } from '../src/foundation/config';
import { workLogDir, workLogDayPath } from '../src/foundation/paths';
import { todayInWorkTz } from '../src/workflow/work-log';
import { ENV, ROLLOVER_MIN_GAP_MS } from '../src/constants';

function isolatedConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-rollover-test-'));
  process.env[ENV.CONFIG_DIR] = dir;
  return dir;
}

function baseConfig(activeIssueStatus: string | null): LwrConfig {
  const profile: LwrConfig['profiles'][string] = {
    baseUrl: 'https://test.redmine',
    me: {
      user: { id: 1, login: 'tester', name: 'Tester' },
      roles: ['developer'],
      fieldMap: { developer: { cfId: 79, name: 'Developer' } },
      memberships: [],
      detectedAt: '2026-05-09T00:00:00.000Z',
    },
  };
  if (activeIssueStatus) {
    profile.activeIssue = {
      id: 12345,
      subject: 'EPIC - Some active issue',
      project: { id: 1, name: 'Linways AMS V4' },
      tracker: 'Enhancement',
      status: activeIssueStatus,
      setAt: '2026-05-22T02:30:00.000Z',
    };
  }
  return {
    version: 1,
    activeProfile: 'test',
    profiles: { test: profile },
    ui: { theme: 'auto', color: 'auto', table: 'rounded', markdown: true, images: 'auto' },
    tui: { refreshIntervalMs: 30_000, defaultView: 'inbox' },
  };
}

function writeActionLogLine(isoDate: string, isoAt: string, issueId: number): void {
  fs.mkdirSync(workLogDir(), { recursive: true });
  const entry = {
    schema: 2,
    at: isoAt,
    cmd: 'issue.edit',
    requestId: 'r-test',
    durationMs: 50,
    outcome: 'success',
    safety: 'mutate',
    args: { id: issueId },
  };
  fs.appendFileSync(workLogDayPath(isoDate), JSON.stringify(entry) + '\n');
}

function writeLegacySessionLine(isoDate: string, start: string, end: string, issueId: number): void {
  fs.mkdirSync(workLogDir(), { recursive: true });
  const entry = {
    schema: 1,
    id: 's_legacy',
    issueId,
    subject: 'legacy',
    project: 'Linways AMS V4',
    tracker: 'Enhancement',
    assignee: 'Tester',
    date: isoDate,
    start,
    end,
    durationMin: 30,
    statusAtStart: 'Development in Progress',
    statusAtEnd: 'Development Completed',
    notes: [],
    meta: {},
  };
  fs.appendFileSync(workLogDayPath(isoDate), JSON.stringify(entry) + '\n');
}

describe('daily-rollover detector', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = isolatedConfigDir();
    _resetRolloverCache();
    saveConfig(baseConfig('Development in Progress'));
  });

  afterEach(() => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    delete process.env[ENV.CONFIG_DIR];
  });

  it('returns null when no log files exist (fresh install)', () => {
    expect(detectRollover()).toBeNull();
  });

  it('returns null when no active issue is set', () => {
    saveConfig(baseConfig(null));
    _resetRolloverCache();
    writeActionLogLine('2026-05-20', '2026-05-20T18:30:00+05:30', 12345);
    expect(detectRollover()).toBeNull();
  });

  it('returns null when active issue status is not in DEV_ACTIVE_STATUS_NAMES', () => {
    saveConfig(baseConfig('Paused'));
    _resetRolloverCache();
    writeActionLogLine('2026-05-20', '2026-05-20T18:30:00+05:30', 12345);
    expect(detectRollover()).toBeNull();
  });

  it('returns null when last activity is today AND gap < 4h', () => {
    const today = todayInWorkTz();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeActionLogLine(today, twoHoursAgo, 12345);
    expect(detectRollover()).toBeNull();
  });

  it('triggers gap-exceeded when last activity is today but gap ≥ 4h', () => {
    const today = todayInWorkTz();
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    writeActionLogLine(today, fiveHoursAgo, 12345);
    const signal = detectRollover();
    expect(signal).not.toBeNull();
    expect(signal?.reason).toBe('gap-exceeded');
    expect(signal?.issueId).toBe(12345);
    expect(signal?.gapMs).toBeGreaterThanOrEqual(ROLLOVER_MIN_GAP_MS);
  });

  it('triggers date-change when most recent activity is on a prior calendar day', () => {
    // Last activity 3 days ago — calendar date differs even if the hour-of-day
    // is roughly the same now.
    writeActionLogLine('2026-05-20', '2026-05-20T18:30:00+05:30', 12345);
    const signal = detectRollover();
    expect(signal).not.toBeNull();
    expect(signal?.reason).toBe('date-change');
    expect(signal?.issueId).toBe(12345);
    expect(signal?.lastActivityAt).toBe('2026-05-20T18:30:00+05:30');
  });

  it('returns null after acknowledgeRolloverToday() — even when stale activity exists', () => {
    writeActionLogLine('2026-05-20', '2026-05-20T18:30:00+05:30', 12345);
    expect(detectRollover()).not.toBeNull(); // sanity
    _resetRolloverCache();
    acknowledgeRolloverToday();
    _resetRolloverCache(); // ack writes to a marker; clear in-process cache too
    expect(detectRollover()).toBeNull();
  });

  it('parses legacy schema-1 sessions (uses end timestamp)', () => {
    writeLegacySessionLine(
      '2026-05-20',
      '2026-05-20T17:00:00+05:30',
      '2026-05-20T18:30:00+05:30',
      12345,
    );
    const signal = detectRollover();
    expect(signal).not.toBeNull();
    expect(signal?.lastActivityAt).toBe('2026-05-20T18:30:00+05:30');
    expect(signal?.reason).toBe('date-change');
  });

  it('walks back over empty log files to find the most recent non-empty one', () => {
    // Yesterday's file exists but is empty (e.g., started lwr but no mutation).
    // Day before has a real entry. Detector should still find it.
    fs.mkdirSync(workLogDir(), { recursive: true });
    fs.writeFileSync(workLogDayPath('2026-05-21'), '');
    writeActionLogLine('2026-05-19', '2026-05-19T17:00:00+05:30', 12345);
    const signal = detectRollover();
    expect(signal).not.toBeNull();
    expect(signal?.lastActivityAt).toBe('2026-05-19T17:00:00+05:30');
  });

  it('loadConfig reflects acknowledgeRolloverToday — sanity', () => {
    // Smoke: the helper writes a file with today's date.
    acknowledgeRolloverToday();
    // After ack, loadConfig still works (config file untouched).
    expect(() => loadConfig()).not.toThrow();
  });
});
