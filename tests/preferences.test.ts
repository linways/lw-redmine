/**
 * Unit coverage for the cross-agent preferences engine.
 *
 * Three layers covered:
 *   1. loadPreferences/savePreferences — file-system layer, isolated via $LWR_CONFIG_DIR
 *   2. applyPreferences — pure function; matrix of match/skip/inject cases
 *   3. deriveRuleId / currentCfValuesFromIssue / bumpTriggerCounts — small helpers
 *
 * The load-bearing contract: with a rule that says "when Developer=57, set Tester=256",
 * a follow-up `issue status` PUT (which Redmine 422'd in the original incident) now
 * carries Tester=256 in the merged custom_fields payload. The unit tests assert the
 * payload shape; the cmd-e2e tests in cmd-prefs-e2e.test.ts assert the wiring.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  loadPreferences,
  savePreferences,
  applyPreferences,
  bumpTriggerCounts,
  deriveRuleId,
  currentCfValuesFromIssue,
  type PreferencesFile,
  type PreferenceRule,
} from '../src/assistant/preferences';
import { preferencesFilePath } from '../src/foundation/paths';
import { ENV, ERROR_CODES, PREFERENCES_SCHEMA } from '../src/constants';
import type { ResolvedCustomField } from '../src/foundation/cf-resolver';

function isolatedConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-prefs-test-'));
  process.env[ENV.CONFIG_DIR] = dir;
  return dir;
}

function makeRule(overrides: Partial<PreferenceRule> = {}): PreferenceRule {
  return {
    id: 'rule-1',
    when: { cf: 79, equals: 57 },
    set: [{ cf: 88, value: 256 }],
    reason: 'test',
    addedBy: 'test',
    addedAt: '2026-05-12T00:00:00.000Z',
    lastTriggeredAt: null,
    triggerCount: 0,
    ...overrides,
  };
}

function userCf(id: number, value: string | number): ResolvedCustomField {
  return { id, value, raw: `${id}=${value}`, source: 'numeric' };
}

// ===========================================================================
// 1. loadPreferences
// ===========================================================================

describe('loadPreferences', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = isolatedConfigDir();
  });

  afterEach(() => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    delete process.env[ENV.CONFIG_DIR];
  });

  it('returns an empty result with no warnings when the file is missing', () => {
    const result = loadPreferences();
    expect(result.file.rules).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('loads a valid file', () => {
    const file: PreferencesFile = {
      schema: PREFERENCES_SCHEMA,
      updatedAt: '2026-05-12T00:00:00.000Z',
      rules: [makeRule()],
    };
    savePreferences(file);

    const result = loadPreferences();
    expect(result.file.rules).toHaveLength(1);
    expect(result.file.rules[0].id).toBe('rule-1');
    expect(result.warnings).toEqual([]);
  });

  it('warns on malformed JSON and returns an empty file', () => {
    fs.mkdirSync(path.dirname(preferencesFilePath()), { recursive: true });
    fs.writeFileSync(preferencesFilePath(), '{ not json');

    const result = loadPreferences();
    expect(result.file.rules).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe(ERROR_CODES.PREFERENCES_PARSE_ERROR);
  });

  it('warns on a wrong-schema file and returns an empty file', () => {
    fs.mkdirSync(path.dirname(preferencesFilePath()), { recursive: true });
    fs.writeFileSync(
      preferencesFilePath(),
      JSON.stringify({ schema: 'lwr-preferences/v99', rules: [] }),
    );

    const result = loadPreferences();
    expect(result.file.rules).toEqual([]);
    expect(result.warnings[0].code).toBe(ERROR_CODES.PREFERENCES_SCHEMA_MISMATCH);
  });

  it('dedupes duplicate rule ids and warns', () => {
    fs.mkdirSync(path.dirname(preferencesFilePath()), { recursive: true });
    fs.writeFileSync(
      preferencesFilePath(),
      JSON.stringify({
        schema: PREFERENCES_SCHEMA,
        updatedAt: '2026-05-12T00:00:00.000Z',
        rules: [
          makeRule({ id: 'same', set: [{ cf: 88, value: 100 }] }),
          makeRule({ id: 'same', set: [{ cf: 88, value: 200 }] }),
        ],
      }),
    );

    const result = loadPreferences();
    expect(result.file.rules).toHaveLength(1);
    expect(result.file.rules[0].set[0].value).toBe(100); // first wins
    expect(result.warnings[0].code).toBe(ERROR_CODES.PREFERENCES_DUPLICATE_RULE_ID);
  });
});

// ===========================================================================
// 2. savePreferences
// ===========================================================================

describe('savePreferences', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = isolatedConfigDir();
  });

  afterEach(() => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    delete process.env[ENV.CONFIG_DIR];
  });

  it('writes the file atomically and round-trips through load', () => {
    const file: PreferencesFile = {
      schema: PREFERENCES_SCHEMA,
      updatedAt: '2026-05-12T00:00:00.000Z',
      rules: [makeRule()],
    };
    savePreferences(file);

    // tmp file shouldn't linger after rename.
    expect(fs.existsSync(`${preferencesFilePath()}.tmp`)).toBe(false);

    const reloaded = loadPreferences();
    expect(reloaded.file.rules[0]).toEqual(file.rules[0]);
  });

  it('writes with mode 0600', () => {
    savePreferences({
      schema: PREFERENCES_SCHEMA,
      updatedAt: '2026-05-12T00:00:00.000Z',
      rules: [],
    });
    const stat = fs.statSync(preferencesFilePath());
    // Mask to the low 9 bits; node returns the full mode field.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ===========================================================================
// 3. applyPreferences — pure function, no I/O
// ===========================================================================

describe('applyPreferences', () => {
  it('injects when `when` matches the user --cf', () => {
    const rules = [makeRule()];
    const result = applyPreferences(rules, {
      userCfs: [userCf(79, 57)],
      currentCfValues: new Map(),
    });
    expect(result.customFields).toEqual([
      { id: 79, value: 57 },
      { id: 88, value: 256 },
    ]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].cf).toBe(88);
    expect(result.applied[0].rule).toBe('rule-1');
    expect(result.firedRuleIds).toEqual(['rule-1']);
  });

  it('injects when `when` matches the issue current state', () => {
    const rules = [makeRule()];
    const result = applyPreferences(rules, {
      userCfs: [],
      currentCfValues: new Map([[79, 57]]),
    });
    expect(result.customFields).toEqual([{ id: 88, value: 256 }]);
    expect(result.applied[0].cf).toBe(88);
  });

  it('does not inject when `when` does not match', () => {
    const rules = [makeRule()];
    const result = applyPreferences(rules, {
      userCfs: [userCf(79, 999)],
      currentCfValues: new Map(),
    });
    expect(result.customFields).toEqual([{ id: 79, value: 999 }]);
    expect(result.applied).toEqual([]);
    expect(result.firedRuleIds).toEqual([]);
  });

  it('skips when target is already non-blank on the issue', () => {
    const rules = [makeRule()];
    const result = applyPreferences(rules, {
      userCfs: [],
      currentCfValues: new Map([
        [79, 57],
        [88, 999], // already set
      ]),
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('issue-non-blank');
    expect(result.skipped[0].cf).toBe(88);
    expect(result.skipped[0].issueValue).toBe(999);
    expect(result.firedRuleIds).toEqual([]);
  });

  it('skips with user-cf-override when user passes a different value for the target', () => {
    const rules = [makeRule()];
    const result = applyPreferences(rules, {
      userCfs: [userCf(79, 57), userCf(88, 700)],
      currentCfValues: new Map(),
    });
    expect(result.customFields).toEqual([
      { id: 79, value: 57 },
      { id: 88, value: 700 }, // user wins
    ]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('user-cf-override');
    expect(result.skipped[0].userValue).toBe(700);
    expect(result.skipped[0].ruleValue).toBe(256);
  });

  it('does not record an override when user passes the same value as the rule', () => {
    const rules = [makeRule()];
    const result = applyPreferences(rules, {
      userCfs: [userCf(79, 57), userCf(88, 256)],
      currentCfValues: new Map(),
    });
    expect(result.skipped).toEqual([]);
    expect(result.applied).toEqual([]); // user already set it; no injection needed
  });

  it('compares values via String() so number 57 matches string "57"', () => {
    const rules = [makeRule({ when: { cf: 79, equals: '57' } })];
    const result = applyPreferences(rules, {
      userCfs: [userCf(79, 57)],
      currentCfValues: new Map(),
    });
    expect(result.applied).toHaveLength(1);
  });

  it('fires multiple rules; first injection per cf wins', () => {
    const rules = [
      makeRule({ id: 'rule-a', set: [{ cf: 88, value: 100 }] }),
      makeRule({ id: 'rule-b', set: [{ cf: 88, value: 200 }] }),
    ];
    const result = applyPreferences(rules, {
      userCfs: [userCf(79, 57)],
      currentCfValues: new Map(),
    });
    expect(result.customFields.find(c => c.id === 88)?.value).toBe(100);
    expect(result.firedRuleIds).toEqual(['rule-a']);
  });

  it('emits no rows when there are no rules', () => {
    const result = applyPreferences([], {
      userCfs: [userCf(79, 57)],
      currentCfValues: new Map([[88, 'something']]),
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.customFields).toEqual([{ id: 79, value: 57 }]);
  });
});

// ===========================================================================
// 4. bumpTriggerCounts
// ===========================================================================

describe('bumpTriggerCounts', () => {
  let cfgDir: string;

  beforeEach(() => {
    cfgDir = isolatedConfigDir();
  });

  afterEach(() => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    delete process.env[ENV.CONFIG_DIR];
  });

  it('increments triggerCount and stamps lastTriggeredAt for fired rules only', () => {
    savePreferences({
      schema: PREFERENCES_SCHEMA,
      updatedAt: '2026-05-12T00:00:00.000Z',
      rules: [
        makeRule({ id: 'a', triggerCount: 5, lastTriggeredAt: '2026-05-01T00:00:00.000Z' }),
        makeRule({ id: 'b', triggerCount: 0 }),
      ],
    });

    bumpTriggerCounts(['a']);

    const { file } = loadPreferences();
    const a = file.rules.find(r => r.id === 'a')!;
    const b = file.rules.find(r => r.id === 'b')!;
    expect(a.triggerCount).toBe(6);
    expect(a.lastTriggeredAt).not.toBe('2026-05-01T00:00:00.000Z'); // freshened
    expect(b.triggerCount).toBe(0);
    expect(b.lastTriggeredAt).toBeNull();
  });

  it('is a no-op with empty input (does not touch the file)', () => {
    bumpTriggerCounts([]);
    // No file should have been created.
    expect(fs.existsSync(preferencesFilePath())).toBe(false);
  });
});

// ===========================================================================
// 5. deriveRuleId
// ===========================================================================

describe('deriveRuleId', () => {
  it('is deterministic for the same when+set', () => {
    const a = deriveRuleId({ cf: 79, equals: 57 }, [{ cf: 88, value: 256 }]);
    const b = deriveRuleId({ cf: 79, equals: 57 }, [{ cf: 88, value: 256 }]);
    expect(a).toBe(b);
    expect(a).toBe('cf79-eq57-cf88');
  });

  it('strips non-[a-z0-9_-] from the equals token', () => {
    const id = deriveRuleId({ cf: 79, equals: 'Sibin Baby!' }, [{ cf: 88, value: 256 }]);
    expect(id).toBe('cf79-eqsibinbaby-cf88');
  });
});

// ===========================================================================
// 6. currentCfValuesFromIssue
// ===========================================================================

describe('currentCfValuesFromIssue', () => {
  it('returns an empty map for undefined input', () => {
    expect(currentCfValuesFromIssue(undefined).size).toBe(0);
  });

  it('maps string and array values to their first element; nulls to null', () => {
    const map = currentCfValuesFromIssue([
      { id: 1, value: 'hello' },
      { id: 2, value: ['first', 'second'] },
      { id: 3, value: null },
      { id: 4, value: [] },
    ]);
    expect(map.get(1)).toBe('hello');
    expect(map.get(2)).toBe('first');
    expect(map.get(3)).toBeNull();
    expect(map.get(4)).toBeNull();
  });
});
