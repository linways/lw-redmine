/**
 * Integration tests for `api/time-entries.ts`.
 *
 * Covers create / get / list / update / delete via nock — every public
 * function lwr's `time` commands depend on. Also verifies float-noise
 * rounding lands at the api boundary (the contract `roundHours` enforces
 * is only useful if it actually runs in this code path).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createClient } from '../src/foundation/client';
import {
  createTimeEntry,
  deleteTimeEntry,
  getTimeEntry,
  listTimeEntries,
  updateTimeEntry,
} from '../src/api/time-entries';
import { LwrError } from '../src/foundation/errors';
import { ERROR_CODES } from '../src/constants';

const BASE = 'https://test.redmine';

describe('api/time-entries', () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('createTimeEntry POSTs to /time_entries.json and rounds hours', async () => {
    nock(BASE)
      .post('/time_entries.json', body => {
        // Verify our payload mapping (camelCase → snake_case).
        return body.time_entry.issue_id === 125415
          && body.time_entry.hours === 2.5
          && body.time_entry.activity_id === 9;
      })
      .reply(201, {
        time_entry: {
          id: 22562,
          // Redmine will respond with the float-precision-noisy value;
          // we expect roundHours to clean it.
          hours: 2.500000023841858,
          spent_on: '2026-05-09',
          activity: { id: 9, name: 'Development' },
          issue: { id: 125415 },
          user: { id: 57, name: 'Jane Doe' },
          project: { id: 51, name: 'Linways AMS V4' },
          created_on: '2026-05-09T11:51:46Z',
          updated_on: '2026-05-09T11:51:46Z',
        },
      });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    const entry = await createTimeEntry(client, { issueId: 125415, hours: 2.5, activityId: 9 });
    expect(entry.id).toBe(22562);
    expect(entry.hours).toBe(2.5); // Rounded.
  });

  it('createTimeEntry refuses payloads with no issue+project', async () => {
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    await expect(
      createTimeEntry(client, { hours: 1, activityId: 9 } as any),
    ).rejects.toThrow(/issueId or projectId/);
  });

  it('getTimeEntry GETs and rounds hours', async () => {
    nock(BASE)
      .get('/time_entries/22562.json')
      .reply(200, {
        time_entry: {
          id: 22562,
          hours: 1.4500000476837158,
          spent_on: '2026-05-09',
          activity: { id: 9, name: 'Development' },
          user: { id: 57, name: 'Jane Doe' },
          project: { id: 51, name: 'Linways AMS V4' },
          created_on: '2026-05-09T11:51:46Z',
          updated_on: '2026-05-09T11:51:46Z',
        },
      });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    const entry = await getTimeEntry(client, 22562);
    expect(entry.hours).toBe(1.45);
  });

  it('getTimeEntry surfaces 404 as NotFoundError', async () => {
    nock(BASE).get('/time_entries/99999.json').reply(404, '');
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    await expect(getTimeEntry(client, 99999)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    });
  });

  it('listTimeEntries paginates with --all', async () => {
    nock(BASE)
      .get('/time_entries.json')
      .query(q => q.user_id === 'me' && q.limit === '100' && q.offset === '0')
      .reply(200, {
        time_entries: Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          hours: 1,
          spent_on: '2026-05-09',
          activity: { id: 9, name: 'Development' },
          user: { id: 57, name: 'Jane Doe' },
          project: { id: 51, name: 'P' },
          created_on: '2026-05-09T11:51:46Z',
          updated_on: '2026-05-09T11:51:46Z',
        })),
        total_count: 150,
        offset: 0,
        limit: 100,
      })
      .get('/time_entries.json')
      .query(q => q.user_id === 'me' && q.offset === '100')
      .reply(200, {
        time_entries: Array.from({ length: 50 }, (_, i) => ({
          id: 100 + i + 1,
          hours: 1,
          spent_on: '2026-05-09',
          activity: { id: 9, name: 'Development' },
          user: { id: 57, name: 'Jane Doe' },
          project: { id: 51, name: 'P' },
          created_on: '2026-05-09T11:51:46Z',
          updated_on: '2026-05-09T11:51:46Z',
        })),
        total_count: 150,
        offset: 100,
        limit: 100,
      });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    const result = await listTimeEntries(client, { userId: 'me', all: true });
    expect(result.entries).toHaveLength(150);
    expect(result.total).toBe(150);
  });

  it('listTimeEntries forwards date filters as `from`/`to`', async () => {
    nock(BASE)
      .get('/time_entries.json')
      .query(q => q.from === '2026-05-04' && q.to === '2026-05-09' && q.user_id === 'me')
      .reply(200, { time_entries: [], total_count: 0, offset: 0, limit: 25 });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    const result = await listTimeEntries(client, { userId: 'me', spentOnFrom: '2026-05-04', spentOnTo: '2026-05-09' });
    expect(result.total).toBe(0);
  });

  it('updateTimeEntry PUTs and re-fetches via getTimeEntry', async () => {
    nock(BASE).put('/time_entries/22562.json', body => body.time_entry.hours === 3.5).reply(204);
    nock(BASE)
      .get('/time_entries/22562.json')
      .reply(200, {
        time_entry: {
          id: 22562,
          hours: 3.5,
          spent_on: '2026-05-09',
          activity: { id: 9, name: 'Development' },
          user: { id: 57, name: 'Jane Doe' },
          project: { id: 51, name: 'P' },
          created_on: '2026-05-09T11:51:46Z',
          updated_on: '2026-05-09T11:51:46Z',
        },
      });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    const entry = await updateTimeEntry(client, 22562, { hours: 3.5 });
    expect(entry.hours).toBe(3.5);
  });

  it('deleteTimeEntry DELETEs and resolves on 204', async () => {
    nock(BASE).delete('/time_entries/22562.json').reply(204);
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    await expect(deleteTimeEntry(client, 22562)).resolves.toBeUndefined();
  });

  it('Redmine 422 surfaces as VALIDATION_API_REJECTED with extracted detail', async () => {
    nock(BASE)
      .post('/time_entries.json')
      .reply(422, { errors: ['Hours must be greater than 0', 'Activity is required'] });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    await expect(
      createTimeEntry(client, { issueId: 1, hours: 0, activityId: 9 }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_API_REJECTED,
      message: expect.stringContaining('Hours must be greater than 0'),
    });
  });
});
