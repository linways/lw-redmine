/**
 * Dev-active mutex enforcement.
 *
 * The rule (locked with the user):
 *
 *   Whenever a status PUT lands an issue in `DEV_ACTIVE_STATUS_NAMES`,
 *   every OTHER issue currently sitting in any dev-active status (for
 *   cf-developer=me) is PUT → Paused.
 *
 * That's it. The trigger is the destination status (must be dev-active);
 * the action is a live Redmine sweep across the dev-active set for the
 * current user. In a healthy world the sweep returns 0 or 1 issue
 * (because the invariant holds); when the invariant has already been
 * violated it self-heals by pausing all the strays in one go.
 *
 * Pointer-independent. The local `profile.activeIssue` plays no part in
 * this — it's intent declaration, not source of truth. Mutex
 * enforcement reads Redmine and writes Redmine.
 *
 * Called by every command that PUTs status (`issue.status`, `issue.edit`
 * when --status is set). NOT called by `issue.use` (pointer-only) or
 * `issue.resolve` (destination "Resolved" isn't dev-active).
 */

import { activeProfile, resolveProfileName } from '../foundation/profiles';
import { getIssue, listIssues, updateIssue } from '../api/issues';
import { assertTransitionAllowed, listStatuses, resolveStatusId } from '../api/statuses';
import { DEV_ACTIVE_STATUS_NAMES, PAUSE_STATUS_NAME } from '../constants';
import { logger } from '../foundation/logger';
import { loadConfig } from '../foundation/config';
import type { RedmineClient } from '../foundation/client';
import { syncActiveIssueFromPayload } from './active-issue';

export interface MutexPausedIssue {
  id: number;
  previousStatus: string;
  newStatus: string;
}

export interface MutexEnforceResult {
  /**
   * Issues that were paused by this sweep. Empty when:
   *   - `newStatusName` wasn't in `DEV_ACTIVE_STATUS_NAMES`, OR
   *   - no other dev-active issues existed for the user (steady state).
   */
  pausedIssues: MutexPausedIssue[];
  /**
   * Pauses that failed (e.g., workflow guard rejected the transition).
   * Best-effort: a single failure doesn't block the others. Empty array
   * is the happy path.
   */
  failedPauses: { id: number; reason: string }[];
}

const EMPTY: MutexEnforceResult = { pausedIssues: [], failedPauses: [] };

/**
 * Enforce the dev-active mutex after a status PUT.
 *
 * @param client            authenticated Redmine client
 * @param targetIssueId     the issue that was just transitioned (excluded from the sweep)
 * @param newStatusName     verbatim Redmine name of the new status — compared against
 *                          `DEV_ACTIVE_STATUS_NAMES`. No-op if not in the set.
 */
