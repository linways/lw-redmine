/**
 * `pauseActivePointerIfDevActive` + integration via `lwr issue resolve` and
 * `lwr issue pause`.
 *
 * The systematic-logging rule: every work mutation on a NON-active issue
 * must pause the active one first (no transient-interrupt exceptions). The
 * helper enforces this for verbs that don't land in DEV_ACTIVE (so the
 * post-PUT `enforceDevActiveMutex` sweep doesn't fire). And `issue pause`
 * now syncs the local pointer's status after the PUT so daily-rollover
 * the next morning doesn't false-positive on the stale snapshot.
 */

import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestProfile,
  runCommandAndCapture,
  type FixtureHandle,
} from './_helpers/profile-fixture';
import { saveConfig, loadConfig } from '../src/foundation/config';
import { createClient } from '../src/foundation/client';
import {
  pauseActivePointerIfDevActive,
  previewInterruptPause,
} from '../src/workflow/auto-pause';
import { resolve as resolveCmd } from '../src/commands/issue/resolve';
import { pauseIssue } from '../src/commands/issue/pause';

/** Standard Linways-shaped status list used by every test below. */
const STATUSES = [
  { id: 7, name: 'Development in Progress', is_closed: false },
  { id: 8, name: 'Dev Analysis In Progress', is_closed: false },
  { id: 10, name: 'Paused', is_closed: false },
  { id: 15, name: 'Resolved', is_closed: false },
];

function mockStatuses(baseUrl: string): void {
  nock(baseUrl).get('/issue_statuses.json').reply(200, { issue_statuses: STATUSES });
}

function makeIssuePayload(id: number, statusId: number, statusName: string) {
  return {
    issue: {
      id,
      subject: `Issue ${id}`,
      project: { id: 1, name: 'P1' },
      tracker: { id: 1, name: 'Bug' },
      status: { id: statusId, name: statusName },
      priority: { id: 4, name: 'Normal' },
      author: { id: 1, name: 'Tester' },
      custom_fields: [],
      created_on: '2026-01-01T00:00:00Z',
      updated_on: '2026-05-23T00:00:00Z',
      allowed_statuses: STATUSES.map(s => ({ ...s })),
    },
  };
}

/**
 * `updateIssue` PUTs then re-GETs the issue (Redmine PUT returns 204; we
 * re-fetch with include=detail). Tests have to mock BOTH the PUT and the
 * follow-up GET, or the GET hangs and the command surfaces NETWORK_TIMEOUT.
 */
function mockPutAndRefetch(baseUrl: string, id: number, postState: { statusId: number; statusName: string }): void {
  nock(baseUrl)
    .put(`/issues/${id}.json`)
    .reply(200, makeIssuePayload(id, postState.statusId, postState.statusName));
  nock(baseUrl)
    .get(`/issues/${id}.json`).query(true)
    .reply(200, makeIssuePayload(id, postState.statusId, postState.statusName));
}

function seedPointer(profileName: string, id: number, status: string): void {
  const cfg = loadConfig();
  cfg.profiles[profileName].activeIssue = {
    id,
    subject: `Issue ${id}`,
    project: { id: 1, name: 'P1' },
    tracker: 'Bug',
    status,
    setAt: new Date(Date.now() - 60_000).toISOString(),
  };
  saveConfig(cfg);
}

