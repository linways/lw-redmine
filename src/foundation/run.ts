/**
 * Command runner.
 *
 * Wraps every command's main function with the common cross-cutting work:
 *   - Resolve output context (Pretty / Plain / JSON) from global flags
 *   - Initialise logger level
 *   - Catch any thrown error, normalise to LwrError, print it in the
 *     selected mode, and exit with the right code
 *   - On success in JSON mode, print the envelope and exit 0
 *   - On success in Pretty/Plain, the command itself printed; we exit 0
 *
 * Commands return either:
 *   - `void` (they printed already), or
 *   - `{ json: T, pretty?: () => void }` so JSON callers see structured
 *     data and human callers see whatever the command rendered.
 */

import { randomUUID } from 'node:crypto';
import pc from 'picocolors';
import { EXIT } from '../constants';
import { asLwrError } from './errors';
import { logger, initLoggerFromFlags } from './logger';
import { COMMAND_ANNOTATIONS } from '../cli-annotations';
import { recordAction, scrubArgs } from './action-log';
import {
  resolveOutputContext,
  jsonSuccess,
  jsonFailure,
  writeJson,
  type EnvelopeContext,
  type OutputContext,
} from './output';

export interface GlobalFlags {
  json?: boolean;
  noColor?: boolean;
  noInteractive?: boolean;
  debug?: boolean;
  silent?: boolean;
  profile?: string;
  baseUrl?: string;
  apiKey?: string;
  /**
   * "Show what this command would do, but don't actually do it." Honored
   * by mutating commands (issue.edit, time.log, etc.) — they run every
   * step (flag parsing, name resolution, workflow guard) up to the HTTP
   * write, then return a {@link DryRunPreview} envelope instead of
   * firing the POST/PUT/DELETE. Read commands silently ignore it.
   */
  dryRun?: boolean;
}

/**
 * Standard payload returned by a mutating command when `--dry-run` is set.
 * Stable shape so agents can branch on it without per-command logic.
 *
 * Fields:
 *   dry_run     literally `true` — agent's branching signal.
 *   method      HTTP verb that *would* have been sent (POST/PUT/DELETE).
 *   path        Redmine path the request would have hit, e.g. `/issues/125415.json`.
 *   payload     The exact JSON body that would have been POSTed.
 *               `null` for DELETE (no body).
 *   resolved    Optional: what name → id resolutions ran. Lets the agent
 *               (or human) confirm "Resolved" really mapped to status #78
 *               on this Redmine before re-running without --dry-run.
 *   guards      Optional: which pre-flight checks passed (e.g.
 *               `workflow.allowed_transition`). Lets agents see what was
 *               validated, so they don't re-run the same checks.
 */
export interface DryRunPreview {
  dry_run: true;
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  payload: Record<string, unknown> | null;
  resolved?: Record<string, unknown>;
  guards?: string[];
}

export function dryRunPreview(input: {
  method: DryRunPreview['method'];
  path: string;
  payload: DryRunPreview['payload'];
  resolved?: Record<string, unknown>;
  guards?: string[];
}): DryRunPreview {
  return {
    dry_run: true,
    method: input.method,
    path: input.path,
    payload: input.payload,
    ...(input.resolved ? { resolved: input.resolved } : {}),
    ...(input.guards ? { guards: input.guards } : {}),
  };
}

export interface CommandResult<T> {
  /** Data emitted in JSON mode under `.data`. */
  json: T;
  /** Optional renderer for Pretty/Plain mode. If absent, no stdout output. */
  pretty?: (ctx: OutputContext) => void;
  /** Extra fields under `.meta` in the JSON envelope. */
  meta?: Record<string, unknown>;
  /**
   * Override the success exit code. Used by `doctor` to surface a non-zero
   * code when any check fails, even though the command itself "succeeded"
   * (the report printed without raising). Defaults to `EXIT.OK`.
   */
  exitCode?: number;
}

export type CommandFn<T> = (
  flags: GlobalFlags,
  ctx: OutputContext,
) => Promise<CommandResult<T> | void>;

/**
 * Snapshot handed to a registered observer at command completion. Read-
 * only — observers must not mutate this. Field shape is stable so
 * downstream consumers (event log, future inference) can rely on it.
 */
