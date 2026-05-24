/**
 * Unit tests for src/workflow/active-issue.ts — the staleness-safe
 * sync + refresh layer for `profile.activeIssue`.
 *
 * Five behaviours under test:
 *   1. `freshnessOf()` thresholds (fresh < 5min, aging < 2h, stale >).
 *   2. `syncActiveIssueFromPayload` updates the pointer when the issue
 *      matches but is still open.
 *   3. Same path clears the pointer when the issue has `closed_on` set.
 *   4. Same path is a no-op when the payload's id doesn't match.
 *   5. `liveRefreshActiveIssue` reports success + freshness=fresh on a
 *      successful GET, and surfaces auto-clear when the issue is closed.
 */

import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestProfile,
  type FixtureHandle,
} from './_helpers/profile-fixture';
import { saveConfig, loadConfig } from '../src/foundation/config';
import {
  freshnessOf,
  syncActiveIssueFromPayload,
  liveRefreshActiveIssue,
  reconcileActiveIssue,
  reconcileLiveActiveIssue,
  discoverActiveIssue,
  resetDiscoveryCache,
  type DiscoveryResult,
  type DiscoveredIssue,
} from '../src/workflow/active-issue';
import type { ActiveIssue } from '../src/foundation/config';
import type { RedmineIssue } from '../src/api/types';
import { createClient } from '../src/foundation/client';

function makeIssue(overrides: Partial<RedmineIssue> = {}): RedmineIssue {
  return {
    id: 100,
    subject: 'Test issue',
    project: { id: 1, name: 'P1' },
    tracker: { id: 1, name: 'Bug' },
    status: { id: 7, name: 'Development in Progress' },
    priority: { id: 4, name: 'Normal' },
    author: { id: 1, name: 'Author' },
    created_on: '2026-01-01T00:00:00Z',
    updated_on: '2026-05-23T00:00:00Z',
    ...overrides,
  };
}

describe('freshnessOf', () => {
  it('returns fresh when justRefreshed is true regardless of setAt', () => {
    expect(freshnessOf('2020-01-01T00:00:00.000Z', true)).toBe('fresh');
  });

  it('classifies < 5 min as fresh', () => {
    const setAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    expect(freshnessOf(setAt)).toBe('fresh');
  });

  it('classifies 5 min – 2 h as aging', () => {
    const setAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(freshnessOf(setAt)).toBe('aging');
  });

  it('classifies > 2 h as stale', () => {
    const setAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(freshnessOf(setAt)).toBe('stale');
  });

  it('returns stale for unparseable input', () => {
    expect(freshnessOf('not-a-date')).toBe('stale');
  });
});

