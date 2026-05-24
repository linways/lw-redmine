/**
 * End-to-end coverage for the per-command --dry-run shortcut.
 *
 * The test contract is sharper than "the function returns a preview":
 * we set up nock with NO mutation interceptor, so if any command
 * accidentally proceeds to a PUT/POST/DELETE under --dry-run, nock
 * raises "no match" and the test surfaces an error envelope instead
 * of a dry-run preview. Equivalent to the audit's check that "zero
 * nock interceptors are satisfied" for the mutation path.
 *
 * For `time delete`, dry-run also runs *before* `confirmDestructive`.
 * Vitest workers run in non-TTY context, so confirmDestructive without
 * --confirm/--yes throws — the test would surface that error if dry-run
 * didn't short-circuit first. The clean dry-run preview is therefore
 * proof of "dry-run runs before confirm".
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { setupTestProfile, runCommandAndCapture, type FixtureHandle } from './_helpers/profile-fixture';
import { note as issueNote } from '../src/commands/issue/note';
import { edit as timeEdit } from '../src/commands/time/edit';
import { del as timeDelete } from '../src/commands/time/delete';
import { log as timeLog } from '../src/commands/time/log';

describe('per-command --dry-run shortcuts (no mutation HTTP fires)', () => {
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

  it('issue.note --dry-run returns preview without touching the network', async () => {
    const { envelope } = await runCommandAndCapture(
      issueNote as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 12345,
        message: 'hello from dry-run',
        dryRun: true,
      },
    );

    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.dry_run).toBe(true);
    expect(data.method).toBe('PUT');
    expect(data.path).toBe('/issues/12345.json');
    // No nock interceptor was set up; if the command tried to PUT,
    // nock would have raised "no match" → envelope.ok === false.
    expect(nock.pendingMocks()).toHaveLength(0);
  });

  it('time.log --dry-run resolves activity name + body but skips the POST', async () => {
    // time.log calls listActivities (a GET) before dry-run. Allow it.
    nock(fixture.baseUrl)
      .get('/enumerations/time_entry_activities.json')
      .reply(200, {
        time_entry_activities: [
          { id: 9, name: 'Development', is_default: true, active: true },
        ],
      });

    const { envelope } = await runCommandAndCapture(
      timeLog as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 12345,
        hours: 1.5,
        activity: 'Development',
        dryRun: true,
      },
    );

    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.dry_run).toBe(true);
    expect(data.method).toBe('POST');
    expect(data.path).toBe('/time_entries.json');
    const payload = data.payload as { time_entry: Record<string, unknown> };
    expect(payload.time_entry).toMatchObject({
      issue_id: 12345,
      hours: 1.5,
      activity_id: 9,
    });
    // No POST interceptor; the GET is satisfied; nothing pending.
    expect(nock.pendingMocks()).toHaveLength(0);
  });

  it('time.edit --dry-run uses the api-layer body builder (Q4 contract)', async () => {
    nock(fixture.baseUrl)
      .get('/enumerations/time_entry_activities.json')
      .reply(200, {
        time_entry_activities: [{ id: 9, name: 'Development', active: true }],
      });

    const { envelope } = await runCommandAndCapture(
      timeEdit as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 22562,
        hours: 2.5,
        activity: 'Development',
        date: '2026-05-10',
        comments: 'Pairing',
        dryRun: true,
      },
    );

    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.dry_run).toBe(true);
    expect(data.method).toBe('PUT');
    expect(data.path).toBe('/time_entries/22562.json');
    const payload = data.payload as { time_entry: Record<string, unknown> };
    // Body shape comes from `toTimeEntryUpdateBody` — same function the
    // real PUT uses. If the dry-run preview drifts, this fails.
    expect(payload.time_entry).toEqual({
      hours: 2.5,
      activity_id: 9,
      spent_on: '2026-05-10',
      comments: 'Pairing',
    });
  });

  it('time.delete --dry-run runs BEFORE confirmDestructive (no --confirm needed)', async () => {
    // delete fetches the entry first; dry-run check is BEFORE confirm.
    nock(fixture.baseUrl)
      .get('/time_entries/22562.json')
      .reply(200, {
        time_entry: {
          id: 22562,
          hours: 2.5,
          spent_on: '2026-05-10',
          issue: { id: 12345 },
          project: { id: 1, name: 'Test' },
          user: { id: 1, name: 'Tester' },
          activity: { id: 9, name: 'Development' },
        },
      });

    // Note: --confirm and --yes are deliberately omitted. In a non-TTY
    // context (vitest workers), confirmDestructive would throw; dry-run
    // must short-circuit before that check.
    const { envelope } = await runCommandAndCapture(
      timeDelete as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 22562,
        dryRun: true,
      },
    );

    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.dry_run).toBe(true);
    expect(data.method).toBe('DELETE');
    expect(data.path).toBe('/time_entries/22562.json');
    // No DELETE interceptor; the GET fixture satisfied; nothing pending.
    expect(nock.pendingMocks()).toHaveLength(0);
  });

  it('time.delete WITHOUT --dry-run blocks on confirm in non-TTY (proves the gate works)', async () => {
    nock(fixture.baseUrl)
      .get('/time_entries/22562.json')
      .reply(200, {
        time_entry: {
          id: 22562,
          hours: 2.5,
          spent_on: '2026-05-10',
          project: { id: 1, name: 'Test' },
          user: { id: 1, name: 'Tester' },
          activity: { id: 9, name: 'Development' },
        },
      });

    const { envelope } = await runCommandAndCapture(
      timeDelete as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 22562,
        // no dryRun, no confirm, no yes — non-TTY non-interactive
      },
    );

    // Without dry-run, the confirm gate fires and rejects.
    expect(envelope.ok).toBe(false);
  });
});