export interface CommandEvent {
  /** ISO timestamp at the moment of completion. */
  at: string;
  /** Dotted command path (matches the JSON envelope's `command` field). */
  cmd: string;
  /** Same UUID that was stamped on the JSON envelope. */
  requestId: string;
  /** Raw flags object passed to the command — observer is responsible for redaction. */
  flags: Readonly<Record<string, unknown>>;
  outcome: 'success' | 'error';
  /** Stable error code from `LwrError.code` — present only on error. */
  errorCode?: string;
  /** Process exit code (would-be — process.exit may be mocked in tests). */
  exitCode: number;
  /** Wall-clock duration from runCommand entry to observer call. */
  durationMs: number;
  /** From cli-annotations: read | mutate | destructive. */
  safety?: 'read' | 'mutate' | 'destructive';
  /** From cli-annotations: did this command reach Redmine? */
  network?: boolean;
}

export interface CommandObserver {
  onComplete: (event: CommandEvent) => void;
}

/**
 * A pre-flight warning surfaced by a workflow-layer provider (today: the
 * daily-rollover detector). Foundation knows nothing about the semantics
 * — it just merges the structured payload into `meta` for JSON callers
 * and prints the styled `prettyLine` to stderr for human callers, before
 * the command's own output.
 */
export interface PreflightWarning {
  /** Key under `meta` in the JSON envelope. e.g. 'dailyRollover'. */
  metaKey: string;
  /** Structured payload exposed to JSON callers / MCP. */
  payload: Record<string, unknown>;
  /** One-line stderr message for pretty mode. Pre-styled (color/icons). */
  prettyLine: string;
}

let currentObserver: CommandObserver | null = null;
let preflightProvider: ((cmdName: string) => PreflightWarning | null) | null = null;

/**
 * Register a single observer to receive completion events. Pass `null`
 * to unregister (used by tests).
 *
 * Default state is `null` — meaning vanilla lwr (with no assistant
 * bootstrap) executes exactly the same code path as before this hook
 * was added: the optional-chain on `currentObserver` short-circuits to
 * `undefined` and no allocation occurs.
 */
export function setCommandObserver(observer: CommandObserver | null): void {
  currentObserver = observer;
}

/**
 * Register the single pre-flight warning provider. Called once at CLI
 * bootstrap (next to `setCommandObserver`). Pass `null` to clear (tests).
 *
 * The provider receives the dotted command name so it can opt out for
 * specific verbs (e.g. the daily-rollover detector skips `issue.handover`
 * — the verb that resolves the rollover would otherwise prompt for itself).
 */
export function setPreflightProvider(
  provider: ((cmdName: string) => PreflightWarning | null) | null,
): void {
  preflightProvider = provider;
}

/**
 * Render an LwrError to stderr as a human-readable line, with an
 * optional `hint:` follow-up. Used by both the pretty/plain catch path
 * and the JSON-mode stderr mirror (gated on `process.stderr.isTTY`).
 */
function writeErrorToStderr(e: { message: string; hint?: string }, color: boolean): void {
  const cross = color ? pc.red('✗') : '✗';
  process.stderr.write(`${cross} ${e.message}\n`);
  if (e.hint) {
    const label = color ? pc.gray('  hint:') : '  hint:';
    process.stderr.write(`${label} ${e.hint}\n`);
  }
}

/** Best-effort observer dispatch. A throwing observer must NEVER break the user's command. */
function notifyObserver(event: CommandEvent): void {
  try {
    currentObserver?.onComplete(event);
  } catch {
    // Swallow. The user's command already completed; we'd be doubly
    // wrong to fail it because of an instrumentation bug.
  }
}

