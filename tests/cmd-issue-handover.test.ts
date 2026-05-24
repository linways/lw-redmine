/**
 * `lwr issue handover` — focused coverage.
 *
 * Two scenarios — the unique-to-handover behaviors:
 *   1. `--dismiss` short-circuit — no HTTP, ack marker stamped, exit ok.
 *   2. Missing `--stopped` → VALIDATION_MISSING_FLAG.
 *
 * The time-entry + status-PUT mechanics on the happy path are identical
 * to `lwr issue resolve` and are exercised by its tests; the integration
 * for handover is also covered by manual smoke (`lwr issue handover
 * --help` + the detector tests).
 */

import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import {
  setupTestProfile,
  runCommandAndCapture,
  type FixtureHandle,
} from './_helpers/profile-fixture';
import { handoverIssue } from '../src/commands/issue/handover';
import { rolloverAckPath } from '../src/foundation/paths';
import { todayInWorkTz } from '../src/workflow/work-log';
import { _resetRolloverCache } from '../src/workflow/daily-rollover';
import { ERROR_CODES } from '../src/constants';

describe('issue handover', () => {
  let fixture: FixtureHandle;

  beforeEach(() => {
    fixture = setupTestProfile();
    nock.disableNetConnect();
    _resetRolloverCache();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    fixture.cleanup();
  });

  it('--dismiss writes the ack marker and skips Redmine entirely', async () => {
    const { envelope, exitCode } = await runCommandAndCapture(
      handoverIssue as (f: Record<string, unknown>) => Promise<never>,
      { dismiss: true, apiKey: 'dummy' },
    );

    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.mode).toBe('dismiss');
    expect(data.issueId).toBeNull();

    // Marker stamped with today's WORK_TZ date.
    const marker = fs.readFileSync(rolloverAckPath(), 'utf8').trim();
    expect(marker).toBe(todayInWorkTz());
  });

  it('missing --stopped errors with VALIDATION_MISSING_FLAG', async () => {
    const { envelope, exitCode } = await runCommandAndCapture(
      handoverIssue as (f: Record<string, unknown>) => Promise<never>,
      { id: '12345', apiKey: 'dummy' },
    );

    expect(envelope.ok).toBe(false);
    const err = envelope.error as Record<string, unknown>;
    expect(err.code).toBe(ERROR_CODES.VALIDATION_MISSING_FLAG);
    expect(String(err.message)).toContain('--stopped');
    expect(exitCode).not.toBe(0);
  });

});
