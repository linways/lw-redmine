/**
 * `lwr log clear --before YYYY-MM-DD`
 *
 * Removes action-log day files strictly older than `--before`. Per-day
 * files make this an `rm` of matching paths — no rewriting, no risk of
 * mangling today's file.
 *
 * Refuses to run without an explicit `--before` to make accidental
 * "clear everything" impossible.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { writeLine } from '../../foundation/output';
import { success } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { ERROR_CODES } from '../../constants';
import { workLogDir } from '../../foundation/paths';
import { isValidIsoDate } from '../../workflow/work-log';

interface ClearFlags extends GlobalFlags {
  before?: string;
}

interface Payload {
  before: string;
  removedDays: string[];
}

const cmd: CommandFn<Payload> = async (flags): Promise<CommandResult<Payload>> => {
  const f = flags as ClearFlags;
  if (!f.before) {
    throw new ValidationError(
      '--before <date> is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'e.g. `lwr log clear --before 2026-01-01` to remove all days before that date.',
    );
  }
  if (!isValidIsoDate(f.before)) {
    throw new ValidationError(
      `Invalid date "${f.before}".`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Use ISO format YYYY-MM-DD with a real month and day.',
    );
  }

  const removedDays = removeMatching(workLogDir(), '.ndjson', f.before);

  return {
    json: { before: f.before, removedDays },
    pretty: ctx => {
      writeLine(
        success(ctx, `Removed ${removedDays.length} day file${removedDays.length === 1 ? '' : 's'} before ${f.before}.`),
      );
    },
  };
};

function removeMatching(dir: string, suffix: string, before: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(suffix)) continue;
    const datePart = name.slice(0, name.length - suffix.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) continue;
    if (datePart < before) {
      fs.unlinkSync(path.join(dir, name));
      removed.push(datePart);
    }
  }
  return removed.sort();
}

export function clearLog(flags: ClearFlags): Promise<never> {
  return runCommand('log.clear', flags, cmd);
}
