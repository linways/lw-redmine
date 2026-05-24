/**
 * `recall()` — query the memory corpus, ranked by recency + frequency.
 *
 * No embeddings, no LLM. Two orthogonal filters do the heavy lifting:
 *
 *   - `kind`           — single-value match (cheap, indexed).
 *   - `metadataFilter` — every key/value pair must appear in the row's
 *                        metadata. Performed in SQLite via JSON1's
 *                        `json_extract` so the filter pushes down.
 *
 * Ranking score:
 *   score = log(1 + seen_count) * recency_decay(last_seen_at)
 *
 * recency_decay is a simple half-life of 30 days. Combined, this favours
 * "user did this 14 times last week" over "user did this once a year ago".
 *
 * For the personalization-suggester use case this is sufficient; if a
 * future caller needs lexical or semantic recall over `content`, that's
 * a separate parameter (and a separate index) we'd add when needed.
 */

import { openMemoryDb } from './storage';
import type { MemoryMetadata, MemoryRow, RecallOptions, RecallResult } from './types';

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LN2 = Math.LN2;

interface Row {
  id: string;
  bank_id: string;
  kind: string;
  content: string;
  metadata: string;
  created_at: number;
  last_seen_at: number;
  seen_count: number;
  superseded_by: string | null;
  superseded_at: number | null;
}

export function recall(options: RecallOptions, dbPath?: string): RecallResult {
  const db = openMemoryDb(dbPath);
  const topK = options.topK ?? 50;

  const clauses: string[] = ['bank_id = ?'];
  const params: (string | number | null)[] = [options.bankId];

  if (options.kind !== undefined) {
    clauses.push('kind = ?');
    params.push(options.kind);
  }

  if (!options.includeSuperseded) {
    clauses.push('superseded_by IS NULL');
  }

  const filter = options.metadataFilter ?? {};
  for (const [key, value] of Object.entries(filter)) {
    // json_extract preserves the native JSON type (number → INTEGER/REAL,
    // string → TEXT). Bind values as their native type so SQLite's type
    // affinity doesn't reject `33 = '33'`. Booleans → 0/1; null gets
    // IS NULL semantics.
    if (value === null) {
      clauses.push('json_extract(metadata, ?) IS NULL');
      params.push(`$.${key}`);
      continue;
    }
    clauses.push('json_extract(metadata, ?) = ?');
    params.push(`$.${key}`, typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }

  const sql = `
    SELECT id, bank_id, kind, content, metadata, created_at,
           last_seen_at, seen_count, superseded_by, superseded_at
    FROM memory
    WHERE ${clauses.join(' AND ')}
  `;
  const raw = db.prepare(sql).all(...params) as Row[];
  const now = Date.now();
  const scored = raw
    .map(r => ({ row: rowToMemory(r), score: scoreRow(r, now) }))
    .sort((a, b) => b.score - a.score);

  return {
    rows: scored.slice(0, topK).map(s => s.row),
    total: raw.length,
  };
}

function scoreRow(row: Row, now: number): number {
  const ageMs = Math.max(0, now - row.last_seen_at);
  const recency = Math.exp(-LN2 * (ageMs / HALF_LIFE_MS));
  const frequency = Math.log(1 + row.seen_count);
  return frequency * recency;
}

function rowToMemory(r: Row): MemoryRow {
  let metadata: MemoryMetadata = {};
  try {
    metadata = JSON.parse(r.metadata) as MemoryMetadata;
  } catch {
    // Corrupt metadata row — leave empty rather than throw. The recall
    // path is read-mostly; one bad row shouldn't poison a result set.
  }
  return {
    id: r.id,
    bankId: r.bank_id,
    kind: r.kind as MemoryRow['kind'],
    content: r.content,
    metadata,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    seenCount: r.seen_count,
    supersededBy: r.superseded_by,
    supersededAt: r.superseded_at,
  };
}
