/**
 * SQLite storage layer for the memory module.
 *
 * One file at `~/.lwr/memory/memory.db`. Opened lazily on first call,
 * cached for the lifetime of the process. Tests pass an explicit path
 * via `openMemoryDb(path)` to keep each suite isolated.
 *
 * The schema is intentionally narrow:
 *   - `memory`  — one row per (bankId, kind, metadata-hash). Dedupe lives
 *                 in the id derivation, not in a trigger.
 *   - `meta`    — schema-version row stamped on first init.
 *
 * No vector column yet. Once embeddings are added (Tier 2 of Tier 2)
 * the schema gains a nullable BLOB and a separate ann index file.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database, { type Database as Db } from 'better-sqlite3';
import { MEMORY_SCHEMA } from '../constants';
import { memoryDbPath, memoryDir } from '../foundation/paths';

let cachedDb: Db | null = null;
let cachedPath: string | null = null;

/**
 * Open (or reuse) the SQLite database. The cache is keyed by path so
 * tests with $LWR_CONFIG_DIR overrides don't collide with a process-
 * wide singleton. Callers should NOT close the returned handle; the
 * process exit handler does that.
 */
export function openMemoryDb(explicitPath?: string): Db {
  const target = explicitPath ?? memoryDbPath();
  if (cachedDb && cachedPath === target) return cachedDb;
  if (cachedDb && cachedPath !== target) {
    cachedDb.close();
    cachedDb = null;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const isFreshFile = !fs.existsSync(target);
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Concurrent `lwr` invocations (especially `lwr serve` + a CLI call)
  // can hit the DB at the same time. Without a busy_timeout, the loser
  // gets SQLITE_BUSY immediately; with it, SQLite waits up to 5 s for
  // the lock — invisible to callers under any sane contention.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  if (isFreshFile) {
    // Behaviour data — match preferences.json (0o600). The pragma calls
    // above already created the file with umask defaults; tighten it
    // before any rows land.
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // Best-effort: a non-POSIX filesystem (Windows, some FUSE mounts)
      // may reject chmod. The data is still under $HOME; this isn't a
      // hard failure.
    }
  }
  cachedDb = db;
  cachedPath = target;
  return db;
}

/**
 * Drop the cached handle. Used by tests between suites and by the
 * (future) `lwr memory reset` verb. Safe to call when nothing's open.
 */
export function closeMemoryDb(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
    cachedPath = null;
  }
}

/** Helper used by tests + `memory reset`. Removes the entire DB file. */
export function deleteMemoryDb(explicitPath?: string): void {
  closeMemoryDb();
  const target = explicitPath ?? memoryDbPath();
  if (fs.existsSync(target)) fs.rmSync(target);
  const walPath = `${target}-wal`;
  const shmPath = `${target}-shm`;
  if (fs.existsSync(walPath)) fs.rmSync(walPath);
  if (fs.existsSync(shmPath)) fs.rmSync(shmPath);
  const dir = memoryDir();
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

function initSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      bank_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1,
      superseded_by TEXT NULL,
      superseded_at INTEGER NULL,
      FOREIGN KEY (superseded_by) REFERENCES memory(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_bank_kind
      ON memory(bank_id, kind);
    CREATE INDEX IF NOT EXISTS idx_memory_last_seen
      ON memory(bank_id, last_seen_at DESC);
  `);

  // Forward-migration for any DB created before `superseded_at` existed.
  // `CREATE TABLE IF NOT EXISTS` is a no-op when the table already exists,
  // so the column above is only applied to fresh files. PRAGMA + ALTER
  // brings older files up to schema. Idempotent — safe to run on every open.
  const cols = db.prepare(`PRAGMA table_info(memory)`).all() as { name: string }[];
  if (!cols.some(c => c.name === 'superseded_at')) {
    db.exec(`ALTER TABLE memory ADD COLUMN superseded_at INTEGER NULL`);
  }

  // INSERT OR IGNORE handles the race where two processes both pass the
  // existence check and try to seed the row. The post-insert SELECT then
  // observes whichever value actually landed.
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'schema',
    MEMORY_SCHEMA,
  );
  const stored = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get('schema') as { value: string } | undefined;
  if (stored === undefined) {
    // Should be unreachable — INSERT OR IGNORE either inserts or sees an
    // existing row, and we just SELECT'd the key we just inserted.
    throw new Error('Memory DB schema row missing after INSERT OR IGNORE.');
  }
  if (stored.value !== MEMORY_SCHEMA) {
    throw new Error(
      `Memory DB schema mismatch: found "${stored.value}", expected "${MEMORY_SCHEMA}".`,
    );
  }
}
