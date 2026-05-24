/**
 * Backup / restore bundle constants.
 *
 * A bundle is a single gzipped-JSON file containing every piece of user
 * state under `~/.lwr/` *except* credentials. It exists so a user (or
 * agent on their behalf) can snapshot the working state — memory,
 * config, action log, feedback log, caches, materialised issues — and
 * later restore it on the same or a different machine.
 *
 * Credentials are deliberately excluded:
 *   - keytar entries live in the OS keychain, not the filesystem.
 *   - `auth.json` (the no-keytar fallback) holds the api key in
 *     plaintext; bundling it would let a leaked backup leak creds.
 * After restore the user re-runs `lwr auth login` once.
 *
 * Filename grammar:
 *   `<timestamp>_backup.lwr`               — user-initiated
 *   `pre-restore-<timestamp>_backup.lwr`   — auto-snapshot before restore
 *
 * `<timestamp>` is filename-safe ISO UTC (colons → hyphens), e.g.
 * `2026-05-23T09-00-00Z`. Lex-sortable; agents can pick the newest by
 * sorting the list.
 */

/** Directory under `~/.lwr/` where backups land by default. */
export const BACKUP_DIR_NAME = 'backups';

/** Schema string stamped into every bundle so future readers can refuse stale layouts. */
export const BACKUP_SCHEMA = 'lwr/backup/v1';

/** Suffix appended to every backup filename. AI-agent-recognisable. */
export const BACKUP_FILE_SUFFIX = '_backup.lwr';

/** Prefix for auto-snapshots taken before a destructive restore. */
export const BACKUP_PRE_RESTORE_PREFIX = 'pre-restore-';

/**
 * Hard cap on the size of a single backup file the restore path will
 * accept. Defends against a maliciously-crafted .lwr file expanding to
 * exhaust memory during gunzip + JSON.parse. 200 MB is well above any
 * plausible single-user state (memory DB + cache + issues + feedback).
 */
export const BACKUP_MAX_BYTES = 200 * 1024 * 1024;
