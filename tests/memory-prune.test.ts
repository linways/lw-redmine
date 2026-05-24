/**
 * Pruning policy tests.
 *   - `observation` rows older than MEMORY_RETENTION_MS get deleted.
 *   - `fact` and `rule-candidate` rows are kept regardless of age.
 *   - The last-prune marker survives across handles.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeMemoryDb,
  openMemoryDb,
  pruneOldObservations,
  readLastPruneAt,
  recall,
  retain,
} from '../src/memory';
import { MEMORY_RETENTION_MS } from '../src/constants';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-prune-test-'));
  return path.join(dir, 'memory.db');
}

describe('memory/prune', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  afterEach(() => {
    closeMemoryDb();
  });

  it('pruneOldObservations deletes only stale observation rows', () => {
    // Seed: one recent obs, one stale obs, one stale fact, one stale candidate.
    retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: 'recent',
        metadata: { cmd: 'issue.edit', cf_id: 1 },
      },
      dbPath,
    );
    retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: 'stale',
        metadata: { cmd: 'issue.edit', cf_id: 2 },
      },
      dbPath,
    );
    retain(
      {
        bankId: 'sibin',
        kind: 'fact',
        content: 'stale fact',
        metadata: { rule_id: 'r1', primary_set_cf: 88 },
      },
      dbPath,
    );
    retain(
      {
        bankId: 'sibin',
        kind: 'rule-candidate',
        content: 'stale candidate',
        metadata: { cf_id: 88, value: 'Maya' },
      },
      dbPath,
    );

    // Manually age the stale rows past the retention cutoff.
    const db = openMemoryDb(dbPath);
    const ancient = Date.now() - MEMORY_RETENTION_MS - 1000;
    db.prepare(
      `UPDATE memory SET last_seen_at = ? WHERE content IN ('stale', 'stale fact', 'stale candidate')`,
    ).run(ancient);

    const result = pruneOldObservations(dbPath);
    expect(result.deleted).toBe(1); // only the stale OBSERVATION
    expect(typeof result.lastPruneAt).toBe('number');

    const remaining = recall({ bankId: 'sibin', topK: 10 }, dbPath);
    const contents = remaining.rows.map(r => r.content).sort();
    expect(contents).toEqual(['recent', 'stale candidate', 'stale fact']);
  });

  it('readLastPruneAt is null before any prune and a number after', () => {
    expect(readLastPruneAt(dbPath)).toBeNull();
    retain(
      { bankId: 'sibin', kind: 'observation', content: 'x', metadata: { a: 1 } },
      dbPath,
    );
    pruneOldObservations(dbPath);
    expect(typeof readLastPruneAt(dbPath)).toBe('number');
  });
});
