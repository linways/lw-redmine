/**
 * `lwr home` (and bare `lwr` when no subcommand is given).
 *
 * The friendly landing view: time-of-day greeting + 3-5 context-aware
 * suggestions for what the user might want to do next. Pure local —
 * no Redmine round-trip. Honours `--json` so agents can introspect.
 *
 * Suggestion priority (top wins, max 5 shown):
 *   1. Unconfigured (no base URL) → setup hint
 *   2. Configured but no profile → auth login hint
 *   3. Rollover pending  → "did you stop yesterday without pausing?"
 *   4. Active issue exists → resume/view the sticky issue
 *   5. Last work-log day → review yesterday's session
 *   6. Recent frequent commands from memory (top 1-2)
 *   7. Always-on fallbacks (`issue list`, `time list`, `--help`)
 *
 * Time-of-day uses system clock (NOT WORK_TZ) — the greeting is about
 * the user's literal now, regardless of where their Redmine is hosted.
 */

import fs from 'node:fs';
import {
  runCommand,
  type CommandFn,
  type CommandResult,
  type GlobalFlags,
} from '../foundation/run';
import { loadConfig } from '../foundation/config';
import { workLogDir } from '../foundation/paths';
import { writeLine } from '../foundation/output';
import { success, dim } from '../foundation/format';
import { detectRollover } from '../workflow/daily-rollover';
import { memoryBankId } from '../assistant/state';
import { recall } from '../memory/recall';
import { openSession } from '../foundation/session';
import {
  freshnessOf,
  reconcileLiveActiveIssue,
  type Freshness,
  type DiscoveredIssue,
  type ReconcileLiveResult,
} from '../workflow/active-issue';

type DayPeriod = 'morning' | 'afternoon' | 'evening' | 'night';

interface Greeting {
  period: DayPeriod;
  /** Full name from profile.me, or null if unconfigured. */
  name: string | null;
  /** Rendered greeting line. */
  text: string;
}

interface HomeContext {
  configured: boolean;
  authed: boolean;
  /**
   * Cached sticky issue. `status` is the LAST KNOWN value — read
   * `activeIssue.freshness` before quoting it. `'fresh'` means we just
   * verified against Redmine; `'aging'` / `'stale'` means the cache
   * may be out of date.
   */
  activeIssue: {
    id: number;
    subject: string;
    status: string;
    freshness: Freshness;
  } | null;
  /**
   * Populated when a live-refresh discovered the previously-active
   * issue has transitioned to a closed status. The pointer has been
   * cleared from config; the agent should report this to the user.
   */
  activeIssueCleared: {
    previousId: number;
    previousSubject: string;
    currentStatus: string;
  } | null;
  /**
   * Set when the LOCAL pointer is empty but Redmine has exactly one
   * issue sitting in DEV_ACTIVE_STATUS_NAMES for the user. The agent
   * should offer it to the user ("looks like #X is in-progress on
   * Redmine — want me to use that as your active issue?") and, on
   * confirmation, run `lwr issue use <id>`. Never auto-adopted.
   */
  discoveredActiveIssue: DiscoveredIssue | null;
  /**
   * Set when the LOCAL pointer points at a different issue than the
   * one Redmine has in DEV_ACTIVE_STATUS_NAMES. The agent should ask
   * the user which is current before any mutation.
   */
  activeIssueConflict: { local: { id: number; subject: string; status: string }; redmine: DiscoveredIssue } | null;
  /**
   * Set when Redmine has MORE THAN ONE issue in DEV_ACTIVE_STATUS_NAMES
   * for the user — the Linways single-active-issue invariant is broken.
   * The agent should surface all candidates and ask which is current.
   */
  mutexViolation: { issues: DiscoveredIssue[] } | null;
  rolloverPending: boolean;
  lastWorkLogDate: string | null;
}

interface Suggestion {
  cmd: string;
  reason: string;
  /** Lower = higher priority. Used for stable ordering. */
  priority: number;
}

interface HomePayload {
  greeting: Greeting;
  context: HomeContext;
  suggestions: Suggestion[];
}

