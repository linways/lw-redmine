/**
 * Backup / restore — pack and unpack the user's `~/.lwr/` state into a
 * single, agent-discoverable `<timestamp>_backup.lwr` bundle.
 *
 * A bundle is a gzipped JSON object:
 *
 *   {
 *     schema:      'lwr/backup/v1',
 *     created:     ISO timestamp,
 *     lwrVersion:  package.json#version,
 *     files:       { <rel-path>: <base64>, ... }
 *   }
 *
 * `<rel-path>` is always relative to `configDir()` (`~/.lwr/`), forward-
 * slash separated, never absolute. Restore writes them back into the
 * current `configDir()`, so a bundle from one machine can be unpacked
 * on another machine with a different home directory.
 *
 * Excluded from every bundle (and from the wipe step on restore):
 *   - `auth.json`     — plaintext-fallback creds. Re-login is one command.
 *   - `backups/`      — the backup directory itself. Never recurse.
 *
 * Restore is **clear-and-restore**: every path that would have been
 * captured by a fresh `pack()` is wiped, then the bundle's files are
 * written. The two exclude paths above are left strictly untouched.
 *
 * On `restoreBackup()` an auto-snapshot is taken first (filename starts
 * with `pre-restore-`) so the previous state is recoverable by another
 * `lwr restore`.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import pkg from '../../package.json';
import {
  configDir,
  backupDir,
  backupFilePath,
} from '../foundation/paths';
import {
  BACKUP_SCHEMA,
  BACKUP_FILE_SUFFIX,
  BACKUP_PRE_RESTORE_PREFIX,
  BACKUP_MAX_BYTES,
  BACKUP_DIR_NAME,
  AUTH_FILE_FALLBACK,
  ERROR_CODES,
  EXIT,
} from '../constants';
import { LwrError } from '../foundation/errors';

/** Paths inside `configDir()` that backup never touches (pack or wipe). */
const EXCLUDE_TOP_LEVEL: ReadonlySet<string> = new Set([
  AUTH_FILE_FALLBACK,
  BACKUP_DIR_NAME,
]);

export interface BackupBundle {
  schema: typeof BACKUP_SCHEMA;
  created: string;
  lwrVersion: string;
  files: Record<string, string>;
}

export interface BackupResult {
  /** Absolute path of the written bundle. */
  path: string;
  /** Size of the bundle on disk (gzipped). */
  sizeBytes: number;
  /** Number of files captured. */
  fileCount: number;
  /** ISO timestamp matching the filename. */
  createdAt: string;
}

export interface RestoreResult {
  /** The bundle that was restored from. */
  restoredFrom: string;
  /** Auto-snapshot of pre-restore state (so the user can roll back). */
  snapshotPath: string | null;
  /** Number of files written from the bundle. */
  fileCount: number;
  /** Total uncompressed bytes written. */
  bytesRestored: number;
}

export interface BackupListEntry {
  path: string;
  name: string;
  /** 'user' = manual `lwr backup`; 'pre-restore' = auto-snapshot. */
  kind: 'user' | 'pre-restore';
  createdAt: string;
  sizeBytes: number;
}

// --- Pack ------------------------------------------------------------------

/**
 * Create a new backup. If `outPath` is omitted, writes to
 * `~/.lwr/backups/<timestamp>_backup.lwr`.
 */
export function createBackup(opts: { outPath?: string; preRestore?: boolean } = {}): BackupResult {
  const root = configDir();
  const timestamp = nowFileSafe();
  const targetPath =
    opts.outPath ?? backupFilePath(timestamp, opts.preRestore ?? false);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const files: Record<string, string> = {};
  walkAndCollect(root, '', files);

  const bundle: BackupBundle = {
    schema: BACKUP_SCHEMA,
    created: new Date().toISOString(),
    lwrVersion: pkg.version,
    files,
  };

  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'));
  fs.writeFileSync(targetPath, gz);
  const stat = fs.statSync(targetPath);

  return {
    path: targetPath,
    sizeBytes: stat.size,
    fileCount: Object.keys(files).length,
    createdAt: bundle.created,
  };
}

/**
 * Recursively walk `root + relDir`, adding every file's contents (base64)
 * to `out`. Skips the excluded top-level paths.
 */
function walkAndCollect(
  root: string,
  relDir: string,
  out: Record<string, string>,
): void {
  const abs = path.join(root, relDir);
  if (!fs.existsSync(abs)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    // Top-level excludes — only filter at depth 0.
    if (relDir === '' && EXCLUDE_TOP_LEVEL.has(ent.name)) continue;
    const childRel = relDir === '' ? ent.name : `${relDir}/${ent.name}`;
    const childAbs = path.join(root, childRel);
    if (ent.isDirectory()) {
      walkAndCollect(root, childRel, out);
    } else if (ent.isFile()) {
      try {
        const data = fs.readFileSync(childAbs);
        out[childRel] = data.toString('base64');
      } catch {
        // Best-effort: a file we can't read is simply skipped. The
        // bundle still represents a valid point-in-time snapshot of
        // what was readable.
      }
    }
    // Symlinks and other types are intentionally skipped.
  }
}

// --- Unpack ----------------------------------------------------------------

/**
 * Restore from a bundle. Wipes every backup-scope path under `configDir()`
 * first (excluding `auth.json` + `backups/`), then writes the bundle's
 * files. Snapshots current state first as `pre-restore-...`.
 */
