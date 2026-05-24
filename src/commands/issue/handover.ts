/**
 * `lwr issue handover [<id>] --stopped <time> [--mode <pause|resolve|resume>] [--note <text>]`
 * `lwr issue handover --dismiss`
 *
 * Resolves the daily-rollover signal — the "you didn't pause; lwr left
 * the issue overnight in a dev-active status" case. Two atomic steps:
 *
 *   1. POST a time entry covering [lastActivityAt → --stopped] on the
 *      target issue. Hours rounded to two decimals. Activity defaults
 *      to "Configurations" (Linways norm; matches `lwr issue resolve`).
 *   2. PUT the issue to the status implied by --mode:
 *        pause   → PAUSE_STATUS_NAME (the typical case — work resumes later)
 *        resolve → RESOLVED_STATUS_NAME (deployed-to-prod semantic)
 *        resume → no status change (just backfill the gap, keep working)
 *
 * `--dismiss` short-circuits: no time entry, no status change. Just
 * marks today's rollover acknowledged so the warning stops surfacing.
 * Use when the dev confirms "no, I really did stop and pause already —
 * just clear the noise."
 *
 * After any successful run (including --dismiss), today is marked
 * acknowledged so subsequent commands in the same day stay quiet.
 */

import {
  runCommand,
  type CommandFn,
  type CommandResult,
  type GlobalFlags,
} from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { getIssue, updateIssue } from '../../api/issues';
import { assertTransitionAllowed, listStatuses, resolveStatusId } from '../../api/statuses';
import { listActivities, resolveActivityId } from '../../api/activities';
import { createTimeEntry } from '../../api/time-entries';
import type { RedmineTimeEntry } from '../../api/types';
import { activeProfile, resolveProfileName } from '../../foundation/profiles';
import { syncActiveIssueFromPayload } from '../../workflow/active-issue';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError, LwrError } from '../../foundation/errors';
import {
  ERROR_CODES,
  EXIT,
  PAUSE_STATUS_NAME,
  RESOLVED_STATUS_NAME,
  ROLLOVER_DEFAULT_MODE,
  ROLLOVER_MODES,
  type RolloverMode,
} from '../../constants';
import {
  findLastActivity,
  acknowledgeRolloverToday,
} from '../../workflow/daily-rollover';

/** Linways default — matches `lwr issue resolve`. */
const DEFAULT_ACTIVITY_NAME = 'Configurations';

export interface IssueHandoverFlags extends GlobalFlags {
  id?: string | number;
  stopped?: string;
  mode?: string;
  note?: string;
  dismiss?: boolean;
}

interface HandoverPayload {
  issueId: number | null;
  mode: RolloverMode | 'dismiss';
  ackedAt: string;
  timeEntry?: {
    id: number;
    hours: number;
    spentOn: string;
    activity: string;
  };
  status?: {
    from: string;
    to: string;
  };
}

