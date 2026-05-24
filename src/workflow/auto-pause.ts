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

import { activeProfile } from '../foundation/profiles';
import { listIssues, updateIssue } from '../api/issues';
import { assertTransitionAllowed, listStatuses, resolveStatusId } from '../api/statuses';
import { DEV_ACTIVE_STATUS_NAMES, PAUSE_STATUS_NAME } from '../constants';
import { logger } from '../foundation/logger';
import type { RedmineClient } from '../foundation/client';

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
