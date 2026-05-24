/**
 * Manual demo of the src/memory/ retain/recall library.
 *
 * Run: `npx tsx scripts/memory-smoke.ts`
 * Cleans up its own temp DB; touches nothing in ~/.lwr/memory/.
 *
 * Not part of the test suite (vitest covers the same surface deterministically).
 * This exists so a reviewer can see the library exercised end-to-end against
 * a realistic Linways-shaped data flow in one command.
 *
 * Models the canonical flow this library was built for: a developer keeps
 * setting Tester=Alex Biju on Development Completed transitions, the memory
 * bank accumulates the pattern, and the future `lwr suggest` consumer
 * proposes the corresponding preferences rule.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  retain,
  recall,
  deriveMemoryId,
  closeMemoryDb,
  deleteMemoryDb,
} from '../src/memory';

const dbPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-memory-smoke-')),
  'memory.db',
);

function header(label: string): void {
  console.log(`\n=== ${label} ===`);
}

function showRows(label: string, rows: ReturnType<typeof recall>['rows']): void {
  console.log(`\n${label}:`);
  for (const r of rows) {
    console.log(
      `  · seen=${r.seenCount}  kind=${r.kind}  meta=${JSON.stringify(r.metadata)}`,
    );
    console.log(`    "${r.content}"`);
  }
}

try {
  // ─── 1. Deterministic id ────────────────────────────────────────────────
  header('1. deriveMemoryId is deterministic');
  const id1 = deriveMemoryId('sibin', 'observation', { cf: 80, value: 256 });
  const id2 = deriveMemoryId('sibin', 'observation', { value: 256, cf: 80 });
  console.log(`  id (key order A): ${id1}`);
  console.log(`  id (key order B): ${id2}`);
  console.log(`  equal? ${id1 === id2}`);

  // ─── 2. Retain → dedupe → seen_count bump ───────────────────────────────
  header('2. Retain bumps seen_count on duplicate metadata');
  for (let i = 0; i < 5; i++) {
    const r = retain(
      {
        bankId: 'sibin',
        kind: 'observation',
        content: `Set Tester=Alex Biju on Development Completed (run #${i + 1})`,
        metadata: {
          cf: 80,
          value: 256,
          triggerCf: 79,
          triggerValue: 256,
          transitionTo: 'Development Completed',
          projectId: 33,
        },
      },
      dbPath,
    );
    console.log(
      `  retain #${i + 1} → id=${r.id}  inserted=${r.inserted}  seenCount=${r.seenCount}`,
    );
  }

  // ─── 3. Different metadata → separate row ───────────────────────────────
  header('3. Different metadata produces a distinct row');
  const bob = retain(
    {
      bankId: 'sibin',
      kind: 'observation',
      content: 'Set Tester=Bob Singh once',
      metadata: {
        cf: 80,
        value: 999,
        triggerCf: 79,
        triggerValue: 256,
        transitionTo: 'Development Completed',
        projectId: 33,
      },
    },
    dbPath,
  );
  console.log(`  retain Bob → id=${bob.id}  inserted=${bob.inserted}  seenCount=${bob.seenCount}`);

  // ─── 4. Cross-bank isolation ────────────────────────────────────────────
  header('4. Cross-bank isolation');
  retain(
    {
      bankId: 'other-user',
      kind: 'observation',
      content: 'Different user, same metadata',
      metadata: { cf: 80, value: 256, triggerCf: 79, triggerValue: 256 },
    },
    dbPath,
  );
  const sibinAll = recall({ bankId: 'sibin' }, dbPath);
  const otherAll = recall({ bankId: 'other-user' }, dbPath);
  console.log(`  bank=sibin       → ${sibinAll.total} rows`);
  console.log(`  bank=other-user  → ${otherAll.total} rows`);

  // ─── 5. Recall with metadata filter ─────────────────────────────────────
  header('5. recall() ranks by frequency × recency');
  const ranked = recall(
    { bankId: 'sibin', kind: 'observation', metadataFilter: { cf: 80 } },
    dbPath,
  );
  showRows('rows for cf=80 (ranked)', ranked.rows);

  // ─── 6. Recall with structured filter ───────────────────────────────────
  header('6. metadataFilter pushes into SQLite (json_extract)');
  const aliceOnly = recall(
    { bankId: 'sibin', metadataFilter: { cf: 80, value: 256 } },
    dbPath,
  );
  showRows('rows matching cf=80 AND value=256', aliceOnly.rows);

  // ─── 7. What a future suggester would see ───────────────────────────────
  header('7. Suggester preview — high-confidence pattern surfacing');
  const candidates = ranked.rows
    .filter(r => r.seenCount >= 3)
    .map(r => ({
      when: { cf: r.metadata.triggerCf, equals: r.metadata.triggerValue },
      set: { cf: r.metadata.cf, value: r.metadata.value },
      fires: r.seenCount,
    }));
  console.log(`  ${candidates.length} candidate rule(s):`);
  for (const c of candidates) {
    console.log(
      `    when cf_${c.when.cf}=${c.when.equals}  →  set cf_${c.set.cf}=${c.set.value}  (seen ${c.fires}×)`,
    );
  }
} finally {
  closeMemoryDb();
  deleteMemoryDb(dbPath);
  fs.rmdirSync(path.dirname(dbPath));
  console.log('\n(cleaned up temp DB)');
}
