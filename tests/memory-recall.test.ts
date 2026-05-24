/**
 * `recall()` tests: kind filter, metadata filter, ranking by recency +
 * frequency, topK cap, superseded hiding.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeMemoryDb, deleteMemoryDb, openMemoryDb, recall, retain } from '../src/memory';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-mem-test-'));
  return path.join(dir, 'memory.db');
}

describe('memory/recall', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  afterEach(() => {
    closeMemoryDb();
    try {
      deleteMemoryDb(dbPath);
    } catch {
      // ignore
    }
  });

  it('returns empty result when bank has no rows', () => {
    const r = recall({ bankId: 'sibin' }, dbPath);
    expect(r.rows).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('returns rows scoped to the bankId', () => {
    retain(
      { bankId: 'sibin', kind: 'observation', content: 'A', metadata: { cf: 1 } },
      dbPath,
    );
    retain(
      { bankId: 'other', kind: 'observation', content: 'B', metadata: { cf: 1 } },
      dbPath,
    );
    const r = recall({ bankId: 'sibin' }, dbPath);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].content).toBe('A');
  });

  it('filters by kind', () => {
    retain(
      { bankId: 'sibin', kind: 'observation', content: 'O', metadata: { cf: 1 } },
      dbPath,
    );
    retain(
      { bankId: 'sibin', kind: 'rule-candidate', content: 'R', metadata: { cf: 2 } },
      dbPath,
    );
    const obs = recall({ bankId: 'sibin', kind: 'observation' }, dbPath);
    const cand = recall({ bankId: 'sibin', kind: 'rule-candidate' }, dbPath);
    expect(obs.rows).toHaveLength(1);
    expect(obs.rows[0].content).toBe('O');
    expect(cand.rows).toHaveLength(1);
    expect(cand.rows[0].content).toBe('R');
  });

  it('filters by metadata key/value pairs (all must match)', () => {
    retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: 'Alex on project 33',
        metadata: { cf: 79, value: 'Alex', projectId: 33 },
      },
      dbPath,
    );
    retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: 'Alex on project 44',
        metadata: { cf: 79, value: 'Alex', projectId: 44 },
      },
      dbPath,
    );
    const r = recall(
      { bankId: 'sibin', metadataFilter: { projectId: 33 } },
      dbPath,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].content).toContain('33');
  });

  it('ranks more-frequent rows above less-frequent', () => {
    retain(
      { bankId: 'sibin', kind: 'observation', content: 'rare', metadata: { cf: 1 } },
      dbPath,
    );
    for (let i = 0; i < 5; i++) {
      retain(
        {
          bankId: 'sibin',
          kind: 'observation',
          content: 'common',
          metadata: { cf: 2 },
        },
        dbPath,
      );
    }
    const r = recall({ bankId: 'sibin' }, dbPath);
    expect(r.rows[0].content).toBe('common');
    expect(r.rows[0].seenCount).toBe(5);
  });

  it('caps the result set with topK', () => {
    for (let i = 0; i < 20; i++) {
      retain(
        {
          bankId: 'sibin',
          kind: 'observation',
          content: `row-${i}`,
          metadata: { i },
        },
        dbPath,
      );
    }
    const r = recall({ bankId: 'sibin', topK: 5 }, dbPath);
    expect(r.rows).toHaveLength(5);
    expect(r.total).toBe(20);
  });

  it('hides superseded rows by default and reveals them on opt-in', () => {
    const a = retain(
      { bankId: 'sibin', kind: 'observation', content: 'A', metadata: { cf: 1 } },
      dbPath,
    );
    const b = retain(
      { bankId: 'sibin', kind: 'observation', content: 'B', metadata: { cf: 2 } },
      dbPath,
    );
    const db = openMemoryDb(dbPath);
    db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(b.id, a.id);

    const hidden = recall({ bankId: 'sibin' }, dbPath);
    expect(hidden.rows.map(r => r.content)).toEqual(['B']);

    const shown = recall({ bankId: 'sibin', includeSuperseded: true }, dbPath);
    expect(shown.rows.map(r => r.content).sort()).toEqual(['A', 'B']);
  });
});
