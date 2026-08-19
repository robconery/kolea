// Production connection — ONLY if references/production.md says SQLite is
// an appropriate production database for this workload (single node,
// read-heavy / modest short writes, durable local disk). Otherwise
// production is Postgres: see references/portability.md.

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

const DB_PATH = process.env.DATABASE_PATH ?? '/data/app.db'; // a real persistent volume

const sqlite = new Database(DB_PATH, { create: true });

// Rule 3 pragmas + server tuning. synchronous=NORMAL under WAL loses no
// committed txn on app crash; only a possible last-commit loss on OS/power
// loss without working fsync. Switch to FULL (and comment why) if that is
// unacceptable for this data.
for (const p of [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA busy_timeout = 5000;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA wal_autocheckpoint = 1000;',
  'PRAGMA cache_size = -65536;',   // ~64 MB
  'PRAGMA mmap_size = 268435456;', // 256 MB
  'PRAGMA temp_store = MEMORY;',
]) {
  sqlite.exec(p);
}

export const db = drizzle(sqlite, { schema });

// Single-writer discipline (production.md): wrap every write path in an
// IMMEDIATE transaction so lock contention fails fast and cleanly instead
// of mid-transaction. Keep the callback tiny — do I/O and CPU work BEFORE
// calling this, only writes inside.
export function writeTx<T>(fn: (tx: typeof db) => T): T {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn(db);
    sqlite.exec('COMMIT;');
    return result;
  } catch (err) {
    sqlite.exec('ROLLBACK;');
    throw err;
  }
}

// Consistent, non-blocking snapshot backup. Schedule this AND use
// Litestream (continuous WAL replication) for real durability — a single
// file is a single point of failure, and `cp` of a live DB is not a
// backup. Test restores.
export function backupTo(path: string): void {
  sqlite.exec(`VACUUM INTO '${path.replace(/'/g, "''")}';`);
}

export { sqlite };