export function restoreBackup(bundlePath: string): RestoreResult {
  const bundle = readBundle(bundlePath);

  const snapshot = createBackup({ preRestore: true });
  const root = configDir();

  // 1. Wipe the backup-scope. Anything under root except the two
  //    excluded names — which guarantees we don't blow away the
  //    auth fallback or the backups directory (including the
  //    snapshot we just wrote).
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (EXCLUDE_TOP_LEVEL.has(ent.name)) continue;
    const abs = path.join(root, ent.name);
    fs.rmSync(abs, { recursive: true, force: true });
  }

  // 2. Write every file from the bundle. Reject any path that tries
  //    to escape the root (defence-in-depth against a malicious
  //    bundle handcrafted with `../etc/passwd` keys).
  let bytesRestored = 0;
  for (const [rel, b64] of Object.entries(bundle.files)) {
    const safeRel = assertInsideRoot(rel);
    const target = path.join(root, safeRel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = Buffer.from(b64, 'base64');
    fs.writeFileSync(target, data);
    bytesRestored += data.length;
  }

  return {
    restoredFrom: bundlePath,
    snapshotPath: snapshot.path,
    fileCount: Object.keys(bundle.files).length,
    bytesRestored,
  };
}

function readBundle(bundlePath: string): BackupBundle {
  if (!fs.existsSync(bundlePath)) {
    throw new LwrError({
      message: `Backup file not found: ${bundlePath}`,
      code: ERROR_CODES.BACKUP_BUNDLE_INVALID,
      exit: EXIT.VALIDATION,
      hint: 'Run `lwr backup list` to see available backups.',
    });
  }
  const stat = fs.statSync(bundlePath);
  if (stat.size > BACKUP_MAX_BYTES) {
    throw new LwrError({
      message: `Backup file exceeds maximum size (${stat.size} > ${BACKUP_MAX_BYTES}).`,
      code: ERROR_CODES.BACKUP_BUNDLE_INVALID,
      exit: EXIT.VALIDATION,
    });
  }
  let json: unknown;
  try {
    const gz = fs.readFileSync(bundlePath);
    const raw = zlib.gunzipSync(gz);
    json = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new LwrError({
      message: `Backup file is not a valid lwr bundle: ${(err as Error).message}`,
      code: ERROR_CODES.BACKUP_BUNDLE_INVALID,
      exit: EXIT.VALIDATION,
    });
  }
  if (
    !json ||
    typeof json !== 'object' ||
    (json as { schema?: unknown }).schema !== BACKUP_SCHEMA ||
    typeof (json as { files?: unknown }).files !== 'object'
  ) {
    throw new LwrError({
      message: `Backup schema mismatch (expected ${BACKUP_SCHEMA}).`,
      code: ERROR_CODES.BACKUP_BUNDLE_INVALID,
      exit: EXIT.VALIDATION,
    });
  }
  return json as BackupBundle;
}

function assertInsideRoot(rel: string): string {
  // No leading slash, no `..` segment, no absolute path.
  const normalised = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (
    normalised.startsWith('/') ||
    normalised.startsWith('..') ||
    normalised.split('/').some(seg => seg === '..')
  ) {
    throw new LwrError({
      message: `Backup bundle contains an unsafe path: ${rel}`,
      code: ERROR_CODES.BACKUP_BUNDLE_INVALID,
      exit: EXIT.VALIDATION,
    });
  }
  return normalised;
}

// --- List ------------------------------------------------------------------

export function listBackups(): BackupListEntry[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  const out: BackupListEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(BACKUP_FILE_SUFFIX)) continue;
    const abs = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    const kind: BackupListEntry['kind'] = name.startsWith(BACKUP_PRE_RESTORE_PREFIX)
      ? 'pre-restore'
      : 'user';
    out.push({
      path: abs,
      name,
      kind,
      createdAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    });
  }
  // Newest first — filenames are lex-sortable by timestamp, so reverse
  // alphabetical gives us newest-first regardless of mtime.
  out.sort((a, b) => (a.name > b.name ? -1 : a.name < b.name ? 1 : 0));
  return out;
}

// --- Prune -----------------------------------------------------------------

export interface PruneBackupsResult {
  /** Bundles that were deleted, in the order they were removed. */
  removed: BackupListEntry[];
  /** Bundles that survived. */
  kept: BackupListEntry[];
  /** Total bytes reclaimed by the prune. */
  bytesFreed: number;
}

/**
 * Delete all but the N most recent backup bundles. `kind` filter lets
 * the caller scope the cull — e.g. only the `pre-restore-*` auto-snapshots
 * (the noisy ones that accumulate on every restore) without touching
 * user-initiated backups.
 *
 * Returns the deleted entries so the caller can report bytes freed.
 * Idempotent: re-running with the same `--keep` is a no-op once the
 * count is reached.
 */
export function pruneBackups(opts: {
  keep: number;
  kind?: 'user' | 'pre-restore' | 'all';
}): PruneBackupsResult {
  const kindFilter = opts.kind ?? 'all';
  const all = listBackups();
  const inScope = kindFilter === 'all' ? all : all.filter(b => b.kind === kindFilter);
  // listBackups already sorted newest-first; keep the first N, prune the rest.
  const kept = inScope.slice(0, Math.max(0, opts.keep));
  const removeSet = new Set(inScope.slice(opts.keep).map(b => b.path));
  const removed: BackupListEntry[] = [];
  let bytesFreed = 0;
  for (const entry of all) {
    if (!removeSet.has(entry.path)) continue;
    try {
      fs.rmSync(entry.path, { force: true });
      removed.push(entry);
      bytesFreed += entry.sizeBytes;
    } catch {
      // Best-effort; skip entries we can't delete.
    }
  }
  return { removed, kept, bytesFreed };
}

// --- Helpers ---------------------------------------------------------------

/** Filename-safe ISO UTC: `2026-05-23T09-00-00Z` (no colons, no millis). */
export function nowFileSafe(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}
