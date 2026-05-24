/**
 * Memory status — read-only diagnostics for `lwr memory status`.
 *
 * Single pass over the DB: counts per kind, file size, oldest / newest
 * timestamps, last-prune marker. No mutations.
 */

import fs from 'node:fs';
import { openMemoryDb } from './storage';
import { readLastPruneAt } from './prune';
import { memoryDbPath } from '../foundation/paths';
import { MEMORY_KINDS, type MemoryKind } from '../constants';

export interface MemoryStatus {
  /** Where the SQLite DB lives. */
  path: string;
  /** Whether the file exists yet (false on a clean install). */
  exists: boolean;
  /** Size on disk in bytes. 0 when absent. */
  sizeBytes: number;
  /** Total rows across all kinds. */
  totalRows: number;
  /** Row counts per memory kind. */
  rowsByKind: Record<MemoryKind, number>;
  /** ISO of the oldest `created_at`, or null when empty. */
  oldestAt: string | null;
  /** ISO of the newest `last_seen_at`, or null when empty. */
  newestAt: string | null;
  /** ISO of the last auto-prune or `lwr memory prune` run, or null. */
  lastPruneAt: string | null;
}

export function getMemoryStatus(dbPath?: string): MemoryStatus {
  const target = dbPath ?? memoryDbPath();
  if (!fs.existsSync(target)) {
    return {
      path: target,
      exists: false,
      sizeBytes: 0,
      totalRows: 0,
      rowsByKind: Object.fromEntries(MEMORY_KINDS.map(k => [k, 0])) as Record<
        MemoryKind,
        number
      >,
      oldestAt: null,
      newestAt: null,
      lastPruneAt: null,
    };
  }

  const db = openMemoryDb(target);
  const sizeBytes = fs.statSync(target).size;

  const rowsByKind = Object.fromEntries(MEMORY_KINDS.map(k => [k, 0])) as Record<
    MemoryKind,
    number
  >;
  const kindRows = db
    .prepare('SELECT kind, COUNT(*) AS n FROM memory GROUP BY kind')
    .all() as { kind: string; n: number }[];
  let totalRows = 0;
  for (const r of kindRows) {
    if ((MEMORY_KINDS as readonly string[]).includes(r.kind)) {
      rowsByKind[r.kind as MemoryKind] = r.n;
    }
    totalRows += r.n;
  }

  const extremes = db
    .prepare(
      'SELECT MIN(created_at) AS oldest, MAX(last_seen_at) AS newest FROM memory',
    )
    .get() as { oldest: number | null; newest: number | null };

  const lastPruneAt = readLastPruneAt(target);

  return {
    path: target,
    exists: true,
    sizeBytes,
    totalRows,
    rowsByKind,
    oldestAt: extremes.oldest !== null ? new Date(extremes.oldest).toISOString() : null,
    newestAt: extremes.newest !== null ? new Date(extremes.newest).toISOString() : null,
    lastPruneAt: lastPruneAt !== null ? new Date(lastPruneAt).toISOString() : null,
  };
}
