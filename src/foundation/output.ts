/**
 * Output mode selection + JSON envelope.
 *
 * Three modes (see PLAN.md §7):
 *   - Pretty: TTY + interactive stdin + color on (humans)
 *   - Plain : non-TTY stdout, or NO_COLOR set, or --no-color
 *   - JSON  : --json flag
 *
 * Mode is auto-detected from environment so AI agents calling `lwr` via
 * a non-TTY pipe automatically get safe (non-blocking, no-spinner) behaviour.
 *
 * The JSON envelope shape is the public contract for AI agents and is
 * versioned via the `schema` field (currently `lwr/v1`).
 */

import { ENV } from '../constants';
import { LwrError } from './errors';

// --- Mode -----------------------------------------------------------------

export type OutputMode = 'pretty' | 'plain' | 'json';

export interface OutputContext {
  mode: OutputMode;
  /** Whether colors should be emitted in user-facing strings. */
  color: boolean;
  /** Whether prompts may be issued. False for non-TTY or --no-interactive. */
  interactive: boolean;
}

export interface OutputFlags {
  json?: boolean;
  noColor?: boolean;
  noInteractive?: boolean;
}

/**
 * Resolve output mode from flags + env + TTY state.
 *
 * Pure function over its arguments + a few process globals. Tests can
 * inject overrides through {@link resolveOutputContextWithEnv}.
 */
export function resolveOutputContext(flags: OutputFlags = {}): OutputContext {
  return resolveOutputContextWithEnv(flags, {
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    noColor: Boolean(process.env.NO_COLOR),
    envNoInteractive: process.env[ENV.NO_INTERACTIVE] === '1',
  });
}

interface OutputEnv {
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  noColor: boolean;
  envNoInteractive: boolean;
}

export function resolveOutputContextWithEnv(flags: OutputFlags, env: OutputEnv): OutputContext {
  if (flags.json) {
    return { mode: 'json', color: false, interactive: false };
  }

  const colorOff = flags.noColor || env.noColor || !env.stdoutIsTTY;
  const interactive = !flags.noInteractive && !env.envNoInteractive && env.stdinIsTTY && env.stdoutIsTTY;

  return {
    mode: env.stdoutIsTTY && !flags.noColor && !env.noColor ? 'pretty' : 'plain',
    color: !colorOff,
    interactive,
  };
}

// --- JSON envelope --------------------------------------------------------

export const JSON_SCHEMA_VERSION = 'lwr/v1';

/**
 * Per-command annotation surfaced inline on the envelope so an agent can
 * read safety class without a separate `lwr commands` round-trip.
 * Populated by `runCommand` from the static annotation registry; missing
 * (i.e. `undefined`) only if the command was registered without an entry,
 * in which case the introspection contract test fails CI before ship.
 */
export interface EnvelopeCommandMeta {
  safety: 'read' | 'mutate' | 'destructive';
  idempotent: boolean;
  network: boolean;
}

export interface JsonSuccess<T> {
  schema: typeof JSON_SCHEMA_VERSION;
  command: string;
  /**
   * Per-run UUID. Stable across success + failure paths. Stamped at the
   * start of `runCommand`. Useful when an agent stitches multiple `lwr`
   * calls together and needs to correlate logs with envelopes.
   */
  requestId: string;
  ok: true;
  data: T;
  /** Static safety/idempotency annotation for this command. */
  commandMeta?: EnvelopeCommandMeta;
  meta?: Record<string, unknown>;
}

export interface JsonFailure {
  schema: typeof JSON_SCHEMA_VERSION;
  command: string;
  requestId: string;
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    /** Structured recovery payload (e.g., allowed status list). */
    details?: Record<string, unknown>;
  };
  commandMeta?: EnvelopeCommandMeta;
  meta?: Record<string, unknown>;
}

export type JsonEnvelope<T> = JsonSuccess<T> | JsonFailure;

export interface EnvelopeContext {
  requestId: string;
  commandMeta?: EnvelopeCommandMeta;
}

export function jsonSuccess<T>(
  command: string,
  data: T,
  ctx: EnvelopeContext,
  meta?: Record<string, unknown>,
): JsonSuccess<T> {
  return {
    schema: JSON_SCHEMA_VERSION,
    command,
    requestId: ctx.requestId,
    ok: true,
    data,
    ...(ctx.commandMeta ? { commandMeta: ctx.commandMeta } : {}),
    ...(meta ? { meta } : {}),
  };
}

export function jsonFailure(
  command: string,
  err: LwrError,
  ctx: EnvelopeContext,
  meta?: Record<string, unknown>,
): JsonFailure {
  return {
    schema: JSON_SCHEMA_VERSION,
    command,
    requestId: ctx.requestId,
    ok: false,
    error: {
      code: err.code,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.details ? { details: err.details } : {}),
    },
    ...(ctx.commandMeta ? { commandMeta: ctx.commandMeta } : {}),
    ...(meta ? { meta } : {}),
  };
}

// --- Writers --------------------------------------------------------------

/** Write JSON to stdout with a trailing newline. */
export function writeJson(envelope: JsonEnvelope<unknown>): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

/** Write a single line to stdout. Colors are caller's responsibility. */
export function writeLine(line: string): void {
  process.stdout.write(line + '\n');
}
