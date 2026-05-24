/**
 * Decision + override log appender.
 *
 * Two contracts:
 *   1. With assistant.enabled = true, recordDecision/recordOverride
 *      append one NDJSON line each.
 *   2. With assistant.enabled = false, both are no-ops — no file is
 *      created. This is the user's "opt out" path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { recordDecision, recordOverride } from '../src/assistant/decisions';
import { enableAssistant, disableAssistant } from '../src/assistant/state';
import { assistantDecisionsLogPath, assistantOverridesLogPath } from '../src/foundation/paths';
import { ENV } from '../src/constants';

function isolatedConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-decisions-test-'));
  process.env[ENV.CONFIG_DIR] = dir;
  return dir;
}

describe('assistant decisions log', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = isolatedConfigDir();
  });

  afterEach(() => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    delete process.env[ENV.CONFIG_DIR];
  });

  it('records one NDJSON line per mutation when assistant is enabled', () => {
    enableAssistant();
    recordDecision({
      at: '2026-05-12T03:53:30.000Z',
      cmd: 'issue.status',
      resolvedCfs: [{ id: 79, value: 57, source: 'numeric' }],
      appliedDefaults: [
        { rule: 'r1', cf: 88, value: 256, reason: 'why', source: 'preferences' },
      ],
      issueId: 124487,
    });

    const lines = fs.readFileSync(assistantDecisionsLogPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.cmd).toBe('issue.status');
    expect(parsed.issueId).toBe(124487);
    const applied = parsed.appliedDefaults as Array<Record<string, unknown>>;
    expect(applied[0].rule).toBe('r1');
  });

  it('records overrides separately under overrides.ndjson', () => {
    enableAssistant();
    recordOverride({
      at: '2026-05-12T03:53:30.000Z',
      cmd: 'issue.edit',
      ruleId: 'r1',
      cf: 88,
      userValue: 999,
      ruleValue: 256,
      issueId: 124487,
    });

    expect(fs.existsSync(assistantOverridesLogPath())).toBe(true);
    const lines = fs.readFileSync(assistantOverridesLogPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.ruleId).toBe('r1');
    expect(parsed.userValue).toBe(999);
    expect(parsed.ruleValue).toBe(256);
  });

  it('is a no-op when assistant is disabled — no files created', () => {
    disableAssistant();
    recordDecision({
      at: '2026-05-12T03:53:30.000Z',
      cmd: 'issue.status',
      resolvedCfs: [],
      appliedDefaults: [],
    });
    recordOverride({
      at: '2026-05-12T03:53:30.000Z',
      cmd: 'issue.edit',
      ruleId: 'x',
      cf: 88,
      userValue: 1,
      ruleValue: 2,
    });

    expect(fs.existsSync(assistantDecisionsLogPath())).toBe(false);
    expect(fs.existsSync(assistantOverridesLogPath())).toBe(false);
  });

  it('appends — does not truncate — across multiple calls', () => {
    enableAssistant();
    for (let i = 0; i < 3; i++) {
      recordDecision({
        at: `2026-05-12T03:53:${30 + i}.000Z`,
        cmd: 'issue.edit',
        resolvedCfs: [],
        appliedDefaults: [],
        issueId: i,
      });
    }
    const lines = fs.readFileSync(assistantDecisionsLogPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('mirrors each resolved cf into memory as a kind=observation row', async () => {
    enableAssistant();
    // recordDecision writes to memory in the same call.
    recordDecision({
      at: '2026-05-12T03:53:30.000Z',
      cmd: 'issue.edit',
      resolvedCfs: [
        { id: 79, value: 'Alex Biju', source: 'user-flag' },
        { id: 88, value: 256, source: 'preferences' },
      ],
      appliedDefaults: [],
      issueId: 124487,
    });

    const { recall, closeMemoryDb } = await import('../src/memory');
    const result = recall({ bankId: 'default', kind: 'observation' });
    // Two cf rows, one per resolvedCfs entry.
    expect(result.total).toBe(2);
    const byCf = new Map(result.rows.map(r => [r.metadata.cf_id, r]));
    expect(byCf.get(79)?.metadata.value).toBe('Alex Biju');
    expect(byCf.get(79)?.metadata.source).toBe('user-flag');
    expect(byCf.get(88)?.metadata.value).toBe(256);
    closeMemoryDb();
  });

  it('mirrors overrides into memory with source="override"', async () => {
    enableAssistant();
    recordOverride({
      at: '2026-05-12T03:53:30.000Z',
      cmd: 'issue.edit',
      ruleId: 'r1',
      cf: 79,
      userValue: 'Maya',
      ruleValue: 'Alex Biju',
      issueId: 124487,
    });

    const { recall, closeMemoryDb } = await import('../src/memory');
    const result = recall({ bankId: 'default', kind: 'observation' });
    expect(result.total).toBe(1);
    expect(result.rows[0].metadata.source).toBe('override');
    expect(result.rows[0].metadata.rule_id).toBe('r1');
    expect(result.rows[0].metadata.value).toBe('Maya');
    closeMemoryDb();
  });
});
