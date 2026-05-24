/**
 * Rule-candidate detector tests.
 *
 * After ≥ MEMORY_RULE_CANDIDATE_MIN_OCCURRENCES (default 5) user-driven
 * mutations of the same (cf, value) within
 * MEMORY_RULE_CANDIDATE_WINDOW_MS (default 30 days), a `kind: 'rule-
 * candidate'` row should land in memory — unless an existing prefs
 * rule already covers that assignment.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordDecision } from '../src/assistant/decisions';
import { enableAssistant } from '../src/assistant/state';
import { savePreferences, type PreferencesFile } from '../src/assistant/preferences';
import { recall, closeMemoryDb } from '../src/memory';
import { ENV, PREFERENCES_SCHEMA } from '../src/constants';

function isolatedConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-rc-test-'));
  process.env[ENV.CONFIG_DIR] = dir;
  return dir;
}

function emitMutation(issueId: number, value: string | number, source = 'user-flag'): void {
  recordDecision({
    at: new Date().toISOString(),
    cmd: 'issue.edit',
    resolvedCfs: [{ id: 79, value, source }],
    appliedDefaults: [],
    issueId,
  });
}

describe('rule-candidate detector', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = isolatedConfigDir();
    enableAssistant();
  });

  afterEach(() => {
    closeMemoryDb();
    fs.rmSync(cfgDir, { recursive: true, force: true });
    delete process.env[ENV.CONFIG_DIR];
  });

  it('does NOT surface a candidate below the threshold (4 occurrences)', () => {
    for (let i = 1; i <= 4; i++) emitMutation(1000 + i, 'Alex Biju');
    const candidates = recall({ bankId: 'default', kind: 'rule-candidate' });
    expect(candidates.total).toBe(0);
  });

  it('surfaces a candidate at exactly the threshold (5 occurrences)', () => {
    for (let i = 1; i <= 5; i++) emitMutation(1000 + i, 'Alex Biju');
    const candidates = recall({ bankId: 'default', kind: 'rule-candidate' });
    expect(candidates.total).toBe(1);
    expect(candidates.rows[0].metadata.cf_id).toBe(79);
    expect(candidates.rows[0].metadata.value).toBe('Alex Biju');
    expect(candidates.rows[0].metadata.observed_count).toBe(5);
  });

  it('does NOT count rule-fired mutations (source="preferences")', () => {
    for (let i = 1; i <= 6; i++) emitMutation(1000 + i, 'Alex Biju', 'preferences');
    const candidates = recall({ bankId: 'default', kind: 'rule-candidate' });
    expect(candidates.total).toBe(0);
  });

  it('does NOT surface a candidate when an existing rule already covers the (cf, value)', () => {
    const prefs: PreferencesFile = {
      schema: PREFERENCES_SCHEMA,
      updatedAt: new Date().toISOString(),
      rules: [
        {
          id: 'existing',
          when: { cf: 79, equals: 57 },
          set: [{ cf: 79, value: 'Alex Biju' }],
          reason: 'taught',
          addedBy: 'claude-code',
          addedAt: new Date().toISOString(),
          lastTriggeredAt: null,
          triggerCount: 0,
        },
      ],
    };
    savePreferences(prefs);

    for (let i = 1; i <= 6; i++) emitMutation(1000 + i, 'Alex Biju');
    const candidates = recall({ bankId: 'default', kind: 'rule-candidate' });
    expect(candidates.total).toBe(0);
  });
});
