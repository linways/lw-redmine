/**
 * `lwr feedback log --kind gap|error --query "<text>" --reason "<text>" [...]`
 *
 * Writes one Markdown incident file under `~/.lwr/feedback/<UTC-date>/`.
 *
 * Trigger A (skill-driven) — the agent calls this when it detects a
 * capability gap and is about to bail. Trigger B (the CLI's own
 * error-formatter auto-log) is Phase 2 — same writer, different caller.
 *
 * Every free-text input passes through the work-log redaction filter
 * before bytes hit disk. See `FEEDBACK_SPEC.md` §5.3.
 */

import {
  runCommand,
  type CommandFn,
  type CommandResult,
  type GlobalFlags,
} from '../../foundation/run';
import { writeLine } from '../../foundation/output';
import { dim, success, warn } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES, FEEDBACK_AGENTS, type FeedbackKind } from '../../constants';
import {
  isValidAgent,
  isValidKind,
  parseAttemptFlag,
  writeFeedback,
  type FeedbackInput,
  type WriteResult,
} from '../../workflow/feedback';

interface LogFlags extends GlobalFlags {
  kind?: string;
  query?: string;
  reason?: string;
  details?: string;
  command?: string;
  issue?: string;
  exitCode?: number;
  errorCode?: string;
  agent?: string;
  /** Repeatable. Each value is `<action>|<outcome>`. */
  attempt?: string[];
}

const cmd: CommandFn<WriteResult> = async (flags): Promise<CommandResult<WriteResult>> => {
  const f = flags as LogFlags;

  const kind = requireKind(f.kind);
  const query = requireText(f.query, '--query', 'the user\'s natural-language request');
  const reason = requireText(
    f.reason,
    '--reason',
    'one-line note on why this is being logged',
  );

  const agent = f.agent === undefined ? undefined : requireAgent(f.agent);

  const attempts = (f.attempt ?? []).map(v => {
    try {
      return parseAttemptFlag(v);
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? err.message : String(err),
        ERROR_CODES.VALIDATION_BAD_VALUE,
        'Format: `--attempt "<action>|<outcome>"`. Repeatable for multiple steps.',
      );
    }
  });

  const input: FeedbackInput = {
    kind,
    query,
    reason,
    ...(f.details !== undefined ? { details: f.details } : {}),
    ...(f.command !== undefined ? { command: f.command } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
    ...(f.issue !== undefined ? { issueContext: parseIssueId(f.issue) } : {}),
    ...(f.exitCode !== undefined ? { exitCode: parseExitCode(f.exitCode) } : {}),
    ...(f.errorCode !== undefined ? { errorCode: f.errorCode } : {}),
    ...(agent !== undefined ? { agent } : {}),
  };

  const result = await writeFeedback(input, { dryRun: f.dryRun === true });

  return {
    json: result,
    pretty: ctx => {
      if (result.dryRun) {
        writeLine(
          dim(ctx, `[dry-run] would write ${result.path} (${result.kind} · ${result.slug})`),
        );
        return;
      }
      writeLine(success(ctx, `Feedback logged → ${result.path}`));
      writeLine(`  ${dim(ctx, `${result.kind} · ${result.slug} · ${result.recordedAt}`)}`);
      if (result.mirror) {
        if (result.mirror.posted) {
          writeLine(`  ${dim(ctx, `↗ mirrored to sheet (${result.mirror.status ?? '2xx'} in ${result.mirror.durationMs ?? '?'}ms)`)}`);
        } else {
          writeLine(`  ${warn(ctx, `sheet mirror failed: ${result.mirror.error ?? `HTTP ${result.mirror.status ?? '?'}`} (local file still saved)`)}`);
        }
      }
    },
  };
};

function requireKind(value: string | undefined): FeedbackKind {
  if (!value) {
    throw new ValidationError(
      '--kind is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass `--kind gap` (agent capability gap) or `--kind error` (runtime auto-log).',
    );
  }
  if (!isValidKind(value)) {
    throw new ValidationError(
      `Invalid --kind "${value}". Expected "gap" or "error".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return value;
}

function requireText(value: string | undefined, flag: string, what: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new ValidationError(
      `${flag} is required.`,
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      `Pass ${flag} "..." — ${what}.`,
    );
  }
  return value;
}

function requireAgent(value: string): NonNullable<FeedbackInput['agent']> {
  if (!isValidAgent(value)) {
    throw new ValidationError(
      `Invalid --agent "${value}". Expected one of: ${FEEDBACK_AGENTS.join(', ')}.`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return value;
}

function parseIssueId(input: string): number {
  const n = Number(String(input).trim().replace(/^#/, ''));
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(
      `Invalid --issue "${input}".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return n;
}

function parseExitCode(input: number | string): number {
  const n = Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ValidationError(
      `Invalid --exit-code "${input}".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  return n;
}

export function logFeedback(flags: LogFlags): Promise<never> {
  return runCommand('feedback.log', flags, cmd);
}
