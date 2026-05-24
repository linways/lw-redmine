/**
 * `lwr backup`, `lwr backup list`, `lwr restore`
 *
 * Three verbs around a single `<timestamp>_backup.lwr` bundle format:
 *
 *   - `lwr backup`            — capture current state to ~/.lwr/backups/
 *   - `lwr backup list`       — enumerate available bundles for an agent
 *   - `lwr restore <file>`    — destructive overwrite, double-confirmed,
 *                                with an auto-snapshot taken first
 *
 * The bundle includes everything under `~/.lwr/` EXCEPT the auth fallback
 * (`auth.json`) and the backups directory itself. Credentials live in the
 * OS keychain (keytar) — not the filesystem — and intentionally do not
 * round-trip through a backup. After restore the user re-runs
 * `lwr auth login` once.
 *
 * Restore is destructive (clear-and-restore semantics) so it goes
 * through `confirmDestructive`. The auto-snapshot taken before the wipe
 * is the safety net: a wrong restore is reversible by `lwr restore` of
 * the `pre-restore-*.lwr` file that was just written.
 */

import {
  runCommand,
  type CommandFn,
  type CommandResult,
  type GlobalFlags,
} from '../foundation/run';
import { writeLine } from '../foundation/output';
import { success, dim } from '../foundation/format';
import { ValidationError } from '../foundation/errors';
import { confirmDestructive, type DoubleConfirmFlags } from '../foundation/confirm';
import {
  createBackup,
  listBackups,
  restoreBackup,
  pruneBackups,
  type BackupListEntry,
} from '../workflow/backup';
import { ERROR_CODES } from '../constants';

// --- backup (create) ------------------------------------------------------

export interface BackupCreateFlags extends GlobalFlags {
  out?: string;
}

interface BackupCreatePayload {
  path: string;
  sizeBytes: number;
  fileCount: number;
  createdAt: string;
}

const createCmd: CommandFn<BackupCreatePayload> = async (
  flags,
): Promise<CommandResult<BackupCreatePayload>> => {
  const f = flags as BackupCreateFlags;
  const result = createBackup({ outPath: f.out });
  return {
    json: result,
    pretty: ctx => {
      writeLine(success(ctx, `Backup written.`));
      writeLine(`  ${dim(ctx, 'path :')} ${result.path}`);
      writeLine(`  ${dim(ctx, 'size :')} ${humanBytes(result.sizeBytes)}`);
      writeLine(`  ${dim(ctx, 'files:')} ${result.fileCount}`);
      writeLine(`  ${dim(ctx, 'next :')} run \`lwr backup list\` to see available restore points.`);
    },
  };
};

export function backupCreate(flags: BackupCreateFlags): Promise<never> {
  return runCommand('backup.create', flags, createCmd);
}

// --- backup list ----------------------------------------------------------

interface BackupListPayload {
  backups: BackupListEntry[];
}

const listCmd: CommandFn<BackupListPayload> = async (): Promise<CommandResult<BackupListPayload>> => {
  const backups = listBackups();
  return {
    json: { backups },
    pretty: ctx => {
      if (backups.length === 0) {
        writeLine(dim(ctx, '(no backups yet — run `lwr backup` to create one)'));
        return;
      }
      writeLine(success(ctx, `${backups.length} backup(s):`));
      for (const b of backups) {
        const tag = b.kind === 'pre-restore' ? dim(ctx, '[pre-restore]') : '';
        writeLine(
          `  ${b.name}  ${dim(ctx, humanBytes(b.sizeBytes))}  ${tag}`.trimEnd(),
        );
      }
      writeLine(`  ${dim(ctx, 'restore:')} \`lwr restore <name> --confirm "restore" --yes\``);
    },
  };
};

export function backupList(flags: GlobalFlags): Promise<never> {
  return runCommand('backup.list', flags, listCmd);
}

// --- backup prune ---------------------------------------------------------

