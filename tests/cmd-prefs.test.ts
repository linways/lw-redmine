/**
 * End-to-end coverage for `lwr prefs add | remove | list`.
 *
 * Drives each command via `runCommand`, captures stdout/exit, and asserts
 * the JSON envelope shape. nock blocks all outbound HTTP — if `prefs add`
 * tries to resolve a name via /users.json or project members, we'd see
 * "no match" failure in the envelope; we test the numeric-only path
 * (no resolution needed) to keep this hermetic.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { setupTestProfile, runCommandAndCapture, type FixtureHandle } from './_helpers/profile-fixture';
import { addPrefs, removePrefs, listPrefs } from '../src/commands/prefs';
import { preferencesFilePath } from '../src/foundation/paths';
import { ERROR_CODES, PREFERENCES_SCHEMA } from '../src/constants';
import { recordCustomFields } from '../src/foundation/cache';

describe('prefs commands', () => {
  let fixture: FixtureHandle;

  beforeEach(() => {
    fixture = setupTestProfile();
    nock.disableNetConnect();
    // Seed the cf catalog so `--when "Developer=…"` / `--set "Tester=…"`
    // resolve names without a network round-trip.
    recordCustomFields([
      { id: 79, name: 'Developer', value: null },
      { id: 88, name: 'Tester', value: null },
    ]);
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    fixture.cleanup();
  });

  // -----------------------------------------------------------------------
  // add
  // -----------------------------------------------------------------------

  it('add: writes a rule with provenance and resolves cf names', async () => {
    const { envelope, exitCode } = await runCommandAndCapture(
      addPrefs as (f: Record<string, unknown>) => Promise<never>,
      {
        when: 'Developer=57',
        set: ['Tester=256'],
        reason: 'User: my default tester is Alex',
        agent: 'claude-code',
      },
    );

    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    const rule = data.rule as Record<string, unknown>;
    expect(rule.id).toBe('cf79-eq57-cf88');
    expect((rule.when as Record<string, unknown>).cf).toBe(79);
    expect((rule.when as Record<string, unknown>).cfName).toBe('Developer');
    expect((rule.when as Record<string, unknown>).equals).toBe(57);
    expect((rule.set as Array<Record<string, unknown>>)[0].cf).toBe(88);
    expect((rule.set as Array<Record<string, unknown>>)[0].cfName).toBe('Tester');
    expect(rule.reason).toBe('User: my default tester is Alex');
    expect(rule.addedBy).toBe('claude-code');
    expect(data.outcome).toBe('added');

    // Persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(preferencesFilePath(), 'utf8')) as { schema: string; rules: unknown[] };
    expect(onDisk.schema).toBe(PREFERENCES_SCHEMA);
    expect(onDisk.rules).toHaveLength(1);
  });

  it('add → re-add: prior fact in memory is marked superseded, new fact active (Tester=Alex → Tester=Maya scenario)', async () => {
    // Day 1: teach lwr "Tester=256" (Alex's user id). Numeric values keep
    // the test hermetic — string-name resolution requires a /users.json hit.
    const { envelope: env1 } = await runCommandAndCapture(
      addPrefs as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 'tester-default',
        when: '79=57',
        set: ['88=256'],
        reason: 'day-1: tester is Alex (256)',
        agent: 'claude-code',
      },
    );
    expect(env1.ok).toBe(true);

    const { recall, closeMemoryDb } = await import('../src/memory');

    // After day 1: one active fact for this rule_id.
    const afterDay1 = recall({
      bankId: fixture.profileName,
      kind: 'fact',
      metadataFilter: { rule_id: 'tester-default' },
    });
    expect(afterDay1.total).toBe(1);
    expect(afterDay1.rows[0].metadata.primary_set_value).toBe(256);
    expect(afterDay1.rows[0].supersededBy).toBeNull();

    // Day 5: re-teach the same rule_id with a new value.
    const { envelope: env2 } = await runCommandAndCapture(
      addPrefs as (f: Record<string, unknown>) => Promise<never>,
      {
        id: 'tester-default',
        when: '79=57',
        set: ['88=512'],
        reason: 'day-5: tester is now Maya (512)',
        agent: 'claude-code',
      },
    );
    expect(env2.ok).toBe(true);
    expect((env2.data as Record<string, unknown>).outcome).toBe('updated');

    // Active recall (default) returns ONLY the new fact.
    const activeOnly = recall({
      bankId: fixture.profileName,
      kind: 'fact',
      metadataFilter: { rule_id: 'tester-default' },
    });
    expect(activeOnly.total).toBe(1);
    expect(activeOnly.rows[0].metadata.primary_set_value).toBe(512);
    expect(activeOnly.rows[0].supersededBy).toBeNull();

    // With includeSuperseded, both facts surface — audit history works.
    const withHistory = recall({
      bankId: fixture.profileName,
      kind: 'fact',
      metadataFilter: { rule_id: 'tester-default' },
      includeSuperseded: true,
    });
    expect(withHistory.total).toBe(2);
    const supersededRow = withHistory.rows.find(r => r.supersededBy !== null);
    expect(supersededRow?.metadata.primary_set_value).toBe(256);
    expect(typeof supersededRow?.supersededAt).toBe('number');
    closeMemoryDb();
  });

  it('remove: writes a removal tombstone fact in memory', async () => {
    await runCommandAndCapture(addPrefs as (f: Record<string, unknown>) => Promise<never>, {
      id: 'tester-default',
      when: '79=57',
      set: ['88=256'],
      reason: 'will be removed',
      agent: 'claude-code',
    });
    const { envelope } = await runCommandAndCapture(
      removePrefs as (f: Record<string, unknown>) => Promise<never>,
      { id: 'tester-default' },
    );
    expect(envelope.ok).toBe(true);

    const { recall, closeMemoryDb } = await import('../src/memory');
    const active = recall({
      bankId: fixture.profileName,
      kind: 'fact',
      metadataFilter: { rule_id: 'tester-default' },
    });
    // Only the (removed) marker is active.
    expect(active.total).toBe(1);
    expect(active.rows[0].metadata.removed).toBe(true);
    closeMemoryDb();
  });

  it('add: idempotent on same id — second call updates and reports outcome=updated', async () => {
    await runCommandAndCapture(addPrefs as (f: Record<string, unknown>) => Promise<never>, {
      when: '79=57',
      set: ['88=256'],
      reason: 'first',
      agent: 'claude-code',
    });
    const { envelope } = await runCommandAndCapture(
      addPrefs as (f: Record<string, unknown>) => Promise<never>,
      {
        when: '79=57',
        set: ['88=256'],
        reason: 'updated reason',
        agent: 'codex',
      },
    );

    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.outcome).toBe('updated');
    expect((data.rule as Record<string, unknown>).reason).toBe('updated reason');
    expect((data.rule as Record<string, unknown>).addedBy).toBe('codex');

    const onDisk = JSON.parse(fs.readFileSync(preferencesFilePath(), 'utf8')) as { rules: unknown[] };
    expect(onDisk.rules).toHaveLength(1); // not duplicated
  });

  it('add: rejects in non-TTY without --reason', async () => {
    const { envelope, exitCode } = await runCommandAndCapture(
      addPrefs as (f: Record<string, unknown>) => Promise<never>,
      {
        when: '79=57',
        set: ['88=256'],
        agent: 'claude-code',
      },
    );

    expect(exitCode).not.toBe(0);
    expect(envelope.ok).toBe(false);
    const err = (envelope.error as Record<string, unknown>);
    expect(err.code).toBe(ERROR_CODES.PREFERENCES_REASON_REQUIRED);
  });

  it('add: rejects in non-TTY without --agent', async () => {
    const { envelope, exitCode } = await runCommandAndCapture(
      addPrefs as (f: Record<string, unknown>) => Promise<never>,
      {
        when: '79=57',
        set: ['88=256'],
        reason: 'because',
      },
    );

    expect(exitCode).not.toBe(0);
    const err = envelope.error as Record<string, unknown>;
    expect(err.code).toBe(ERROR_CODES.PREFERENCES_AGENT_REQUIRED);
  });

  it('add: rejects duplicate cf in --set', async () => {
    const { envelope, exitCode } = await runCommandAndCapture(
      addPrefs as (f: Record<string, unknown>) => Promise<never>,
      {
        when: '79=57',
        set: ['88=256', '88=999'],
        reason: 'because',
        agent: 'test',
      },
    );

    expect(exitCode).not.toBe(0);
    expect((envelope.error as Record<string, unknown>).code).toBe(ERROR_CODES.VALIDATION_BAD_VALUE);
  });

  // -----------------------------------------------------------------------
  // remove
  // -----------------------------------------------------------------------

  it('remove: drops a rule by id', async () => {
    await runCommandAndCapture(addPrefs as (f: Record<string, unknown>) => Promise<never>, {
      when: '79=57',
      set: ['88=256'],
      reason: 'r',
      agent: 'test',
      id: 'my-rule',
    });

    const { envelope, exitCode } = await runCommandAndCapture(
      removePrefs as (f: Record<string, unknown>) => Promise<never>,
      { id: 'my-rule' },
    );

    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(preferencesFilePath(), 'utf8')) as { rules: unknown[] };
    expect(onDisk.rules).toEqual([]);
  });

  it('remove: emits PREFERENCES_RULE_NOT_FOUND for an unknown id', async () => {
    const { envelope, exitCode } = await runCommandAndCapture(
      removePrefs as (f: Record<string, unknown>) => Promise<never>,
      { id: 'no-such-rule' },
    );

    expect(exitCode).not.toBe(0);
    expect((envelope.error as Record<string, unknown>).code).toBe(ERROR_CODES.PREFERENCES_RULE_NOT_FOUND);
  });

  // -----------------------------------------------------------------------
  // list
  // -----------------------------------------------------------------------

  it('list: returns empty when no preferences file exists', async () => {
    const { envelope, exitCode } = await runCommandAndCapture(
      listPrefs as (f: Record<string, unknown>) => Promise<never>,
      {},
    );

    expect(exitCode).toBe(0);
    const data = envelope.data as Record<string, unknown>;
    expect(data.count).toBe(0);
    expect(data.rules).toEqual([]);
    expect(data.warnings).toEqual([]);
  });

  it('list: surfaces all rules with provenance', async () => {
    await runCommandAndCapture(addPrefs as (f: Record<string, unknown>) => Promise<never>, {
      when: '79=57',
      set: ['88=256'],
      reason: 'r1',
      agent: 'claude-code',
      id: 'rule-1',
    });
    await runCommandAndCapture(addPrefs as (f: Record<string, unknown>) => Promise<never>, {
      when: '79=99',
      set: ['88=100'],
      reason: 'r2',
      agent: 'codex',
      id: 'rule-2',
    });

    const { envelope } = await runCommandAndCapture(
      listPrefs as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    const data = envelope.data as Record<string, unknown>;
    expect(data.count).toBe(2);
    const rules = data.rules as Array<Record<string, unknown>>;
    expect(rules.map(r => r.id)).toEqual(['rule-1', 'rule-2']);
  });

  it('list: surfaces warnings from a malformed file in meta.warnings', async () => {
    fs.mkdirSync(path.dirname(preferencesFilePath()), { recursive: true });
    fs.writeFileSync(preferencesFilePath(), '{ corrupt');

    const { envelope } = await runCommandAndCapture(
      listPrefs as (f: Record<string, unknown>) => Promise<never>,
      {},
    );
    expect(envelope.ok).toBe(true);
    const meta = envelope.meta as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect((meta.warnings as Array<Record<string, unknown>>)[0].code).toBe(ERROR_CODES.PREFERENCES_PARSE_ERROR);
  });
});