describe('syncActiveIssueFromPayload', () => {
  let fixture: FixtureHandle;
  beforeEach(() => {
    fixture = setupTestProfile();
  });
  afterEach(() => fixture.cleanup());

  it('updates the pointer when the payload matches and the issue is still open', () => {
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 100,
      subject: 'old subject',
      project: { id: 1, name: 'P1' },
      tracker: 'Bug',
      status: 'old status',
      setAt: '2026-01-01T00:00:00.000Z',
    };
    saveConfig(cfg);

    const result = syncActiveIssueFromPayload(
      makeIssue({ subject: 'new subject', status: { id: 7, name: 'In Progress' } }),
      fixture.profileName,
    );

    expect(result.matched).toBe(true);
    expect(result.cleared).toBe(false);
    expect(result.updated).toBe(true);
    const reloaded = loadConfig().profiles[fixture.profileName].activeIssue!;
    expect(reloaded.subject).toBe('new subject');
    expect(reloaded.status).toBe('In Progress');
    // setAt was bumped to "now" — should be very recent.
    expect(Date.parse(reloaded.setAt)).toBeGreaterThan(Date.now() - 5_000);
  });

  it('clears the pointer when status is a terminal name (e.g. "Closed")', () => {
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 100,
      subject: 'still open',
      project: { id: 1, name: 'P1' },
      tracker: 'Bug',
      status: 'In Progress',
      setAt: '2026-01-01T00:00:00.000Z',
    };
    saveConfig(cfg);

    const result = syncActiveIssueFromPayload(
      makeIssue({ status: { id: 5, name: 'Closed' } }),
      fixture.profileName,
    );

    expect(result.matched).toBe(true);
    expect(result.cleared).toBe(true);
    expect(loadConfig().profiles[fixture.profileName].activeIssue).toBeUndefined();
  });

  it('does NOT clear when closed_on is set but status was reopened (regression)', () => {
    // Real Linways scenario: #111233 was closed in July 2025, then
    // reopened to "Development in Progress". Redmine preserves
    // closed_on as a "last closed at" timestamp; using it as a
    // boolean would incorrectly clear the active pointer the next
    // time any mutation (issue note, issue edit, etc.) flowed
    // through syncActiveIssueFromPayload.
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 100,
      subject: 'reopened ticket',
      project: { id: 1, name: 'P1' },
      tracker: 'Bug',
      status: 'Development in Progress',
      setAt: '2026-01-01T00:00:00.000Z',
    };
    saveConfig(cfg);

    const result = syncActiveIssueFromPayload(
      makeIssue({
        status: { id: 7, name: 'Development in Progress' },
        // Carry the stale closed_on from a prior close cycle.
        closed_on: '2025-07-19T14:02:57Z',
      }),
      fixture.profileName,
    );

    expect(result.matched).toBe(true);
    expect(result.cleared).toBe(false);
    expect(result.updated).toBe(true);
    // Pointer survives — it's still our active issue.
    expect(loadConfig().profiles[fixture.profileName].activeIssue?.id).toBe(100);
  });

  it('clears for every EFFECTIVELY_DONE name even when closed_on is absent', () => {
    // Belt-and-suspenders: terminal classification is driven entirely
    // by status name; closed_on doesn't even need to be present.
    const cfg = loadConfig();
    for (const name of ['Closed', 'Resolved', 'Rejected', 'Obsolete']) {
      cfg.profiles[fixture.profileName].activeIssue = {
        id: 100,
        subject: 'x',
        project: { id: 1, name: 'P1' },
        tracker: 'Bug',
        status: 'In Progress',
        setAt: '2026-01-01T00:00:00.000Z',
      };
      saveConfig(cfg);

      const result = syncActiveIssueFromPayload(
        makeIssue({ status: { id: 99, name } }),
        fixture.profileName,
      );
      expect(result.cleared, `cleared for status=${name}`).toBe(true);
      expect(loadConfig().profiles[fixture.profileName].activeIssue).toBeUndefined();
    }
  });

  it('is a no-op when the payload id does not match the pointer', () => {
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 100,
      subject: 'pinned',
      project: { id: 1, name: 'P1' },
      tracker: 'Bug',
      status: 'In Progress',
      setAt: '2026-01-01T00:00:00.000Z',
    };
    saveConfig(cfg);

    const result = syncActiveIssueFromPayload(makeIssue({ id: 200 }), fixture.profileName);

    expect(result.matched).toBe(false);
    expect(result.updated).toBe(false);
    expect(result.cleared).toBe(false);
    expect(loadConfig().profiles[fixture.profileName].activeIssue!.id).toBe(100);
  });
});

