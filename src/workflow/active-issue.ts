/**
 * Sticky `activeIssue` pointer — sync + refresh helpers.
 *
 * The pointer at `~/.lwr/config.json#profiles.<name>.activeIssue` is a
 * snapshot, not a live feed. It's set by `lwr issue use` and used by
 * `lwr issue current`, `lwr home`, the daily-rollover detector and
 * `me.md`. Three flavours of staleness this module exists to prevent:
 *
 *   - lwr-driven mutation that doesn't echo into the pointer.
 *   - status change made via the Redmine web UI (or another tool).
 *   - issue closed/resolved externally → pointer keeps reporting it
 *     as in-progress.
 *
 * The fix is layered:
 *
 *   1. `syncActiveIssueFromPayload()` — call after any successful PUT
 *      that returned a fresh RedmineIssue. Auto-clears when the issue's
 *      status is in `EFFECTIVELY_DONE_STATUS_NAMES` (the canonical
 *      Linways terminal set — `closed_on` is unreliable because Redmine
 *      doesn't clear it on reopen). Used by every mutating verb.
 *
 *   2. `liveRefreshActiveIssue()` — best-effort GET used by display
 *      surfaces (`home`, `issue current`). Swallow network failures
 *      and return a freshness verdict so the caller can fall back to
 *      cached + a stale marker.
 *
 *   3. `freshnessOf()` — pure timestamp → label. Cheap, lets every
 *      JSON envelope advertise how trustworthy its `status` is.
 *
 * Both sync helpers also rewrite `me.md` so the rendered identity
 * snippet stays in sync with the pointer.
 */

import type { RedmineIssue } from '../api/types';
import { getIssue, listIssues } from '../api/issues';
import { listStatuses, resolveStatusId } from '../api/statuses';
import type { RedmineClient } from '../foundation/client';
import {
  loadConfig,
  saveConfig,
  type ActiveIssue,
  type Profile,
} from '../foundation/config';
import { logger } from '../foundation/logger';
import { DEV_ACTIVE_STATUS_NAMES, isEffectivelyDoneStatus } from '../constants';
import { writeMeMarkdown } from './me';

/**
 * Is this Redmine issue currently terminal (closed / resolved / etc.)?
 *
 * **Do not use `issue.closed_on` as the indicator.** That field is the
 * "last closed at" timestamp — it persists across reopens, so a ticket
 * that was once closed and then re-opened still carries a `closed_on`
 * even though its current status is "In Progress" again. Using it as a
 * boolean would falsely clear the active-pointer the moment any
 * mutation flows through `syncActiveIssueFromPayload` for such an issue.
 *
 * Truth comes from the status name. At Linways, `status.is_closed` is
 * `false` on every status (the flag is unused on this instance), so
 * `EFFECTIVELY_DONE_STATUS_NAMES` is the canonical list. Forks that DO
 * keep the flag honest will also hit the same set via the name match.
 */
function isCurrentlyTerminal(issue: RedmineIssue): boolean {
  return isEffectivelyDoneStatus(issue.status.name);
}

/**
 * Freshness verdict on the cached pointer. `fresh` = we just refreshed
 * (or wrote it ourselves in this command run); `aging` = under a couple
 * of hours old; `stale` = older. Agents reading the JSON envelope use
 * this to decide whether to quote `status` or to verify first.
 */
export type Freshness = 'fresh' | 'aging' | 'stale';

const FRESHNESS_FRESH_MS = 5 * 60 * 1000;       // < 5 min
const FRESHNESS_AGING_MS = 2 * 60 * 60 * 1000;  // 5 min – 2 h; > 2 h = stale

export interface SyncResult {
  /** Was the synced issue the active one for this profile? */
  matched: boolean;
  /** Did the issue's new state cause the pointer to be cleared? */
  cleared: boolean;
  /** Did the pointer's fields change (status / subject / etc)? */
  updated: boolean;
}

