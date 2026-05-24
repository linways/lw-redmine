/**
 * End-to-end: the cross-agent preferences apply-path on issue mutations.
 *
 * This is the load-bearing test for the original 2026-05-12 incident:
 * `lwr issue status 124487 'Development Completed'` 422'd because the
 * workflow required the Tester CF. With a preferences file saying
 * "when Developer=57, set Tester=256", the PUT must now carry the
 * injected `custom_fields: [{ id: 88, value: 256 }]`.
 *
 * Verified via --dry-run so nock catches any accidental real PUT.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { setupTestProfile, runCommandAndCapture, type FixtureHandle } from './_helpers/profile-fixture';
import { statusVerb, closeVerb } from '../src/commands/issue/verbs';
import { edit as issueEdit } from '../src/commands/issue/edit';
import { create as issueCreate } from '../src/commands/issue/create';
import { savePreferences } from '../src/assistant/preferences';
import { preferencesFilePath } from '../src/foundation/paths';
import { ERROR_CODES, PREFERENCES_SCHEMA } from '../src/constants';

const FROZEN_NOW = '2026-05-12T00:00:00.000Z';

function seedSibinTesterRule(): void {
  savePreferences({
    schema: PREFERENCES_SCHEMA,
    updatedAt: FROZEN_NOW,
    rules: [
      {
        id: 'cf79-eq57-cf88',
        when: { cf: 79, cfName: 'Developer', equals: 57, equalsLabel: 'Sibin Baby' },
        set: [{ cf: 88, cfName: 'Tester', value: 256, valueLabel: 'Alex Biju' }],
        reason: 'User: my default tester is Alex when I am the developer',
        addedBy: 'claude-code',
        addedAt: FROZEN_NOW,
        lastTriggeredAt: null,
        triggerCount: 0,
      },
    ],
  });
}

function mockIssueFetch(baseUrl: string, opts: { developerId: number | null; testerId: number | null }): void {
  const cfs: Array<{ id: number; name: string; value: string | null }> = [];
  cfs.push({ id: 79, name: 'Developer', value: opts.developerId === null ? null : String(opts.developerId) });
  cfs.push({ id: 88, name: 'Tester', value: opts.testerId === null ? null : String(opts.testerId) });

  nock(baseUrl)
    .get('/issues/124487.json')
    .query(true) // any include= params
    .reply(200, {
      issue: {
        id: 124487,
        subject: 'Test',
        project: { id: 1, name: 'Test' },
        tracker: { id: 1, name: 'Bug' },
        priority: { id: 2, name: 'Normal' },
        status: { id: 1, name: 'In Progress' },
        author: { id: 1, name: 'Tester' },
        created_on: '2026-01-01T00:00:00Z',
        updated_on: '2026-05-01T00:00:00Z',
        custom_fields: cfs,
        allowed_statuses: [
          { id: 1, name: 'In Progress', is_closed: false },
          { id: 7, name: 'Development Completed', is_closed: false },
          { id: 10, name: 'Closed', is_closed: true },
        ],
      },
    });

  nock(baseUrl)
    .get('/issue_statuses.json')
    .reply(200, {
      issue_statuses: [
        { id: 1, name: 'In Progress', is_closed: false },
        { id: 7, name: 'Development Completed', is_closed: false },
        { id: 10, name: 'Closed', is_closed: true },
      ],
    });
}

describe('preferences apply-path on issue mutations', () => {
  let fixture: FixtureHandle;

  beforeEach(() => {
    fixture = setupTestProfile();
    nock.disableNetConnect();
    seedSibinTesterRule();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    fixture.cleanup();
  });

  // -----------------------------------------------------------------------
  // issue.status — the original incident
  // -----------------------------------------------------------------------

  it('issue.status --dry-run: rule fires when issue has Developer=57 and Tester is blank', async () => {
    mockIssueFetch(fixture.baseUrl, { developerId: 57, testerId: null });

    const { envelope } = await runCommandAndCapture(
      statusVerb as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 124487,
        status: 'Development Completed',
        dryRun: true,
      },
    );

    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.dry_run).toBe(true);
    expect(data.method).toBe('PUT');

    const body = (data.payload as { issue: Record<string, unknown> }).issue;
    const cfs = body.custom_fields as Array<Record<string, unknown>>;
    expect(cfs).toEqual([{ id: 88, value: 256 }]);

    const meta = envelope.meta as Record<string, unknown>;
    expect(meta).toBeDefined();
    const applied = meta.appliedDefaults as Array<Record<string, unknown>>;
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      rule: 'cf79-eq57-cf88',
      cf: 88,
      value: 256,
      source: 'preferences',
    });
  });

  it('issue.status --dry-run: rule does NOT fire when Tester is already set on the issue', async () => {
    mockIssueFetch(fixture.baseUrl, { developerId: 57, testerId: 999 });

    const { envelope } = await runCommandAndCapture(
      statusVerb as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 124487,
        status: 'Development Completed',
        dryRun: true,
      },
    );

    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    const body = (data.payload as { issue: Record<string, unknown> }).issue;
    expect(body.custom_fields).toBeUndefined();
    const meta = envelope.meta as Record<string, unknown> | undefined;
    expect(meta).toBeUndefined();
  });

  it('issue.status --dry-run: rule does NOT fire when Developer is someone else', async () => {
    mockIssueFetch(fixture.baseUrl, { developerId: 100, testerId: null });

    const { envelope } = await runCommandAndCapture(
      statusVerb as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 124487,
        status: 'Development Completed',
        dryRun: true,
      },
    );
    expect(envelope.ok).toBe(true);
    const body = ((envelope.data as Record<string, unknown>).payload as { issue: Record<string, unknown> }).issue;
    expect(body.custom_fields).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // issue.close — same plumbing, different verb
  // -----------------------------------------------------------------------

  it('issue.close --dry-run: rule fires when the closing transition needs a cf', async () => {
    mockIssueFetch(fixture.baseUrl, { developerId: 57, testerId: null });

    const { envelope } = await runCommandAndCapture(
      closeVerb as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 124487,
        dryRun: true,
      },
    );

    expect(envelope.ok).toBe(true);
    const body = ((envelope.data as Record<string, unknown>).payload as { issue: Record<string, unknown> }).issue;
    const cfs = body.custom_fields as Array<Record<string, unknown>>;
    expect(cfs).toEqual([{ id: 88, value: 256 }]);
  });

  // -----------------------------------------------------------------------
  // issue.edit — status change path
  // -----------------------------------------------------------------------

  it('issue.edit --dry-run: rule fires on a status transition', async () => {
    mockIssueFetch(fixture.baseUrl, { developerId: 57, testerId: null });

    const { envelope } = await runCommandAndCapture(
      issueEdit as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 124487,
        status: 'Development Completed',
        dryRun: true,
      },
    );

    expect(envelope.ok).toBe(true);
    const body = ((envelope.data as Record<string, unknown>).payload as { issue: Record<string, unknown> }).issue;
    const cfs = body.custom_fields as Array<Record<string, unknown>>;
    expect(cfs).toEqual([{ id: 88, value: 256 }]);

    const meta = envelope.meta as Record<string, unknown>;
    expect((meta.appliedDefaults as unknown[]).length).toBe(1);
  });

  it('issue.edit --dry-run: user --cf overrides the rule and skipped[] records it', async () => {
    mockIssueFetch(fixture.baseUrl, { developerId: 57, testerId: null });

    const { envelope } = await runCommandAndCapture(
      issueEdit as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 124487,
        status: 'Development Completed',
        cf: ['88=999'], // user explicitly sets Tester to a different value
        dryRun: true,
      },
    );

    expect(envelope.ok).toBe(true);
    const body = ((envelope.data as Record<string, unknown>).payload as { issue: Record<string, unknown> }).issue;
    // User wins; cf 88 carries 999, not 256.
    const cfs = body.custom_fields as Array<Record<string, unknown>>;
    expect(cfs.find(c => c.id === 88)?.value).toBe(999);
    // appliedDefaults is empty — rule didn't inject.
    const meta = envelope.meta as Record<string, unknown> | undefined;
    expect(meta?.appliedDefaults).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // issue.create — no current state, only user --cf
  // -----------------------------------------------------------------------

  it('issue.create --dry-run: rule fires when user passes --cf "Developer=57"', async () => {
    nock(fixture.baseUrl)
      .get('/projects.json')
      .query(true)
      .reply(200, { projects: [{ id: 1, name: 'Test', identifier: 'test', status: 1 }], total_count: 1 });

    const { envelope } = await runCommandAndCapture(
      issueCreate as (f: Record<string, unknown>) => Promise<never>,
      {
        project: 'test',
        subject: 'New issue',
        cf: ['79=57'],
        dryRun: true,
      },
    );

    expect(envelope.ok).toBe(true);
    const body = ((envelope.data as Record<string, unknown>).payload as { issue: Record<string, unknown> }).issue;
    const cfs = body.custom_fields as Array<Record<string, unknown>>;
    // Order: user --cf first, then injected default.
    expect(cfs).toEqual([
      { id: 79, value: 57 },
      { id: 88, value: 256 },
    ]);
  });

  // -----------------------------------------------------------------------
  // Negative path — malformed preferences file
  // -----------------------------------------------------------------------

  it('issue.status --dry-run: malformed preferences file surfaces a warning, command proceeds', async () => {
    // Replace the seeded file with junk.
    fs.writeFileSync(preferencesFilePath(), '{ corrupt');
    mockIssueFetch(fixture.baseUrl, { developerId: 57, testerId: null });

    const { envelope } = await runCommandAndCapture(
      statusVerb as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 124487,
        status: 'Development Completed',
        dryRun: true,
      },
    );

    expect(envelope.ok).toBe(true);
    const meta = envelope.meta as Record<string, unknown>;
    const warnings = meta.warnings as Array<Record<string, unknown>>;
    expect(warnings[0].code).toBe(ERROR_CODES.PREFERENCES_PARSE_ERROR);
    // No defaults applied (rules list is empty due to parse failure).
    expect(meta.appliedDefaults).toBeUndefined();
    // Payload doesn't carry custom_fields.
    const body = ((envelope.data as Record<string, unknown>).payload as { issue: Record<string, unknown> }).issue;
    expect(body.custom_fields).toBeUndefined();
  });
});

// Reference path imports used only for the `replace seeded file` test.
void path;