describe('pauseActivePointerIfDevActive', () => {
  let fixture: FixtureHandle;
  beforeEach(() => {
    fixture = setupTestProfile();
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    fixture.cleanup();
  });

  it('skips with no-active when the profile has no pointer', async () => {
    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const result = await pauseActivePointerIfDevActive(client, 12345, fixture.profileName);
    expect(result.paused).toBeNull();
    expect(result.skipped).toBe('no-active');
  });

  it('skips with same-issue when the target IS the active pointer', async () => {
    seedPointer(fixture.profileName, 99, 'Development in Progress');
    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const result = await pauseActivePointerIfDevActive(client, 99, fixture.profileName);
    expect(result.paused).toBeNull();
    expect(result.skipped).toBe('same-issue');
  });

  it('skips with not-dev-active when the active is already paused on Redmine', async () => {
    seedPointer(fixture.profileName, 99, 'Development in Progress'); // stale snapshot
    nock(fixture.baseUrl)
      .get('/issues/99.json').query(true)
      .reply(200, makeIssuePayload(99, 10, 'Paused')); // Redmine truth: already paused
    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const result = await pauseActivePointerIfDevActive(client, 12345, fixture.profileName);
    expect(result.paused).toBeNull();
    expect(result.skipped).toBe('not-dev-active');
  });

  it('pauses the active when its live status is in DEV_ACTIVE_STATUS_NAMES', async () => {
    seedPointer(fixture.profileName, 99, 'Development in Progress');
    // First GET: helper reads live state.
    nock(fixture.baseUrl)
      .get('/issues/99.json').query(true)
      .reply(200, makeIssuePayload(99, 7, 'Development in Progress'));
    mockStatuses(fixture.baseUrl);
    // PUT body must include the auto-pause note referencing the interrupt target.
    nock(fixture.baseUrl)
      .put('/issues/99.json', (body: { issue?: { status_id?: number; notes?: string } }) => {
        return body.issue?.status_id === 10
          && typeof body.issue.notes === 'string'
          && body.issue.notes.includes('#12345');
      })
      .reply(200, makeIssuePayload(99, 10, 'Paused'));
    // updateIssue re-fetches after PUT (the result feeds syncActiveIssueFromPayload).
    nock(fixture.baseUrl)
      .get('/issues/99.json').query(true)
      .reply(200, makeIssuePayload(99, 10, 'Paused'));

    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const result = await pauseActivePointerIfDevActive(client, 12345, fixture.profileName);

    expect(result.skipped).toBeNull();
    expect(result.paused).toEqual({ id: 99, previousStatus: 'Development in Progress', newStatus: 'Paused' });

    // Pointer's status snapshot is now Paused — the sync ran.
    const ptr = loadConfig().profiles[fixture.profileName].activeIssue;
    expect(ptr?.status).toBe('Paused');
  });

  it('reports failed when the pause PUT throws (e.g. workflow guard rejects)', async () => {
    seedPointer(fixture.profileName, 99, 'Development in Progress');
    // Live read returns dev-active so the helper proceeds to PUT.
    nock(fixture.baseUrl)
      .get('/issues/99.json').query(true)
      .reply(200, makeIssuePayload(99, 7, 'Development in Progress'));
    mockStatuses(fixture.baseUrl);
    nock(fixture.baseUrl)
      .put('/issues/99.json')
      .reply(422, { errors: ['Status is not allowed'] });
    // No re-fetch — the PUT errored before the re-fetch would run.

    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const result = await pauseActivePointerIfDevActive(client, 12345, fixture.profileName);

    expect(result.paused).toBeNull();
    expect(result.skipped).toBe('failed');
    expect(result.failureReason).toBeDefined();
  });
});

describe('previewInterruptPause (dry-run twin)', () => {
  let fixture: FixtureHandle;
  beforeEach(() => {
    fixture = setupTestProfile();
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    fixture.cleanup();
  });

  it('returns the would-pause without firing the PUT', async () => {
    seedPointer(fixture.profileName, 99, 'Development in Progress');
    nock(fixture.baseUrl)
      .get('/issues/99.json').query(true)
      .reply(200, makeIssuePayload(99, 7, 'Development in Progress'));
    // No mock for PUT — the dry-run must not call it.

    const client = createClient({ baseUrl: fixture.baseUrl, apiKey: 'k' });
    const result = await previewInterruptPause(client, 12345, fixture.profileName);
    expect(result.paused).toEqual({ id: 99, previousStatus: 'Development in Progress', newStatus: 'Paused' });
    expect(result.skipped).toBeNull();
  });
});

