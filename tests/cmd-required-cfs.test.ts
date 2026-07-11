/**
 * End-to-end: the required-CF guard on `issue status` / `issue close`.
 *
 * Teams declare "status X requires CFs A, B" in
 * `~/.lwr/facts/required-cfs.json` (Redmine's own required-field metadata
 * is admin-only, so it can't be read via the API). After prefs are applied
 * but before the PUT, the guard checks the target status's required CFs:
 *   - mode "warn"  → warnings in `meta.requiredCfWarnings`, mutation proceeds
 *   - mode "block" → LwrError MISSING_REQUIRED_CF, the PUT never fires
 *   - --force      → block is bypassed
 *   - malformed file → guard skipped with REQUIRED_CFS_PARSE_ERROR in
 *     `meta.warnings[]` (a typo must never silently disable the guard),
 *     mutation proceeds
 *
 * Verified against nock: in the block case the PUT is deliberately NOT
 * mocked, so if the code fired it, nock would throw — proving the refusal
 * happened first.
 */

import fs from 'node:fs';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { setupTestProfile, runCommandAndCapture, type FixtureHandle } from './_helpers/profile-fixture';
import { statusVerb } from '../src/commands/issue/verbs';
import { assistantFactsDir, requiredCfsFilePath } from '../src/foundation/paths';
import { ERROR_CODES } from '../src/constants';

type Mode = 'warn' | 'block';

function seedRequiredCfs(mode: Mode): void {
  fs.mkdirSync(assistantFactsDir(), { recursive: true });
  fs.writeFileSync(
    requiredCfsFilePath(),
    JSON.stringify({
      version: 1,
      mode,
      rules: [
        {
          status: 'Development Completed',
          requires: [
            { cf: 130, name: 'Root Cause for Bugs' },
            { cf: 88, name: 'Tester' },
          ],
        },
      ],
    }),
  );
}

function mockIssueFetch(baseUrl: string): void {
  // Persist the issue GET: the initial fetch AND `updateIssue`'s post-PUT
  // re-fetch both hit it (in the warn / --force cases). The block case
  // only ever consumes the first GET.
  nock(baseUrl)
    .persist()
    .get('/issues/42.json')
    .query(true)
    .reply(200, {
      issue: {
        id: 42,
        subject: 'Test',
        project: { id: 1, name: 'Test' },
        tracker: { id: 1, name: 'Bug' },
        priority: { id: 2, name: 'Normal' },
        status: { id: 1, name: 'New' },
        author: { id: 1, name: 'Tester' },
        created_on: '2026-01-01T00:00:00Z',
        updated_on: '2026-05-01T00:00:00Z',
        custom_fields: [
          { id: 130, name: 'Root Cause for Bugs', value: '' },
          { id: 88, name: 'Tester', value: '' },
        ],
        allowed_statuses: [
          { id: 1, name: 'New', is_closed: false },
          { id: 7, name: 'Development Completed', is_closed: false },
        ],
      },
    });

  nock(baseUrl)
    .persist()
    .get('/issue_statuses.json')
    .reply(200, {
      issue_statuses: [
        { id: 1, name: 'New', is_closed: false },
        { id: 7, name: 'Development Completed', is_closed: false },
      ],
    });
}

describe('required-CF guard on issue status', () => {
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

  it('block mode refuses and never fires the PUT', async () => {
    seedRequiredCfs('block');
    mockIssueFetch(fixture.baseUrl);
    // NB: the PUT is deliberately NOT mocked — nock would throw if fired.

    const { envelope } = await runCommandAndCapture(
      statusVerb as (f: Record<string, unknown>) => Promise<never>,
      { id: '42', status: 'Development Completed' },
    );

    expect(envelope.ok).toBe(false);
    const error = envelope.error as Record<string, unknown>;
    expect(error.code).toBe(ERROR_CODES.MISSING_REQUIRED_CF);
    const details = error.details as Record<string, unknown>;
    expect(details.missing).toEqual([
      { cf: 130, name: 'Root Cause for Bugs' },
      { cf: 88, name: 'Tester' },
    ]);
  });

  it('warn mode proceeds with warnings in meta', async () => {
    seedRequiredCfs('warn');
    mockIssueFetch(fixture.baseUrl);
    nock(fixture.baseUrl).put('/issues/42.json').reply(204);

    const { envelope } = await runCommandAndCapture(
      statusVerb as (f: Record<string, unknown>) => Promise<never>,
      { id: '42', status: 'Development Completed' },
    );

    expect(envelope.ok).toBe(true);
    const meta = envelope.meta as Record<string, unknown>;
    expect(meta.requiredCfWarnings).toBeDefined();
    expect((meta.requiredCfWarnings as unknown[]).length).toBe(2);
  });

  it('block mode + --force proceeds', async () => {
    seedRequiredCfs('block');
    mockIssueFetch(fixture.baseUrl);
    nock(fixture.baseUrl).put('/issues/42.json').reply(204);

    const { envelope } = await runCommandAndCapture(
      statusVerb as (f: Record<string, unknown>) => Promise<never>,
      { id: '42', status: 'Development Completed', force: true },
    );

    expect(envelope.ok).toBe(true);
  });

  it('malformed rules file: mutation proceeds and the parse warning is surfaced', async () => {
    // The exact scenario the warning exists for: the user typo'd "block",
    // believes the guard is active, and it must not silently vanish.
    fs.mkdirSync(assistantFactsDir(), { recursive: true });
    fs.writeFileSync(
      requiredCfsFilePath(),
      JSON.stringify({ version: 1, mode: 'blcok', rules: [] }),
    );
    mockIssueFetch(fixture.baseUrl);
    nock(fixture.baseUrl).put('/issues/42.json').reply(204);

    const { envelope } = await runCommandAndCapture(
      statusVerb as (f: Record<string, unknown>) => Promise<never>,
      { id: '42', status: 'Development Completed' },
    );

    expect(envelope.ok).toBe(true);
    const meta = envelope.meta as Record<string, unknown>;
    const warnings = meta.warnings as Array<Record<string, unknown>>;
    expect(warnings).toBeDefined();
    expect(warnings[0].code).toBe(ERROR_CODES.REQUIRED_CFS_PARSE_ERROR);
    // Guard was skipped — no missing-CF warnings.
    expect(meta.requiredCfWarnings).toBeUndefined();
  });
});
