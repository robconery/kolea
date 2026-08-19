import { defineConfig } from 'drizzle-kit'

// Dialect is `sqlite` because D1 *is* SQLite. Porting to Postgres later is a
// change to this line plus the column-type imports in schema.ts — not a redesign.
export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/db/schema.ts',
  out: './migrations',
  verbose: true,
  strict: true,
})