const cmd: CommandFn<HomePayload> = async (flags): Promise<CommandResult<HomePayload>> => {
  const greeting = buildGreeting();
  const { context, reconcileOutcome } = await buildContext(flags);
  const suggestions = buildSuggestions(context);

  const meta: Record<string, unknown> = {};
  if (reconcileOutcome) {
    meta.activeIssue = {
      cacheHit: reconcileOutcome.cacheHit,
      httpCalls: reconcileOutcome.httpCalls,
    };
  }

  return {
    json: { greeting, context, suggestions },
    meta,
    pretty: ctx => {
      writeLine(success(ctx, greeting.text));
      writeLine('');
      if (suggestions.length === 0) {
        writeLine(dim(ctx, 'Run `lwr --help` to see what lwr can do.'));
        return;
      }
      writeLine(dim(ctx, 'Suggested next steps:'));
      for (const s of suggestions) {
        writeLine(`  • ${s.cmd}`);
        writeLine(`    ${dim(ctx, s.reason)}`);
      }
      writeLine('');
      writeLine(dim(ctx, 'Run `lwr --help` for the full command list.'));
    },
  };
};

export function home(flags: HomeFlags): Promise<never> {
  return runCommand('home', flags, cmd);
}

// --- Greeting --------------------------------------------------------------

function buildGreeting(now: Date = new Date()): Greeting {
  const period = periodOf(now);
  const name = readProfileName();
  const firstName = name?.split(/\s+/)[0] ?? null;
  const text = firstName ? `Good ${period}, ${firstName}.` : `Good ${period}.`;
  return { period, name, text };
}

function periodOf(now: Date): DayPeriod {
  const h = now.getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

function readProfileName(): string | null {
  try {
    const cfg = loadConfig();
    const profile = cfg.profiles[cfg.activeProfile];
    if (!profile) return null;
    return profile.me?.user?.name ?? profile.me?.user?.login ?? null;
  } catch {
    return null;
  }
}

// --- Context ---------------------------------------------------------------

async function buildContext(
  flags: GlobalFlags,
): Promise<{ context: HomeContext; reconcileOutcome: ReconcileLiveResult | null }> {
  let configured = false;
  let authed = false;
  let cachedActiveIssue: { id: number; subject: string; status: string; setAt: string } | null = null;
  let profileName: string | null = null;

  try {
    const cfg = loadConfig();
    profileName = cfg.activeProfile;
    const profile = cfg.profiles[cfg.activeProfile];
    configured = Boolean(cfg.defaultBaseUrl) || Boolean(profile?.baseUrl);
    if (profile) {
      authed = Boolean(profile.me?.user?.id);
      if (profile.activeIssue) {
        cachedActiveIssue = {
          id: profile.activeIssue.id,
          subject: profile.activeIssue.subject,
          status: profile.activeIssue.status,
          setAt: profile.activeIssue.setAt,
        };
      }
    }
  } catch {
    // Config unreadable — first-run-ish state. Leave defaults.
  }

  // Talk to Redmine in parallel: live-refresh the local pointer (when
  // one is set) AND discover what Redmine currently has sitting in
  // DEV_ACTIVE_STATUS_NAMES for the user. The reconcile step folds the
  // two signals so the agent always sees the truth — even when the
  // user set the status via the Redmine UI without going through lwr.
  const reconcileOutcome = await safeLiveRedmineReconcile(flags, profileName, configured, authed);

  let activeIssue: HomeContext['activeIssue'] = null;
  let activeIssueCleared: HomeContext['activeIssueCleared'] = null;
  let discoveredActiveIssue: HomeContext['discoveredActiveIssue'] = null;
  let activeIssueConflict: HomeContext['activeIssueConflict'] = null;
  let mutexViolation: HomeContext['mutexViolation'] = null;

  if (reconcileOutcome) {
    const { refresh, verdict } = reconcileOutcome;

    if (refresh?.cleared && cachedActiveIssue) {
      activeIssueCleared = {
        previousId: cachedActiveIssue.id,
        previousSubject: cachedActiveIssue.subject,
        currentStatus: refresh.currentStatus ?? 'Closed',
      };
    }

    switch (verdict.kind) {
      case 'mutex-violation':
        mutexViolation = { issues: verdict.issues };
        break;
      case 'discovered':
        discoveredActiveIssue = verdict.discovered;
        break;
      case 'conflict':
        activeIssueConflict = {
          local: { id: verdict.local.id, subject: verdict.local.subject, status: verdict.local.status },
          redmine: verdict.redmine,
        };
        break;
      case 'aligned':
      case 'local-only': {
        // Read the post-refresh pointer; if the refresh cleared it,
        // skip — activeIssueCleared already covers the agent's reply.
        if (!activeIssueCleared) {
          try {
            const cfg = loadConfig();
            const profile = profileName ? cfg.profiles[profileName] : undefined;
            const pointer = profile?.activeIssue;
            if (pointer) {
              activeIssue = {
                id: pointer.id,
                subject: pointer.subject,
                status: pointer.status,
                freshness: refresh?.succeeded ? 'fresh' : freshnessOf(pointer.setAt),
              };
            }
          } catch {
            // Fall through; activeIssue stays null.
          }
        }
        break;
      }
      case 'no-active':
        // Both local and Redmine empty — nothing to report.
        break;
    }
  } else if (cachedActiveIssue) {
    // No Redmine round-trip possible (unconfigured/unauthed/network
    // failed before the discovery even attempted) — return cached +
    // freshness so the agent can still report SOMETHING with a stale
    // marker.
    activeIssue = {
      id: cachedActiveIssue.id,
      subject: cachedActiveIssue.subject,
      status: cachedActiveIssue.status,
      freshness: freshnessOf(cachedActiveIssue.setAt),
    };
  }

  let rolloverPending = false;
  try {
    rolloverPending = detectRollover() !== null;
  } catch {
    // Best-effort: never block the home view.
  }

  return {
    context: {
      configured,
      authed,
      activeIssue,
      activeIssueCleared,
      discoveredActiveIssue,
      activeIssueConflict,
      mutexViolation,
      rolloverPending,
      lastWorkLogDate: findLastWorkLogDate(),
    },
    reconcileOutcome,
  };
}

/**
 * Open a session and run the unified `reconcileLiveActiveIssue` dance.
 * Returns null when no Redmine round-trip is possible (unconfigured /
 * unauthed / session open failed) — caller falls back to cached pointer
 * with a freshness label.
 */
async function safeLiveRedmineReconcile(
  flags: GlobalFlags,
  profileName: string | null,
  configured: boolean,
  authed: boolean,
): Promise<ReconcileLiveResult | null> {
  if (!configured || !authed || !profileName) return null;
  try {
    const session = await openSession(flags);
    const f = flags as HomeFlags;
    return await reconcileLiveActiveIssue(session.client, profileName, { noCache: f.noCache });
  } catch {
    return null;
  }
}

export interface HomeFlags extends GlobalFlags {
  noCache?: boolean;
}

function findLastWorkLogDate(): string | null {
  try {
    const dir = workLogDir();
    if (!fs.existsSync(dir)) return null;
    const dates = fs
      .readdirSync(dir)
      .filter(n => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n))
      .map(n => n.replace(/\.ndjson$/, ''))
      .sort();
    return dates.length > 0 ? dates[dates.length - 1] : null;
  } catch {
    return null;
  }
}

