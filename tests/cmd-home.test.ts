/**
 * `lwr home` — the bare-`lwr` landing view.
 *
 * Checks the JSON envelope contract: greeting period derived from the
 * system clock, suggestion ordering by priority (rollover > active
 * issue > work-log > memory > fallbacks), and the bootstrap short-
 * circuit (unconfigured → only the setup hint).
 *
 * Also covers the staleness-safe behaviour: home does a best-effort
 * live-refresh against Redmine when an active issue is set, marks
 * `freshness` accordingly, and auto-clears the pointer if the issue
 * has turned out closed in Redmine.
 */

import fs from 'node:fs';
import path from 'node:path';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestProfile,
  runCommandAndCapture,
  type FixtureHandle,
} from './_helpers/profile-fixture';
import { home } from '../src/commands/home';
import { workLogDir, configFilePath } from '../src/foundation/paths';
import { saveConfig, loadConfig } from '../src/foundation/config';
import { resetDiscoveryCache } from '../src/workflow/active-issue';

describe('lwr home', () => {
  let fixture: FixtureHandle;

  beforeEach(() => {
    fixture = setupTestProfile();
    resetDiscoveryCache();
  });

  afterEach(() => {
    fixture.cleanup();
    nock.cleanAll();
    resetDiscoveryCache();
  });

  /**
   * Mock the discovery dance (listStatuses + per-status listIssues) so a
   * home call that reaches Redmine doesn't time out on unmocked endpoints.
   * Tests that want a specific discovery outcome inline their own mocks
   * instead of calling this.
   */
  function mockEmptyDiscovery(): void {
    nock(fixture.baseUrl)
      .get('/issue_statuses.json')
      .reply(200, {
        issue_statuses: [
          { id: 7, name: 'Development in Progress', is_closed: false },
          { id: 8, name: 'Dev Analysis In Progress', is_closed: false },
        ],
      });
    nock(fixture.baseUrl)
      .get('/issues.json')
      .query(true)
      .twice()
      .reply(200, { issues: [], total_count: 0, offset: 0, limit: 25 });
  }

  it('returns a JSON envelope with greeting + context + suggestions', async () => {
    mockEmptyDiscovery();
    const { envelope, exitCode } = await runCommandAndCapture(
      home as (f: Record<string, unknown>) => Promise<never>,
      {},
    );

    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;

    const greeting = data.greeting as { period: string; name: string | null; text: string };
    expect(['morning', 'afternoon', 'evening', 'night']).toContain(greeting.period);
    expect(greeting.text).toMatch(/^Good (morning|afternoon|evening|night), Tester\.$/);
    expect(greeting.name).toBe('Tester');

    expect(Array.isArray(data.suggestions)).toBe(true);
    const suggestions = data.suggestions as { cmd: string }[];
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });

  it('live-refreshes the active issue and marks freshness=fresh on success', async () => {
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 122047,
      subject: 'Fix the login bug',
      project: { id: 51, name: 'Linways AMS V4' },
      tracker: 'Bug',
      status: 'Development in Progress',
      setAt: '2026-01-01T00:00:00.000Z',
    };
    saveConfig(cfg);

    // Live-refresh returns the issue with the same status, still open.
    nock(fixture.baseUrl)
      .get('/issues/122047.json')
      .reply(200, {
        issue: {
          id: 122047,
          subject: 'Fix the login bug',
          project: { id: 51, name: 'Linways AMS V4' },
          tracker: { id: 1, name: 'Bug' },
          status: { id: 7, name: 'Development in Progress' },
          priority: { id: 4, name: 'Normal' },
          author: { id: 1, name: 'Tester' },
          created_on: '2026-01-01T00:00:00Z',
          updated_on: '2026-05-23T00:00:00Z',
        },
      });
    // Discovery: Redmine has the same issue in dev-active. Aligned.
    nock(fixture.baseUrl)
      .get('/issue_statuses.json')
      .reply(200, {
        issue_statuses: [
          { id: 7, name: 'Development in Progress', is_closed: false },
          { id: 8, name: 'Dev Analysis In Progress', is_closed: false },
        ],
      });
    nock(fixture.baseUrl)
      .get('/issues.json')
      .query((q: Record<string, string>) => q.status_id === '7')
      .reply(200, {
        issues: [{
          id: 122047, subject: 'Fix the login bug',
          project: { id: 51, name: 'Linways AMS V4' },
          tracker: { id: 1, name: 'Bug' },
          status: { id: 7, name: 'Development in Progress' },
          priority: { id: 4, name: 'Normal' },
          author: { id: 1, name: 'Tester' },
          created_on: '2026-01-01T00:00:00Z',
          updated_on: '2026-05-23T00:00:00Z',
        }],
        total_count: 1, offset: 0, limit: 25,
      });
    nock(fixture.baseUrl)
      .get('/issues.json')
      .query((q: Record<string, string>) => q.status_id === '8')
      .reply(200, { issues: [], total_count: 0, offset: 0, limit: 25 });

    const { envelope } = await runCommandAndCapture(
      home as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    const data = envelope.data as { context: { activeIssue: { id: number; freshness: string; status: string } | null; activeIssueCleared: unknown }; suggestions: { cmd: string; reason: string }[] };
    expect(data.context.activeIssue).not.toBeNull();
    expect(data.context.activeIssue!.id).toBe(122047);
    expect(data.context.activeIssue!.freshness).toBe('fresh');
    expect(data.context.activeIssue!.status).toBe('Development in Progress');
    expect(data.context.activeIssueCleared).toBeNull();
    // Fresh suggestion quotes status confidently.
    const active = data.suggestions.find(s => s.cmd === 'lwr issue current');
    expect(active!.reason).toContain('Development in Progress');
  });

  it('auto-clears the pointer when live-refresh finds the issue closed', async () => {
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 122047,
      subject: 'Fix the login bug',
      project: { id: 51, name: 'Linways AMS V4' },
      tracker: 'Bug',
      status: 'Development in Progress',
      setAt: '2026-05-22T08:00:00.000Z',
    };
    saveConfig(cfg);

    nock(fixture.baseUrl)
      .get('/issues/122047.json')
      .reply(200, {
        issue: {
          id: 122047,
          subject: 'Fix the login bug',
          project: { id: 51, name: 'Linways AMS V4' },
          tracker: { id: 1, name: 'Bug' },
          status: { id: 5, name: 'Closed' },
          priority: { id: 4, name: 'Normal' },
          author: { id: 1, name: 'Tester' },
          created_on: '2026-01-01T00:00:00Z',
          updated_on: '2026-05-23T00:00:00Z',
          closed_on: '2026-05-23T08:00:00Z',
        },
      });
    mockEmptyDiscovery();

    const { envelope } = await runCommandAndCapture(
      home as (f: Record<string, unknown>) => Promise<never>,
      {},
    );

    const data = envelope.data as {
      context: {
        activeIssue: unknown;
        activeIssueCleared: { previousId: number; currentStatus: string } | null;
      };
      suggestions: { cmd: string; reason: string; priority: number }[];
    };
    expect(data.context.activeIssue).toBeNull();
    expect(data.context.activeIssueCleared).not.toBeNull();
    expect(data.context.activeIssueCleared!.previousId).toBe(122047);
    expect(data.context.activeIssueCleared!.currentStatus).toBe('Closed');

    // Pointer on disk is gone.
    expect(loadConfig().profiles[fixture.profileName].activeIssue).toBeUndefined();

    // The clear announcement is in the suggestions (priority 1).
    const clear = data.suggestions.find(s => s.reason.includes('#122047') && s.reason.includes('Closed'));
    expect(clear).toBeDefined();
    expect(clear!.priority).toBe(1);
  });

  it('falls back to cached + stale freshness when live-refresh fails', async () => {
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 122047,
      subject: 'Fix the login bug',
      project: { id: 51, name: 'Linways AMS V4' },
      tracker: 'Bug',
      status: 'Development in Progress',
      setAt: '2026-01-01T00:00:00.000Z', // way old → stale
    };
    saveConfig(cfg);

    // Live-refresh AND discovery both fail (Redmine down).
    nock(fixture.baseUrl).get('/issues/122047.json').times(4).reply(503);
    nock(fixture.baseUrl).get('/issue_statuses.json').times(4).reply(503);

    const { envelope } = await runCommandAndCapture(
      home as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    const data = envelope.data as {
      context: { activeIssue: { freshness: string } | null };
      suggestions: { cmd: string; reason: string }[];
    };
    expect(data.context.activeIssue!.freshness).toBe('stale');
    // Reason text MUST NOT quote the cached status as if it were authoritative.
    const active = data.suggestions.find(s => s.cmd === 'lwr issue current');
    expect(active).toBeDefined();
    expect(active!.reason).not.toContain('Development in Progress');
    expect(active!.reason).toMatch(/Live status not verified/);
  }, 60_000);

  it('surfaces the last work-log date when one exists', async () => {
    mockEmptyDiscovery();
    fs.mkdirSync(workLogDir(), { recursive: true });
    fs.writeFileSync(path.join(workLogDir(), '2026-05-22.ndjson'), '{}\n');
    fs.writeFileSync(path.join(workLogDir(), '2026-05-20.ndjson'), '{}\n');

    const { envelope } = await runCommandAndCapture(
      home as (f: Record<string, unknown>) => Promise<never>,
      {},
    );

    const data = envelope.data as { suggestions: { cmd: string }[]; context: { lastWorkLogDate: string | null } };
    expect(data.context.lastWorkLogDate).toBe('2026-05-22');
    const review = data.suggestions.find(s => s.cmd.includes('lwr log show --date 2026-05-22'));
    expect(review).toBeDefined();
  });

  it('first-run (no base URL) short-circuits to a setup hint only', async () => {
    fs.rmSync(configFilePath(), { force: true });

    const { envelope } = await runCommandAndCapture(
      home as (f: Record<string, unknown>) => Promise<never>,
      {},
    );

    const data = envelope.data as {
      context: { configured: boolean; authed: boolean };
      suggestions: { cmd: string }[];
    };
    expect(data.context.configured).toBe(false);
    expect(data.suggestions).toHaveLength(1);
    expect(data.suggestions[0].cmd).toBe('lwr config base-url <url>');
  });

  it('configured-but-unauthed short-circuits to the login hint', async () => {
    const cfg = loadConfig();
    saveConfig({
      ...cfg,
      defaultBaseUrl: 'https://example.com',
      activeProfile: 'no-such-profile',
      profiles: {},
    });

    const { envelope } = await runCommandAndCapture(
      home as (f: Record<string, unknown>) => Promise<never>,
      {},
    );

    const data = envelope.data as {
      context: { configured: boolean; authed: boolean };
      suggestions: { cmd: string }[];
    };
    expect(data.context.configured).toBe(true);
    expect(data.context.authed).toBe(false);
    expect(data.suggestions).toHaveLength(1);
    expect(data.suggestions[0].cmd).toBe('lwr auth login');
  });

  it('falls back to issue list / time list when no priority signals are present', async () => {
    mockEmptyDiscovery();
    const { envelope } = await runCommandAndCapture(
      home as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    const data = envelope.data as { suggestions: { cmd: string }[] };
    const cmds = data.suggestions.map(s => s.cmd);
    expect(cmds).toContain('lwr issue list');
  });

  it('surfaces discoveredActiveIssue when local is empty but Redmine has one in-progress', async () => {
    // Local pointer stays empty. Redmine reports #126208 sitting in
    // 'Development in Progress' for the user — exactly the user's
    // original bug scenario.
    nock(fixture.baseUrl)
      .get('/issue_statuses.json')
      .reply(200, {
        issue_statuses: [
          { id: 7, name: 'Development in Progress', is_closed: false },
          { id: 8, name: 'Dev Analysis In Progress', is_closed: false },
        ],
      });
    nock(fixture.baseUrl)
      .get('/issues.json')
      .query((q: Record<string, string>) => q.status_id === '7')
      .reply(200, {
        issues: [{
          id: 126208, subject: 'Bug — Total Marks Displayed',
          project: { id: 51, name: 'Linways AMS V4' },
          tracker: { id: 1, name: 'Bug' },
          status: { id: 7, name: 'Development in Progress' },
          priority: { id: 4, name: 'Normal' },
          author: { id: 1, name: 'Tester' },
          created_on: '2026-01-01T00:00:00Z',
          updated_on: '2026-05-23T00:00:00Z',
        }],
        total_count: 1, offset: 0, limit: 25,
      });
    nock(fixture.baseUrl)
      .get('/issues.json')
      .query((q: Record<string, string>) => q.status_id === '8')
      .reply(200, { issues: [], total_count: 0, offset: 0, limit: 25 });

    const { envelope } = await runCommandAndCapture(
      home as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    const data = envelope.data as {
      context: { activeIssue: unknown; discoveredActiveIssue: { id: number; subject: string } | null };
      suggestions: { cmd: string; priority: number }[];
    };
    expect(data.context.activeIssue).toBeNull();
    expect(data.context.discoveredActiveIssue).not.toBeNull();
    expect(data.context.discoveredActiveIssue!.id).toBe(126208);
    // Suggestion guides the agent to offer adopting it.
    const adopt = data.suggestions.find(s => s.cmd === 'lwr issue use 126208');
    expect(adopt).toBeDefined();
    expect(adopt!.priority).toBe(1);
    // Pointer was NOT auto-adopted.
    expect(loadConfig().profiles[fixture.profileName].activeIssue).toBeUndefined();
  });

  it('surfaces mutexViolation when Redmine has > 1 in-progress for the user', async () => {
    nock(fixture.baseUrl)
      .get('/issue_statuses.json')
      .reply(200, {
        issue_statuses: [
          { id: 7, name: 'Development in Progress', is_closed: false },
          { id: 8, name: 'Dev Analysis In Progress', is_closed: false },
        ],
      });
    const issueShape = (id: number, statusId: number, statusName: string) => ({
      id, subject: `subj-${id}`,
      project: { id: 51, name: 'Linways AMS V4' },
      tracker: { id: 1, name: 'Bug' },
      status: { id: statusId, name: statusName },
      priority: { id: 4, name: 'Normal' },
      author: { id: 1, name: 'Tester' },
      created_on: '2026-01-01T00:00:00Z',
      updated_on: '2026-05-23T00:00:00Z',
    });
    nock(fixture.baseUrl)
      .get('/issues.json')
      .query((q: Record<string, string>) => q.status_id === '7')
      .reply(200, {
        issues: [issueShape(100, 7, 'Development in Progress'), issueShape(200, 7, 'Development in Progress')],
        total_count: 2, offset: 0, limit: 25,
      });
    nock(fixture.baseUrl)
      .get('/issues.json')
      .query((q: Record<string, string>) => q.status_id === '8')
      .reply(200, { issues: [], total_count: 0, offset: 0, limit: 25 });

    const { envelope } = await runCommandAndCapture(
      home as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    const data = envelope.data as {
      context: { mutexViolation: { issues: { id: number }[] } | null };
      suggestions: { reason: string; priority: number }[];
    };
    expect(data.context.mutexViolation).not.toBeNull();
    expect(data.context.mutexViolation!.issues.map(i => i.id).sort()).toEqual([100, 200]);
    // Top-priority suggestion is the mutex-violation ask.
    const top = data.suggestions[0];
    expect(top.priority).toBe(0);
    expect(top.reason).toContain('Mutex violation');
  });

  it('surfaces activeIssueConflict when local and Redmine disagree', async () => {
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 100,
      subject: 'pinned',
      project: { id: 51, name: 'Linways AMS V4' },
      tracker: 'Bug',
      status: 'Development in Progress',
      setAt: new Date().toISOString(),
    };
    saveConfig(cfg);

    // Live-refresh of local #100 returns it still in-progress (so the
    // pointer doesn't auto-clear). Discovery returns a DIFFERENT id
    // (#200) — that's the conflict.
    nock(fixture.baseUrl)
      .get('/issues/100.json')
      .reply(200, {
        issue: {
          id: 100, subject: 'pinned',
          project: { id: 51, name: 'Linways AMS V4' },
          tracker: { id: 1, name: 'Bug' },
          status: { id: 7, name: 'Development in Progress' },
          priority: { id: 4, name: 'Normal' },
          author: { id: 1, name: 'Tester' },
          created_on: '2026-01-01T00:00:00Z',
          updated_on: '2026-05-23T00:00:00Z',
        },
      });
    nock(fixture.baseUrl)
      .get('/issue_statuses.json')
      .reply(200, {
        issue_statuses: [
          { id: 7, name: 'Development in Progress', is_closed: false },
          { id: 8, name: 'Dev Analysis In Progress', is_closed: false },
        ],
      });
    nock(fixture.baseUrl)
      .get('/issues.json')
      .query((q: Record<string, string>) => q.status_id === '7')
      .reply(200, {
        issues: [{
          id: 200, subject: 'rogue',
          project: { id: 51, name: 'Linways AMS V4' },
          tracker: { id: 1, name: 'Bug' },
          status: { id: 7, name: 'Development in Progress' },
          priority: { id: 4, name: 'Normal' },
          author: { id: 1, name: 'Tester' },
          created_on: '2026-01-01T00:00:00Z',
          updated_on: '2026-05-23T00:00:00Z',
        }],
        total_count: 1, offset: 0, limit: 25,
      });
    nock(fixture.baseUrl)
      .get('/issues.json')
      .query((q: Record<string, string>) => q.status_id === '8')
      .reply(200, { issues: [], total_count: 0, offset: 0, limit: 25 });

    const { envelope } = await runCommandAndCapture(
      home as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    const data = envelope.data as {
      context: { activeIssueConflict: { local: { id: number }; redmine: { id: number } } | null };
      suggestions: { reason: string; priority: number }[];
    };
    expect(data.context.activeIssueConflict).not.toBeNull();
    expect(data.context.activeIssueConflict!.local.id).toBe(100);
    expect(data.context.activeIssueConflict!.redmine.id).toBe(200);
    // Top-priority suggestion is the conflict ask.
    const top = data.suggestions[0];
    expect(top.priority).toBe(0);
    expect(top.reason).toContain('conflict');
  });
});
