/**
 * `lwr clear-data`
 *
 * Wipes accumulated session data without logging the user out:
 *
 *   - `~/.lwr/cache/statuses.json`        — instance status dictionary
 *   - `~/.lwr/cache/projects-index.json`  — id ↔ name dictionary
 *   - `~/.lwr/cache/projects/`            — per-project member lists
 *   - `~/.lwr/issues/`                    — materialised issue downloads
 *
 * Preserves:
 *   - `~/.lwr/config.json`         (credentials reference, profile.me, activeProject)
 *   - `~/.lwr/me.md`               (rendered identity snippet — still valid)
 *   - `~/.lwr/cache/users-manual.json`  (user-curated; sacred)
 *
 * Use this when caches feel stale or out of sync but you don't want to
 * re-authenticate. Re-fetching everything is one command away (the next
 * `lwr issue list`, `--no-cache`, or `lwr cache refresh`).
 *
 * Requires double confirmation — TTY: type `clear-data` then `YES`;
 * agents: pass `--confirm "clear-data" --yes`.
 */

import fs from 'node:fs';
import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../foundation/run';
import { confirmDestructive, type DoubleConfirmFlags } from '../foundation/confirm';
import path from 'node:path';
import {
  cacheStatusesPath,
  cacheProjectsIndexPath,
  cacheProjectsDir,
  configDir,
} from '../foundation/paths';
import { ISSUES_DIR_NAME } from '../constants';
import { writeLine } from '../foundation/output';
import { success, dim } from '../foundation/format';

export interface ClearDataFlags extends GlobalFlags, DoubleConfirmFlags {}

interface ClearDataPayload {
  removed: { type: string; path: string; sizeBytes?: number }[];
}

const cmd: CommandFn<ClearDataPayload> = async (flags, ctx): Promise<CommandResult<ClearDataPayload>> => {
  const flgs = flags as ClearDataFlags;

  // Build the list of paths up front so the user sees exactly what's affected.
  const targets = collectTargets();

  await confirmDestructive({
    action: 'clear-data',
    description: 'remove cached Redmine data (statuses, projects index, members, downloaded issues). Credentials, profile, me.md and the manual users list are preserved',
    affectedPaths: targets.map(t => t.path),
    ctx,
    flags: { confirm: flgs.confirm, yes: flgs.yes },
  });

  const removed: { type: string; path: string; sizeBytes?: number }[] = [];
  for (const t of targets) {
    if (!fs.existsSync(t.path)) continue;
    const size = safeSize(t.path);
    try {
      fs.rmSync(t.path, { recursive: true, force: true });
      removed.push({ type: t.type, path: t.path, sizeBytes: size });
    } catch (err) {
      // Best-effort — keep going so partial cleanup still succeeds.
      void err;
    }
  }

  return {
    json: { removed },
    pretty: c => {
      if (removed.length === 0) {
        writeLine(dim(c, '(nothing to clear — caches are already empty)'));
        return;
      }
      writeLine(success(c, `Cleared ${removed.length} cache target(s).`));
      for (const r of removed) {
        const sz = r.sizeBytes !== undefined ? ` ${dim(c, `(${humanBytes(r.sizeBytes)})`)}` : '';
        writeLine(`  ${dim(c, '✗')} ${r.path}${sz}`);
      }
      writeLine(`  ${dim(c, 'next call will repopulate caches as needed.')}`);
    },
  };
};

interface Target {
  type: 'statuses' | 'projects-index' | 'projects-members' | 'issues';
  path: string;
}

function collectTargets(): Target[] {
  return [
    { type: 'statuses', path: cacheStatusesPath() },
    { type: 'projects-index', path: cacheProjectsIndexPath() },
    { type: 'projects-members', path: cacheProjectsDir() },
    { type: 'issues', path: path.join(configDir(), ISSUES_DIR_NAME) },
  ];
}

function safeSize(p: string): number | undefined {
  try {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return dirSize(p);
    return stat.size;
  } catch {
    return undefined;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = `${dir}/${name}`;
    try {
      const stat = fs.statSync(full);
      total += stat.isDirectory() ? dirSize(full) : stat.size;
    } catch {
      // ignore
    }
  }
  return total;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function clearData(flags: ClearDataFlags): Promise<never> {
  return runCommand('clear-data', flags, cmd);
}
