/**
 * Action audit log — one NDJSON line per mutating lwr command.
 *
 * Replaces the old `work-log` session machinery (which inferred start/end
 * times via the agent and frequently got them wrong). The new contract:
 * record what lwr actually did at the moment it did it. Observed, not
 * inferred — the timestamp is the wall-clock moment the command completed.
 *
 * What ends up in the file:
 *   - One line per command call whose annotation is `safety !== 'read'`.
 *   - Schema version stamped per line (`schema: 2`) so the file format can
 *     evolve without ambiguous reads.
 *   - The args passed to the command (with secrets / control flags
 *     scrubbed). The result data (for success) or the structured error
 *     (for failure). Plus `requestId`, `durationMs`, `outcome`, `safety`.
 *
 * Why one file per day: makes `lwr log clear --before <date>` a simple
 * `rm`. Matches the old session-log directory layout (`~/.lwr/log/`) so
 * the on-disk path is unchanged.
 *
 * This module never throws. Disk errors are swallowed — the command
 * already ran; an audit-write failure must not break the user's flow.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { workLogDir, workLogDayPath } from './paths';
import { todayInWorkTz, nowIsoInWorkTz } from '../workflow/work-log';

/** Bumped when the on-disk shape changes. Readers gate on this. */
export const ACTION_LOG_SCHEMA = 2;

/**
 * Keys we never persist to the audit log. `apiKey` is the obvious one;
 * the rest are control flags whose values are not part of "what the
 * command did" (and `dryRun=true` rows are pre-filtered upstream — they
 * never reach this writer in the first place, since dry-runs don't
 * mutate).
 */
const ARG_SCRUB_KEYS: ReadonlySet<string> = new Set([
  'apiKey',
  'baseUrl',
  'profile',
  'json',
  'noColor',
  'noInteractive',
  'debug',
  'silent',
  'dryRun',
]);

export interface ActionLogEntry {
  /** Append-time wall-clock in `WORK_TZ`. */
  at: string;
  /** Dotted command path, matches `runCommand` name. */
  cmd: string;
  /** Per-run correlation id (same UUID as in the JSON envelope). */
  requestId: string;
  /** Wall-clock from `runCommand` entry to log write. */
  durationMs: number;
  outcome: 'success' | 'error';
  /** From `cli-annotations`. */
  safety?: 'read' | 'mutate' | 'destructive';
  /** Network-touching command? */
  network?: boolean;
  /** Command args with control flags + secrets stripped. */
  args: Record<string, unknown>;
  /** Command's `json` payload on success. Omitted for errors. */
  result?: unknown;
  /** Structured error info on failure. Omitted for success. */
  error?: { code: string; message: string };
}

/**
 * Append one entry to today's NDJSON. Best-effort.
 *
 * Caller already knows the annotation; pass it through so we don't have
 * to re-import the registry here.
 */
export function recordAction(input: Omit<ActionLogEntry, 'at'> & { at?: string }): void {
  try {
    const entry = {
      schema: ACTION_LOG_SCHEMA,
      at: input.at ?? nowIsoInWorkTz(),
      cmd: input.cmd,
      requestId: input.requestId,
      durationMs: input.durationMs,
      outcome: input.outcome,
      ...(input.safety !== undefined ? { safety: input.safety } : {}),
      ...(input.network !== undefined ? { network: input.network } : {}),
      args: input.args,
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };
    mkdirSync(workLogDir(), { recursive: true, mode: 0o700 });
    appendFileSync(workLogDayPath(todayInWorkTz()), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    // Audit-write failure must never break the user's command.
  }
}

/**
 * Strip control flags + secret-shaped keys from a flags object. Returns
 * a plain object safe to JSON-serialise into the audit log.
 *
 * Exported so callers that have additional sensitive keys can build a
 * scrubber on top.
 */
export function scrubArgs(flags: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (ARG_SCRUB_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}