export async function runCommand<T>(name: string, flags: GlobalFlags, fn: CommandFn<T>): Promise<never> {
  initLoggerFromFlags({ debug: flags.debug, silent: flags.silent });
  const ctx = resolveOutputContext(flags);
  const startedAt = Date.now();

  // Per-run correlation id. Stamped on success + failure envelopes so
  // multi-call agent flows can stitch logs to responses.
  const requestId = randomUUID();
  const annotation = COMMAND_ANNOTATIONS[name];
  const envCtx: EnvelopeContext = {
    requestId,
    ...(annotation
      ? { commandMeta: { safety: annotation.safety, idempotent: annotation.idempotent, network: annotation.network } }
      : {}),
  };
  logger.debug(`requestId=${requestId} command=${name}`);

  // Pre-flight warning (e.g., daily-rollover). Computed before the
  // command body so we can write a stderr line BEFORE pretty output
  // and merge structured payload into meta on the JSON success path.
  // Failures in the provider are swallowed by setPreflightProvider's
  // contract — a broken detector must not block lwr.
  let preflight: PreflightWarning | null = null;
  try {
    preflight = preflightProvider?.(name) ?? null;
  } catch {
    preflight = null;
  }
  if (preflight && ctx.mode !== 'json' && !flags.silent) {
    process.stderr.write(preflight.prettyLine + '\n');
  }

  try {
    const result = await fn(flags, ctx);
    if (ctx.mode === 'json') {
      const data = (result && 'json' in result ? result.json : null) as T;
      const baseMeta = result && 'meta' in result ? result.meta : undefined;
      const meta = preflight
        ? { ...(baseMeta ?? {}), [preflight.metaKey]: preflight.payload }
        : baseMeta;
      writeJson(jsonSuccess(name, data, envCtx, meta));
    } else if (result && 'pretty' in result && result.pretty) {
      result.pretty(ctx);
    }
    const exitCode = result && 'exitCode' in result && typeof result.exitCode === 'number' ? result.exitCode : EXIT.OK;
    const durationMs = Date.now() - startedAt;
    notifyObserver({
      at: new Date().toISOString(),
      cmd: name,
      requestId,
      flags: flags as unknown as Readonly<Record<string, unknown>>,
      outcome: 'success',
      exitCode,
      durationMs,
      ...(annotation ? { safety: annotation.safety, network: annotation.network } : {}),
    });
    // Audit-log every mutating command's success. Dry-runs are skipped
    // because they didn't actually mutate; reads are skipped because
    // they're noise. Best-effort write — never blocks command exit.
    if (annotation && annotation.safety !== 'read' && !flags.dryRun) {
      recordAction({
        cmd: name,
        requestId,
        durationMs,
        outcome: 'success',
        safety: annotation.safety,
        network: annotation.network,
        args: scrubArgs(flags as unknown as Record<string, unknown>),
        result: result && 'json' in result ? result.json : null,
      });
    }
    process.exit(exitCode);
  } catch (err) {
    const e = asLwrError(err);
    if (ctx.mode === 'json') {
      writeJson(jsonFailure(name, e, envCtx));
      // Mirror the error to stderr as readable text when stderr is a
      // TTY, so a human running `lwr ... --json | jq` still sees the
      // message + hint instead of staring at a silent terminal. The
      // JSON envelope on stdout stays the agent's source of truth;
      // stderr is the human's eyeball channel and is suppressed when
      // redirected to a file or pipe so machine-readable logs aren't
      // polluted.
      if (process.stderr.isTTY) {
        const useColor = !flags.noColor && !process.env.NO_COLOR;
        writeErrorToStderr(e, useColor);
      }
    } else {
      writeErrorToStderr(e, ctx.color);
    }
    const durationMs = Date.now() - startedAt;
    notifyObserver({
      at: new Date().toISOString(),
      cmd: name,
      requestId,
      flags: flags as unknown as Readonly<Record<string, unknown>>,
      outcome: 'error',
      errorCode: e.code,
      exitCode: e.exit,
      durationMs,
      ...(annotation ? { safety: annotation.safety, network: annotation.network } : {}),
    });
    // Audit-log mutating-command failures too — agents need to see what
    // tried to happen and why it failed. Skip read failures (noise) and
    // dry-runs (no mutation attempted).
    if (annotation && annotation.safety !== 'read' && !flags.dryRun) {
      recordAction({
        cmd: name,
        requestId,
        durationMs,
        outcome: 'error',
        safety: annotation.safety,
        network: annotation.network,
        args: scrubArgs(flags as unknown as Record<string, unknown>),
        error: { code: e.code, message: e.message },
      });
    }
    process.exit(e.exit);
  }
}
