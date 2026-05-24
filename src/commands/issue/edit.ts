/**
 * `lwr issue edit <id>`
 *
 * Apply field updates. Every flag is optional; the issue is updated only
 * for fields that were passed.
 *
 * Status transitions go through `assertTransitionAllowed`: if the target
 * isn't in the issue's `allowed_statuses` for the current user, the call
 * is rejected with WORKFLOW_NOT_ALLOWED before any PUT — so blind agent
 * guesses don't silently land on the wrong state.
 */

import fs from 'node:fs';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags, dryRunPreview, type DryRunPreview } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { getIssue, toIssueUpdateBody, updateIssue, type UpdateIssueInput } from '../../api/issues';
import { assertTransitionAllowed, listStatuses, resolveStatusId } from '../../api/statuses';
import { resolveUserId } from '../../api/users';
import { resolveCustomFieldPairs, type ResolvedCustomField } from '../../foundation/cf-resolver';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES, REDMINE_PATHS } from '../../constants';
import type { RedmineIssue } from '../../api/types';
import {
  loadPreferences,
  applyPreferences,
  currentCfValuesFromIssue,
  bumpTriggerCounts,
  type AppliedDefault,
} from '../../assistant/preferences';
import { recordDecision, recordOverride } from '../../assistant/decisions';
import { enforceDevActiveMutex, previewDevActiveMutex } from '../../workflow/auto-pause';
import { syncActiveIssueFromPayload } from '../../workflow/active-issue';
import { resolveProfileName } from '../../foundation/profiles';

export interface IssueEditFlags extends GlobalFlags {
  id?: string | number;
  subject?: string;
  description?: string;
  descriptionFile?: string;
  trackerId?: number;
  statusId?: number;
  /** Status by name (resolved against the instance's status list). */
  status?: string;
  priorityId?: number;
  assigneeId?: number;
  /** Assignee by login or name (resolved via project members → /users.json → manual list). */
  assignee?: string;
  parentIssueId?: number;
  startDate?: string;
  dueDate?: string;
  estimatedHours?: number;
  doneRatio?: number;
  notes?: string;
  notesFile?: string;
  privateNotes?: boolean;
  /**
   * Custom-field setter, repeatable. Each entry is `<name-or-id>=<value>`;
   * see `foundation/cf-resolver.ts` for the resolution pipeline. Values that look
   * like names are run through the user resolver against the issue's
   * project (with `raw:` / `id:` escape hatches for ambiguous cases).
   */
  cf?: string[];
}

interface EditPayload {
  issue: RedmineIssue;
  /**
   * Issues paused by the dev-active mutex sweep after this edit. Empty
   * when the edit didn't change status, the new status isn't in
   * `DEV_ACTIVE_STATUS_NAMES`, or no other dev-active issues existed.
   */
  pausedIssues: { id: number; previousStatus: string; newStatus: string }[];
  /** Pause attempts that failed (best-effort). Usually empty. */
  failedPauses: { id: number; reason: string }[];
}