export interface LiveRefreshOutcome {
  /** Did we attempt the GET at all? (False when no activeIssue is set.) */
  performed: boolean;
  /** Did the GET succeed? */
  succeeded: boolean;
  /** Was the pointer cleared as a result of a terminal status? */
  cleared: boolean;
  /** Status we held before the refresh. */
  previousStatus?: string;
  /** Status returned by the live GET (when `performed && succeeded`). */
  currentStatus?: string;
  /** Trustworthiness verdict for downstream consumers. */
  freshness: Freshness;
  /** Best-effort error message when the GET failed. */
  error?: string;
}

/** Pure: derive freshness from the pointer's `setAt`. */
export function freshnessOf(setAt: string, justRefreshed = false): Freshness {
  if (justRefreshed) return 'fresh';
  const t = Date.parse(setAt);
  if (!Number.isFinite(t)) return 'stale';
  const age = Date.now() - t;
  if (age < 0) return 'stale';
  if (age < FRESHNESS_FRESH_MS) return 'fresh';
  if (age < FRESHNESS_AGING_MS) return 'aging';
  return 'stale';
}

/**
 * After any successful lwr-driven mutation (statusVerb, closeVerb,
 * editIssue, addNote, etc.) that returned a fresh `RedmineIssue`, call
 * this with the response. Idempotent — when the payload isn't for the
 * active issue, this is a no-op.
 */
export function syncActiveIssueFromPayload(
  issue: RedmineIssue,
  profileName: string,
): SyncResult {
  try {
    const cfg = loadConfig();
    const profile = cfg.profiles[profileName];
    if (!profile?.activeIssue || profile.activeIssue.id !== issue.id) {
      return { matched: false, cleared: false, updated: false };
    }

    const isClosed = isCurrentlyTerminal(issue);
    const nextProfile = { ...profile };

    if (isClosed) {
      delete nextProfile.activeIssue;
      cfg.profiles = { ...cfg.profiles, [profileName]: nextProfile };
      saveConfig(cfg);
      writeMeMarkdown(nextProfile.me, nextProfile.baseUrl, nextProfile.activeProject, undefined);
      return { matched: true, cleared: true, updated: false };
    }

    const nextPointer: ActiveIssue = {
      id: issue.id,
      subject: issue.subject,
      project: { id: issue.project.id, name: issue.project.name },
      tracker: issue.tracker.name,
      status: issue.status.name,
      setAt: new Date().toISOString(),
    };
    const before = JSON.stringify({ ...profile.activeIssue, setAt: '' });
    const after = JSON.stringify({ ...nextPointer, setAt: '' });
    const changed = before !== after;

    nextProfile.activeIssue = nextPointer;
    cfg.profiles = { ...cfg.profiles, [profileName]: nextProfile };
    saveConfig(cfg);
    writeMeMarkdown(nextProfile.me, nextProfile.baseUrl, nextProfile.activeProject, nextPointer);
    return { matched: true, cleared: false, updated: changed };
  } catch (err) {
    logger.debug(`active-issue sync failed: ${(err as Error).message}`);
    return { matched: false, cleared: false, updated: false };
  }
}

/**
 * Live-refresh used by `home` and `issue current`. Strictly best-effort
 * — any network or auth failure is swallowed; the caller falls back to
 * the cached pointer + the freshness verdict.
 */
export async function liveRefreshActiveIssue(
  client: RedmineClient,
  profileName: string,
): Promise<LiveRefreshOutcome> {
  const cfg = loadConfig();
  const profile = cfg.profiles[profileName];
  if (!profile?.activeIssue) {
    return { performed: false, succeeded: false, cleared: false, freshness: 'fresh' };
  }
  const previousStatus = profile.activeIssue.status;
  try {
    const issue = await getIssue(client, profile.activeIssue.id);
    const result = syncActiveIssueFromPayload(issue, profileName);
    return {
      performed: true,
      succeeded: true,
      cleared: result.cleared,
      previousStatus,
      currentStatus: issue.status.name,
      freshness: 'fresh',
    };
  } catch (err) {
    return {
      performed: true,
      succeeded: false,
      cleared: false,
      previousStatus,
      freshness: freshnessOf(profile.activeIssue.setAt),
      error: (err as Error).message,
    };
  }
}

