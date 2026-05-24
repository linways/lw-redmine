/**
 * Memory module — constants.
 *
 * The `src/memory/` module is a Hindsight-inspired (retain/recall) memory
 * engine. It's a self-contained library: lwr's assistant layer is the
 * first consumer, but the module itself imports nothing from
 * `src/assistant/` / `src/commands/` / `src/api/` and only borrows
 * `paths.ts` for the on-disk location. The boundary is enforced by
 * convention; keeping the constants here makes that boundary explicit.
 *
 * Per the project's constants-files rule, anything a forker would
 * reasonably retarget (directory name, schema version, retention
 * defaults) lives in this file.
 */

/** Subdirectory under `~/.lwr/` that holds the SQLite database. */
export const MEMORY_DIR = 'memory';

/** SQLite database filename inside `~/.lwr/memory/`. */
export const MEMORY_DB_NAME = 'memory.db';

/**
 * Schema version stamped in the `meta` table on first init. The storage
 * layer refuses to open a database with a mismatched version — a forward-
 * compatible future schema must not be silently downgraded.
 */
export const MEMORY_SCHEMA = 'lwr-memory/v1';

/**
 * Allowed values for `memory.kind`. Kept narrow on purpose — broader
 * categorisation belongs in `metadata`, not in a free-text column that
 * the recall path would need to interpret.
 *
 *   observation     — raw event captured from a mutation (the dominant kind)
 *   rule-candidate  — a pattern the suggester thinks might become a rule
 *   fact            — user-asserted statement ("I work on AMS V4")
 */
export const MEMORY_KINDS = ['observation', 'rule-candidate', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * Default retention window before consolidation prunes stale, low-
 * frequency observations. Generous on purpose — the recall path is
 * cheap and behaviour patterns benefit from a long window.
 */
export const MEMORY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

/**
 * Rule-candidate detector — how many times a user must manually do the
 * same `(cf_id, value)` mutation within `MEMORY_RULE_CANDIDATE_WINDOW_MS`
 * before lwr surfaces it as a candidate for `lwr prefs add`.
 *
 * 5 / 30 days balances signal vs. noise: too low (≤2) trips on one-off
 * operations; too high (≥20) takes months to spot the obvious "every
 * sprint I assign Tester=Alex" pattern.
 */
export const MEMORY_RULE_CANDIDATE_MIN_OCCURRENCES = 5;
export const MEMORY_RULE_CANDIDATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Auto-prune throttle. On every retain, lwr checks the last-prune
 * marker; if older than this, it kicks off a synchronous prune pass.
 * 24 h keeps the DB from unbounded growth without burning cycles
 * inside hot mutation paths.
 */
export const MEMORY_AUTO_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