const cmd: CommandFn<EditPayload | DryRunPreview> = async (flags): Promise<CommandResult<EditPayload | DryRunPreview>> => {
  const flgs = flags as IssueEditFlags;
  if (flgs.id === undefined || flgs.id === null || flgs.id === '') {
    throw new ValidationError(
      'Issue id is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it as `lwr issue edit <id> ...`.',
    );
  }
  const id = normaliseId(flgs.id);

  if (flgs.status !== undefined && flgs.statusId !== undefined) {
    throw new ValidationError(
      'Pass either --status (name) or --status-id (number), not both.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  if (flgs.assignee !== undefined && flgs.assigneeId !== undefined) {
    throw new ValidationError(
      'Pass either --assignee (name/login) or --assignee-id (number), not both.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }

  const session = await openSession(flags);
  const { file: prefsFile, warnings: prefsWarnings } = loadPreferences();
  const rules = prefsFile.rules;

  const haveStatusChange = flgs.status !== undefined || flgs.statusId !== undefined;
  const haveCfChange = Boolean(flgs.cf && flgs.cf.length > 0);
  // Fetch the issue when status is changing (for the workflow guard) OR
  // when preferences exist AND the user is touching cfs (so the apply
  // path can check whether a target cf is already non-blank).
  const needsIssue = haveStatusChange || (rules.length > 0 && haveCfChange);

  let issue: RedmineIssue | undefined;
  let resolvedStatusId: number | undefined;
  let resolvedStatusName: string | undefined;
  if (needsIssue) {
    const fetches: [Promise<RedmineIssue>, Promise<Awaited<ReturnType<typeof listStatuses>>> | null] = [
      getIssue(session.client, id, { allowedStatuses: true }),
      haveStatusChange ? listStatuses(session.client) : null,
    ];
    issue = await fetches[0];
    const statuses = fetches[1] ? await fetches[1] : null;

    if (haveStatusChange && statuses) {
      const raw = flgs.status ?? String(flgs.statusId);
      try {
        resolvedStatusId = resolveStatusId(statuses, raw);
      } catch (err) {
        throw new ValidationError(
          err instanceof Error ? err.message : String(err),
          ERROR_CODES.VALIDATION_BAD_VALUE,
        );
      }
      assertTransitionAllowed(issue, resolvedStatusId);
      resolvedStatusName = statuses.find(s => s.id === resolvedStatusId)?.name ?? raw;
    }
  }

  // Resolve assignee by name/login against the issue's project members
  // (cache-first), with /users.json + manual fallback on miss.
  let resolvedAssigneeId: number | null | undefined;
  if (flgs.assignee !== undefined) {
    const r = await resolveUserId(session.client, flgs.assignee, { issueId: id });
    resolvedAssigneeId = r.source === 'none' ? null : r.id;
  }

  // Resolve --cf <name-or-id>=<value> pairs. Same project anchor as the
  // assignee resolver — values that look like names are resolved against
  // the issue's project members, falling back to a literal string for
  // list/text-type cfs.
  const resolvedCfs: ResolvedCustomField[] = haveCfChange
    ? await resolveCustomFieldPairs(session.client, flgs.cf!, { issueId: id })
    : [];

  // Apply cross-agent preferences. The apply-path's currentCfValues is
  // built from the fetched issue (when we have it); otherwise empty —
  // rules whose `when` only matches issue state will be no-ops, which
  // is fine: in that case the user isn't touching cfs or status.
  const currentCfValues = currentCfValuesFromIssue(issue?.custom_fields);
  const apply = applyPreferences(rules, { userCfs: resolvedCfs, currentCfValues });

  const input = collectUpdates(flgs);
  if (resolvedStatusId !== undefined) input.statusId = resolvedStatusId;
  if (resolvedAssigneeId !== undefined) input.assignedToId = resolvedAssigneeId;
  if (apply.customFields.length > 0) {
    input.customFields = apply.customFields;
  }
  if (Object.keys(input).length === 0) {
    throw new ValidationError(
      'Nothing to update.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass at least one field flag, e.g. `--status "In Progress"` or `--notes "..."`.',
    );
  }

  if (flags.dryRun) {
    const path = REDMINE_PATHS.ISSUE_BY_ID(id);
    const guards: string[] = [];
    if (resolvedStatusId !== undefined) guards.push('workflow.allowed_transition');
    const resolved: Record<string, unknown> = { issueId: id };
    if (resolvedStatusId !== undefined) resolved.status = { id: resolvedStatusId, name: resolvedStatusName ?? flgs.status ?? null };
    if (resolvedAssigneeId !== undefined) resolved.assignee = { id: resolvedAssigneeId, query: flgs.assignee ?? null };
    if (resolvedCfs.length > 0) {
      resolved.customFields = resolvedCfs.map(cf => ({
        id: cf.id,
        value: cf.value,
        raw: cf.raw,
        source: cf.source,
        ...(cf.matchedCf ? { resolvedName: cf.matchedCf.name } : {}),
      }));
    }
    // If a status change would land in dev-active, surface the would-be mutex sweep.
    const mutexPreview = resolvedStatusName !== undefined
      ? await previewDevActiveMutex(session.client, id, resolvedStatusName)
      : { wouldPause: [] };
    if (mutexPreview.wouldPause.length > 0) {
      resolved.wouldPause = mutexPreview.wouldPause;
    }
    const preview = dryRunPreview({
      method: 'PUT',
      path,
      payload: { issue: toIssueUpdateBody(input) },
      resolved,
      ...(guards.length > 0 ? { guards } : {}),
    });
    return {
      json: preview,
      pretty: ctx => {
        writeLine(dim(ctx, `[dry-run] would PUT ${path} — ${Object.keys(input).length} field(s)`));
        for (const p of mutexPreview.wouldPause) {
          writeLine(dim(ctx, `[dry-run] would PUT #${p.id} → Paused (mutex: ${p.currentStatus} → Paused)`));
        }
        renderAppliedDefaults(ctx, apply.applied);
      },
      meta: buildMeta(apply.applied, prefsWarnings),
    };
  }

  const updated = await updateIssue(session.client, id, input);

  syncActiveIssueFromPayload(updated, resolveProfileName(flags.profile));

  // After the PUT lands, bump counters + log to the events corpus.
  bumpTriggerCounts(apply.firedRuleIds);
  recordDecision({
    at: new Date().toISOString(),
    cmd: 'issue.edit',
    resolvedCfs: resolvedCfs.map(cf => ({ id: cf.id, value: cf.value, source: cf.source })),
    appliedDefaults: apply.applied,
    issueId: id,
  });
  for (const s of apply.skipped) {
    if (s.reason !== 'user-cf-override' || s.userValue === undefined) continue;
    recordOverride({
      at: new Date().toISOString(),
      cmd: 'issue.edit',
      ruleId: s.rule,
      cf: s.cf,
      userValue: s.userValue,
      ruleValue: s.ruleValue,
      issueId: id,
    });
  }

  // Post-PUT mutex sweep. Only fires if --status was set AND the new
  // status is in DEV_ACTIVE_STATUS_NAMES. This is what closes the
  // consistency gap with `issue.status` — `edit --status` now enforces
  // the mutex too.
  const mutex = resolvedStatusName !== undefined
    ? await enforceDevActiveMutex(session.client, id, resolvedStatusName)
    : { pausedIssues: [], failedPauses: [] };

  const payload: EditPayload = {
    issue: updated,
    pausedIssues: mutex.pausedIssues,
    failedPauses: mutex.failedPauses,
  };
  return {
    json: payload,
    pretty: ctx => {
      writeLine(success(ctx, `Updated #${updated.id}`));
      for (const p of mutex.pausedIssues) {
        writeLine(dim(ctx, `  ⏸ paused #${p.id} (${p.previousStatus} → ${p.newStatus})`));
      }
      for (const fp of mutex.failedPauses) {
        writeLine(dim(ctx, `  ⚠ could not pause #${fp.id}: ${fp.reason}`));
      }
      renderAppliedDefaults(ctx, apply.applied);
    },
    meta: buildMeta(apply.applied, prefsWarnings),
  };
};

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

function normaliseId(input: string | number): number {
  const s = String(input).trim().replace(/^#/, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(
      `Invalid issue id: ${input}`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return n;
}

function collectUpdates(flgs: IssueEditFlags): UpdateIssueInput {
  const u: UpdateIssueInput = {};
  if (flgs.subject !== undefined) u.subject = flgs.subject;
  if (flgs.description !== undefined) u.description = flgs.description;
  else if (flgs.descriptionFile !== undefined) u.description = readFileOrStdin(flgs.descriptionFile);
  if (flgs.trackerId !== undefined) u.trackerId = flgs.trackerId;
  // statusId is intentionally NOT collected here — status changes flow
  // through the preflight in the main command body so the workflow guard
  // and name resolution always run.
  if (flgs.priorityId !== undefined) u.priorityId = flgs.priorityId;
  if (flgs.assigneeId !== undefined) u.assignedToId = flgs.assigneeId;
  if (flgs.parentIssueId !== undefined) u.parentIssueId = flgs.parentIssueId;
  if (flgs.startDate !== undefined) u.startDate = flgs.startDate;
  if (flgs.dueDate !== undefined) u.dueDate = flgs.dueDate;
  if (flgs.estimatedHours !== undefined) u.estimatedHours = flgs.estimatedHours;
  if (flgs.doneRatio !== undefined) u.doneRatio = flgs.doneRatio;
  if (flgs.notes !== undefined) u.notes = flgs.notes;
  else if (flgs.notesFile !== undefined) u.notes = readFileOrStdin(flgs.notesFile);
  if (flgs.privateNotes !== undefined) u.privateNotes = flgs.privateNotes;
  return u;
}

function readFileOrStdin(path: string): string {
  return path === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path, 'utf8');
}

export function edit(flags: IssueEditFlags): Promise<never> {
  return runCommand('issue.edit', flags, cmd);
}
