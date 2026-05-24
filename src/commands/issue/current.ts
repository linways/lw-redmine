/**
 * `lwr issue current [--no-cache]`
 *
 * Reconciles the local sticky pointer (`profile.activeIssue`) with a
 * live Redmine query for whatever currently sits in
 * `DEV_ACTIVE_STATUS_NAMES` for the user. Five outcomes:
 *
 *   - aligned          local + Redmine agree, freshness=fresh
 *   - local-only       local set, Redmine sees nothing in dev-active
 *   - discovered       local empty, Redmine has 1 → surface, don't auto-adopt
 *   - conflict         local + Redmine disagree → surface both
 *   - mutex-violation  Redmine has > 1 → surface all
 *
 * Only throws `NOT_FOUND` when local AND Redmine both came up empty.
 * The pointer auto-clears if the live-refresh found a terminal status
 * (status name matches EFFECTIVELY_DONE_STATUS_NAMES).
 *
 * The discovery half is cached in-process for 60 s — repeated calls
 * within the same lwr process (e.g. `lwr serve` MCP mode) are free.
 * Pass `--no-cache` to force a fresh query.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { loadConfig, type ActiveIssue } from '../../foundation/config';
import { resolveProfileName } from '../../foundation/profiles';
import { openSession } from '../../foundation/session';
import { writeLine } from '../../foundation/output';
import { dim, success, warn } from '../../foundation/format';
import { NotFoundError } from '../../foundation/errors';
import {
  freshnessOf,
  reconcileLiveActiveIssue,
  type Freshness,
  type DiscoveredIssue,
  type ReconcileLiveResult,
} from '../../workflow/active-issue';

export interface IssueCurrentFlags extends GlobalFlags {
  noCache?: boolean;
}

interface ClearedReport {
  previousId: number;
  previousSubject: string;
  currentStatus: string;
}

interface Payload {
  profile: string;
  /** Set when local + Redmine agree, or local set + Redmine empty. */
  activeIssue: (ActiveIssue & { freshness: Freshness }) | null;
  /** Set when live-refresh found the local issue closed → pointer cleared. */
  cleared: ClearedReport | null;
  /** Set when local empty + Redmine has exactly one in-progress for me. */
  discoveredActiveIssue: DiscoveredIssue | null;
  /** Set when local + Redmine disagree on which issue is current. */
  conflict: { local: { id: number; subject: string; status: string }; redmine: DiscoveredIssue } | null;
  /** Set when Redmine has > 1 in DEV_ACTIVE_STATUS_NAMES for the user. */
  mutexViolation: { issues: DiscoveredIssue[] } | null;
  /** True iff a Redmine refresh succeeded in this run (cache hit also counts). */
  refreshed: boolean;
}

const cmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const profileName = resolveProfileName(flags.profile);
  const f = flags as IssueCurrentFlags;

  const cfgBefore = loadConfig();
  const profileBefore = cfgBefore.profiles[profileName];
  const localBefore = profileBefore?.activeIssue;

  let outcome: ReconcileLiveResult | null = null;
  let discoveryFailed = false;

  if (profileBefore) {
    try {
      const session = await openSession(flags);
      outcome = await reconcileLiveActiveIssue(session.client, profileName, { noCache: f.noCache });
    } catch {
      discoveryFailed = true;
    }
  }

  const refresh = outcome?.refresh ?? null;
  const verdict = outcome?.verdict;

  const meta: Record<string, unknown> = {};
  if (outcome) {
    meta.activeIssue = {
      cacheHit: outcome.cacheHit,
      httpCalls: outcome.httpCalls,
    };
  }

  // ----- 1. Refresh cleared the local pointer (terminal status). -----
  if (refresh?.cleared && localBefore) {
    const cleared: ClearedReport = {
      previousId: localBefore.id,
      previousSubject: localBefore.subject,
      currentStatus: refresh.currentStatus ?? 'Closed',
    };
    return {
      json: emptyPayload(profileName, { cleared, refreshed: true }),
      meta,
      pretty: ctx => {
        writeLine(success(ctx, `Sticky pointer cleared — #${cleared.previousId} is now ${cleared.currentStatus} on Redmine.`));
        writeLine(`  ${dim(ctx, 'previous:')} #${cleared.previousId} — ${cleared.previousSubject}`);
        writeLine(`  ${dim(ctx, 'next    :')} pick a new active issue with \`lwr issue use <id>\` when ready.`);
      },
    };
  }

  // ----- 2. Mutex violation. Linways one-active rule broken. -----
  if (verdict?.kind === 'mutex-violation') {
    return {
      json: emptyPayload(profileName, {
        mutexViolation: { issues: verdict.issues },
        refreshed: refresh?.succeeded ?? false,
      }),
      meta,
      pretty: ctx => {
        writeLine(warn(ctx, `Mutex violation — ${verdict.issues.length} issues sit in dev-active statuses on Redmine.`));
        for (const i of verdict.issues) {
          writeLine(`  ${dim(ctx, '·')} #${i.id} — ${i.subject} (${i.status})`);
        }
        writeLine(`  ${dim(ctx, 'next:')} pick the one that's truly current; pause the rest.`);
      },
    };
  }

  // ----- 3. Conflict between local + Redmine. -----
  if (verdict?.kind === 'conflict') {
    const conflict = {
      local: { id: verdict.local.id, subject: verdict.local.subject, status: verdict.local.status },
      redmine: verdict.redmine,
    };
    return {
      json: emptyPayload(profileName, { conflict, refreshed: refresh?.succeeded ?? false }),
      meta,
      pretty: ctx => {
        writeLine(warn(ctx, 'Active-issue conflict — local pointer and Redmine disagree.'));
        writeLine(`  ${dim(ctx, 'local  :')} #${conflict.local.id} — ${conflict.local.subject} (${conflict.local.status})`);
        writeLine(`  ${dim(ctx, 'redmine:')} #${conflict.redmine.id} — ${conflict.redmine.subject} (${conflict.redmine.status})`);
        writeLine(`  ${dim(ctx, 'next   :')} pick one with \`lwr issue use <id>\`.`);
      },
    };
  }

  // ----- 4. Discovered — local empty but Redmine has one. -----
  if (verdict?.kind === 'discovered') {
    return {
      json: emptyPayload(profileName, {
        discoveredActiveIssue: verdict.discovered,
        refreshed: refresh?.succeeded ?? false,
      }),
      meta,
      pretty: ctx => {
        writeLine(success(ctx, `Redmine has #${verdict.discovered.id} (${verdict.discovered.subject}) in '${verdict.discovered.status}'.`));
        writeLine(`  ${dim(ctx, 'note:')} local sticky pointer is empty.`);
        writeLine(`  ${dim(ctx, 'next:')} run \`lwr issue use ${verdict.discovered.id}\` to track this as your active issue.`);
      },
    };
  }

  // ----- 5. Aligned or local-only: read post-refresh local pointer. -----
  const cfgAfter = loadConfig();
  const activeIssue = cfgAfter.profiles[profileName]?.activeIssue;
  if (!activeIssue) {
    if (discoveryFailed) {
      throw new NotFoundError(
        `No active issue for profile "${profileName}" (and Redmine discovery failed).`,
        'Run `lwr issue use <id>` to set one, or check connectivity.',
      );
    }
    throw new NotFoundError(
      `No active issue for profile "${profileName}".`,
      'Run `lwr issue use <id>` to set one.',
    );
  }

  const freshness: Freshness = refresh?.succeeded ? 'fresh' : freshnessOf(activeIssue.setAt);

  return {
    json: {
      profile: profileName,
      activeIssue: { ...activeIssue, freshness },
      cleared: null,
      discoveredActiveIssue: null,
      conflict: null,
      mutexViolation: null,
      refreshed: refresh?.succeeded ?? false,
    },
    meta,
    pretty: ctx => {
      writeLine(`#${activeIssue.id} — ${activeIssue.subject}`);
      const tag = freshness === 'fresh'
        ? activeIssue.status
        : `${activeIssue.status} (${freshness} — last seen ${ageDescription(activeIssue.setAt)})`;
      writeLine(`  ${dim(ctx, `${activeIssue.tracker} · ${activeIssue.project.name} · ${tag}`)}`);
      writeLine(`  ${dim(ctx, `set at ${activeIssue.setAt}`)}`);
      if (refresh && !refresh.succeeded) {
        writeLine(`  ${dim(ctx, `(live-refresh failed: ${refresh.error ?? 'network unavailable'})`)}`);
      }
      if (outcome?.cacheHit) {
        writeLine(`  ${dim(ctx, '(reconciled from cache; pass --no-cache to force a fresh query)')}`);
      }
    },
  };
};

function emptyPayload(
  profile: string,
  patch: Partial<Payload>,
): Payload {
  return {
    profile,
    activeIssue: null,
    cleared: null,
    discoveredActiveIssue: null,
    conflict: null,
    mutexViolation: null,
    refreshed: false,
    ...patch,
  };
}

function ageDescription(setAt: string): string {
  const t = Date.parse(setAt);
  if (!Number.isFinite(t)) return 'unknown';
  const ageMs = Date.now() - t;
  if (ageMs < 60_000) return 'just now';
  if (ageMs < 60 * 60_000) return `${Math.round(ageMs / 60_000)} min ago`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.round(ageMs / (60 * 60_000))} h ago`;
  return `${Math.round(ageMs / (24 * 60 * 60_000))} d ago`;
}

export function currentIssue(flags: IssueCurrentFlags): Promise<never> {
  return runCommand('issue.current', flags, cmd);
}