describe('liveRefreshActiveIssue', () => {
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

  it('refreshes the pointer and reports freshness=fresh on success', async () => {
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 100,
      subject: 'old',
      project: { id: 1, name: 'P1' },
      tracker: 'Bug',
      status: 'In Progress',
      setAt: '2026-01-01T00:00:00.000Z',
    };
    saveConfig(cfg);

    nock(fixture.baseUrl)
      .get('/issues/100.json')
      .reply(200, {
        issue: {
          id: 100,
          subject: 'updated subject',
          project: { id: 1, name: 'P1' },
          tracker: { id: 1, name: 'Bug' },
          status: { id: 7, name: 'In Progress' },
          priority: { id: 4, name: 'Normal' },
          author: { id: 1, name: 'A' },
          created_on: '2026-01-01T00:00:00Z',
          updated_on: '2026-05-23T00:00:00Z',
        },
      });

    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const outcome = await liveRefreshActiveIssue(client, fixture.profileName);

    expect(outcome.performed).toBe(true);
    expect(outcome.succeeded).toBe(true);
    expect(outcome.freshness).toBe('fresh');
    expect(outcome.cleared).toBe(false);
    expect(outcome.currentStatus).toBe('In Progress');
    expect(loadConfig().profiles[fixture.profileName].activeIssue!.subject).toBe('updated subject');
  });

  it('reports cleared=true when the refresh finds a closed status', async () => {
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 100,
      subject: 'was open',
      project: { id: 1, name: 'P1' },
      tracker: 'Bug',
      status: 'In Progress',
      setAt: '2026-01-01T00:00:00.000Z',
    };
    saveConfig(cfg);

    nock(fixture.baseUrl)
      .get('/issues/100.json')
      .reply(200, {
        issue: {
          id: 100,
          subject: 'was open',
          project: { id: 1, name: 'P1' },
          tracker: { id: 1, name: 'Bug' },
          status: { id: 5, name: 'Closed' },
          priority: { id: 4, name: 'Normal' },
          author: { id: 1, name: 'A' },
          created_on: '2026-01-01T00:00:00Z',
          updated_on: '2026-05-23T00:00:00Z',
          closed_on: '2026-05-23T00:00:00Z',
        },
      });

    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const outcome = await liveRefreshActiveIssue(client, fixture.profileName);

    expect(outcome.cleared).toBe(true);
    expect(outcome.currentStatus).toBe('Closed');
    expect(loadConfig().profiles[fixture.profileName].activeIssue).toBeUndefined();
  });

  it('no-ops when no activeIssue is set', async () => {
    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const outcome = await liveRefreshActiveIssue(client, fixture.profileName);
    expect(outcome.performed).toBe(false);
    expect(outcome.succeeded).toBe(false);
  });
});

describe('reconcileActiveIssue', () => {
  function discovery(kind: DiscoveryResult['kind'], items: DiscoveredIssue[] = []): DiscoveryResult {
    return {
      kind,
      issues: items,
      issue: items.length === 1 && kind === 'single' ? items[0] : null,
      mutexViolation: kind === 'ambiguous',
      full: [],
      fromCache: false,
    };
  }

  function active(id: number, subject = 'pinned'): ActiveIssue {
    return {
      id,
      subject,
      project: { id: 1, name: 'P1' },
      tracker: 'Bug',
      status: 'In Progress',
      setAt: '2026-05-23T00:00:00.000Z',
    };
  }

  function disc(id: number, subject = 'redmine'): DiscoveredIssue {
    return {
      id,
      subject,
      status: 'Development in Progress',
      project: { id: 1, name: 'P1' },
      tracker: 'Bug',
    };
  }

  it('no local + no discovery → no-active', () => {
    expect(reconcileActiveIssue(undefined, discovery('none')).kind).toBe('no-active');
  });

  it('no local + single discovery → discovered', () => {
    const result = reconcileActiveIssue(undefined, discovery('single', [disc(100)]));
    expect(result.kind).toBe('discovered');
    if (result.kind === 'discovered') expect(result.discovered.id).toBe(100);
  });

  it('no local + ambiguous discovery → mutex-violation', () => {
    const result = reconcileActiveIssue(
      undefined,
      discovery('ambiguous', [disc(100), disc(200)]),
    );
    expect(result.kind).toBe('mutex-violation');
    if (result.kind === 'mutex-violation') expect(result.issues).toHaveLength(2);
  });

  it('local set + no discovery → local-only', () => {
    const result = reconcileActiveIssue(active(100), discovery('none'));
    expect(result.kind).toBe('local-only');
    if (result.kind === 'local-only') expect(result.local.id).toBe(100);
  });

  it('local set + single discovery, same id → aligned', () => {
    const result = reconcileActiveIssue(active(100), discovery('single', [disc(100)]));
    expect(result.kind).toBe('aligned');
  });

  it('local set + single discovery, different id → conflict', () => {
    const result = reconcileActiveIssue(active(100), discovery('single', [disc(200)]));
    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') {
      expect(result.local.id).toBe(100);
      expect(result.redmine.id).toBe(200);
    }
  });

  it('local set + ambiguous discovery → mutex-violation (wins over conflict)', () => {
    const result = reconcileActiveIssue(
      active(100),
      discovery('ambiguous', [disc(200), disc(300)]),
    );
    expect(result.kind).toBe('mutex-violation');
  });
});

