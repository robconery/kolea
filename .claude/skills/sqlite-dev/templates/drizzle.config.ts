// drizzle-kit config for the SQLite dev dialect.
//
//   bunx drizzle-kit generate   # diff schema.ts -> a migration in ./drizzle
//   bunx drizzle-kit migrate    # apply (or migrate() at startup, see db.ts)
//
// Postgres cutover (references/portability.md): change `dialect` to
// 'postgresql', point `dbCredentials` at the Postgres URL, swap the
// drizzle driver in db.ts, and adjust the column builders in schema.ts.
// The column NAMES are already Postgres-legal, so this is mechanical.

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/app.db',
  },
  strict: true,
  verbose: true,
});

// Reminder: drizzle-kit does NOT emit `STRICT` on CREATE TABLE. After
// `generate`, edit the new migration so each table ends `) STRICT;`
// (references/types.md) — this is what makes SQLite reject wrong types
// like Postgres will.
