/**
 * Daily rollover — detects when a dev shut down without pausing.
 *
 * The Linways workflow has a single-active-issue mutex: at most one issue
 * per dev sits in DEV_ACTIVE_STATUS_NAMES. The auto-pause hook keeps the
 * mutex true when the dev switches issues, but it can't see "user shut
 * the laptop without running anything." On the next morning's first
 * mutating command, the issue is *still* in-progress — and auto-pause
 * would back-fill the entire overnight gap as work time. That's wrong.
 *
 * This module detects that state by looking at three independent signals:
 *
 *   1. There is an active issue in config, AND its status is in
 *      DEV_ACTIVE_STATUS_NAMES.
 *   2. The most recent action-log entry has either a different calendar
 *      date (in WORK_TZ) than today, OR a wall-clock gap from now of at
 *      least ROLLOVER_MIN_GAP_MS.
 *   3. The user hasn't already acknowledged today's rollover (single
 *      marker file at `~/.lwr/.rollover-ack`).
 *
 * When all three hit, `detectRollover()` returns a structured signal that
 * the foundation preflight surfaces as `meta.dailyRollover` in JSON mode
 * and as a one-line stderr warning in pretty mode. The agent reads the
 * signal, asks the user when they actually stopped, then drives
 * `lwr issue handover` to do the atomic time-entry backfill + status
 * change.
 *
 * Everything in this file is best-effort: a thrown exception in the
 * detection path must never break the user's command. The detector also
 * caches its result per process — subsequent commands in the same lwr
 * invocation reuse it instead of re-walking the log directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { activeProfile } from '../foundation/profiles';
import { rolloverAckPath, workLogDir } from '../foundation/paths';
import {
  setPreflightProvider,
  type PreflightWarning,
} from '../foundation/run';
import { todayInWorkTz } from './work-log';
import {
  DEV_ACTIVE_STATUS_NAMES,
  ROLLOVER_MIN_GAP_MS,
  WORK_TZ,
} from '../constants';

export interface RolloverSignal {
  /** The issue carrying over from a prior session. */
  issueId: number;
  issueSubject: string;
  issueStatus: string;
  /** ISO of the last action-log entry, in WORK_TZ offset. */
  lastActivityAt: string;
  /** Which signal tripped first. */
  reason: 'date-change' | 'gap-exceeded';
  /** Wall-clock ms between lastActivityAt and now. */
  gapMs: number;
}

let cached: RolloverSignal | null | undefined = undefined;

/**
 * Run all three checks. Returns `null` when no rollover is in effect.
 * Memoised per process: tests + multi-call agent flows pay the readdir
 * cost once.
 */
export function detectRollover(): RolloverSignal | null {
  if (cached !== undefined) return cached;
  try {
    if (isAcknowledgedToday()) return cache(null);

    const activeIssue = readActiveIssueForRollover();
    if (!activeIssue) return cache(null);

    const last = findLastActivity();
    if (!last) return cache(null);

    const lastMs = Date.parse(last.isoTimestamp);
    if (!Number.isFinite(lastMs)) return cache(null);

    const nowMs = Date.now();
    const gapMs = nowMs - lastMs;
    // Compare DATES in WORK_TZ — not raw string slices. The action-log
    // writes WORK_TZ offsets in production, but tests may use UTC; either
    // way we want the calendar-day-in-Asia/Kolkata comparison.
    const lastDateInWorkTz = ymdInWorkTz(new Date(lastMs));
    const dateChanged = lastDateInWorkTz !== todayInWorkTz();

    if (!dateChanged && gapMs < ROLLOVER_MIN_GAP_MS) return cache(null);

    return cache({
      issueId: activeIssue.id,
      issueSubject: activeIssue.subject,
      issueStatus: activeIssue.status,
      lastActivityAt: last.isoTimestamp,
      reason: dateChanged ? 'date-change' : 'gap-exceeded',
      gapMs,
    });
  } catch {
    return cache(null);
  }
}

function cache(value: RolloverSignal | null): RolloverSignal | null {
  cached = value;
  return value;
}

/** Test helper — flush the cache between assertions in the same process. */
export function _resetRolloverCache(): void {
  cached = undefined;
}

/**
 * Read the active issue from the active profile, but only return it if
 * its status is in the dev-active mutex set. Any other status (paused,
 * resolved, in queue) means there's nothing to roll over.
 */
