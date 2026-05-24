/**
 * `lwr prefs add | list | remove`
 *
 * Read-and-write surface for `~/.lwr/facts/preferences.json` — the
 * cross-agent shared brain. Every AI agent (Claude Code, Codex, Copilot,
 * …) teaches lwr a fact via `prefs add` instead of stashing it in
 * per-agent memory; the apply-path on `issue edit/create/status/close`
 * then fires the rule for every subsequent mutation by any agent.
 *
 * `prefs add` reuses `foundation/cf-resolver` so `--when "Developer=Sibin"`
 * and `--set "Tester=Alex Biju"` resolve names→ids the same way
 * `--cf` does on `issue edit`.
 */

import { randomUUID } from 'node:crypto';
import {
  runCommand,
  type CommandFn,
  type CommandResult,
  type GlobalFlags,
} from '../../foundation/run';
import { writeLine } from '../../foundation/output';
import { success, dim, header } from '../../foundation/format';
import { LwrError, ValidationError } from '../../foundation/errors';
import { ERROR_CODES, EXIT } from '../../constants';
import { openSession } from '../../foundation/session';
import {
  parseCfPair,
  resolveCfKey,
  resolveCfValue,
} from '../../foundation/cf-resolver';
import {
  loadPreferences,
  savePreferences,
  deriveRuleId,
  findRuleById,
  type PreferenceRule,
  type PreferenceWhen,
  type PreferenceSetItem,
  type PreferencesFile,
} from '../../assistant/preferences';
import { memoryBankId } from '../../assistant/state';
import { retain } from '../../memory';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface PrefsAddFlags extends GlobalFlags {
  when?: string;
  set?: string[];
  reason?: string;
  agent?: string;
  id?: string;
  note?: string;
}

interface PrefsRemoveFlags extends GlobalFlags {
  id?: string;
}

interface PrefsListFlags extends GlobalFlags {
  // No filters yet — list is intentionally simple. Future: --since, --agent.
}

interface PrefsAddPayload {
  rule: PreferenceRule;
  /**
   * "added" for a fresh rule, "updated" when an existing id was replaced.
   * Lets agents log "I taught lwr something new" vs "I corrected a rule".
   */
  outcome: 'added' | 'updated';
}

interface PrefsRemovePayload {
  id: string;
  removed: PreferenceRule;
}

