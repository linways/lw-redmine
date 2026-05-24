/**
 * Filesystem path resolution.
 *
 * Single source of truth for where `lwr` reads/writes its state. All paths
 * are derived from `constants/config.ts` so a fork can change the layout in
 * one place. Tests can override the root via $LWR_CONFIG_DIR.
 */

import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_ROOT,
  CONFIG_FILE,
  AUTH_FILE_FALLBACK,
  CACHE_DIR_NAME,
  CACHE_FILE_NAMES,
  ISSUES_DIR_NAME,
  ME_FILE,
  ENV,
  ASSISTANT_EVENTS_DIR,
  ASSISTANT_EVENT_FILES,
  ASSISTANT_FACTS_DIR,
  ASSISTANT_FACT_FILES,
  MEMORY_DIR,
  MEMORY_DB_NAME,
  WORK_LOG_DIR,
  workLogDayFile,
  FEEDBACK_DIR,
  feedbackEntryFile,
  type FeedbackKind,
  BACKUP_DIR_NAME,
  BACKUP_FILE_SUFFIX,
  BACKUP_PRE_RESTORE_PREFIX,
} from '../constants';

/**
 * The directory `lwr` owns. Either:
 *   - $LWR_CONFIG_DIR (for tests / explicit override), or
 *   - ~/.lwr/                                          (default)
 */
export function configDir(): string {
  const override = process.env[ENV.CONFIG_DIR];
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), CONFIG_ROOT);
}

export function configFilePath(): string {
  return path.join(configDir(), CONFIG_FILE);
}

export function authFallbackPath(): string {
  return path.join(configDir(), AUTH_FILE_FALLBACK);
}

/** Rendered "who am I" snippet (`~/.lwr/me.md`). */
export function meMarkdownPath(): string {
  return path.join(configDir(), ME_FILE);
}

/** Per-issue cache directory: `~/.lwr/issues/<id>/`. */
export function issuesDir(issueId: number | string): string {
  return path.join(configDir(), ISSUES_DIR_NAME, String(issueId));
}

// --- Metadata cache (~/.lwr/cache/) ----------------------------------------
//
// Plain-JSON cache for the statuses dictionary and per-project member
// lists. Used by the user resolver (issue → project → members) so an
// agent assigning by name never re-fetches if the project's members
// were already pulled in this 24h window.

export function cacheDir(): string {
  return path.join(configDir(), CACHE_DIR_NAME);
}

export function cacheStatusesPath(): string {
  return path.join(cacheDir(), CACHE_FILE_NAMES.STATUSES);
}

export function cacheActivitiesPath(): string {
  return path.join(cacheDir(), CACHE_FILE_NAMES.ACTIVITIES);
}

export function cacheProjectsIndexPath(): string {
  return path.join(cacheDir(), CACHE_FILE_NAMES.PROJECTS_INDEX);
}

export function cacheProjectsDir(): string {
  return path.join(cacheDir(), CACHE_FILE_NAMES.PROJECTS_DIR);
}

export function cacheProjectPath(projectId: number | string): string {
  return path.join(cacheProjectsDir(), `${projectId}.json`);
}

export function cacheUsersManualPath(): string {
  return path.join(cacheDir(), CACHE_FILE_NAMES.USERS_MANUAL);
}

export function cacheCustomFieldsPath(): string {
  return path.join(cacheDir(), CACHE_FILE_NAMES.CUSTOM_FIELDS);
}

export function cacheMetaPath(): string {
  return path.join(cacheDir(), CACHE_FILE_NAMES.META);
}

// --- Assistant (~/.lwr/events/) -------------------------------------------
//
// Append-only behaviour event logs. Created lazily — only exists once
// the user runs `lwr assistant enable` AND a command then runs.

export function assistantEventsDir(): string {
  return path.join(configDir(), ASSISTANT_EVENTS_DIR);
}

export function assistantCommandsLogPath(): string {
  return path.join(assistantEventsDir(), ASSISTANT_EVENT_FILES.COMMANDS);
}

