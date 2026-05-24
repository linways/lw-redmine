/**
 * `lwr issue prune [--before <date>] [--keep <n>]`
 *
 * Removes per-issue materialisation directories under `~/.lwr/issues/`
 * that haven't been touched in a while. Materialisations are
 * trivially re-fetchable via `lwr issue fetch <id>` — they're a
 * convenience snapshot, not source-of-truth state.
 *
 * Two scoping modes, mutually compatible:
 *
 *   - `--before <YYYY-MM-DD>` — drop any issue whose newest file
 *     predates this date (in WORK_TZ; midnight cutoff).
 *
 *   - `--keep <n>` — alternatively, keep only the N most recently
 *     touched and drop the rest.
 *
 * Without either flag, defaults to `--before <today minus 30d>` (a safe
 * default that won't ever cull something fetched in the current month).
 *
 * Annotated `destructive` because the directories vanish; idempotent
 * (re-running with the same flags is a no-op once the cull is done).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  runCommand,
  type CommandFn,
  type CommandResult,
  type GlobalFlags,
} from '../../foundation/run';
import { writeLine } from '../../foundation/output';
import { success, dim } from '../../foundation/format';
import { ValidationError } from '../../foundation/errors';
import { configDir } from '../../foundation/paths';
import { ISSUES_DIR_NAME, ERROR_CODES } from '../../constants';

export interface IssuePruneFlags extends GlobalFlags {
  before?: string;
  keep?: number;
}

interface PrunedEntry {
  id: string;
  path: string;
  sizeBytes: number;
  lastTouchedAt: string;
}

interface IssuePrunePayload {
  removed: PrunedEntry[];
  kept: PrunedEntry[];
  bytesFreed: number;
  cutoff: { mode: 'before' | 'keep'; value: string | number };
}

const DEFAULT_BEFORE_DAYS = 30;

const cmd: CommandFn<IssuePrunePayload> = async (
  flags,
): Promise<CommandResult<IssuePrunePayload>> => {
  const f = flags as IssuePruneFlags;

  if (f.before !== undefined && f.keep !== undefined) {
    throw new ValidationError(
      '--before and --keep are mutually exclusive.',
      ERROR_CODES.VALIDATION_BAD_VALUE,
      'Pick one: --before <YYYY-MM-DD> drops by age, --keep <n> keeps the N most recent.',
    );
  }

  const root = path.join(configDir(), ISSUES_DIR_NAME);
  const entries = collectMaterialisations(root);

  let toRemove: PrunedEntry[] = [];
  let toKeep: PrunedEntry[] = [];
  let cutoff: IssuePrunePayload['cutoff'];

  if (f.keep !== undefined) {
    const n = Math.max(0, Number(f.keep));
    if (!Number.isFinite(n)) {
      throw new ValidationError(
        `--keep must be a non-negative integer (got "${f.keep}").`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
    // Sort newest-first by lastTouchedAt; keep the first N.
    entries.sort((a, b) => (a.lastTouchedAt > b.lastTouchedAt ? -1 : 1));
    toKeep = entries.slice(0, n);
    toRemove = entries.slice(n);
    cutoff = { mode: 'keep', value: n };
  } else {
    const beforeRaw = f.before ?? defaultBeforeDate();
    const beforeMs = Date.parse(beforeRaw);
    if (!Number.isFinite(beforeMs)) {
      throw new ValidationError(
        `--before must be an ISO date (YYYY-MM-DD or full ISO timestamp). Got "${beforeRaw}".`,
        ERROR_CODES.VALIDATION_BAD_VALUE,
      );
    }
    for (const e of entries) {
      if (Date.parse(e.lastTouchedAt) < beforeMs) toRemove.push(e);
      else toKeep.push(e);
    }
    cutoff = { mode: 'before', value: beforeRaw };
  }

  let bytesFreed = 0;
  for (const e of toRemove) {
    try {
      fs.rmSync(e.path, { recursive: true, force: true });
      bytesFreed += e.sizeBytes;
    } catch {
      // Best-effort: a directory we can't delete just stays. The
      // caller's JSON still reports the attempted removal.
    }
  }

  return {
    json: {
      removed: toRemove,
      kept: toKeep,
      bytesFreed,
      cutoff,
    },
    pretty: ctx => {
      if (toRemove.length === 0) {
        writeLine(dim(ctx, `(nothing to prune — ${toKeep.length} issue dir(s) within ${cutoff.mode}=${cutoff.value})`));
        return;
      }
      writeLine(success(ctx, `Pruned ${toRemove.length} issue dir(s) (${humanBytes(bytesFreed)} freed).`));
      for (const e of toRemove) {
        writeLine(`  ${dim(ctx, '✗')} #${e.id}  ${dim(ctx, humanBytes(e.sizeBytes))}  ${dim(ctx, `(last touched ${e.lastTouchedAt})`)}`);
      }
      writeLine(`  ${dim(ctx, 'kept:')} ${toKeep.length} issue dir(s)`);
    },
  };
};

function collectMaterialisations(root: string): PrunedEntry[] {
  if (!fs.existsSync(root)) return [];
  const out: PrunedEntry[] = [];
  for (const name of fs.readdirSync(root)) {
    const abs = path.join(root, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (!/^\d+$/.test(name)) continue; // only numeric ids
    const { newestMtime, totalBytes } = walkDirStats(abs);
    out.push({
      id: name,
      path: abs,
      sizeBytes: totalBytes,
      lastTouchedAt: new Date(newestMtime).toISOString(),
    });
  }
  return out;
}

function walkDirStats(dir: string): { newestMtime: number; totalBytes: number } {
  let newest = 0;
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (ent.isFile()) total += st.size;
        else if (ent.isDirectory()) stack.push(full);
      } catch {
        // skip
      }
    }
  }
  return { newestMtime: newest, totalBytes: total };
}

function defaultBeforeDate(now: Date = new Date()): string {
  const d = new Date(now.getTime() - DEFAULT_BEFORE_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function pruneIssue(flags: IssuePruneFlags): Promise<never> {
  return runCommand('issue.prune', flags, cmd);
}