export interface BackupPruneFlags extends GlobalFlags {
  keep?: number;
  kind?: 'user' | 'pre-restore' | 'all';
}

interface BackupPrunePayload {
  removed: BackupListEntry[];
  kept: BackupListEntry[];
  bytesFreed: number;
}

const pruneCmd: CommandFn<BackupPrunePayload> = async (
  flags,
): Promise<CommandResult<BackupPrunePayload>> => {
  const f = flags as BackupPruneFlags;
  const keepRaw = f.keep ?? 5;
  const keep = Math.max(0, Number(keepRaw));
  if (!Number.isFinite(keep)) {
    throw new ValidationError(
      `--keep must be a non-negative integer (got "${keepRaw}").`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  const kind = f.kind ?? 'all';
  if (!['user', 'pre-restore', 'all'].includes(kind)) {
    throw new ValidationError(
      `--kind must be one of: user, pre-restore, all (got "${kind}").`,
      ERROR_CODES.VALIDATION_BAD_VALUE,
    );
  }
  const result = pruneBackups({ keep, kind });
  return {
    json: result,
    pretty: ctx => {
      if (result.removed.length === 0) {
        writeLine(dim(ctx, `(nothing to prune — ${result.kept.length} backup(s) within --keep=${keep})`));
        return;
      }
      writeLine(success(ctx, `Pruned ${result.removed.length} backup(s) (${humanBytes(result.bytesFreed)} freed).`));
      for (const b of result.removed) {
        writeLine(`  ${dim(ctx, '✗')} ${b.name}  ${dim(ctx, humanBytes(b.sizeBytes))}`);
      }
      writeLine(`  ${dim(ctx, 'kept:')} ${result.kept.length} most-recent`);
    },
  };
};

export function backupPrune(flags: BackupPruneFlags): Promise<never> {
  return runCommand('backup.prune', flags, pruneCmd);
}

// --- restore --------------------------------------------------------------

export interface RestoreFlags extends GlobalFlags, DoubleConfirmFlags {
  file?: string;
}

interface RestorePayload {
  restoredFrom: string;
  snapshotPath: string | null;
  fileCount: number;
  bytesRestored: number;
}

const restoreCmd: CommandFn<RestorePayload> = async (
  flags,
  ctx,
): Promise<CommandResult<RestorePayload>> => {
  const f = flags as RestoreFlags;
  if (!f.file || f.file.trim().length === 0) {
    throw new ValidationError(
      'Backup file path is required.',
      ERROR_CODES.VALIDATION_MISSING_FLAG,
      'Pass it positionally: `lwr restore <path-to-backup.lwr>`.',
    );
  }

  await confirmDestructive({
    action: 'restore',
    description:
      'overwrite current lwr state (config, memory, action log, feedback log, caches, materialised issues) with the contents of the bundle. An auto-snapshot of the current state is written to ~/.lwr/backups/pre-restore-*.lwr first',
    affectedPaths: [f.file],
    ctx,
    flags: { confirm: f.confirm, yes: f.yes },
  });

  const result = restoreBackup(f.file);
  return {
    json: result,
    pretty: c => {
      writeLine(success(c, `Restore complete.`));
      writeLine(`  ${dim(c, 'from    :')} ${result.restoredFrom}`);
      writeLine(`  ${dim(c, 'files   :')} ${result.fileCount}`);
      writeLine(`  ${dim(c, 'bytes   :')} ${humanBytes(result.bytesRestored)}`);
      if (result.snapshotPath) {
        writeLine(`  ${dim(c, 'rollback:')} ${result.snapshotPath}`);
      }
      writeLine(`  ${dim(c, 'next    :')} run \`lwr auth login\` if credentials are missing.`);
    },
  };
};

export function restore(flags: RestoreFlags): Promise<never> {
  return runCommand('restore', flags, restoreCmd);
}

// --- helpers --------------------------------------------------------------

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
