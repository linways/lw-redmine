/**
 * Structured logger with levels.
 *
 * - `info` is the default; goes to stderr so stdout stays clean for `--json`
 *   consumers (the JSON envelope is the only thing on stdout).
 * - `debug` is gated behind `--debug` or `LWR_DEBUG=1`.
 * - `silent` suppresses everything except errors.
 *
 * Color is applied via picocolors when stderr is a TTY and NO_COLOR is unset.
 */

import pc from 'picocolors';
import { ENV } from '../constants';

export type LogLevel = 'silent' | 'info' | 'debug';

let currentLevel: LogLevel = 'info';
let useColor = supportsColor();

function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stderr.isTTY);
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setColorEnabled(enabled: boolean): void {
  useColor = enabled;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Initialise from process flags + env. Called once from `cli.ts`.
 * Pass `--debug` and `--silent` from commander; this also picks up env.
 */
export function initLoggerFromFlags(opts: { debug?: boolean; silent?: boolean }): void {
  if (opts.silent) {
    currentLevel = 'silent';
    return;
  }
  if (opts.debug || process.env[ENV.DEBUG] === '1') {
    currentLevel = 'debug';
    return;
  }
  currentLevel = 'info';
}

function paint(fn: (s: string) => string, s: string): string {
  return useColor ? fn(s) : s;
}

export const logger = {
  /** Diagnostic info gated behind --debug. */
  debug(msg: string, ...rest: unknown[]): void {
    if (currentLevel !== 'debug') return;
    process.stderr.write(`${paint(pc.gray, '[debug]')} ${msg}\n`);
    for (const r of rest) process.stderr.write(`${paint(pc.gray, '       ')} ${formatExtra(r)}\n`);
  },

  /** Normal user-facing progress / status messages. */
  info(msg: string): void {
    if (currentLevel === 'silent') return;
    process.stderr.write(`${msg}\n`);
  },

  /** Warnings — shown unless silent. */
  warn(msg: string): void {
    if (currentLevel === 'silent') return;
    process.stderr.write(`${paint(pc.yellow, '!')} ${msg}\n`);
  },

  /** Errors are never silenced. */
  error(msg: string): void {
    process.stderr.write(`${paint(pc.red, '✗')} ${msg}\n`);
  },
};

function formatExtra(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
