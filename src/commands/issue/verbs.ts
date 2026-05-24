/**
 * Issue verb sugar.
 *
 * Each function below is a thin wrapper over `updateIssue` / watcher API
 * that gives agents a one-shot command for the most common
 * lifecycle operations:
 *
 *   - status   change status by name or id
 *   - close    set status to the first is_closed status
 *   - assign   set assignee by id, login, or 'me'
 *   - watch    add the current (or named) user to watchers
 *   - unwatch  remove ditto
 *   - open     compute the canonical URL (and optionally launch a browser)
 *
 * Why verbs instead of just `lwr issue edit`? Two reasons:
 *   1. Shorter SKILL.md decision tree — agents pick a verb, not a flag set.
 *   2. Each verb can do the resolution work (status name → id, 'me' → user
 *      id) so callers don't have to.
 */

import { spawn } from 'node:child_process';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags, dryRunPreview, type DryRunPreview } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { addWatcher, getIssue, removeWatcher, updateIssue } from '../../api/issues';
import { assertTransitionAllowed, firstClosedStatus, listStatuses, resolveStatusId } from '../../api/statuses';
import { getCurrentUser, resolveUserId } from '../../api/users';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { LwrError, ValidationError } from '../../foundation/errors';
import { ERROR_CODES, EXIT, REDMINE_PATHS } from '../../constants';
import type { RedmineIssue } from '../../api/types';
import {
  loadPreferences,
  applyPreferences,
  currentCfValuesFromIssue,
  bumpTriggerCounts,
  type AppliedDefault,
} from '../../assistant/preferences';
import { recordDecision } from '../../assistant/decisions';
import { enforceDevActiveMutex, previewDevActiveMutex } from '../../workflow/auto-pause';
import { syncActiveIssueFromPayload } from '../../workflow/active-issue';
import { resolveProfileName } from '../../foundation/profiles';

// ---------------------------------------------------------------------------
// Shared id parsing
// ---------------------------------------------------------------------------