// --- Live discovery from Redmine -------------------------------------------

/**
 * What an issue looks like in a discovery result. Minimal projection of
 * RedmineIssue — just the fields a `home` reply needs to greet the user
 * with ("you have #X in-progress on Redmine, want me to use that?").
 */
export interface DiscoveredIssue {
  id: number;
  subject: string;
  status: string;
  project: { id: number; name: string };
  tracker: string;
}

export type DiscoveryKind = 'none' | 'single' | 'ambiguous';

export interface DiscoveryResult {
  kind: DiscoveryKind;
  issues: DiscoveredIssue[];
  /** When `kind === 'single'`, this is `issues[0]`; otherwise null. */
  issue: DiscoveredIssue | null;
  /** True iff Redmine returned more than one match (mutex broken). */
  mutexViolation: boolean;
  /**
   * Full RedmineIssue payloads for every projected entry, in the same
   * order. Used internally by `reconcileLiveActiveIssue` to avoid a
   * second `GET /issues/<id>` when the local pointer is already in
   * the discovery result.
   */
  full: RedmineIssue[];
  /** True when this result came from the in-process cache (no HTTP). */
  fromCache: boolean;
}

// --- Discovery cache (in-process, 60 s) ------------------------------------
//
// Many agent flows fire several commands in the same process (notably
// `lwr serve` MCP mode, where one long-running orchestrator handles every
// `tools/call`). Re-running the discovery dance per call burns 1 + N HTTP
// round trips against Linways for state that almost never changes between
// consecutive turns. The cache is keyed by (profile name, user id) so the
// agent can't bleed another profile's discovery into the current one.
//
// One-shot CLI invocations don't benefit (each lwr process starts cold),
// but the cache costs ~zero in that mode — it's a single null check.

interface DiscoveryCacheEntry {
  key: string;
  result: DiscoveryResult;
  cachedAt: number;
}

const DISCOVERY_TTL_MS = 60 * 1000;
let discoveryCache: DiscoveryCacheEntry | null = null;

function discoveryCacheKey(profile: Profile): string {
  return `${profile.me.user.id}@${profile.baseUrl}`;
}

/** Test/utility seam: drop the cache (e.g. between test cases). */
export function resetDiscoveryCache(): void {
  discoveryCache = null;
}

/**
 * Live query: which Redmine issues are currently sitting in
 * DEV_ACTIVE_STATUS_NAMES for THIS user (cf_<developer>=me.id)?
 *
 * The Linways workflow enforces a single-active-issue mutex (one such
 * issue per dev). Result:
 *
 *   - `none`      → user has no current in-progress work on Redmine.
 *   - `single`    → exactly one match, the actual active issue.
 *   - `ambiguous` → > 1 match. The mutex is broken; the agent should
 *                   surface this so the user can pause all but one.
 *
 * Best-effort: any failure (missing dev cf binding, network, auth)
 * returns `none` and logs at debug. Callers fall back gracefully.
 *
 * Cached for 60 s per (user, baseUrl). Pass `noCache: true` to force
 * a fresh query (used by `lwr issue current --no-cache` and tests).
 */