describe('discoverActiveIssue (cache)', () => {
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

  /** Mock listStatuses + 2 listIssues (one per DEV_ACTIVE status) returning empty. */
  function mockEmptyDiscoveryOnce(): void {
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

  it('caches the result for 60 s; second call within the window is a cache hit', async () => {
    mockEmptyDiscoveryOnce(); // only one set of mocks → if cache misses, second call fails

    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const profile = loadConfig().profiles[fixture.profileName];

    const first = await discoverActiveIssue(client, profile);
    expect(first.fromCache).toBe(false);
    expect(first.kind).toBe('none');

    const second = await discoverActiveIssue(client, profile);
    expect(second.fromCache).toBe(true);
    expect(second.kind).toBe('none');
    // Importantly, nock would error if a second set of HTTP calls leaked through.
    expect(nock.isDone()).toBe(true);
  });

  it('noCache:true forces a fresh query', async () => {
    // listStatuses is cached on disk (~/.lwr/cache/statuses.json) after
    // the first call, so we only mock that endpoint ONCE. The discovery
    // listIssues calls always run; mock them twice (one set per call).
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
      .times(4) // 2 dev-active statuses × 2 invocations
      .reply(200, { issues: [], total_count: 0, offset: 0, limit: 25 });

    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const profile = loadConfig().profiles[fixture.profileName];

    const first = await discoverActiveIssue(client, profile);
    expect(first.fromCache).toBe(false);

    const forced = await discoverActiveIssue(client, profile, { noCache: true });
    expect(forced.fromCache).toBe(false);
    expect(nock.isDone()).toBe(true);
  });
});

describe('reconcileLiveActiveIssue (skip-refresh fast path)', () => {
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

  it('uses the discovery payload to refresh (no separate GET /issues/<id>)', async () => {
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 100,
      subject: 'cached subject',
      project: { id: 1, name: 'P1' },
      tracker: 'Bug',
      status: 'In Progress',
      setAt: '2026-01-01T00:00:00.000Z',
    };
    saveConfig(cfg);

    // ONLY mock the discovery dance. NO mock for GET /issues/100.json —
    // if reconcile tries to hit it, the test fails with nock error.
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
          id: 100, subject: 'updated subject',
          project: { id: 1, name: 'P1' },
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

    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const outcome = await reconcileLiveActiveIssue(client, fixture.profileName);

    expect(outcome.verdict.kind).toBe('aligned');
    expect(outcome.refresh).not.toBeNull();
    expect(outcome.refresh!.succeeded).toBe(true);
    expect(outcome.refresh!.freshness).toBe('fresh');
    // Pointer was synced from the discovery payload → subject updated.
    expect(loadConfig().profiles[fixture.profileName].activeIssue!.subject).toBe('updated subject');
    // Discovery exhausted all mocks — no refresh GET was issued.
    expect(nock.isDone()).toBe(true);
  });

  it('falls back to GET /issues/<id> when local.id is not in discovery', async () => {
    const cfg = loadConfig();
    cfg.profiles[fixture.profileName].activeIssue = {
      id: 100, subject: 'pinned',
      project: { id: 1, name: 'P1' },
      tracker: 'Bug',
      status: 'In Progress',
      setAt: '2026-01-01T00:00:00.000Z',
    };
    saveConfig(cfg);

    // Discovery returns empty → reconcile must do a refresh GET to learn about #100.
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
    nock(fixture.baseUrl)
      .get('/issues/100.json')
      .reply(200, {
        issue: {
          id: 100, subject: 'pinned',
          project: { id: 1, name: 'P1' },
          tracker: { id: 1, name: 'Bug' },
          status: { id: 99, name: 'Paused' },
          priority: { id: 4, name: 'Normal' },
          author: { id: 1, name: 'Tester' },
          created_on: '2026-01-01T00:00:00Z',
          updated_on: '2026-05-23T00:00:00Z',
        },
      });

    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const outcome = await reconcileLiveActiveIssue(client, fixture.profileName);

    expect(outcome.verdict.kind).toBe('local-only');
    expect(outcome.refresh).not.toBeNull();
    expect(outcome.refresh!.succeeded).toBe(true);
    expect(nock.isDone()).toBe(true);
  });
});
