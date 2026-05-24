/**
 * Linways developer workflow — status constants.
 *
 * The Redmine status NAMES that lwr commands key off when reasoning about
 * developer activity. Names match the Linways instance's status dictionary
 * exactly (see `~/.lwr/cache/statuses.json`) and are resolved to ids at
 * runtime via `resolveStatusId` so a fork pointing at a different Redmine
 * instance only needs to edit this file.
 *
 * Why names and not ids: ids are instance-fragile (the same status can have
 * a different id on a different Redmine deployment). The name is the human
 * contract — "Resolved" means "deployed to production" at Linways
 * regardless of which integer id the database assigned it.
 */

/**
 * Statuses where a developer is **actively spending hands-on time** on an
 * issue. These are mutually exclusive per developer — by Linways policy,
 * at most ONE issue may sit in any of these for a given developer at a
 * time. Moving an issue INTO any of these triggers the mutex enforcement
 * sweep on all other issues that already sit in this set for the same dev.
 *
 * Notably absent:
 * - "Dev Analysis required" — that's a *queue* state ("dev needs to
 *   look at this"), not active work. The dev hasn't engaged yet.
 * - "Development Completed", "Testing completed", "Dev Analysis
 *   Completed" — *waiting* states, not active work.
 * - "Testing in progress" — that's the QA mutex set, not dev.
 *
 * Extend this array to bring more "<phase> in Progress" states under the
 * mutex (e.g., a future "Deployment in Progress" status would slot in
 * here so a deploy interrupt auto-pauses the prior dev work).
 */
export const DEV_ACTIVE_STATUS_NAMES = [
  'Development in Progress',
  'Dev Analysis In Progress',
] as const;

/**
 * Target status for the auto-pause hook. When a dev switches active issue,
 * the previously-active issue moves to this status (with a comment).
 */
export const PAUSE_STATUS_NAME = 'Paused';

/**
 * Target status for `lwr issue resolve`. At Linways, "Resolved" means the
 * change has been **deployed to production** — not just "dev finished".
 */
export const RESOLVED_STATUS_NAME = 'Resolved';

/**
 * Status of issues that have passed QA and are awaiting deployment by the
 * developer. Source filter for "what's on my deploy queue".
 */
export const READY_TO_RESOLVE_STATUS_NAME = 'Testing completed';

/**
 * Statuses lwr treats as **terminal / done** at Linways, regardless of
 * what `is_closed` says on the Redmine status row.
 *
 * Why a hard-coded list instead of the API's `is_closed` flag: on the
 * Linways instance, EVERY status (including "Closed" and "Resolved") has
 * `is_closed: false`. That makes Redmine's native `status_id=open`
 * filter a no-op — it never excludes anything. We override that behaviour
 * by post-filtering on name.
 *
 * `--status open` (the default for "show my open tickets") drops every
 * row whose status name appears here. `--include-done` opts back into
 * the raw Redmine semantic.
 *
 * Names are matched case-insensitively against the live status dictionary.
 */
export const EFFECTIVELY_DONE_STATUS_NAMES = [
  'Closed',
  'Resolved',
  'Rejected',
  'Obsolete',
  'Duplicate',
  'Verified & Closed',
  'delivered',
  'Shipped',
  'canceled',
  'completed',
] as const;

/** Case-insensitive set membership check against EFFECTIVELY_DONE_STATUS_NAMES. */
export function isEffectivelyDoneStatus(name: string): boolean {
  const needle = name.toLowerCase();
  return EFFECTIVELY_DONE_STATUS_NAMES.some(n => n.toLowerCase() === needle);
}

// --- Daily rollover --------------------------------------------------------
//
// When a dev shuts the laptop without pausing, the active issue stays in a
// dev-active status overnight. Next morning, lwr should surface "you didn't
// stop — when did you actually finish?" rather than silently let auto-pause
// backfill the entire overnight gap as work time.

/**
 * Minimum gap (in ms) since the last action-log entry that triggers the
 * rollover prompt even on the same calendar day. 4 h covers "early task →
 * back to bed → restart" without nagging on lunch-break gaps. Either this
 * OR a calendar-date change (in WORK_TZ) is enough to trigger.
 */
export const ROLLOVER_MIN_GAP_MS = 4 * 60 * 60 * 1000;

/**
 * Default `--mode` for `lwr issue handover` when not passed explicitly.
 * 'pause' preserves the issue's spot in the dev's plate without claiming
 * either "deployed" (resolve) or "still active" (resume) intent.
 */
export const ROLLOVER_DEFAULT_MODE = 'pause' as const;

/**
 * Allowed values for `lwr issue handover --mode`.
 *   - pause:   move to PAUSE_STATUS_NAME after backfilling the time entry
 *   - resolve: move to RESOLVED_STATUS_NAME (deployed-to-prod semantic)
 *   - resume:  no status change; just backfill the missing time entry
 */
export const ROLLOVER_MODES = ['pause', 'resolve', 'resume'] as const;
export type RolloverMode = (typeof ROLLOVER_MODES)[number];
