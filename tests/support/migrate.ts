/**
 * Apply the real migrations to a test database.
 *
 * Not `drizzle-kit push`, and not a hand-written CREATE TABLE script: the specs
 * run against the exact DDL that production ran, in the exact order, so a
 * migration that is wrong is wrong here too. `src/db/schema.ts` is the truth
 * about intent (CLAUDE.md); `migrations/` is the truth about what the database
 * actually looks like, and that is what a test needs to sit on.
 *
 * Drizzle separates statements with `--> statement-breakpoint`, which is exactly
 * how `wrangler d1 migrations apply` splits them too.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(import.meta.dir, '../../migrations')

/** Read once per process; every spec file pays the disk cost at most one time. */
let cachedStatements: string[] | null = null

function statements(): string[] {
  if (cachedStatements) return cachedStatements

  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  if (files.length === 0) throw new Error(`No migrations found in ${MIGRATIONS}`)

  cachedStatements = files.flatMap((file) =>
    readFileSync(join(MIGRATIONS, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  return cachedStatements
}

export function migrate(d1: D1Database): void {
  // Reach past the D1 surface deliberately: `exec()` splits on semicolons, and a
  // DDL statement containing one inside a string literal or a CHECK constraint
  // would be cut in half by it.
  const sqlite = (d1 as unknown as { sqlite: import('bun:sqlite').Database }).sqlite
  for (const statement of statements()) {
    try {
      sqlite.run(statement)
    } catch (err) {
      throw new Error(`Migration statement failed:\n${statement}\n\n${String(err)}`)
    }
  }
}