export async function discoverActiveIssue(
  client: RedmineClient,
  profile: Profile,
  opts: { noCache?: boolean } = {},
): Promise<DiscoveryResult> {
  const empty: DiscoveryResult = {
    kind: 'none', issues: [], issue: null, mutexViolation: false,
    full: [], fromCache: false,
  };
  const key = discoveryCacheKey(profile);
  if (!opts.noCache && discoveryCache && discoveryCache.key === key &&
      Date.now() - discoveryCache.cachedAt < DISCOVERY_TTL_MS) {
    return { ...discoveryCache.result, fromCache: true };
  }
  try {
    const devCf = profile.me.fieldMap.developer;
    if (!devCf) return empty;

    const statuses = await listStatuses(client);
    const mutexIds: number[] = [];
    for (const name of DEV_ACTIVE_STATUS_NAMES) {
      try {
        mutexIds.push(resolveStatusId(statuses, name));
      } catch {
        // A status name in the constant doesn't exist on this Redmine —
        // skip it rather than fail the whole discovery. The active-set
        // is the union of those that DO resolve.
      }
    }
    if (mutexIds.length === 0) return empty;

    // Redmine's status_id filter is single-valued; fan out one query
    // per status and union by id (same pattern as `lwr issue active`).
    const pages = await Promise.all(
      mutexIds.map(statusId =>
        listIssues(client, {
          statusId,
          customFieldFilters: { [devCf.cfId]: profile.me.user.id },
          sort: 'updated_on:desc',
        }),
      ),
    );

    const seen = new Map<number, RedmineIssue>();
    for (const page of pages) {
      for (const i of page.issues) {
        if (!seen.has(i.id)) seen.set(i.id, i);
      }
    }
    const merged = Array.from(seen.values()).sort(
      (a, b) => (a.updated_on > b.updated_on ? -1 : 1),
    );
    const projected: DiscoveredIssue[] = merged.map(i => ({
      id: i.id,
      subject: i.subject,
      status: i.status.name,
      project: { id: i.project.id, name: i.project.name },
      tracker: i.tracker.name,
    }));

    let result: DiscoveryResult;
    if (projected.length === 0) {
      result = empty;
    } else if (projected.length === 1) {
      result = {
        kind: 'single', issues: projected, issue: projected[0],
        mutexViolation: false, full: merged, fromCache: false,
      };
    } else {
      result = {
        kind: 'ambiguous', issues: projected, issue: null,
        mutexViolation: true, full: merged, fromCache: false,
      };
    }
    discoveryCache = { key, result, cachedAt: Date.now() };
    return result;
  } catch (err) {
    logger.debug(`active-issue discovery failed: ${(err as Error).message}`);
    return empty;
  }
}

/**
 * Reconciliation cases between the local sticky pointer and the live
 * Redmine discovery. The caller (home / issue current) projects the
 * relevant subset of this into its envelope so the agent can route to
 * the right natural-language question.
 */
export type ReconcileVerdict =
  | { kind: 'no-active' }                                              // both empty
  | { kind: 'aligned'; local: ActiveIssue }                            // both set + same id
  | { kind: 'discovered'; discovered: DiscoveredIssue }                // local empty, single discovery
  | { kind: 'mutex-violation'; issues: DiscoveredIssue[] }             // > 1 in-progress (with or without local)
  | { kind: 'conflict'; local: ActiveIssue; redmine: DiscoveredIssue } // local + single discovery, different ids
  | { kind: 'local-only'; local: ActiveIssue };                        // local set, Redmine sees nothing in DEV_ACTIVE

export function reconcileActiveIssue(
  local: ActiveIssue | undefined,
  discovery: DiscoveryResult,
): ReconcileVerdict {
  if (discovery.mutexViolation) {
    return { kind: 'mutex-violation', issues: discovery.issues };
  }
  if (!local) {
    if (discovery.kind === 'single' && discovery.issue) {
      return { kind: 'discovered', discovered: discovery.issue };
    }
    return { kind: 'no-active' };
  }
  if (discovery.kind === 'none') {
    return { kind: 'local-only', local };
  }
  // discovery is 'single' here
  if (discovery.issue && discovery.issue.id === local.id) {
    return { kind: 'aligned', local };
  }
  if (discovery.issue) {
    return { kind: 'conflict', local, redmine: discovery.issue };
  }
  return { kind: 'local-only', local };
}

// --- Unified live reconcile (the fast path) --------------------------------

