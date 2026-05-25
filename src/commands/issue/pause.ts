/**
 * `lwr issue pause --status <name> [--note <text>]`
 *
 * Sugar for "pause what I'm currently on" — reads the active-issue
 * pointer, PUTs that issue to the named status (typically "Paused"),
 * leaves the pointer set so the user can resume with
 * `lwr issue use <same-id>` later.
 *
 * Difference from `lwr issue clear`: clear unsets the pointer too.
 * Pause keeps it set so the agent can offer a one-shot resume.
 *
 * Difference from `lwr issue status <id> "Paused"`: this verb infers
 * the id from the pointer — the agent doesn't have to look it up first.
 */

import {
  runCommand,
  type CommandFn,
  type CommandResult,
  type GlobalFlags,
  dryRunPreview,
  type DryRunPreview,
} from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { activeProfile, resolveProfileName } from '../../foundation/profiles';
import { getIssue, updateIssue } from '../../api/issues';
import { assertTransitionAllowed, listStatuses, resolveStatusId } from '../../api/statuses';
import { syncActiveIssueFromPayload } from '../../workflow/active-issue';
import {
  loadPreferences,
  applyPreferences,
  currentCfValuesFromIssue,
  bumpTriggerCounts,
  type AppliedDefault,
} from '../../assistant/preferences';
import { recordDecision } from '../../assistant/decisions';
import { writeLine } from '../../foundation/output';
import type { OutputContext } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { NotFoundError, ValidationError } from '../../foundation/errors';
import { ERROR_CODES, REDMINE_PATHS, PAUSE_STATUS_NAME } from '../../constants';

export interface IssuePauseFlags extends GlobalFlags {
  /**
   * Redmine status name to set on the active issue. Defaults to
   * "Paused" — the canonical pause state. Override to pass through a
   * different transition (e.g., a tester running `pause --status "Need
   * More Information"` to bounce back to the developer).
   */
  status?: string;
  /** Optional one-line note appended as a Redmine journal comment. */
  note?: string;
}

interface Payload {
  issueId: number;
  previousStatus: string;
  newStatus: string;
}

const cmd: CommandFn<Payload | DryRunPreview> = async (flags) => {
  const f = flags as IssuePauseFlags;
  const { profile } = activeProfile(flags.profile);
  const pointer = profile.activeIssue;
  if (!pointer) {
    throw new NotFoundError(
      'No active issue to pause.',
      'Run `lwr issue use <id>` to set one, or `lwr issue current` to confirm.',
    );
  }

  const targetStatus = (f.status ?? PAUSE_STATUS_NAME).trim();
  if (targetStatus.length === 0) {
    throw new ValidationError(
      '--status is empty.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
      `Pass --status "${PAUSE_STATUS_NAME}" (or another transition). Run \`lwr issue transitions ${pointer.id}\` to see what's allowed.`,
    );
  }

  const session = await openSession(flags);
  const [issue, statuses] = await Promise.all([
    getIssue(session.client, pointer.id, { allowedStatuses: true }),
    listStatuses(session.client),
  ]);

  let statusId: number;
  try {
    statusId = resolveStatusId(statuses, targetStatus);
  } catch (err) {
    throw new ValidationError(
      err instanceof Error ? err.message : String(err),
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  assertTransitionAllowed(issue, statusId);
  const statusName = statuses.find(s => s.id === statusId)?.name ?? targetStatus;

  // Apply cross-agent preferences. The verb itself doesn't accept --cf, so
  // userCfs is empty — only rules whose `when` matches the issue's existing
  // cf state can fire (e.g. "set Tester=Lakshmi when blank on pause").
  const { file: prefsFile, warnings: prefsWarnings } = loadPreferences();
  const apply = applyPreferences(prefsFile.rules, {
    userCfs: [],
    currentCfValues: currentCfValuesFromIssue(issue.custom_fields),
  });

  if (flags.dryRun) {
    const path = REDMINE_PATHS.ISSUE_BY_ID(pointer.id);
    const body: Record<string, unknown> = { status_id: statusId };
    if (f.note !== undefined) body.notes = f.note;
    if (apply.customFields.length > 0) body.custom_fields = apply.customFields;
    const preview = dryRunPreview({
      method: 'PUT',
      path,
      payload: { issue: body },
      resolved: {
        issueId: pointer.id,
        status: { id: statusId, name: statusName },
        currentStatus: issue.status,
      },
      guards: ['workflow.allowed_transition'],
    });
    return {
      json: preview,
      pretty: ctx => {
        writeLine(
          dim(
            ctx,
            `[dry-run] would PUT ${path} — pause #${pointer.id} as "${statusName}"`,
          ),
        );
        renderAppliedDefaults(ctx, apply.applied);
      },
      meta: buildMeta(apply.applied, prefsWarnings),
    } as CommandResult<DryRunPreview>;
  }

  const updated = await updateIssue(session.client, pointer.id, {
    statusId,
    notes: f.note,
    ...(apply.customFields.length > 0 ? { customFields: apply.customFields } : {}),
  });

  // Sync the local pointer's snapshot — the pointer stays SET (pause keeps
  // the resume target around), but its `status` field needs to reflect the
  // post-PUT state. Without this, daily-rollover the next morning re-reads
  // the stale "Development in Progress" snapshot and emits a false "you
  // didn't pause!" warning.
  syncActiveIssueFromPayload(updated, resolveProfileName(flags.profile));

  bumpTriggerCounts(apply.firedRuleIds);
  recordDecision({
    at: new Date().toISOString(),
    cmd: 'issue.pause',
    resolvedCfs: [],
    appliedDefaults: apply.applied,
    issueId: pointer.id,
  });

  return {
    json: { issueId: pointer.id, previousStatus: issue.status.name, newStatus: statusName },
    pretty: ctx => {
      writeLine(success(ctx, `Paused #${pointer.id} → "${statusName}".`));
      writeLine(`  ${dim(ctx, `active issue stays set — \`lwr issue use ${pointer.id}\` to resume.`)}`);
      renderAppliedDefaults(ctx, apply.applied);
    },
    meta: buildMeta(apply.applied, prefsWarnings),
  } as CommandResult<Payload>;
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

function renderAppliedDefaults(ctx: OutputContext, applied: AppliedDefault[]): void {
  for (const a of applied) {
    const cfLabel = a.cfName ? `${a.cfName} (cf ${a.cf})` : `cf ${a.cf}`;
    const valueLabel = a.valueLabel ? `${a.valueLabel} (${a.value})` : String(a.value);
    writeLine(dim(ctx, `  applied default: ${cfLabel} = ${valueLabel} — rule: ${a.rule}`));
  }
}

export function pauseIssue(flags: IssuePauseFlags): Promise<never> {
  return runCommand('issue.pause', flags, cmd);
}
