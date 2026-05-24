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
  type GlobalFlags,
  dryRunPreview,
  type DryRunPreview,
} from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { activeProfile } from '../../foundation/profiles';
import { getIssue, updateIssue } from '../../api/issues';
import { assertTransitionAllowed, listStatuses, resolveStatusId } from '../../api/statuses';
import { writeLine } from '../../foundation/output';
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

  if (flags.dryRun) {
    const path = REDMINE_PATHS.ISSUE_BY_ID(pointer.id);
    const body: Record<string, unknown> = { status_id: statusId };
    if (f.note !== undefined) body.notes = f.note;
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
      pretty: ctx =>
        writeLine(
          dim(
            ctx,
            `[dry-run] would PUT ${path} — pause #${pointer.id} as "${statusName}"`,
          ),
        ),
    };
  }

  await updateIssue(session.client, pointer.id, {
    statusId,
    notes: f.note,
  });

  return {
    json: { issueId: pointer.id, previousStatus: issue.status.name, newStatus: statusName },
    pretty: ctx => {
      writeLine(success(ctx, `Paused #${pointer.id} → "${statusName}".`));
      writeLine(`  ${dim(ctx, `active issue stays set — \`lwr issue use ${pointer.id}\` to resume.`)}`);
    },
  };
};

export function pauseIssue(flags: IssuePauseFlags): Promise<never> {
  return runCommand('issue.pause', flags, cmd);
}
