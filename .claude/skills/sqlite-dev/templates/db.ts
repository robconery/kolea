// Dev connection: bun:sqlite + Drizzle, one Database per process, the
// mandatory pragma block, and startup migration.
//
//   import { db } from './db';
//
// Rule 2: one shared Database instance. Rule 3: pragmas on every open.

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from './schema';

const DB_PATH = process.env.DATABASE_PATH ?? './data/app.db';

const sqlite = new Database(DB_PATH, { create: true });

// Rule 3 — mandatory, in this order, on every connection. `foreign_keys`
// is OFF by default in SQLite: omit it and every onDelete is silently
// inert. Treat a missing line here as a bug.
sqlite.exec('PRAGMA journal_mode = WAL;');
sqlite.exec('PRAGMA foreign_keys = ON;');
sqlite.exec('PRAGMA busy_timeout = 5000;');
sqlite.exec('PRAGMA synchronous = NORMAL;');

export const db = drizzle(sqlite, { schema });

// Apply generated migrations at startup (or run `bunx drizzle-kit migrate`
// in CI instead and delete this).
migrate(db, { migrationsFolder: './drizzle' });

// Single-writer reminder: do not open a second writable Database against
// DB_PATH. Reads are concurrent under WAL; writes serialize regardless.
export { sqlite };