const cmd: CommandFn<HandoverPayload> = async (
  flags,
): Promise<CommandResult<HandoverPayload>> => {
  const f = flags as IssueHandoverFlags;

  // --dismiss short-circuits everything. No session needed.
  if (f.dismiss) {
    acknowledgeRolloverToday();
    return {
      json: {
        issueId: null,
        mode: 'dismiss',
        ackedAt: new Date().toISOString(),
      },
      pretty: () => writeLine(`Rollover dismissed for today.`),
    };
  }

  if (!f.stopped) {
    throw new ValidationError(
      '`--stopped` is required when --dismiss is not set.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass the time you actually stopped working — `--stopped 19:30` or `--stopped 2026-05-22T19:30:00+05:30`.',
    );
  }

  const mode = parseMode(f.mode);
  const targetId = resolveTargetIssueId(f.id);
  const last = findLastActivity();
  if (!last) {
    throw new LwrError({
      message: 'No prior action-log activity found — nothing to back-fill.',
      code: ERROR_CODES.VALIDATION_BAD_VALUE,
      exit: EXIT.VALIDATION,
      hint: 'If you genuinely had no prior session, you probably meant `lwr issue pause` rather than `handover`.',
    });
  }

  const lastMs = Date.parse(last.isoTimestamp);
  if (!Number.isFinite(lastMs)) {
    throw new LwrError({
      message: `Could not parse last activity timestamp: ${last.isoTimestamp}`,
      code: ERROR_CODES.VALIDATION_BAD_VALUE,
      exit: EXIT.VALIDATION,
    });
  }
  const stoppedMs = parseStoppedTime(f.stopped, last.isoTimestamp);
  if (stoppedMs <= lastMs) {
    throw new ValidationError(
      `--stopped (${new Date(stoppedMs).toISOString()}) must be after the last action-log entry (${last.isoTimestamp}).`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'If you meant to log a session that ended yesterday, pass `--stopped 2026-05-22T19:30` with the full date.',
    );
  }

  // 2-decimal hours via inline math. roundHours() in foundation/numbers
  // is null/undefined-aware (returns number | null | undefined) which
  // doesn't match the strict `number` createTimeEntry expects, and we
  // already know our inputs are finite here.
  const hours = Math.round(((stoppedMs - lastMs) / 3_600_000) * 100) / 100;
  const spentOn = last.isoTimestamp.slice(0, 10); // YYYY-MM-DD of the day work happened

  const session = await openSession(flags);
  const activities = await listActivities(session.client);
  let activityId: number;
  try {
    activityId = resolveActivityId(activities, DEFAULT_ACTIVITY_NAME);
  } catch (err) {
    throw new ValidationError(
      err instanceof Error ? err.message : String(err),
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Edit DEFAULT_ACTIVITY_NAME in src/commands/issue/handover.ts to a value from `lwr time activities --json`.',
    );
  }

  // Step 1: time entry. If this fails the command fails — no half-done state.
  const entry: RedmineTimeEntry = await createTimeEntry(session.client, {
    issueId: targetId,
    hours,
    activityId,
    spentOn,
    comments: f.note ?? buildAutoNote(last.isoTimestamp, f.stopped),
  });

  // Step 2: status (skipped on --mode resume). Need the issue for the
  // allowed-statuses check, mirroring how `lwr issue resolve` validates.
  let statusPayload: HandoverPayload['status'];
  if (mode !== 'resume') {
    const targetStatusName = mode === 'pause' ? PAUSE_STATUS_NAME : RESOLVED_STATUS_NAME;
    const [issue, statuses] = await Promise.all([
      getIssue(session.client, targetId, { allowedStatuses: true }),
      listStatuses(session.client),
    ]);
    let statusId: number;
    try {
      statusId = resolveStatusId(statuses, targetStatusName);
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? err.message : String(err),
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
    if (issue.status.id !== statusId) {
      assertTransitionAllowed(issue, statusId);
      const updated = await updateIssue(session.client, targetId, { statusId });
      syncActiveIssueFromPayload(updated, resolveProfileName(flags.profile));
    }
    statusPayload = {
      from: issue.status.name,
      to: targetStatusName,
    };
  }

  acknowledgeRolloverToday();

  return {
    json: {
      issueId: targetId,
      mode,
      ackedAt: new Date().toISOString(),
      timeEntry: {
        id: entry.id,
        hours,
        spentOn,
        activity: DEFAULT_ACTIVITY_NAME,
      },
      ...(statusPayload ? { status: statusPayload } : {}),
    },
    pretty: ctx => {
      writeLine(success(ctx, `Backfilled ${hours}h on issue #${targetId} for ${spentOn}.`));
      if (statusPayload) {
        writeLine(`  ${dim(ctx, 'status:')} → ${statusPayload.to}`);
      }
      writeLine(`  ${dim(ctx, 'mode  :')} ${mode}`);
      writeLine(`  ${dim(ctx, 'ack   :')} today (rollover warning suppressed)`);
    },
  };
};

function parseMode(raw: string | undefined): RolloverMode {
  if (raw === undefined) return ROLLOVER_DEFAULT_MODE;
  if (!(ROLLOVER_MODES as readonly string[]).includes(raw)) {
    throw new ValidationError(
      `--mode must be one of: ${ROLLOVER_MODES.join(', ')} (got "${raw}").`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return raw as RolloverMode;
}

function resolveTargetIssueId(raw: string | number | undefined): number {
  if (raw !== undefined) {
    const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ValidationError(
        `Issue id must be a positive integer (got "${raw}").`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
    return n;
  }
  // Fall back to active issue.
  try {
    const { profile } = activeProfile();
    if (profile.activeIssue) return profile.activeIssue.id;
  } catch {
    // Fall through to the validation error below.
  }
  throw new ValidationError(
    'No issue id passed and no active issue set.',
    ERROR_CODES.VALIDATION_MISSING_FLAG,
    'Pass it positionally: `lwr issue handover 12345 --stopped HH:MM`. Or set an active issue first with `lwr issue use <id>`.',
  );
}

/**
 * Parse `--stopped` in one of:
 *   - HH:MM            ("19:30") — combined with the date of lastActivityAt
 *   - HH:MM:SS         ("19:30:00") — same
 *   - YYYY-MM-DDTHH:MM[:SS][+offset|Z] — full ISO
 *
 * Returns milliseconds since epoch.
 */
function parseStoppedTime(raw: string, lastActivityAt: string): number {
  // HH:MM or HH:MM:SS
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (hm) {
    const [, hh, mm, ss = '0'] = hm;
    const h = Number(hh);
    const m = Number(mm);
    const s = Number(ss);
    if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) {
      throw new ValidationError(
        `--stopped time out of range: "${raw}".`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
    // Combine with the date + offset of lastActivityAt.
    const lastDate = lastActivityAt.slice(0, 10); // YYYY-MM-DD
    const offset = extractOffset(lastActivityAt);
    const composed = `${lastDate}T${pad(h)}:${pad(m)}:${pad(s)}${offset}`;
    const ms = Date.parse(composed);
    if (!Number.isFinite(ms)) {
      throw new ValidationError(
        `Could not parse composed --stopped: "${composed}".`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
    return ms;
  }

  // Full ISO
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new ValidationError(
      `--stopped must be HH:MM, HH:MM:SS, or a full ISO timestamp (got "${raw}").`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return ms;
}

function extractOffset(iso: string): string {
  // Last 6 chars: +HH:MM or -HH:MM ; or 'Z' as last char.
  if (iso.endsWith('Z')) return 'Z';
  const m = /([+-]\d{2}:\d{2})$/.exec(iso);
  return m ? m[1] : '+00:00';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function buildAutoNote(lastActivityAt: string, stoppedRaw: string): string {
  return `[lwr handover] Backfill from ${lastActivityAt} to ${stoppedRaw}. Active issue carried over; lwr could not auto-pause because no command ran when work stopped.`;
}

export function handoverIssue(flags: IssueHandoverFlags): Promise<never> {
  return runCommand('issue.handover', flags, cmd);
}
