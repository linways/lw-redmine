/**
 * Memory pruning — keep the SQLite store bounded.
 *
 * Policy (intentionally simple — every knob lives in `constants/memory.ts`):
 *   - `kind: 'observation'` older than MEMORY_RETENTION_MS gets DELETEd.
 *   - `kind: 'fact'` and `kind: 'rule-candidate'` are kept forever.
 *     They're high-signal, low-volume rows; pruning them is opt-in via
 *     a future flag, not on the default path.
 *
 * Triggered two ways:
 *   - Explicit:   `lwr memory prune` (CLI command, Phase 7).
 *   - Automatic:  `maybeAutoPrune()` is called from `retain()`. It uses
 *                 a row in the `meta` table to throttle to one real
 *                 prune per MEMORY_AUTO_PRUNE_INTERVAL_MS (24 h default).
 *                 An in-process guard skips the meta read on hot paths.
 */

import { openMemoryDb } from './storage';
import {
  MEMORY_RETENTION_MS,
  MEMORY_AUTO_PRUNE_INTERVAL_MS,
} from '../constants';

const META_KEY_LAST_PRUNE = 'last_prune_at';
const IN_PROCESS_THROTTLE_MS = 60_000; // 1 min between meta checks per process

let lastInProcessCheckAt: number | null = null;

export interface PruneResult {
  deleted: number;
  lastPruneAt: number;
}

/**
 * Delete every `observation` row whose `last_seen_at` is older than
 * MEMORY_RETENTION_MS, then stamp the `last_prune_at` meta marker.
 * Returns the count for the CLI / status output.
 */
export function pruneOldObservations(dbPath?: string): PruneResult {
  const db = openMemoryDb(dbPath);
  const cutoff = Date.now() - MEMORY_RETENTION_MS;
  const result = db
    .prepare(
      `DELETE FROM memory
       WHERE kind = 'observation' AND last_seen_at < ?`,
    )
    .run(cutoff);
  const lastPruneAt = Date.now();
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(META_KEY_LAST_PRUNE, String(lastPruneAt));
  return { deleted: result.changes, lastPruneAt };
}

/**
 * Opportunistic prune. Called from `retain()` so the DB stays bounded
 * without anyone needing to run a cron job. Throttled two ways:
 *   1. In-process: at most one meta-table read per minute.
 *   2. Cross-process: prune itself only runs once per
 *      MEMORY_AUTO_PRUNE_INTERVAL_MS.
 *
 * Best-effort — failures are silently swallowed so a corrupt meta row
 * can never break a retain. The next user-facing `lwr memory prune`
 * surfaces any real problem.
 */
export function maybeAutoPrune(dbPath?: string): void {
  const now = Date.now();
  if (
    lastInProcessCheckAt !== null &&
    now - lastInProcessCheckAt < IN_PROCESS_THROTTLE_MS
  ) {
    return;
  }
  lastInProcessCheckAt = now;

  try {
    const db = openMemoryDb(dbPath);
    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(META_KEY_LAST_PRUNE) as { value: string } | undefined;
    const lastPruneAt = row ? Number.parseInt(row.value, 10) : 0;
    if (now - lastPruneAt < MEMORY_AUTO_PRUNE_INTERVAL_MS) return;
    pruneOldObservations(dbPath);
  } catch {
    // Best-effort.
  }
}

/** Read the last-prune timestamp for `lwr memory status` (Phase 7). */
export function readLastPruneAt(dbPath?: string): number | null {
  try {
    const db = openMemoryDb(dbPath);
    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(META_KEY_LAST_PRUNE) as { value: string } | undefined;
    return row ? Number.parseInt(row.value, 10) : null;
  } catch {
    return null;
  }
}

/** Test helper: clear in-process throttle between tests. */
export function _resetAutoPruneThrottle(): void {
  lastInProcessCheckAt = null;
}
