/**
 * `retain()` — insert-or-bump a memory row.
 *
 * Identity is derived from `(bankId, kind, metadata)`. Two retain calls
 * describing the same observation converge to the same id, so the row
 * gets `seen_count + 1` and `last_seen_at` refreshed instead of
 * accumulating duplicates. The latest writer's `content` wins on a bump
 * (cheapest sensible rule — content is meant to be a human-readable
 * label, not load-bearing data).
 *
 * Metadata is what the recall path filters on, so it MUST contain the
 * structured signal the caller cares about (e.g., `{cf: 79, value: "Alex Biju"}`).
 */

import crypto from 'node:crypto';
import { openMemoryDb } from './storage';
import { maybeAutoPrune } from './prune';
import type { MemoryMetadata, RetainInput, RetainResult } from './types';

/**
 * Deterministic id: `sha256(bankId | kind | canonical(metadata))[:16]`.
 * Uses '|' as a separator so a bankId containing whitespace can't
 * collide with a different (bankId, kind) pair.
 */
export function deriveMemoryId(
  bankId: string,
  kind: string,
  metadata: MemoryMetadata,
): string {
  const canonical = canonicalize(metadata);
  const hash = crypto.createHash('sha256');
  hash.update(bankId);
  hash.update('|');
  hash.update(kind);
  hash.update('|');
  hash.update(canonical);
  return hash.digest('hex').slice(0, 16);
}

/** Stable JSON: keys sorted, no incidental whitespace. */
function canonicalize(metadata: MemoryMetadata): string {
  const keys = Object.keys(metadata).sort();
  const obj: Record<string, MemoryMetadata[string]> = {};
  for (const k of keys) obj[k] = metadata[k];
  return JSON.stringify(obj);
}

export function retain(input: RetainInput, dbPath?: string): RetainResult {
  const db = openMemoryDb(dbPath);
  const metadata = input.metadata ?? {};
  const id = deriveMemoryId(input.bankId, input.kind, metadata);
  const now = Date.now();

  const existing = db
    .prepare('SELECT seen_count FROM memory WHERE id = ?')
    .get(id) as { seen_count: number } | undefined;

  let inserted: boolean;
  let seenCount: number;
  if (existing) {
    db.prepare(
      `UPDATE memory
       SET content = ?, last_seen_at = ?, seen_count = seen_count + 1
       WHERE id = ?`,
    ).run(input.content, now, id);
    inserted = false;
    seenCount = existing.seen_count + 1;
  } else {
    db.prepare(
      `INSERT INTO memory
         (id, bank_id, kind, content, metadata, created_at, last_seen_at, seen_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      id,
      input.bankId,
      input.kind,
      input.content,
      JSON.stringify(metadata),
      now,
      now,
    );
    inserted = true;
    seenCount = 1;
  }

  const supersededIds = input.supersedeWhere
    ? supersedePriorRows(db, input.bankId, input.kind, input.supersedeWhere, id, now)
    : [];

  // Opportunistic prune. Throttled to once per 24h cross-process and
  // once per minute in-process, so the hot path stays a no-op.
  maybeAutoPrune(dbPath);

  return { id, inserted, seenCount, supersededIds };
}

/**
 * Mark every prior active row matching the supersession filter as
 * superseded by `newId`. Returns the ids that were updated.
 *
 * "Prior active" = same bankId + kind, different id, currently not
 * superseded, with `metadata` containing all of `filter`'s key/value
 * pairs (json_extract push-down — same shape as the recall filter).
 */
function supersedePriorRows(
  db: ReturnType<typeof openMemoryDb>,
  bankId: string,
  kind: string,
  filter: Record<string, string | number | boolean | null>,
  newId: string,
  now: number,
): string[] {
  const clauses: string[] = [
    'bank_id = ?',
    'kind = ?',
    'id != ?',
    'superseded_by IS NULL',
  ];
  const params: (string | number | null)[] = [bankId, kind, newId];

  for (const [key, value] of Object.entries(filter)) {
    if (value === null) {
      clauses.push('json_extract(metadata, ?) IS NULL');
      params.push(`$.${key}`);
      continue;
    }
    clauses.push('json_extract(metadata, ?) = ?');
    params.push(`$.${key}`, typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }

  const selectSql = `SELECT id FROM memory WHERE ${clauses.join(' AND ')}`;
  const priorIds = (db.prepare(selectSql).all(...params) as { id: string }[]).map(
    r => r.id,
  );
  if (priorIds.length === 0) return [];

  const updateSql = `
    UPDATE memory
    SET superseded_by = ?, superseded_at = ?
    WHERE id IN (${priorIds.map(() => '?').join(',')})
  `;
  db.prepare(updateSql).run(newId, now, ...priorIds);
  return priorIds;
}
