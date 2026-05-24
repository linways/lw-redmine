/**
 * Action audit log — on-disk constants.
 *
 * Previously held the session-spec constants (anomaly codes, work-hours,
 * status-phase semantics, branch parser). All of that was replaced by
 * the action-log model — see `foundation/action-log.ts`. Only the things
 * shared with the path resolver remain here.
 *
 * A fork that retargets `lwr` to a different Redmine instance generally
 * doesn't need to touch this file; `WORK_TZ` is the only thing they'd
 * tweak.
 */

/** Working timezone for "today" / "yesterday" date math. */
export const WORK_TZ = 'Asia/Kolkata';

/** Subdirectory under `~/.lwr/` for action-log files. */
export const WORK_LOG_DIR = 'log';

/** `~/.lwr/log/2026-05-10.ndjson` — append-only, one mutation per line. */
export const workLogDayFile = (isoDate: string): string => `${isoDate}.ndjson`;
