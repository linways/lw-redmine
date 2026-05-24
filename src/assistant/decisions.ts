/**
 * Decision + override event log — high-signal corpus for future inference.
 *
 * Two append-only NDJSON files under `~/.lwr/events/`:
 *
 *   decisions.ndjson — One line per successful mutating command. Records
 *                      the resolved CF state + which (if any) rules from
 *                      `facts/preferences.json` fired. Lets a future
 *                      `lwr prefs suggest` see "user injected Tester=Alex
 *                      Biju 14 times manually before teaching a rule".
 *
 *   overrides.ndjson — One line whenever the user *explicitly* passed
 *                      `--cf X=Y` while a preference rule wanted to set
 *                      X=Z. Very-high signal: "this rule no longer
 *                      matches the user's behaviour". Kept longer than
 *                      decisions per ASSISTANT_OVERRIDE_RETENTION_MS.
 *
 * Both files are gated on `assistant.enabled` (default `true`, opt-out
 * via `lwr assistant disable`). Failures are silently swallowed — this
 * layer must never break a user command.
 */

import fs from 'node:fs';
import { assistantDecisionsLogPath, assistantOverridesLogPath, assistantEventsDir } from '../foundation/paths';
import { isAssistantEnabled, memoryBankId } from './state';
import type { AppliedDefault } from './preferences';
import { retain } from '../memory';
import { maybeProposeRuleCandidate } from './rule-candidates';

export interface DecisionRecord {
  /** ISO timestamp. */
  at: string;
  /** Dotted command path (matches the JSON envelope's `command` field). */
  cmd: string;
  /** Self-identified agent label (claude-code / codex / human / …) if known. */
  agent?: string;
  /** The cf state of the issue after the mutation (cf id → value). */
  resolvedCfs: { id: number; value: string | number; source: string }[];
  /** Which preference rules fired on this mutation. Empty when none. */
  appliedDefaults: AppliedDefault[];
  /** Issue id, when applicable. */
  issueId?: number;
}

export interface OverrideRecord {
  at: string;
  cmd: string;
  agent?: string;
  /** Rule that wanted to inject — but the user passed their own value. */
  ruleId: string;
  /** cf id whose user value conflicted with the rule's `set`. */
  cf: number;
  /** What the user passed. */
  userValue: string | number;
  /** What the rule would have set. */
  ruleValue: string | number;
  issueId?: number;
}

export function recordDecision(record: DecisionRecord): void {
  if (!isAssistantEnabled()) return;
  appendLine(assistantDecisionsLogPath(), record as unknown as Record<string, unknown>);
  retainDecisionCfs(record);
}

export function recordOverride(record: OverrideRecord): void {
  if (!isAssistantEnabled()) return;
  appendLine(assistantOverridesLogPath(), record as unknown as Record<string, unknown>);
  retainOverride(record);
}

/**
 * Retain one memory `observation` row per cf set in the mutation. The
 * rule-candidate detector (Phase 5) buckets by `(cf_id, value, source)`
 * to spot "user passed the same Tester=Alex 5 times in 30 days" patterns.
 *
 * Best-effort: failures never bubble up — the user's mutation already
 * succeeded by the time we get here.
 */
function retainDecisionCfs(record: DecisionRecord): void {
  try {
    const bankId = memoryBankId();
    for (const cf of record.resolvedCfs) {
      retain({
        bankId,
        kind: 'observation',
        content: `${record.cmd}: cf${cf.id}=${cf.value} (${cf.source})`,
        metadata: {
          cmd: record.cmd,
          cf_id: cf.id,
          value: cf.value,
          source: cf.source,
          issue_id: record.issueId ?? null,
          agent: record.agent ?? null,
        },
      });
      maybeProposeRuleCandidate(bankId, cf.id, cf.value, cf.source);
    }
  } catch {
    // Best-effort.
  }
}

/**
 * Overrides are very-high-signal: the user explicitly contradicted a
 * preference rule. Retain them as observations with `source: 'override'`
 * so the detector can spot "this rule is going stale."
 */
function retainOverride(record: OverrideRecord): void {
  try {
    retain({
      bankId: memoryBankId(),
      kind: 'observation',
      content: `${record.cmd}: cf${record.cf}=${record.userValue} (override of rule ${record.ruleId})`,
      metadata: {
        cmd: record.cmd,
        cf_id: record.cf,
        value: record.userValue,
        source: 'override',
        rule_id: record.ruleId,
        rule_value: record.ruleValue,
        issue_id: record.issueId ?? null,
        agent: record.agent ?? null,
      },
    });
  } catch {
    // Best-effort.
  }
}

function appendLine(file: string, payload: Record<string, unknown>): void {
  try {
    fs.mkdirSync(assistantEventsDir(), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o644 });
  } catch {
    // Best-effort: the user's command already succeeded. Don't fail it
    // because of a write to an observation log.
  }
}
