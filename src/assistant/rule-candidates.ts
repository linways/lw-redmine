/**
 * Rule-candidate detector.
 *
 * After every observation retain for a USER-driven mutation, check the
 * recent history for the same `(cf_id, value)` pair. If the user has
 * manually applied that value `MEMORY_RULE_CANDIDATE_MIN_OCCURRENCES`
 * times within `MEMORY_RULE_CANDIDATE_WINDOW_MS`, and no existing
 * preference rule already covers that (cf, value), surface a
 * `kind: 'rule-candidate'` row.
 *
 * The candidate is what a future `lwr prefs suggest` command reads to
 * propose "you keep doing X — want lwr to remember it?" to the user.
 *
 * Why USER-only: rule-fired mutations (`source = 'preferences'`) are
 * already automated; counting them as candidates would re-propose rules
 * the user has already taught.
 */

import { recall, retain } from '../memory';
import { loadPreferences } from './preferences';
import {
  MEMORY_RULE_CANDIDATE_MIN_OCCURRENCES,
  MEMORY_RULE_CANDIDATE_WINDOW_MS,
} from '../constants';

/** Sources that count as user-driven and therefore as candidate signal. */
const USER_DRIVEN_SOURCES = new Set(['user-flag', 'override', 'numeric']);

export function maybeProposeRuleCandidate(
  bankId: string,
  cfId: number,
  value: string | number,
  source: string,
): void {
  if (!USER_DRIVEN_SOURCES.has(source)) return;

  try {
    const cutoff = Date.now() - MEMORY_RULE_CANDIDATE_WINDOW_MS;
    const matching = recall({
      bankId,
      kind: 'observation',
      metadataFilter: { cf_id: cfId, value },
      topK: 1000,
    });
    const recentUserDriven = matching.rows.filter(
      r =>
        typeof r.metadata.source === 'string' &&
        USER_DRIVEN_SOURCES.has(r.metadata.source) &&
        r.lastSeenAt >= cutoff,
    );
    if (recentUserDriven.length < MEMORY_RULE_CANDIDATE_MIN_OCCURRENCES) return;
    if (existingRuleCovers(cfId, value)) return;

    retain({
      bankId,
      kind: 'rule-candidate',
      content: `cf${cfId}=${value} observed ${recentUserDriven.length} times — candidate for \`lwr prefs add\``,
      metadata: {
        cf_id: cfId,
        value,
        observed_count: recentUserDriven.length,
      },
    });
  } catch {
    // Best-effort: never break a mutation.
  }
}

/**
 * Walk the live preferences file. A rule "covers" the (cf, value) when
 * any of its `set` entries match — meaning lwr already auto-applies
 * this exact assignment, so re-proposing it would be noise.
 */
function existingRuleCovers(cfId: number, value: string | number): boolean {
  try {
    const { file } = loadPreferences();
    return file.rules.some(rule =>
      rule.set.some(s => s.cf === cfId && s.value === value),
    );
  } catch {
    return false;
  }
}