describe('lwr issue resolve — interrupt-pause integration', () => {
  let fixture: FixtureHandle;
  beforeEach(() => {
    fixture = setupTestProfile();
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    fixture.cleanup();
  });

  it('pauses the dev-active pointer first, then resolves the target', async () => {
    seedPointer(fixture.profileName, 99, 'Development in Progress');

    // 1. interruptPause: GET active live state.
    nock(fixture.baseUrl)
      .get('/issues/99.json').query(true)
      .reply(200, makeIssuePayload(99, 7, 'Development in Progress'));
    // statuses (read once; second listStatuses lands on disk cache).
    mockStatuses(fixture.baseUrl);
    // 2. interruptPause: PUT active → Paused + the updateIssue re-fetch.
    mockPutAndRefetch(fixture.baseUrl, 99, { statusId: 10, statusName: 'Paused' });
    // 3. resolve: GET target with allowed_statuses.
    nock(fixture.baseUrl)
      .get('/issues/12345.json').query(true)
      .reply(200, makeIssuePayload(12345, 7, 'Development in Progress'));
    // 4. resolve: PUT target → Resolved + the updateIssue re-fetch.
    nock(fixture.baseUrl)
      .put('/issues/12345.json', (body: { issue?: { status_id?: number } }) => body.issue?.status_id === 15)
      .reply(200, makeIssuePayload(12345, 15, 'Resolved'));
    nock(fixture.baseUrl)
      .get('/issues/12345.json').query(true)
      .reply(200, makeIssuePayload(12345, 15, 'Resolved'));

    const { envelope, exitCode } = await runCommandAndCapture(
      resolveCmd as (f: Record<string, unknown>) => Promise<never>,
      { id: '12345' },
    );

    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.resolved).toEqual({ id: 12345, previousStatus: 'Development in Progress', newStatus: 'Resolved' });
    expect(data.interruptPause).toBeDefined();
    const ip = data.interruptPause as { paused: { id: number; newStatus: string } | null; skipped: string | null };
    expect(ip.paused).toEqual({ id: 99, previousStatus: 'Development in Progress', newStatus: 'Paused' });
    expect(ip.skipped).toBeNull();
  });

  it('skips the interrupt-pause when the resolve target IS the active pointer', async () => {
    seedPointer(fixture.profileName, 12345, 'Development in Progress');

    // No interrupt-helper GET — same-issue short-circuit fires first.
    nock(fixture.baseUrl)
      .get('/issues/12345.json').query(true)
      .reply(200, makeIssuePayload(12345, 7, 'Development in Progress'));
    mockStatuses(fixture.baseUrl);
    mockPutAndRefetch(fixture.baseUrl, 12345, { statusId: 15, statusName: 'Resolved' });

    const { envelope } = await runCommandAndCapture(
      resolveCmd as (f: Record<string, unknown>) => Promise<never>,
      { id: '12345' },
    );

    const data = envelope.data as { interruptPause: { skipped: string | null }; pointerCleared: boolean };
    expect(data.interruptPause.skipped).toBe('same-issue');
    expect(data.pointerCleared).toBe(true); // target was the pointer → cleared
  });
});

describe('lwr issue pause — pointer sync after PUT', () => {
  let fixture: FixtureHandle;
  beforeEach(() => {
    fixture = setupTestProfile();
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    fixture.cleanup();
  });

  it('updates the pointer snapshot from "Development in Progress" → "Paused" after the PUT', async () => {
    seedPointer(fixture.profileName, 99, 'Development in Progress');

    nock(fixture.baseUrl)
      .get('/issues/99.json').query(true)
      .reply(200, makeIssuePayload(99, 7, 'Development in Progress'));
    mockStatuses(fixture.baseUrl);
    // PUT + updateIssue's re-fetch.
    mockPutAndRefetch(fixture.baseUrl, 99, { statusId: 10, statusName: 'Paused' });

    const { envelope, exitCode } = await runCommandAndCapture(
      pauseIssue as (f: Record<string, unknown>) => Promise<never>,
      {},
    );

    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.previousStatus).toBe('Development in Progress');
    expect(data.newStatus).toBe('Paused');

    // The pointer snapshot is the load-bearing assertion: stale 'Development
    // in Progress' would have caused the next daily-rollover preflight to
    // falsely warn "you didn't pause!".
    const ptr = loadConfig().profiles[fixture.profileName].activeIssue;
    expect(ptr?.id).toBe(99); // pointer stays set (pause != clear)
    expect(ptr?.status).toBe('Paused');
  });
});
