/**
 * Storage-layer tests: schema init, lazy open, isolation per path,
 * schema-version refusal on mismatch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { closeMemoryDb, deleteMemoryDb, openMemoryDb } from '../src/memory';
import { MEMORY_SCHEMA } from '../src/constants';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-mem-test-'));
  return path.join(dir, 'memory.db');
}

describe('memory/storage', () => {
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

  it('creates the schema on first open', () => {
    const db = openMemoryDb(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('memory');
    expect(names).toContain('meta');
  });

  it('stamps the schema version on first init', () => {
    const db = openMemoryDb(dbPath);
    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('schema') as { value: string };
    expect(row.value).toBe(MEMORY_SCHEMA);
  });

  it('reuses the cached handle for the same path', () => {
    const a = openMemoryDb(dbPath);
    const b = openMemoryDb(dbPath);
    expect(a).toBe(b);
  });

  it('opens a fresh handle when the path changes', () => {
    const otherPath = tmpDbPath();
    const a = openMemoryDb(dbPath);
    const b = openMemoryDb(otherPath);
    expect(a).not.toBe(b);
    deleteMemoryDb(otherPath);
  });

  it('refuses to open a DB stamped with a different schema version', () => {
    // Pre-create the DB with the wrong schema string.
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema', 'lwr-memory/v0');
    `);
    seed.close();
    expect(() => openMemoryDb(dbPath)).toThrow(/schema mismatch/i);
  });

  it('deleteMemoryDb removes file + WAL artefacts', () => {
    openMemoryDb(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    deleteMemoryDb(dbPath);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('creates the DB file with 0o600 permissions (POSIX)', () => {
    if (process.platform === 'win32') return;
    openMemoryDb(dbPath);
    const mode = fs.statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
