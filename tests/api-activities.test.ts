/**
 * Integration tests for `api/activities.ts`.
 *
 * Stubs `/enumerations/time_entry_activities.json` via nock and walks
 * three paths:
 *   1. cache miss → fetch + write
 *   2. cache hit (fresh) → no fetch
 *   3. --no-cache → fetch even when fresh
 *
 * Plus the pure resolver: name → id, ambiguous, unknown.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createClient } from '../src/foundation/client';
import { listActivities, resolveActivityId, defaultActivity } from '../src/api/activities';

const BASE = 'https://test.redmine';

function isolatedConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-test-'));
  process.env.LWR_CONFIG_DIR = dir;
  return dir;
}

describe('api/activities', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = isolatedConfigDir();
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    fs.rmSync(cfgDir, { recursive: true, force: true });
    delete process.env.LWR_CONFIG_DIR;
  });

  it('listActivities fetches on cache miss and writes the cache file', async () => {
    const scope = nock(BASE)
      .get('/enumerations/time_entry_activities.json')
      .reply(200, {
        time_entry_activities: [
          { id: 9, name: 'Development', is_default: false, active: true },
          { id: 15, name: 'Testing', is_default: false, active: true },
        ],
      });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    const out = await listActivities(client);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('Development');
    expect(scope.isDone()).toBe(true);
    // Cache file exists.
    expect(fs.existsSync(path.join(cfgDir, 'cache', 'activities.json'))).toBe(true);
  });

  it('listActivities serves from cache on second call (no second HTTP)', async () => {
    nock(BASE)
      .get('/enumerations/time_entry_activities.json')
      .reply(200, {
        time_entry_activities: [{ id: 9, name: 'Development', is_default: true, active: true }],
      });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    await listActivities(client);
    // Second call — no nock interceptor pending; if it tried to fetch
    // nock would throw "no match" (disableNetConnect is on).
    const out2 = await listActivities(client);
    expect(out2).toHaveLength(1);
    expect(nock.pendingMocks()).toHaveLength(0);
  });

  it('--no-cache forces a fetch even when fresh', async () => {
    nock(BASE)
      .get('/enumerations/time_entry_activities.json')
      .reply(200, { time_entry_activities: [{ id: 9, name: 'Development' }] });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    await listActivities(client);
    // Set up a second interceptor with different data; --no-cache should
    // hit it.
    nock(BASE)
      .get('/enumerations/time_entry_activities.json')
      .reply(200, { time_entry_activities: [{ id: 9, name: 'Development' }, { id: 15, name: 'Testing' }] });
    const out = await listActivities(client, { noCache: true });
    expect(out).toHaveLength(2);
  });

  it('resolveActivityId handles numeric, exact name, and case-insensitive name', () => {
    const list = [{ id: 9, name: 'Development' }, { id: 15, name: 'Testing' }];
    expect(resolveActivityId(list, 9)).toBe(9);
    expect(resolveActivityId(list, '9')).toBe(9);
    expect(resolveActivityId(list, 'Testing')).toBe(15);
    expect(resolveActivityId(list, 'testing')).toBe(15);
  });

  it('resolveActivityId throws on unknown name with the available list', () => {
    const list = [{ id: 9, name: 'Development' }];
    expect(() => resolveActivityId(list, 'Nope')).toThrow(/Unknown activity "Nope"/);
    expect(() => resolveActivityId(list, 'Nope')).toThrow(/Available: Development/);
  });

  it('defaultActivity prefers is_default; falls back to first', () => {
    expect(defaultActivity([{ id: 1, name: 'A' }, { id: 2, name: 'B', is_default: true }])).toMatchObject({ id: 2 });
    expect(defaultActivity([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])).toMatchObject({ id: 1 });
    expect(defaultActivity([])).toBeUndefined();
  });

  /**
   * If the instance has two activities with the same lowercased name
   * (e.g. an admin renamed one without retiring the duplicate), the
   * resolver uses Array.find which returns the FIRST match. Pin that
   * behaviour — agents that hit this can pass the numeric id to
   * disambiguate.
   */
  it('resolveActivityId returns the first match on duplicate names (no error)', () => {
    const list = [
      { id: 9, name: 'Development' },
      { id: 99, name: 'development' }, // same lowercased name
    ];
    expect(resolveActivityId(list, 'development')).toBe(9);
    expect(resolveActivityId(list, 'Development')).toBe(9);
    // Numeric escape hatch still works for the second entry.
    expect(resolveActivityId(list, 99)).toBe(99);
  });
});