// --- Suggestions -----------------------------------------------------------

const MAX_SUGGESTIONS = 5;

function buildSuggestions(ctx: HomeContext): Suggestion[] {
  // Setup states short-circuit — the user can't do anything useful until
  // they finish bootstrap, so we only show the next bootstrap step.
  if (!ctx.configured) {
    return [
      {
        cmd: 'lwr config base-url <url>',
        reason: 'Set your Redmine URL once to unlock everything else.',
        priority: 0,
      },
    ];
  }
  if (!ctx.authed) {
    return [
      {
        cmd: 'lwr auth login',
        reason: 'Sign in (run this in a fresh terminal — keep credentials out of agent context).',
        priority: 0,
      },
    ];
  }

  const out: Suggestion[] = [];

  // Highest priority: mutex violation. Linways policy is one in-progress
  // issue per dev; if Redmine shows more, the agent should ask the user
  // which is current before doing anything else.
  if (ctx.mutexViolation) {
    out.push({
      cmd: 'lwr issue active',
      reason: `Mutex violation — ${ctx.mutexViolation.issues.length} issues sit in dev-active statuses on Redmine. Ask the user which one is current; pause the rest before continuing.`,
      priority: 0,
    });
  }

  // Local + Redmine disagree on the active issue. Ask the user.
  if (ctx.activeIssueConflict) {
    out.push({
      cmd: 'lwr issue current',
      reason: `Active-issue conflict — local says #${ctx.activeIssueConflict.local.id} (${ctx.activeIssueConflict.local.subject}), Redmine has #${ctx.activeIssueConflict.redmine.id} (${ctx.activeIssueConflict.redmine.subject}) in '${ctx.activeIssueConflict.redmine.status}'. Ask the user which is current.`,
      priority: 0,
    });
  }

  // Local pointer empty, but Redmine has one active. Offer to adopt.
  if (ctx.discoveredActiveIssue) {
    out.push({
      cmd: `lwr issue use ${ctx.discoveredActiveIssue.id}`,
      reason: `Redmine has #${ctx.discoveredActiveIssue.id} (${ctx.discoveredActiveIssue.subject}) in '${ctx.discoveredActiveIssue.status}', but the local sticky pointer is empty. Offer to set this as the active issue.`,
      priority: 1,
    });
  }

  // A previously-active issue that turned out to be closed in Redmine.
  if (ctx.activeIssueCleared) {
    out.push({
      cmd: 'lwr issue list',
      reason: `Your previously-active issue #${ctx.activeIssueCleared.previousId} (${ctx.activeIssueCleared.previousSubject}) is now ${ctx.activeIssueCleared.currentStatus} on Redmine — sticky pointer was cleared. Pick a new one when you're ready.`,
      priority: 1,
    });
  }

  if (ctx.rolloverPending) {
    out.push({
      cmd: 'lwr issue handover --stopped <HH:MM>',
      reason: 'Looks like you stopped without pausing — log the stop time so tracking stays accurate.',
      priority: 1,
    });
  }

  if (ctx.activeIssue) {
    // Only quote status when freshness is fresh — otherwise the agent
    // would be reporting cached state as authoritative.
    const reason = ctx.activeIssue.freshness === 'fresh'
      ? `You're on #${ctx.activeIssue.id} — ${ctx.activeIssue.subject} (${ctx.activeIssue.status}).`
      : `You're on #${ctx.activeIssue.id} — ${ctx.activeIssue.subject}. Live status not verified (run \`lwr issue view ${ctx.activeIssue.id}\` if it matters).`;
    out.push({
      cmd: 'lwr issue current',
      reason,
      priority: 2,
    });
  }

  if (ctx.lastWorkLogDate) {
    const today = todayIsoDate();
    if (ctx.lastWorkLogDate === today) {
      out.push({
        cmd: 'lwr log show --today',
        reason: 'Review what you logged so far today.',
        priority: 3,
      });
    } else {
      out.push({
        cmd: `lwr log show --date ${ctx.lastWorkLogDate}`,
        reason: `Last session was on ${ctx.lastWorkLogDate}.`,
        priority: 3,
      });
    }
  }

  // Memory-driven frequent commands. Filter out introspection and the
  // home verb itself — they're noise on a landing view. Cap at 2 so the
  // fallbacks still have room.
  const memSuggestions = readFrequentCommands(out.map(s => s.cmd));
  for (const s of memSuggestions) {
    if (out.length >= MAX_SUGGESTIONS) break;
    out.push(s);
  }

  // Always-on fallbacks if we're still under the cap.
  const fallbacks: Suggestion[] = [
    { cmd: 'lwr issue list', reason: 'List your open tickets.', priority: 9 },
    { cmd: 'lwr time list', reason: "Check this week's logged hours.", priority: 9 },
    { cmd: 'lwr --help', reason: 'See the full command list.', priority: 10 },
  ];
  for (const f of fallbacks) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (!out.some(s => s.cmd === f.cmd)) out.push(f);
  }

  return out.slice(0, MAX_SUGGESTIONS);
}

function readFrequentCommands(exclude: string[]): Suggestion[] {
  try {
    const r = recall({
      bankId: memoryBankId(),
      kind: 'observation',
      topK: 5,
      metadataFilter: { outcome: 'success' },
    });
    const excluded = new Set(exclude);
    const out: Suggestion[] = [];
    const seenCmd = new Set<string>();
    const skipNoise = new Set(['home', 'commands', 'doctor', 'serve', 'me.show']);
    for (const row of r.rows) {
      if (out.length >= 2) break;
      const raw = String(row.metadata.cmd ?? '');
      if (!raw || skipNoise.has(raw) || seenCmd.has(raw)) continue;
      seenCmd.add(raw);
      const lwrCmd = `lwr ${raw.replace(/\./g, ' ')}`;
      if (excluded.has(lwrCmd)) continue;
      out.push({
        cmd: lwrCmd,
        reason: `You've used this ${row.seenCount} time${row.seenCount === 1 ? '' : 's'} recently.`,
        priority: 4,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