function readActiveIssueForRollover():
  | { id: number; subject: string; status: string }
  | null {
  try {
    const { profile } = activeProfile();
    const issue = profile.activeIssue;
    if (!issue) return null;
    if (!(DEV_ACTIVE_STATUS_NAMES as readonly string[]).includes(issue.status)) {
      return null;
    }
    return { id: issue.id, subject: issue.subject, status: issue.status };
  } catch {
    return null;
  }
}

export interface LastActivity {
  isoTimestamp: string;
}

/**
 * Find the most recent action-log entry by walking `~/.lwr/log/` in
 * reverse-date order. Skips empty files (a day where lwr was loaded
 * but never produced a mutating command). Handles both the legacy
 * schema-1 session format and the current schema-2 action format —
 * either has enough info to derive a timestamp.
 *
 * Returns `null` for fresh installs / cleared logs.
 *
 * Exported because `lwr issue handover` needs the same lookup to
 * compute the time-entry start.
 */
export function findLastActivity(): LastActivity | null {
  const dir = workLogDir();
  if (!fs.existsSync(dir)) return null;

  const files = fs
    .readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f))
    .sort()
    .reverse();

  for (const file of files) {
    const fullPath = path.join(dir, file);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf8').trim();
    } catch {
      continue;
    }
    if (content === '') continue;

    const lastLine = content.slice(content.lastIndexOf('\n') + 1);
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      continue;
    }

    const ts = extractTimestamp(entry);
    if (ts) return { isoTimestamp: ts };
  }
  return null;
}

/**
 * Schema-2 (`recordAction`) uses `at`. Schema-1 (legacy session) uses
 * `end` when the session closed cleanly, else `start`. Either is good
 * enough to anchor the gap calculation.
 */
function extractTimestamp(entry: Record<string, unknown>): string | null {
  if (typeof entry.at === 'string') return entry.at;
  if (typeof entry.end === 'string') return entry.end;
  if (typeof entry.start === 'string') return entry.start;
  return null;
}

// --- Acknowledgement marker -----------------------------------------------

/** Returns true iff today (WORK_TZ) has already been ack'd. */
export function isAcknowledgedToday(): boolean {
  try {
    const file = rolloverAckPath();
    if (!fs.existsSync(file)) return false;
    const stamp = fs.readFileSync(file, 'utf8').trim();
    return stamp === todayInWorkTz();
  } catch {
    return false;
  }
}

/**
 * Stamp today as ack'd. Called by `lwr issue handover` (any mode,
 * including --dismiss) and exposed for tests. Idempotent.
 */
export function acknowledgeRolloverToday(): void {
  try {
    const file = rolloverAckPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, todayInWorkTz() + '\n', { mode: 0o600 });
    cache(null); // future detect() calls in this process return null
  } catch {
    // Best-effort.
  }
}

// --- Bootstrap ------------------------------------------------------------

/**
 * Wire the detector into `foundation/run`'s pre-flight slot. Called once
 * at CLI startup (next to `bootstrapAssistantObserver`). Skipped commands:
 *   - `issue.handover` — the verb that *resolves* the rollover would
 *     loop on itself otherwise.
 *   - `home` — the landing view embeds its own rollover-prompt
 *     suggestion; the stderr preflight warning would duplicate it.
 *
 * The provider is best-effort: any throw is swallowed by foundation/run.
 */
export function bootstrapDailyRollover(): void {
  setPreflightProvider((cmdName: string): PreflightWarning | null => {
    if (cmdName === 'issue.handover' || cmdName === 'home') return null;
    const signal = detectRollover();
    if (!signal) return null;
    return {
      metaKey: 'dailyRollover',
      payload: {
        issueId: signal.issueId,
        issueSubject: signal.issueSubject,
        issueStatus: signal.issueStatus,
        lastActivityAt: signal.lastActivityAt,
        reason: signal.reason,
        gapMs: signal.gapMs,
        suggestedAction: `lwr issue handover ${signal.issueId} --stopped <when>`,
      },
      prettyLine: buildPrettyWarning(signal),
    };
  });
}

function buildPrettyWarning(signal: RolloverSignal): string {
  const ago = formatGap(signal.gapMs);
  return (
    `⚠ Issue #${signal.issueId} (${signal.issueStatus}) carried over from ` +
    `${signal.lastActivityAt.slice(0, 16).replace('T', ' ')} (${ago} ago). ` +
    `Run \`lwr issue handover ${signal.issueId} --stopped <HH:MM>\` to backfill.`
  );
}

/**
 * Date in `YYYY-MM-DD` form according to WORK_TZ, regardless of the
 * input Date's storage. Mirrors `ymdInTz` from work-log.ts (private
 * there) so we don't need to widen its surface.
 */
function ymdInWorkTz(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function formatGap(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
