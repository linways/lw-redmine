/**
 * `retain()` tests: deterministic id derivation, dedupe-by-metadata,
 * seen_count bumping, content-on-bump overwrite.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeMemoryDb,
  deleteMemoryDb,
  deriveMemoryId,
  openMemoryDb,
  retain,
} from '../src/memory';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-mem-test-'));
  return path.join(dir, 'memory.db');
}

describe('memory/retain', () => {
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

  it('inserts a fresh row on first retain', () => {
    const result = retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: 'Set Tester=Alex Biju on cf 79=ABC',
        metadata: { cf: 79, value: 'Alex Biju' },
      },
      dbPath,
    );
    expect(result.inserted).toBe(true);
    expect(result.seenCount).toBe(1);

    const db = openMemoryDb(dbPath);
    const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(result.id) as {
      bank_id: string;
      kind: string;
      content: string;
      seen_count: number;
    };
    expect(row.bank_id).toBe('sibin');
    expect(row.kind).toBe('observation');
    expect(row.seen_count).toBe(1);
  });

  it('bumps seen_count on a duplicate retain (same metadata)', () => {
    const input = {
      bankId: 'sibin',
      kind: 'observation' as const,
      content: 'Set Tester=Alex Biju',
      metadata: { cf: 79, value: 'Alex Biju' },
    };
    const first = retain(input, dbPath);
    const second = retain(input, dbPath);
    const third = retain(input, dbPath);

    expect(first.id).toBe(second.id);
    expect(second.id).toBe(third.id);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(third.inserted).toBe(false);
    expect(third.seenCount).toBe(3);
  });

  it('overwrites content on bump (latest-writer-wins)', () => {
    const base = {
      bankId: 'sibin',
      kind: 'observation' as const,
      metadata: { cf: 79, value: 'Alex Biju' },
    };
    const a = retain({ ...base, content: 'old phrasing' }, dbPath);
    const b = retain({ ...base, content: 'new phrasing' }, dbPath);
    expect(a.id).toBe(b.id);

    const db = openMemoryDb(dbPath);
    const row = db.prepare('SELECT content FROM memory WHERE id = ?').get(b.id) as {
      content: string;
    };
    expect(row.content).toBe('new phrasing');
  });

  it('treats metadata-order independently (canonical hashing)', () => {
    const a = retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: 'x',
        metadata: { cf: 79, value: 'Alex Biju' },
      },
      dbPath,
    );
    const b = retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: 'x',
        metadata: { value: 'Alex Biju', cf: 79 },
      },
      dbPath,
    );
    expect(a.id).toBe(b.id);
    expect(b.inserted).toBe(false);
  });

  it('distinguishes different metadata values as separate rows', () => {
    const a = retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: 'Tester=Alex',
        metadata: { cf: 79, value: 'Alex Biju' },
      },
      dbPath,
    );
    const b = retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: 'Tester=Bob',
        metadata: { cf: 79, value: 'Bob Singh' },
      },
      dbPath,
    );
    expect(a.id).not.toBe(b.id);
  });

  it('distinguishes different bankIds as separate rows', () => {
    const a = retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: 'x',
        metadata: { cf: 79, value: 'Alex' },
      },
      dbPath,
    );
    const b = retain(
      {
        bankId: 'other-user',
        kind: 'observation',
        content: 'x',
        metadata: { cf: 79, value: 'Alex' },
      },
      dbPath,
    );
    expect(a.id).not.toBe(b.id);
  });

  it('deriveMemoryId is pure and stable', () => {
    const id1 = deriveMemoryId('sibin', 'observation', { cf: 79, value: 'Alex' });
    const id2 = deriveMemoryId('sibin', 'observation', { value: 'Alex', cf: 79 });
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('supersedeWhere marks prior matching rows as superseded', () => {
    // Day 1: Tester is Alex Biju
    const day1 = retain(
      {
        bankId: 'sibin',
        kind: 'fact',
        content: 'Tester=Alex Biju',
        metadata: { cf_id: 79, value_id: 101, value_name: 'Alex Biju' },
      },
      dbPath,
    );
    expect(day1.supersededIds).toEqual([]);

    // Day 5: Tester becomes Maya — supersede any prior fact for cf_id=79
    const day5 = retain(
      {
        bankId: 'sibin',
        kind: 'fact',
        content: 'Tester=Maya',
        metadata: { cf_id: 79, value_id: 202, value_name: 'Maya' },
        supersedeWhere: { cf_id: 79 },
      },
      dbPath,
    );
    expect(day5.supersededIds).toEqual([day1.id]);

    // The new row itself is NOT marked superseded.
    const db = openMemoryDb(dbPath);
    const newRow = db
      .prepare('SELECT superseded_by, superseded_at FROM memory WHERE id = ?')
      .get(day5.id) as { superseded_by: string | null; superseded_at: number | null };
    expect(newRow.superseded_by).toBeNull();
    expect(newRow.superseded_at).toBeNull();

    // The old row is marked, with both columns set.
    const oldRow = db
      .prepare('SELECT superseded_by, superseded_at FROM memory WHERE id = ?')
      .get(day1.id) as { superseded_by: string | null; superseded_at: number | null };
    expect(oldRow.superseded_by).toBe(day5.id);
    expect(typeof oldRow.superseded_at).toBe('number');
  });

  it('supersedeWhere is a no-op when no matching rows exist', () => {
    const result = retain(
      {
        bankId: 'sibin',
        kind: 'fact',
        content: 'first time',
        metadata: { cf_id: 79, value_name: 'Maya' },
        supersedeWhere: { cf_id: 79 },
      },
      dbPath,
    );
    expect(result.inserted).toBe(true);
    expect(result.supersededIds).toEqual([]);
  });

  it('supersedeWhere ignores rows in a different bank or kind', () => {
    // Same metadata, different bank — should NOT be superseded.
    retain(
      {
        bankId: 'other-user',
        kind: 'fact',
        content: 'their tester',
        metadata: { cf_id: 79, value_name: 'Someone' },
      },
      dbPath,
    );
    // Same metadata, different kind — should NOT be superseded either.
    retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: 'event row',
        metadata: { cf_id: 79, value_name: 'Past' },
      },
      dbPath,
    );

    const newFact = retain(
      {
        bankId: 'sibin',
        kind: 'fact',
        content: 'Tester=Maya',
        metadata: { cf_id: 79, value_name: 'Maya' },
        supersedeWhere: { cf_id: 79 },
      },
      dbPath,
    );
    expect(newFact.supersededIds).toEqual([]);
  });
});
