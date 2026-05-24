/**
 * Integration tests for `api/issues.ts` (the issue CRUD layer).
 *
 * Focus on the paths the agent surface depends on:
 *   - getIssue rounds float-precision noise on hours
 *   - updateIssue PUTs + re-fetches
 *   - addNote convenience wrapper
 *   - listIssues forwards filters correctly (project, --as cf id, sort)
 *   - createIssue POSTs and rounds
 *   - 404 / 422 / network failures surface as typed LwrError codes
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createClient } from '../src/foundation/client';
import {
  addNote,
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
} from '../src/api/issues';
import { ERROR_CODES } from '../src/constants';

const BASE = 'https://test.redmine';

const RAW_ISSUE = {
  id: 125415,
  subject: 'Test',
  project: { id: 51, name: 'AMS' },
  tracker: { id: 4, name: 'Enhancement' },
  status: { id: 72, name: 'Dev Analysis Completed' },
  priority: { id: 5, name: 'Immediate' },
  author: { id: 232, name: 'Lakshmi N' },
  // Floats with precision noise — should be rounded by `normaliseIssue`.
  estimated_hours: 2.0000000023841858,
  spent_hours: 2.500000023841858,
  total_estimated_hours: 2.0000000023841858,
  total_spent_hours: 2.500000023841858,
  created_on: '2026-04-22T07:29:17Z',
  updated_on: '2026-05-09T11:13:40Z',
};

describe('api/issues', () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('getIssue rounds estimated_hours / spent_hours / total_*', async () => {
    nock(BASE).get('/issues/125415.json').reply(200, { issue: RAW_ISSUE });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    const issue = await getIssue(client, 125415);
    expect(issue.estimated_hours).toBe(2);
    expect(issue.spent_hours).toBe(2.5);
    // total_* aren't typed but should still be cleaned in place.
    const extras = issue as unknown as { total_estimated_hours?: number; total_spent_hours?: number };
    expect(extras.total_estimated_hours).toBe(2);
    expect(extras.total_spent_hours).toBe(2.5);
  });

  it('getIssue forwards include flags (allowed_statuses, detail)', async () => {
    nock(BASE)
      .get('/issues/1.json')
      .query(q => typeof q.include === 'string' && q.include.includes('allowed_statuses'))
      .reply(200, { issue: { ...RAW_ISSUE, id: 1 } });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    await expect(getIssue(client, 1, { allowedStatuses: true })).resolves.toMatchObject({ id: 1 });
  });

  it('updateIssue PUTs and re-fetches', async () => {
    nock(BASE)
      .put('/issues/125415.json', body => body.issue.status_id === 78)
      .reply(204)
      .get('/issues/125415.json')
      .query(true)
      .reply(200, { issue: { ...RAW_ISSUE, status: { id: 78, name: 'Resolved' } } });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    const issue = await updateIssue(client, 125415, { statusId: 78 });
    expect(issue.status.name).toBe('Resolved');
  });

  it('addNote sends only `notes` in the issue body', async () => {
    nock(BASE)
      .put('/issues/125415.json', body => {
        // Only `notes` should be set; no other fields.
        return body.issue.notes === 'hello' && Object.keys(body.issue).length === 1;
      })
      .reply(204)
      .get('/issues/125415.json')
      .query(true)
      .reply(200, { issue: RAW_ISSUE });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    await expect(addNote(client, 125415, 'hello')).resolves.toMatchObject({ id: 125415 });
  });

  it('createIssue POSTs and rounds the response', async () => {
    nock(BASE)
      .post('/issues.json', body => body.issue.subject === 'New' && body.issue.project_id === 51)
      .reply(201, { issue: { ...RAW_ISSUE, id: 9999, subject: 'New' } });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    const issue = await createIssue(client, { projectId: 51, subject: 'New' });
    expect(issue.id).toBe(9999);
    expect(issue.spent_hours).toBe(2.5);
  });

  it('listIssues forwards cf filters as cf_<id>=<value>', async () => {
    nock(BASE)
      .get('/issues.json')
      .query(q => q.cf_79 === '57' && q.project_id === '51')
      .reply(200, { issues: [], total_count: 0, offset: 0, limit: 25 });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    const result = await listIssues(client, { projectId: 51, customFieldFilters: { 79: 57 } });
    expect(result.total).toBe(0);
  });

  it('listIssues forwards sort + assigned_to=me + fixed_version_id', async () => {
    nock(BASE)
      .get('/issues.json')
      .query(q => q.sort === 'priority:desc' && q.assigned_to_id === 'me' && q.fixed_version_id === '1055')
      .reply(200, { issues: [], total_count: 0, offset: 0, limit: 25 });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    await listIssues(client, { sort: 'priority:desc', assignedTo: 'me', fixedVersionId: 1055 });
  });

  it('404 surfaces as NOT_FOUND with the issue id in the resource hint', async () => {
    nock(BASE).get('/issues/999.json').reply(404, '');
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    await expect(getIssue(client, 999)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
      message: expect.stringContaining('999'),
    });
  });

  it('422 errors[] body is concatenated into the LwrError message', async () => {
    nock(BASE)
      .put('/issues/125415.json')
      .reply(422, { errors: ['Status is invalid', 'Subject cannot be blank'] });
    const client = createClient({ baseUrl: BASE, apiKey: 'k' });
    await expect(updateIssue(client, 125415, { subject: '' })).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_API_REJECTED,
      message: expect.stringContaining('Subject cannot be blank'),
    });
  });
});