export async function enforceDevActiveMutex(
  client: RedmineClient,
  targetIssueId: number,
  newStatusName: string,
): Promise<MutexEnforceResult> {
  if (!(DEV_ACTIVE_STATUS_NAMES as readonly string[]).includes(newStatusName)) {
    return EMPTY;
  }

  const { profile } = activeProfile();
  const devCf = profile.me.fieldMap.developer;
  if (!devCf) {
    // Without the dev cf binding we can't ask "which issues are MINE in
    // dev-active". Skip silently — agents will see the missing binding
    // when they try other dev-cf flows.
    logger.debug('enforceDevActiveMutex: profile has no developer cf binding — skipping mutex sweep');
    return EMPTY;
  }
  const myUserId = profile.me.user.id;

  const statuses = await listStatuses(client);

  // Resolve all dev-active status names → ids. Names that don't exist on
  // this instance are skipped (with a debug log) — that way a fork can
  // add forward-looking names to the array without breaking present-day
  // queries.
  const devActiveIds: number[] = [];
  for (const name of DEV_ACTIVE_STATUS_NAMES) {
    try {
      devActiveIds.push(resolveStatusId(statuses, name));
    } catch {
      logger.debug(`enforceDevActiveMutex: status name "${name}" not in instance dictionary — skipping`);
    }
  }
  if (devActiveIds.length === 0) return EMPTY;

  // Redmine's `status_id` filter is single-valued. Fan out one query per
  // dev-active id and union by issue id, excluding the target.
  const pages = await Promise.all(
    devActiveIds.map(statusId =>
      listIssues(client, {
        statusId,
        customFieldFilters: { [devCf.cfId]: myUserId },
        sort: 'updated_on:desc',
      }),
    ),
  );
  const candidates = new Map<number, { id: number; currentStatus: { id: number; name: string } }>();
  for (const page of pages) {
    for (const i of page.issues) {
      if (i.id === targetIssueId) continue;
      if (!candidates.has(i.id)) {
        candidates.set(i.id, { id: i.id, currentStatus: i.status });
      }
    }
  }
  if (candidates.size === 0) return EMPTY;

  const pausedId = resolveStatusId(statuses, PAUSE_STATUS_NAME);
  const pausedName = statuses.find(s => s.id === pausedId)?.name ?? PAUSE_STATUS_NAME;

  // Pause each candidate. Best-effort: failures (e.g., workflow guard
  // rejection on a state that doesn't transition to Paused) are collected
  // and returned alongside successes, not thrown.
  const pausedIssues: MutexPausedIssue[] = [];
  const failedPauses: { id: number; reason: string }[] = [];
  for (const c of candidates.values()) {
    try {
      // Re-fetch the issue's allowed_statuses to validate the transition.
      // Cheap: one issue read per pause. In steady state there's at most one.
      const fresh = await import('../api/issues').then(m => m.getIssue(client, c.id, { allowedStatuses: true }));
      assertTransitionAllowed(fresh, pausedId);
      await updateIssue(client, c.id, {
        statusId: pausedId,
        notes: `Auto-paused by lwr — mutex enforcement (focus shifted to #${targetIssueId}).`,
      });
      pausedIssues.push({ id: c.id, previousStatus: c.currentStatus.name, newStatus: pausedName });
    } catch (err) {
      failedPauses.push({ id: c.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { pausedIssues, failedPauses };
}

// ---------------------------------------------------------------------------
// Interrupt-style auto-pause
// ---------------------------------------------------------------------------
//
// Used by verbs that mutate a NON-active issue without going through a status
// PUT that fires `enforceDevActiveMutex` (e.g. `lwr issue resolve` lands on
// "Resolved", which isn't in DEV_ACTIVE_STATUS_NAMES, so the post-PUT mutex
// sweep never runs). Without this helper, the dev's active pointer keeps
// ticking on Redmine while they push a deploy → time entries on the active
// issue silently absorb the interrupt window.
//
// Contract: the active pointer stays SET after the pause. The dev resumes
// with `lwr issue use <active-id>` + a subsequent `issue status` PUT (or
// `issue edit --status`), which re-fires the mutex sweep in the normal way.

export interface InterruptPauseResult {
  /** The Redmine issue that was paused, or `null` if no pause happened. */
  paused: { id: number; previousStatus: string; newStatus: string } | null;
  /**
   * Why `paused` is `null`. `'no-active'` = no pointer set; `'same-issue'` =
   * target IS the active pointer (no interrupt); `'not-dev-active'` = pointer's
   * live status isn't in DEV_ACTIVE_STATUS_NAMES (already paused / resolved /
   * closed externally); `'no-dev-cf'` = profile lacks the developer cf binding
   * (mutex disabled); `'failed'` = the pause PUT itself threw.
   */
  skipped: 'no-active' | 'same-issue' | 'not-dev-active' | 'no-dev-cf' | 'failed' | null;
  /** Populated when `skipped === 'failed'`. Best-effort; the interrupt verb continues. */
  failureReason?: string;
}

const NO_OP_PAUSE: InterruptPauseResult = { paused: null, skipped: 'no-active' };

/**
 * Pause the active-pointer's Redmine issue iff it's currently in a dev-active
 * status AND the target of the impending interrupt isn't the active pointer
 * itself. Call BEFORE the interrupt mutation (resolve / future note / etc.).
 *
 * Best-effort: a pause failure (workflow guard rejected, transient network)
 * is captured in the result, not thrown. The interrupt verb should proceed
 * and surface the `paused` / `skipped` fields in its response so the agent
 * can render "⏸ paused #X first" hints.
 *
 * After a successful pause, the local pointer's `status` field is
 * re-synced from the Redmine response — so the next `lwr home` / `issue current`
 * reads the post-pause state, not the stale dev-active label.
 */
export async function pauseActivePointerIfDevActive(
  client: RedmineClient,
  targetIssueId: number,
  profileName: string,
): Promise<InterruptPauseResult> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    logger.debug(`pauseActivePointerIfDevActive: config load failed — skipping (${(err as Error).message})`);
    return NO_OP_PAUSE;
  }
  const profile = cfg.profiles[profileName];
  const pointer = profile?.activeIssue;
  if (!pointer) return NO_OP_PAUSE;
  if (pointer.id === targetIssueId) {
    return { paused: null, skipped: 'same-issue' };
  }
  if (!profile?.me.fieldMap.developer) {
    return { paused: null, skipped: 'no-dev-cf' };
  }

  // Live-fetch the active issue. The local pointer's `status` field is a
  // snapshot — it may say "Development in Progress" while Redmine has already
  // moved the issue to "Paused" via the web UI. Trust the live read.
  let live;
  try {
    live = await getIssue(client, pointer.id, { allowedStatuses: true });
  } catch (err) {
    logger.debug(`pauseActivePointerIfDevActive: GET #${pointer.id} failed — skipping (${(err as Error).message})`);
    return { paused: null, skipped: 'failed', failureReason: (err as Error).message };
  }

  if (!(DEV_ACTIVE_STATUS_NAMES as readonly string[]).includes(live.status.name)) {
    return { paused: null, skipped: 'not-dev-active' };
  }

  const statuses = await listStatuses(client);
  const pausedId = resolveStatusId(statuses, PAUSE_STATUS_NAME);
  const pausedName = statuses.find(s => s.id === pausedId)?.name ?? PAUSE_STATUS_NAME;

  try {
    assertTransitionAllowed(live, pausedId);
    const updated = await updateIssue(client, live.id, {
      statusId: pausedId,
      notes: `Auto-paused by lwr — interrupt to work on #${targetIssueId}.`,
    });
    syncActiveIssueFromPayload(updated, profileName);
    return {
      paused: { id: live.id, previousStatus: live.status.name, newStatus: pausedName },
      skipped: null,
    };
  } catch (err) {
    return { paused: null, skipped: 'failed', failureReason: (err as Error).message };
  }
}

/**
 * Dry-run twin of `pauseActivePointerIfDevActive`. Returns the same shape
 * but never PUTs. Used by interrupt-verb dry-run previews so the agent can
 * see "[dry-run] would pause #X" before the real call.
 */
export async function previewInterruptPause(
  client: RedmineClient,
  targetIssueId: number,
  profileName?: string,
): Promise<InterruptPauseResult> {
  const resolved = profileName ?? resolveProfileName();
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return NO_OP_PAUSE;
  }
  const profile = cfg.profiles[resolved];
  const pointer = profile?.activeIssue;
  if (!pointer) return NO_OP_PAUSE;
  if (pointer.id === targetIssueId) return { paused: null, skipped: 'same-issue' };
  if (!profile?.me.fieldMap.developer) return { paused: null, skipped: 'no-dev-cf' };

  let live;
  try {
    live = await getIssue(client, pointer.id);
  } catch (err) {
    return { paused: null, skipped: 'failed', failureReason: (err as Error).message };
  }
  if (!(DEV_ACTIVE_STATUS_NAMES as readonly string[]).includes(live.status.name)) {
    return { paused: null, skipped: 'not-dev-active' };
  }
  return {
    paused: { id: live.id, previousStatus: live.status.name, newStatus: PAUSE_STATUS_NAME },
    skipped: null,
  };
}

/**
 * Dry-run helper: peek at what `enforceDevActiveMutex` *would* do without
 * pausing anything. Returns the same shape but flagged so callers can
 * render "would pause #X" lines in their preview output.
 */
export async function previewDevActiveMutex(
  client: RedmineClient,
  targetIssueId: number,
  newStatusName: string,
): Promise<{ wouldPause: { id: number; currentStatus: string }[] }> {
  if (!(DEV_ACTIVE_STATUS_NAMES as readonly string[]).includes(newStatusName)) {
    return { wouldPause: [] };
  }
  const { profile } = activeProfile();
  const devCf = profile.me.fieldMap.developer;
  if (!devCf) return { wouldPause: [] };

  const statuses = await listStatuses(client);
  const devActiveIds: number[] = [];
  for (const name of DEV_ACTIVE_STATUS_NAMES) {
    try {
      devActiveIds.push(resolveStatusId(statuses, name));
    } catch {
      // skip
    }
  }
  if (devActiveIds.length === 0) return { wouldPause: [] };

  const pages = await Promise.all(
    devActiveIds.map(statusId =>
      listIssues(client, {
        statusId,
        customFieldFilters: { [devCf.cfId]: profile.me.user.id },
      }),
    ),
  );
  const seen = new Map<number, { id: number; currentStatus: string }>();
  for (const page of pages) {
    for (const i of page.issues) {
      if (i.id === targetIssueId) continue;
      if (!seen.has(i.id)) seen.set(i.id, { id: i.id, currentStatus: i.status.name });
    }
  }
  return { wouldPause: Array.from(seen.values()) };
}