export interface ReconcileLiveResult {
  verdict: ReconcileVerdict;
  /**
   * Set when we actually issued (or simulated) a fresh GET against the
   * local pointer's id. `null` when no local pointer existed. When
   * `succeeded: true`, the activeIssue freshness label is `'fresh'`.
   */
  refresh: LiveRefreshOutcome | null;
  /** True iff the discovery half of the dance came from the 60s cache. */
  cacheHit: boolean;
  /** Total HTTP round trips this reconcile triggered (0..N). For diagnostics. */
  httpCalls: number;
}

/**
 * The single entry point every display surface (`home`, `issue current`)
 * should call. Combines:
 *
 *   1. `discoverActiveIssue()`  — what's in dev-active for the user
 *      right now on Redmine (cached for 60s in-process).
 *
 *   2. Conditional `liveRefreshActiveIssue()` — only when the local
 *      pointer's id is NOT among the discovery results. When it IS,
 *      we already have the fresh `RedmineIssue` payload (in
 *      `discovery.full`); we feed that into `syncActiveIssueFromPayload`
 *      directly and skip the duplicate `GET /issues/<id>` call.
 *
 *   3. `reconcileActiveIssue()`  — the post-refresh verdict.
 *
 * Net effect on the hot path: aligned `lwr home` invocations drop from
 * 3 HTTP calls to 2 (1 listStatuses + 2 listIssues; the refresh is folded
 * into the discovery data). With the cache warm, drops to 0 HTTP calls.
 *
 * Best-effort: returns `kind: 'no-active'` with `httpCalls: 0` if the
 * session can't be opened or discovery fails completely.
 */
export async function reconcileLiveActiveIssue(
  client: RedmineClient,
  profileName: string,
  opts: { noCache?: boolean } = {},
): Promise<ReconcileLiveResult> {
  const cfgBefore = loadConfig();
  const profile = cfgBefore.profiles[profileName];
  if (!profile) {
    return {
      verdict: { kind: 'no-active' },
      refresh: null,
      cacheHit: false,
      httpCalls: 0,
    };
  }
  const localBefore = profile.activeIssue;

  // Always discover first. If a local pointer exists, the discovery's
  // own payloads tell us whether we need a separate refresh.
  const discovery = await discoverActiveIssue(client, profile, opts);

  // HTTP-call tally: listStatuses (cached on disk so usually free) +
  // N listIssues per non-cached discovery. We can't know precisely
  // without instrumenting; report the worst case for the discovery
  // half so callers / debug logs have a stable upper bound.
  let httpCalls = discovery.fromCache
    ? 0
    : 1 /* listStatuses worst case */ + DEV_ACTIVE_STATUS_NAMES.length;

  let refresh: LiveRefreshOutcome | null = null;

  if (localBefore) {
    const matchInDiscovery = discovery.full.find(i => i.id === localBefore.id);
    if (matchInDiscovery) {
      // No need for a separate GET — discovery already returned the
      // full RedmineIssue payload for our local pointer. Run the sync
      // against it and synthesize a "fresh" outcome.
      const syncResult = syncActiveIssueFromPayload(matchInDiscovery, profileName);
      refresh = {
        performed: true,
        succeeded: true,
        cleared: syncResult.cleared,
        previousStatus: localBefore.status,
        currentStatus: matchInDiscovery.status.name,
        freshness: 'fresh',
      };
    } else {
      // The local pointer's issue isn't in dev-active anymore (or
      // never was). Hit the canonical refresh endpoint to learn its
      // current state (and auto-clear if terminal).
      refresh = await liveRefreshActiveIssue(client, profileName);
      if (refresh.performed) httpCalls += 1;
    }
  }

  const localAfter = loadConfig().profiles[profileName]?.activeIssue;
  const verdict = reconcileActiveIssue(localAfter, discovery);
  return { verdict, refresh, cacheHit: discovery.fromCache, httpCalls };
}