function normaliseId(input: string | number | undefined): number {
  if (input === undefined || input === null || input === '') {
    throw new ValidationError('Issue id is required.', ERROR_CODES.VALIDATION_MISSING_FLAG);
  }
  const s = String(input).trim().replace(/^#/, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`Invalid issue id: ${input}`, ERROR_CODES.VALIDATION_BAD_VALUE);
  }
  return n;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface IssueStatusFlags extends GlobalFlags {
  id?: string | number;
  status?: string;
  note?: string;
  private?: boolean;
}

interface StatusVerbPayload {
  issue: RedmineIssue;
  /**
   * Issues that were paused by the dev-active mutex sweep after this PUT.
   * Empty when:
   *   - the new status isn't in `DEV_ACTIVE_STATUS_NAMES`, OR
   *   - no other dev-active issues existed for this user (steady state).
   * The agent uses this to render "⏸ paused #X" hints and to know
   * the resume targets after the side work.
   */
  pausedIssues: { id: number; previousStatus: string; newStatus: string }[];
  /** Pause attempts that failed (best-effort). Usually empty. */
  failedPauses: { id: number; reason: string }[];
}

const statusCmd: CommandFn<StatusVerbPayload | DryRunPreview> = async (flags) => {
  const f = flags as IssueStatusFlags;
  const id = normaliseId(f.id);
  if (!f.status || f.status.trim().length === 0) {
    throw new ValidationError(
      'Status name or id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr issue status <id> <status>`.',
    );
  }

  const session = await openSession(flags);
  // Fetch issue with allowed_statuses + the global status list in parallel:
  // we need both to resolve names and to enforce the workflow guard.
  const [issue, statuses] = await Promise.all([
    getIssue(session.client, id, { allowedStatuses: true }),
    listStatuses(session.client),
  ]);
  let statusId: number;
  try {
    statusId = resolveStatusId(statuses, f.status);
  } catch (err) {
    throw new ValidationError(
      err instanceof Error ? err.message : String(err),
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }

  assertTransitionAllowed(issue, statusId);

  const statusName = statuses.find(s => s.id === statusId)?.name ?? f.status;

  // Apply cross-agent preferences. The verb itself doesn't accept --cf,
  // so `userCfs` is empty — only rules whose `when` matches the issue's
  // existing cf state can fire. This is the path that catches the
  // "transition requires Tester to be set" 422.
  const { file: prefsFile, warnings: prefsWarnings } = loadPreferences();
  const apply = applyPreferences(prefsFile.rules, {
    userCfs: [],
    currentCfValues: currentCfValuesFromIssue(issue.custom_fields),
  });

  // Dry-run path — preview the status PUT and the would-be mutex sweep
  // (issues that would be paused if the destination is dev-active).
  if (flags.dryRun) {
    const path = REDMINE_PATHS.ISSUE_BY_ID(id);
    const body: Record<string, unknown> = { status_id: statusId };
    if (f.note !== undefined) body.notes = f.note;
    if (f.private) body.private_notes = true;
    if (apply.customFields.length > 0) body.custom_fields = apply.customFields;
    const mutexPreview = await previewDevActiveMutex(session.client, id, statusName);
    const preview = dryRunPreview({
      method: 'PUT',
      path,
      payload: { issue: body },
      resolved: {
        issueId: id,
        status: { id: statusId, name: statusName },
        currentStatus: issue.status,
        wouldPause: mutexPreview.wouldPause,
      },
      guards: ['workflow.allowed_transition'],
    });
    return {
      json: preview,
      pretty: ctx => {
        writeLine(dim(ctx, `[dry-run] would PUT ${path} — status ${issue.status.name} → ${statusName}`));
        for (const p of mutexPreview.wouldPause) {
          writeLine(dim(ctx, `[dry-run] would PUT #${p.id} → Paused (mutex: ${p.currentStatus} → Paused)`));
        }
        renderAppliedDefaults(ctx, apply.applied);
      },
      meta: buildMeta(apply.applied, prefsWarnings),
    } as CommandResult<DryRunPreview>;
  }

  // Step 1: the target status PUT.
  const updated = await updateIssue(session.client, id, {
    statusId,
    notes: f.note,
    privateNotes: f.private,
    ...(apply.customFields.length > 0 ? { customFields: apply.customFields } : {}),
  });

  syncActiveIssueFromPayload(updated, resolveProfileName(flags.profile));

  bumpTriggerCounts(apply.firedRuleIds);
  recordDecision({
    at: new Date().toISOString(),
    cmd: 'issue.status',
    resolvedCfs: [],
    appliedDefaults: apply.applied,
    issueId: id,
  });

  // Step 2: post-PUT mutex sweep. Fires iff the new status is in
  // DEV_ACTIVE_STATUS_NAMES; pauses every OTHER dev-active issue for me.
  const mutex = await enforceDevActiveMutex(session.client, id, statusName);

  const payload: StatusVerbPayload = {
    issue: updated,
    pausedIssues: mutex.pausedIssues,
    failedPauses: mutex.failedPauses,
  };
  return {
    json: payload,
    pretty: ctx => {
      writeLine(success(ctx, `#${updated.id} → ${updated.status.name}`));
      for (const p of mutex.pausedIssues) {
        writeLine(dim(ctx, `  ⏸ paused #${p.id} (${p.previousStatus} → ${p.newStatus})`));
      }
      for (const fp of mutex.failedPauses) {
        writeLine(dim(ctx, `  ⚠ could not pause #${fp.id}: ${fp.reason}`));
      }
      renderAppliedDefaults(ctx, apply.applied);
    },
    meta: buildMeta(apply.applied, prefsWarnings),
  } as CommandResult<StatusVerbPayload>;
};

export function statusVerb(flags: IssueStatusFlags): Promise<never> {
  return runCommand('issue.status', flags, statusCmd);
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

export interface IssueCloseFlags extends GlobalFlags {
  id?: string | number;
  note?: string;
  private?: boolean;
  /** Override which closed status to use (e.g., "Rejected" vs "Closed"). */
  as?: string;
}

const closeCmd: CommandFn<RedmineIssue | DryRunPreview> = async (flags) => {
  const f = flags as IssueCloseFlags;
  const id = normaliseId(f.id);
  const session = await openSession(flags);
  const [issue, statuses] = await Promise.all([
    getIssue(session.client, id, { allowedStatuses: true }),
    listStatuses(session.client),
  ]);

  // Prefer a closed status that is actually allowed for this issue right
  // now; fall back to the global firstClosedStatus only if allowed_statuses
  // is missing (e.g. older Redmine).
  let target = f.as ? statuses.find(s => s.name.toLowerCase() === f.as!.toLowerCase()) : undefined;
  if (!target) {
    const allowed = issue.allowed_statuses ?? [];
    target = allowed.find(s => s.is_closed === true)
      ?? allowed.find(s => /closed/i.test(s.name))
      ?? firstClosedStatus(statuses);
  }
  if (!target) {
    throw new ValidationError(
      f.as
        ? `Unknown status "${f.as}".`
        : 'No closed status is allowed for this issue.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
      `Run \`lwr issue transitions ${id}\` to see what's allowed.`,
    );
  }

  assertTransitionAllowed(issue, target.id);

  const { file: prefsFile, warnings: prefsWarnings } = loadPreferences();
  const apply = applyPreferences(prefsFile.rules, {
    userCfs: [],
    currentCfValues: currentCfValuesFromIssue(issue.custom_fields),
  });

  if (flags.dryRun) {
    const path = REDMINE_PATHS.ISSUE_BY_ID(id);
    const body: Record<string, unknown> = { status_id: target.id };
    if (f.note !== undefined) body.notes = f.note;
    if (f.private) body.private_notes = true;
    if (apply.customFields.length > 0) body.custom_fields = apply.customFields;
    const preview = dryRunPreview({
      method: 'PUT',
      path,
      payload: { issue: body },
      resolved: { issueId: id, status: { id: target.id, name: target.name, is_closed: target.is_closed }, currentStatus: issue.status },
      guards: ['workflow.allowed_transition'],
    });
    return {
      json: preview,
      pretty: ctx => {
        writeLine(dim(ctx, `[dry-run] would PUT ${path} — close as "${target!.name}"`));
        renderAppliedDefaults(ctx, apply.applied);
      },
      meta: buildMeta(apply.applied, prefsWarnings),
    } as CommandResult<DryRunPreview>;
  }

  const updated = await updateIssue(session.client, id, {
    statusId: target.id,
    notes: f.note,
    privateNotes: f.private,
    ...(apply.customFields.length > 0 ? { customFields: apply.customFields } : {}),
  });

  syncActiveIssueFromPayload(updated, resolveProfileName(flags.profile));

  bumpTriggerCounts(apply.firedRuleIds);
  recordDecision({
    at: new Date().toISOString(),
    cmd: 'issue.close',
    resolvedCfs: [],
    appliedDefaults: apply.applied,
    issueId: id,
  });

  return {
    json: updated,
    pretty: ctx => {
      writeLine(success(ctx, `Closed #${updated.id} as "${updated.status.name}"`));
      renderAppliedDefaults(ctx, apply.applied);
    },
    meta: buildMeta(apply.applied, prefsWarnings),
  } as CommandResult<RedmineIssue>;
};

export function closeVerb(flags: IssueCloseFlags): Promise<never> {
  return runCommand('issue.close', flags, closeCmd);
}

// ---------------------------------------------------------------------------
// Preferences plumbing — small helpers shared by status + close verbs.
// ---------------------------------------------------------------------------

function buildMeta(
  applied: AppliedDefault[],
  warnings: { code: string; message: string }[],
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (applied.length > 0) meta.appliedDefaults = applied;
  if (warnings.length > 0) meta.warnings = warnings.map(w => ({ code: w.code, message: w.message }));
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function renderAppliedDefaults(ctx: import('../../foundation/output').OutputContext, applied: AppliedDefault[]): void {
  for (const a of applied) {
    const cfLabel = a.cfName ? `${a.cfName} (cf ${a.cf})` : `cf ${a.cf}`;
    const valueLabel = a.valueLabel ? `${a.valueLabel} (${a.value})` : String(a.value);
    writeLine(dim(ctx, `  applied default: ${cfLabel} = ${valueLabel} — rule: ${a.rule}`));
  }
}

// ---------------------------------------------------------------------------
// assign
// ---------------------------------------------------------------------------

export interface IssueAssignFlags extends GlobalFlags {
  id?: string | number;
  /** numeric id, 'me', or 'none' to clear. */
  user?: string;
  note?: string;
  private?: boolean;
}

const assignCmd: CommandFn<RedmineIssue | DryRunPreview> = async (flags) => {
  const f = flags as IssueAssignFlags;
  const id = normaliseId(f.id);
  const target = (f.user ?? '').trim();
  if (target.length === 0) {
    throw new ValidationError(
      'Assignee is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass `me`, `none`, a numeric user id, a login, or a name.',
    );
  }

  const session = await openSession(flags);
  // Resolve via the canonical path: numeric/me/none short-circuit, then
  // project members for this issue, then /users.json, then manual list.
  const resolved = await resolveUserId(session.client, target, { issueId: id });
  const assignedToId: number | null = resolved.source === 'none' ? null : resolved.id;

  if (flags.dryRun) {
    const path = REDMINE_PATHS.ISSUE_BY_ID(id);
    const body: Record<string, unknown> = { assigned_to_id: assignedToId };
    if (f.note !== undefined) body.notes = f.note;
    if (f.private) body.private_notes = true;
    const preview = dryRunPreview({
      method: 'PUT',
      path,
      payload: { issue: body },
      resolved: {
        issueId: id,
        ...(assignedToId === null ? { assignee: null } : { assignee: { id: assignedToId, name: resolved.name, source: resolved.source, query: target } }),
      },
    });
    return {
      json: preview,
      pretty: ctx => writeLine(dim(ctx, `[dry-run] would PUT ${path} — ${assignedToId === null ? 'unassign' : `assign to ${resolved.name}`}`)),
    } as CommandResult<DryRunPreview>;
  }

  const updated = await updateIssue(session.client, id, {
    assignedToId,
    notes: f.note,
    privateNotes: f.private,
  });

  syncActiveIssueFromPayload(updated, resolveProfileName(flags.profile));

  return {
    json: updated,
    pretty: ctx => writeLine(
      success(
        ctx,
        assignedToId === null
          ? `#${updated.id} unassigned`
          : `#${updated.id} → assigned to ${updated.assigned_to?.name ?? resolved.name}`,
      ),
    ),
  } as CommandResult<RedmineIssue>;
};

export function assignVerb(flags: IssueAssignFlags): Promise<never> {
  return runCommand('issue.assign', flags, assignCmd);
}

// ---------------------------------------------------------------------------
// watch / unwatch
// ---------------------------------------------------------------------------

export interface IssueWatchFlags extends GlobalFlags {
  id?: string | number;
  /** numeric user id; defaults to the current user. */
  user?: string;
}

async function resolveWatcherUserId(client: import('../../foundation/client').RedmineClient, raw?: string): Promise<number> {
  const t = (raw ?? '').trim();
  if (t.length === 0 || t.toLowerCase() === 'me') {
    const me = await getCurrentUser(client);
    return me.id;
  }
  if (/^\d+$/.test(t)) return Number(t);
  throw new ValidationError(
    `Cannot resolve watcher user "${t}".`,
    ERROR_CODES.VALIDATION_BAD_VALUE,
    'Pass a numeric user id or `me`.',
  );
}

const watchCmd: CommandFn<{ issueId: number; userId: number } | DryRunPreview> = async (flags) => {
  const f = flags as IssueWatchFlags;
  const id = normaliseId(f.id);
  const session = await openSession(flags);
  const userId = await resolveWatcherUserId(session.client, f.user);
  if (flags.dryRun) {
    const path = REDMINE_PATHS.ISSUE_WATCHERS(id);
    const preview = dryRunPreview({
      method: 'POST',
      path,
      payload: { user_id: userId },
      resolved: { issueId: id, userId },
    });
    return {
      json: preview,
      pretty: ctx => writeLine(dim(ctx, `[dry-run] would POST ${path} — add user ${userId} as watcher`)),
    } as CommandResult<DryRunPreview>;
  }
  await addWatcher(session.client, id, userId);
  return {
    json: { issueId: id, userId },
    pretty: ctx => writeLine(success(ctx, `Watching #${id} as user ${userId}`)),
  } as CommandResult<{ issueId: number; userId: number }>;
};

const unwatchCmd: CommandFn<{ issueId: number; userId: number } | DryRunPreview> = async (flags) => {
  const f = flags as IssueWatchFlags;
  const id = normaliseId(f.id);
  const session = await openSession(flags);
  const userId = await resolveWatcherUserId(session.client, f.user);
  if (flags.dryRun) {
    const path = REDMINE_PATHS.ISSUE_WATCHER_BY_ID(id, userId);
    const preview = dryRunPreview({
      method: 'DELETE',
      path,
      payload: null,
      resolved: { issueId: id, userId },
    });
    return {
      json: preview,
      pretty: ctx => writeLine(dim(ctx, `[dry-run] would DELETE ${path} — remove user ${userId} as watcher`)),
    } as CommandResult<DryRunPreview>;
  }
  try {
    await removeWatcher(session.client, id, userId);
  } catch (err) {
    // Redmine commonly gates watcher DELETE on the "Manage watchers" project
    // permission — even for self-removal. Re-raise with a verb-specific hint.
    if (err instanceof LwrError && err.code === ERROR_CODES.AUTH_FORBIDDEN) {
      throw new LwrError({
        message: err.message,
        code: ERROR_CODES.AUTH_FORBIDDEN,
        exit: EXIT.AUTH,
        hint: 'Redmine requires the "Manage watchers" role permission on this project to unwatch (even for yourself). Ask a project admin or remove via the web UI.',
        cause: err,
      });
    }
    throw err;
  }
  return {
    json: { issueId: id, userId },
    pretty: ctx => writeLine(success(ctx, `Unwatched #${id} as user ${userId}`)),
  } as CommandResult<{ issueId: number; userId: number }>;
};

export function watchVerb(flags: IssueWatchFlags): Promise<never> {
  return runCommand('issue.watch', flags, watchCmd);
}
export function unwatchVerb(flags: IssueWatchFlags): Promise<never> {
  return runCommand('issue.unwatch', flags, unwatchCmd);
}

// ---------------------------------------------------------------------------
// open (URL / browser)
// ---------------------------------------------------------------------------

export interface IssueOpenFlags extends GlobalFlags {
  id?: string | number;
  /** Actually launch a browser (only honoured in interactive TTY). */
  browser?: boolean;
}

const openCmd: CommandFn<{ issueId: number; url: string; launched: boolean }> = async (flags, ctx) => {
  const f = flags as IssueOpenFlags;
  const id = normaliseId(f.id);
  const session = await openSession(flags);

  // Touch the issue so a 404 surfaces as NOT_FOUND, not a misleading "url printed".
  const issue = await getIssue(session.client, id);

  const baseUrl = session.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/issues/${issue.id}`;

  let launched = false;
  if (f.browser) {
    if (!ctx.interactive) {
      throw new ValidationError(
        '--browser refused in non-interactive context (no TTY).',
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Drop --browser to just print the URL, which agents and pipes can consume.',
      );
    }
    launchBrowser(url);
    launched = true;
  }

  return {
    json: { issueId: issue.id, url, launched },
    pretty: c => {
      writeLine(url);
      if (launched) writeLine(dim(c, '  (launched in browser)'));
    },
  } as CommandResult<{ issueId: number; url: string; launched: boolean }>;
};

function launchBrowser(url: string): void {
  // Defense-in-depth: the URL is already built from a validated baseUrl
  // + numeric issue id, but parse-validate before handing to the OS opener
  // so a future code path that constructs a malformed string can't slip
  // anything past us. spawn (not exec) means there's no shell parsing,
  // but the URL still flows into the platform browser as an argument.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(
      `Refusing to open malformed URL: ${url}`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ValidationError(
      `Refusing to open URL with scheme "${parsed.protocol}": ${url}`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
}

export function openVerb(flags: IssueOpenFlags): Promise<never> {
  return runCommand('issue.open', flags, openCmd);
}
