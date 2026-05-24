/**
 * `lwr issue create`
 *
 * Required: --project + --subject. Description can come from --description,
 * --description-file (path or `-` for stdin). Assignee accepts either a
 * numeric id (`--assignee-id`) or a login / name (`--assignee`) which is
 * resolved against the target project's members (cache-first), then
 * `/users.json`, then the manual list — same chain as `issue edit`.
 */

import fs from 'node:fs';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags, dryRunPreview, type DryRunPreview } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { createIssue } from '../../api/issues';
import { resolveProjectRef } from '../../api/projects';
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
  bumpTriggerCounts,
  type AppliedDefault,
} from '../../assistant/preferences';
import { recordDecision, recordOverride } from '../../assistant/decisions';

export interface IssueCreateFlags extends GlobalFlags {
  project?: string;
  subject?: string;
  description?: string;
  descriptionFile?: string;
  trackerId?: number;
  statusId?: number;
  priorityId?: number;
  assigneeId?: number;
  /** Assignee by login or name (resolved via project members → /users.json → manual list). */
  assignee?: string;
  parentIssueId?: number;
  startDate?: string;
  dueDate?: string;
  estimatedHours?: number;
  /**
   * Custom-field setter, repeatable. Same `<name-or-id>=<value>` form
   * as `issue edit`; values that look like names are resolved against
   * the target project's members.
   */
  cf?: string[];
}

const cmd: CommandFn<RedmineIssue | DryRunPreview> = async (flags): Promise<CommandResult<RedmineIssue | DryRunPreview>> => {
  const flgs = flags as IssueCreateFlags;
  if (!flgs.project) {
    throw new ValidationError(
      'Project is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass `--project <id|identifier>`.',
    );
  }
  if (!flgs.subject) {
    throw new ValidationError(
      'Subject is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass `--subject "..."`.',
    );
  }
  if (flgs.assignee !== undefined && flgs.assigneeId !== undefined) {
    throw new ValidationError(
      'Pass either --assignee (name/login) or --assignee-id (number), not both.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }

  const description = readDescription(flgs);

  const session = await openSession(flags);
  const projectRef = await resolveProjectRef(session.client, flgs.project);

  // Resolve assignee by name/login against the target project's members
  // (cache-first), with /users.json + manual fallback on miss. On create
  // there's no existing assignee to clear, so `none` is treated as "omit".
  let assignedToId: number | undefined = flgs.assigneeId;
  if (flgs.assignee !== undefined) {
    const r = await resolveUserId(session.client, flgs.assignee, { projectId: projectRef.id });
    assignedToId = r.source === 'none' ? undefined : r.id;
  }

  // Resolve --cf <name-or-id>=<value> pairs against the target project.
  const resolvedCfs: ResolvedCustomField[] = flgs.cf && flgs.cf.length > 0
    ? await resolveCustomFieldPairs(session.client, flgs.cf, { projectId: projectRef.id })
    : [];

  // Apply cross-agent preferences. On create there's no existing issue,
  // so `currentCfValues` is built solely from the user's --cf pairs —
  // rules whose `when` keys off an issue's existing state don't fire here.
  const { file: prefsFile, warnings: prefsWarnings } = loadPreferences();
  const apply = applyPreferences(prefsFile.rules, {
    userCfs: resolvedCfs,
    currentCfValues: new Map(),
  });

  const createInput = {
    projectId: projectRef.id,
    subject: flgs.subject,
    description,
    trackerId: flgs.trackerId,
    statusId: flgs.statusId,
    priorityId: flgs.priorityId,
    assignedToId,
    parentIssueId: flgs.parentIssueId,
    startDate: flgs.startDate,
    dueDate: flgs.dueDate,
    estimatedHours: flgs.estimatedHours,
    ...(apply.customFields.length > 0
      ? { customFields: apply.customFields }
      : {}),
  };

  if (flags.dryRun) {
    const body: Record<string, unknown> = {
      project_id: createInput.projectId,
      subject: createInput.subject,
    };
    if (createInput.description !== undefined) body.description = createInput.description;
    if (createInput.trackerId !== undefined) body.tracker_id = createInput.trackerId;
    if (createInput.statusId !== undefined) body.status_id = createInput.statusId;
    if (createInput.priorityId !== undefined) body.priority_id = createInput.priorityId;
    if (createInput.assignedToId !== undefined) body.assigned_to_id = createInput.assignedToId;
    if (createInput.parentIssueId !== undefined) body.parent_issue_id = createInput.parentIssueId;
    if (createInput.startDate !== undefined) body.start_date = createInput.startDate;
    if (createInput.dueDate !== undefined) body.due_date = createInput.dueDate;
    if (createInput.estimatedHours !== undefined) body.estimated_hours = createInput.estimatedHours;
    if (apply.customFields.length > 0) {
      body.custom_fields = apply.customFields;
    }
    const preview = dryRunPreview({
      method: 'POST',
      path: REDMINE_PATHS.ISSUES,
      payload: { issue: body },
      resolved: {
        project: { id: projectRef.id, name: projectRef.name, identifier: projectRef.identifier },
        ...(assignedToId !== undefined ? { assignee: { id: assignedToId, query: flgs.assignee ?? null } } : {}),
        ...(resolvedCfs.length > 0
          ? {
              customFields: resolvedCfs.map(cf => ({
                id: cf.id,
                value: cf.value,
                raw: cf.raw,
                source: cf.source,
                ...(cf.matchedCf ? { resolvedName: cf.matchedCf.name } : {}),
              })),
            }
          : {}),
      },
    });
    return {
      json: preview,
      pretty: ctx => {
        writeLine(dim(ctx, `[dry-run] would POST ${REDMINE_PATHS.ISSUES} — create issue in ${projectRef.name}`));
        renderAppliedDefaults(ctx, apply.applied);
      },
      meta: buildMeta(apply.applied, prefsWarnings),
    };
  }

  const issue = await createIssue(session.client, createInput);

  bumpTriggerCounts(apply.firedRuleIds);
  recordDecision({
    at: new Date().toISOString(),
    cmd: 'issue.create',
    resolvedCfs: resolvedCfs.map(cf => ({ id: cf.id, value: cf.value, source: cf.source })),
    appliedDefaults: apply.applied,
    issueId: issue.id,
  });
  for (const s of apply.skipped) {
    if (s.reason !== 'user-cf-override' || s.userValue === undefined) continue;
    recordOverride({
      at: new Date().toISOString(),
      cmd: 'issue.create',
      ruleId: s.rule,
      cf: s.cf,
      userValue: s.userValue,
      ruleValue: s.ruleValue,
      issueId: issue.id,
    });
  }

  return {
    json: issue,
    pretty: ctx => {
      writeLine(success(ctx, `Created #${issue.id} in ${issue.project.name}`));
      writeLine(`  ${dim(ctx, 'subject:')} ${issue.subject}`);
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

function readDescription(flgs: IssueCreateFlags): string | undefined {
  if (flgs.description !== undefined) return flgs.description;
  if (flgs.descriptionFile === undefined) return undefined;
  if (flgs.descriptionFile === '-') {
    return fs.readFileSync(0, 'utf8');
  }
  return fs.readFileSync(flgs.descriptionFile, 'utf8');
}

export function create(flags: IssueCreateFlags): Promise<never> {
  return runCommand('issue.create', flags, cmd);
}
