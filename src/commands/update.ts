/**
 * `lwr update`
 *
 * Discoverable wrapper around `node <repo>/install.mjs update`. The
 * actual update pipeline (git pull → npm install → npm build → npm
 * link → skill snapshot → permission inject) lives in install.mjs;
 * this command's only job is to find the script and run it.
 *
 * Why a wrapper, not a reimplementation:
 *   install.mjs is the canonical install/update entry point, runs in
 *   plain Node with zero deps, and already handles the Windows/Unix
 *   edge cases of replacing dist/cli.js while it's running. Forking
 *   that logic into a TS command would mean two scripts to keep in
 *   sync. One source of truth is cheaper.
 *
 * Modes:
 *   pretty/plain — inherit stdio so the user sees the colored
 *     installer output live (git pull progress, npm spam, etc).
 *     The wrapper exits with the installer's exit code.
 *   json — capture stdout/stderr to memory and emit a single
 *     `lwr/v1` envelope at the end. The captured output rides on
 *     `data.installerOutput` for success or `error.details.output`
 *     for failure, so an agent has the diagnostic context.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { writeLine } from '../foundation/output';
import { dim, success } from '../foundation/format';
import { LwrError } from '../foundation/errors';
import { ERROR_CODES, EXIT } from '../constants';

const INSTALL_SCRIPT = 'install.mjs';

export interface UpdatePayload {
  /** Path to the install.mjs script that was invoked. */
  script: string;
  /** Exit code returned by `node install.mjs update`. */
  exitCode: number;
  /** Captured installer output (only populated in JSON mode). */
  installerOutput?: string;
}

/**
 * Find <repo>/install.mjs by resolving the running binary's symlink
 * chain. The npm-linked `lwr` binary's realpath is `<repo>/dist/cli.js`;
 * install.mjs lives at the repo root, one directory up.
 *
 * Two candidates, in order: process.argv[1] (fastest, doesn't depend
 * on PATH) and `which lwr` as a fallback for unusual launch paths.
 * Returns null when neither resolves to a directory containing
 * install.mjs — the caller raises CONFIG_MALFORMED with a hint.
 */
export function locateInstallScript(): string | null {
  const candidates: string[] = [];
  if (process.argv[1]) candidates.push(process.argv[1]);
  const which = spawnSync('which', ['lwr'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim().length > 0) {
    candidates.push(which.stdout.trim());
  }
  for (const c of candidates) {
    try {
      const real = fs.realpathSync(c);
      const repoRoot = path.resolve(path.dirname(real), '..');
      const script = path.join(repoRoot, INSTALL_SCRIPT);
      if (fs.existsSync(script)) return script;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const cmd: CommandFn<UpdatePayload> = async (_flags, ctx): Promise<CommandResult<UpdatePayload>> => {
  const script = locateInstallScript();
  if (!script) {
    throw new LwrError({
      message: 'Could not locate install.mjs.',
      code: ERROR_CODES.CONFIG_MALFORMED,
      exit: EXIT.CONFIG,
      hint: 'lwr expects to be installed via `npm link` from the repo. If you ran the binary in some other way, run `node <repo>/install.mjs update` directly.',
    });
  }

  if (ctx.mode === 'json') {
    // Capture mode — keep installer output off stdout (the JSON
    // envelope owns stdout) and bundle it into the envelope.
    const result = spawnSync('node', [script, 'update'], { encoding: 'utf8' });
    const exitCode = result.status ?? 1;
    const output = combineOutput(result.stdout, result.stderr);

    if (exitCode !== 0) {
      throw new LwrError({
        message: `install.mjs update exited with code ${exitCode}.`,
        code: ERROR_CODES.CONFIG_MALFORMED,
        exit: EXIT.CONFIG,
        hint: 'See `error.details.output` for the underlying failure (git pull, npm install, build, or link).',
        details: { script, exitCode, output },
      });
    }
    return {
      json: { script, exitCode, installerOutput: output },
    };
  }

  // Pretty/plain — inherit stdio so the user sees the colored
  // installer output live (git pull progress, npm spam, etc).
  const result = spawnSync('node', [script, 'update'], { stdio: 'inherit' });
  const exitCode = result.status ?? 1;

  if (exitCode !== 0) {
    throw new LwrError({
      message: `install.mjs update exited with code ${exitCode}.`,
      code: ERROR_CODES.CONFIG_MALFORMED,
      exit: EXIT.CONFIG,
      hint: 'Check the installer output above for the underlying failure (git pull, npm install, build, or link).',
      details: { script, exitCode },
    });
  }
  return {
    json: { script, exitCode },
    pretty: c => {
      writeLine(success(c, 'lwr update complete.'));
      writeLine(`  ${dim(c, 'script:')} ${script}`);
    },
  };
};

function combineOutput(stdout?: string | null, stderr?: string | null): string {
  return [stdout ?? '', stderr ?? ''].join('').trim();
}

export function update(flags: GlobalFlags): Promise<never> {
  return runCommand('update', flags, cmd);
}