export function assistantDecisionsLogPath(): string {
  return path.join(assistantEventsDir(), ASSISTANT_EVENT_FILES.DECISIONS);
}

export function assistantOverridesLogPath(): string {
  return path.join(assistantEventsDir(), ASSISTANT_EVENT_FILES.OVERRIDES);
}

// --- Assistant facts (~/.lwr/facts/) --------------------------------------
//
// Durable, user-declared (and future agent-inferred) facts. Unlike events,
// facts are bounded in size and intended for round-tripping through the
// agent. Today only `preferences.json` is implemented; the rest of
// ASSISTANT_FACT_FILES are reserved.

export function assistantFactsDir(): string {
  return path.join(configDir(), ASSISTANT_FACTS_DIR);
}

export function preferencesFilePath(): string {
  return path.join(assistantFactsDir(), ASSISTANT_FACT_FILES.PREFERENCES);
}

// --- Memory module (~/.lwr/memory/) ---------------------------------------
//
// SQLite database holding the Hindsight-inspired retain/recall corpus.
// One file per profile so deleting `~/.lwr/memory/` is the full reset
// path. Created lazily on first `retain()`; absent until then.

export function memoryDir(): string {
  return path.join(configDir(), MEMORY_DIR);
}

export function memoryDbPath(): string {
  return path.join(memoryDir(), MEMORY_DB_NAME);
}

// --- Action log (~/.lwr/log/) ----------------------------------------------
//
// Per-day NDJSON files holding the audit log of every mutating lwr
// command. Written by `foundation/action-log.ts` from inside `runCommand`.
// One file per ISO date keeps cleanup trivial (`lwr log clear --before X`
// is just `rm`).

export function workLogDir(): string {
  return path.join(configDir(), WORK_LOG_DIR);
}

export function workLogDayPath(isoDate: string): string {
  return path.join(workLogDir(), workLogDayFile(isoDate));
}

/**
 * Single-line marker file: `~/.lwr/.rollover-ack`. Contents = ISO date
 * (YYYY-MM-DD in WORK_TZ) of the last day the user acknowledged the
 * daily-rollover prompt. While the file's date matches today, the
 * detector stays silent; running `lwr issue handover` (or its --dismiss
 * subform) updates the marker so a single ack covers the whole day.
 */
export function rolloverAckPath(): string {
  return path.join(configDir(), '.rollover-ack');
}

// --- Feedback log (~/.lwr/feedback/) ---------------------------------------
//
// One markdown file per incident, grouped under a UTC-date folder so a
// week's bundle is `tar czf` over the matching folders. See
// `FEEDBACK_SPEC.md` for the full design.

export function feedbackDir(): string {
  return path.join(configDir(), FEEDBACK_DIR);
}

export function feedbackDayDir(isoDate: string): string {
  return path.join(feedbackDir(), isoDate);
}

export function feedbackEntryPath(
  isoDate: string,
  timeUtc: string,
  kind: FeedbackKind,
  slug: string,
): string {
  return path.join(feedbackDayDir(isoDate), feedbackEntryFile(timeUtc, kind, slug));
}

// --- Backups (~/.lwr/backups/) ---------------------------------------------
//
// Default location for `<timestamp>_backup.lwr` bundles produced by
// `lwr backup` and consumed by `lwr restore`. Created lazily.

export function backupDir(): string {
  return path.join(configDir(), BACKUP_DIR_NAME);
}

/** Build the canonical backup filename for a given ISO timestamp. */
export function backupFileName(timestamp: string, preRestore = false): string {
  const prefix = preRestore ? BACKUP_PRE_RESTORE_PREFIX : '';
  return `${prefix}${timestamp}${BACKUP_FILE_SUFFIX}`;
}

export function backupFilePath(timestamp: string, preRestore = false): string {
  return path.join(backupDir(), backupFileName(timestamp, preRestore));
}