interface PrefsListPayload {
  schema: string;
  updatedAt: string;
  count: number;
  rules: PreferenceRule[];
  warnings: { code: string; message: string }[];
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

const addCmd: CommandFn<PrefsAddPayload> = async (flags, ctx): Promise<CommandResult<PrefsAddPayload>> => {
  const f = flags as PrefsAddFlags;

  if (!f.when || f.when.trim().length === 0) {
    throw new ValidationError(
      '--when is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass a single condition like `--when "Developer=Sibin Baby"` or `--when "79=57"`.',
    );
  }
  if (!f.set || f.set.length === 0) {
    throw new ValidationError(
      '--set is required (and may repeat).',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass one or more `--set "<cf>=<value>"` flags.',
    );
  }

  // Non-TTY teaches must quote the user and identify themselves so a
  // future `prefs list` is auditable. In a TTY we default `agent` to
  // 'human' and let `reason` be optional but encouraged.
  const interactive = ctx.interactive;
  if (!interactive && !f.reason) {
    throw new LwrError({
      message: '--reason is required in non-interactive contexts.',
      code: ERROR_CODES.PREFERENCES_REASON_REQUIRED,
      exit: EXIT.VALIDATION,
      hint: 'Quote what the user said, e.g. `--reason "User: my default tester is Alex Biju"`.',
    });
  }
  if (!interactive && !f.agent) {
    throw new LwrError({
      message: '--agent is required in non-interactive contexts.',
      code: ERROR_CODES.PREFERENCES_AGENT_REQUIRED,
      exit: EXIT.VALIDATION,
      hint: 'Identify your agent, e.g. `--agent claude-code` or `--agent codex`.',
    });
  }

  const session = await openSession(flags);

  // Resolve --when. Single key=value pair.
  const whenPair = parseCfPair(f.when);
  const whenKey = resolveCfKey(whenPair.key);
  const whenValue = await resolveCfValue(session.client, whenPair.value, {});
  const when: PreferenceWhen = {
    cf: whenKey.id,
    equals: whenValue.value,
  };
  if (whenKey.matched?.name !== undefined) when.cfName = whenKey.matched.name;
  if (whenValue.source === 'user-resolved') when.equalsLabel = whenPair.value;

  // Resolve --set. May repeat. Reuses the same resolver chain.
  const set: PreferenceSetItem[] = [];
  const seenCfIds = new Set<number>();
  for (const raw of f.set) {
    const pair = parseCfPair(raw);
    const key = resolveCfKey(pair.key);
    if (seenCfIds.has(key.id)) {
      throw new ValidationError(
        `Duplicate cf id in --set: ${key.id}.`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Each cf can only appear once per rule.',
      );
    }
    seenCfIds.add(key.id);
    const value = await resolveCfValue(session.client, pair.value, {});
    const entry: PreferenceSetItem = {
      cf: key.id,
      value: value.value,
    };
    if (key.matched?.name !== undefined) entry.cfName = key.matched.name;
    if (value.source === 'user-resolved') entry.valueLabel = pair.value;
    set.push(entry);
  }

  const ruleId = f.id ?? deriveRuleId(when, set);
  if (f.id !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(f.id)) {
    throw new ValidationError(
      `Invalid --id "${f.id}".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Use kebab- or snake-case: lowercase letters, digits, `-`, `_`; starting with [a-z0-9].',
    );
  }

  const reason = f.reason ?? '(human, no reason given)';
  const agent = f.agent ?? 'human';
  const now = new Date().toISOString();

  const newRule: PreferenceRule = {
    id: ruleId,
    when,
    set,
    reason,
    addedBy: agent,
    addedAt: now,
    lastTriggeredAt: null,
    triggerCount: 0,
  };

  const { file: current } = loadPreferences();
  const existing = findRuleById(current, ruleId);

  // Idempotent replace: an explicit re-teach with the same id overwrites.
  // This is the documented "agent re-teaches" path — agents that re-run
  // their teach logic shouldn't pile up duplicates.
  const nextRules = existing
    ? current.rules.map(r => (r.id === ruleId ? { ...newRule, triggerCount: r.triggerCount, lastTriggeredAt: r.lastTriggeredAt } : r))
    : [...current.rules, newRule];

  const next: PreferencesFile = {
    ...current,
    rules: nextRules,
    updatedAt: now,
  };
  savePreferences(next);

  const stored = nextRules.find(r => r.id === ruleId)!;
  const outcome: PrefsAddPayload['outcome'] = existing ? 'updated' : 'added';

  retainFactForRule(stored);

  return {
    json: { rule: stored, outcome },
    pretty: c => {
      writeLine(success(c, `${outcome === 'added' ? 'Added' : 'Updated'} rule "${stored.id}".`));
      writeLine(
        `  ${dim(c, 'when:')} cf ${stored.when.cf}${stored.when.cfName ? ` (${stored.when.cfName})` : ''} == ${stored.when.equals}${stored.when.equalsLabel ? ` (${stored.when.equalsLabel})` : ''}`,
      );
      for (const s of stored.set) {
        writeLine(
          `  ${dim(c, 'set :')} cf ${s.cf}${s.cfName ? ` (${s.cfName})` : ''} = ${s.value}${s.valueLabel ? ` (${s.valueLabel})` : ''}`,
        );
      }
      writeLine(`  ${dim(c, 'why :')} ${stored.reason}`);
      writeLine(`  ${dim(c, 'by  :')} ${stored.addedBy}`);
    },
  };
};

export function addPrefs(flags: PrefsAddFlags): Promise<never> {
  return runCommand('prefs.add', flags, addCmd);
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

const removeCmd: CommandFn<PrefsRemovePayload> = async (flags): Promise<CommandResult<PrefsRemovePayload>> => {
  const f = flags as PrefsRemoveFlags;
  if (!f.id || f.id.trim().length === 0) {
    throw new ValidationError(
      'Rule id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr prefs remove <id>`. List ids with `lwr prefs list --json`.',
    );
  }
  const ruleId = f.id.trim();

  const { file: current } = loadPreferences();
  const existing = findRuleById(current, ruleId);
  if (!existing) {
    throw new LwrError({
      message: `No rule with id "${ruleId}".`,
      code: ERROR_CODES.PREFERENCES_RULE_NOT_FOUND,
      exit: EXIT.VALIDATION,
      hint: 'List existing rules with `lwr prefs list --json`.',
      details: {
        query: ruleId,
        known: current.rules.map(r => r.id),
      },
    });
  }

  const next: PreferencesFile = {
    ...current,
    rules: current.rules.filter(r => r.id !== ruleId),
    updatedAt: new Date().toISOString(),
  };
  savePreferences(next);

  retainFactRemoval(existing);

  return {
    json: { id: ruleId, removed: existing },
    pretty: c => writeLine(success(c, `Removed rule "${ruleId}".`)),
  };
};

export function removePrefs(flags: PrefsRemoveFlags): Promise<never> {
  return runCommand('prefs.remove', flags, removeCmd);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const listCmd: CommandFn<PrefsListPayload> = async (flags): Promise<CommandResult<PrefsListPayload>> => {
  void flags;
  const { file, warnings } = loadPreferences();
  const payload: PrefsListPayload = {
    schema: file.schema,
    updatedAt: file.updatedAt,
    count: file.rules.length,
    rules: file.rules,
    warnings: warnings.map(w => ({ code: w.code, message: w.message })),
  };

  const result: CommandResult<PrefsListPayload> = {
    json: payload,
    pretty: c => {
      writeLine(header(c, `Preferences — ${payload.count} ${payload.count === 1 ? 'rule' : 'rules'}`));
      if (payload.count === 0) {
        writeLine(`  ${dim(c, 'No rules. Teach lwr via `lwr prefs add`.')}`);
      }
      for (const r of payload.rules) {
        writeLine('');
        writeLine(`  ${r.id}`);
        writeLine(
          `    ${dim(c, 'when:')} cf ${r.when.cf}${r.when.cfName ? ` (${r.when.cfName})` : ''} == ${r.when.equals}${r.when.equalsLabel ? ` (${r.when.equalsLabel})` : ''}`,
        );
        for (const s of r.set) {
          writeLine(
            `    ${dim(c, 'set :')} cf ${s.cf}${s.cfName ? ` (${s.cfName})` : ''} = ${s.value}${s.valueLabel ? ` (${s.valueLabel})` : ''}`,
          );
        }
        writeLine(`    ${dim(c, 'why :')} ${r.reason}`);
        writeLine(
          `    ${dim(c, 'by  :')} ${r.addedBy} · added ${r.addedAt}${r.lastTriggeredAt ? ` · last fired ${r.lastTriggeredAt} (${r.triggerCount}x)` : ` · never fired`}`,
        );
      }
      for (const w of payload.warnings) {
        writeLine('');
        writeLine(`  ${dim(c, `[${w.code}]`)} ${w.message}`);
      }
    },
  };
  // Carry warnings into meta for JSON callers (agents branch on this).
  if (warnings.length > 0) {
    result.meta = { warnings: payload.warnings };
  }
  return result;
};

export function listPrefs(flags: PrefsListFlags): Promise<never> {
  return runCommand('prefs.list', flags, listCmd);
}

// ---------------------------------------------------------------------------
// Memory mirror — every successful prefs mutation is also a `fact` row
// ---------------------------------------------------------------------------
//
// Why mirror prefs into memory at all? Because memory is the queryable
// index agents read BEFORE writing. When the user later says "my new
// tester will be Maya", the agent needs to recall the prior Tester rule
// to know which rule_id to supersede. Without this mirror, the agent's
// only lookup surface is `prefs list` — which has no "find rule by
// target cf" affordance and no history of past values.
//
// supersedeWhere={rule_id} so re-teaching the same rule_id marks the
// prior fact superseded and keeps an audit trail.

function retainFactForRule(rule: PreferenceRule): void {
  try {
    const primarySet = rule.set[0];
    const content =
      rule.set.length === 1
        ? `when cf${rule.when.cf}=${rule.when.equals} → cf${primarySet.cf}=${primarySet.value}`
        : `when cf${rule.when.cf}=${rule.when.equals} → ${rule.set.length} cfs set (primary cf${primarySet.cf}=${primarySet.value})`;
    retain({
      bankId: memoryBankId(),
      kind: 'fact',
      content,
      metadata: {
        rule_id: rule.id,
        when_cf: rule.when.cf,
        when_value: rule.when.equals,
        primary_set_cf: primarySet.cf,
        primary_set_value: primarySet.value,
        set_count: rule.set.length,
      },
      supersedeWhere: { rule_id: rule.id },
    });
  } catch {
    // Best-effort: prefs mutation already succeeded.
  }
}

function retainFactRemoval(rule: PreferenceRule): void {
  try {
    const primarySet = rule.set[0];
    retain({
      bankId: memoryBankId(),
      kind: 'fact',
      content: `(removed) ${rule.id}`,
      metadata: {
        rule_id: rule.id,
        when_cf: rule.when.cf,
        primary_set_cf: primarySet.cf,
        removed: true,
      },
      supersedeWhere: { rule_id: rule.id },
    });
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Re-exports used by cli.ts wiring
// ---------------------------------------------------------------------------

export const _internal = { randomUUID };
