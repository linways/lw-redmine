/**
 * `lwr feedback list [--since 7d | --week | --month | --all] [--kind gap|error]`
 *
 * Walk `~/.lwr/feedback/<date>/` and return one row per incident, newest
 * first. Used by the user (audit your own history) and the maintainer
 * (weekly review pass). Pure read; no Redmine round-trip.
 */

import {
  runCommand,
  type CommandFn,
  type CommandResult,
  type GlobalFlags,
} from '../../foundation/run';
import { writeLine } from '../../foundation/output';
import { dim, header } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES, FEEDBACK_LIST_DEFAULT_DAYS, type FeedbackKind } from '../../constants';
import {
  isValidKind,
  listFeedback,
  type FeedbackEntryMeta,
} from '../../workflow/feedback';

interface ListFlags extends GlobalFlags {
  since?: string;
  week?: boolean;
  month?: boolean;
  all?: boolean;
  kind?: string;
}

interface ListPayload {
  /** Window in days. `null` when `--all`. */
  windowDays: number | null;
  /** Filter applied, if any. */
  kind: FeedbackKind | null;
  count: number;
  entries: Array<{
    path: string;
    kind: FeedbackKind;
    slug: string;
    recorded_at: string;
    command: string | null;
    summary: string;
  }>;
}

const cmd: CommandFn<ListPayload> = async (flags): Promise<CommandResult<ListPayload>> => {
  const f = flags as ListFlags;
  const windowDays = resolveWindow(f);
  const kind = resolveKind(f.kind);

  const matchOpts: { windowDays: number | null; kind?: FeedbackKind } = { windowDays };
  if (kind !== null) matchOpts.kind = kind;
  const entries = listFeedback(matchOpts);

  const payload: ListPayload = {
    windowDays,
    kind,
    count: entries.length,
    entries: entries.map(toRow),
  };

  return {
    json: payload,
    pretty: ctx => renderPretty(ctx, payload, entries),
  };
};

function toRow(e: FeedbackEntryMeta): ListPayload['entries'][number] {
  return {
    path: e.path,
    kind: e.kind,
    slug: e.slug,
    recorded_at: e.recordedAt,
    command: e.command,
    summary: e.summary,
  };
}

function resolveWindow(f: ListFlags): number | null {
  if (f.all) return null;
  if (f.month) return 30;
  if (f.week) return 7;
  if (f.since !== undefined) {
    const m = /^(\d+)d$/.exec(f.since);
    if (!m) {
      throw new ValidationError(
        `Invalid --since "${f.since}".`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Use a day count like `--since 7d`, or `--week` / `--month` / `--all`.',
      );
    }
    return Math.min(365, Math.max(1, Number(m[1])));
  }
  return FEEDBACK_LIST_DEFAULT_DAYS;
}

function resolveKind(input: string | undefined): FeedbackKind | null {
  if (input === undefined) return null;
  if (!isValidKind(input)) {
    throw new ValidationError(
      `Invalid --kind "${input}". Expected "gap" or "error".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return input;
}

function renderPretty(
  ctx: import('../../foundation/output').OutputContext,
  payload: ListPayload,
  entries: FeedbackEntryMeta[],
): void {
  const windowLabel = payload.windowDays === null ? 'all time' : `last ${payload.windowDays} days`;
  const kindLabel = payload.kind ? ` · kind=${payload.kind}` : '';
  writeLine(
    header(
      ctx,
      `Feedback — ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} (${windowLabel}${kindLabel})`,
    ),
  );
  if (entries.length === 0) {
    writeLine(`  ${dim(ctx, 'No incidents in window.')}`);
    return;
  }
  for (const e of entries) {
    const summary = e.summary.length > 0 ? e.summary : dim(ctx, '(no summary)');
    writeLine(`  ${e.recordedAt}  ${e.kind.padEnd(5)}  ${e.path}`);
    writeLine(`     ${dim(ctx, summary)}`);
  }
}

export function listFeedbackCmd(flags: ListFlags): Promise<never> {
  return runCommand('feedback.list', flags, cmd);
}
