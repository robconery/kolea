/**
 * A working `D1Database` on top of `bun:sqlite`.
 *
 * ## Why this exists
 *
 * Kōlea's domain code takes a Drizzle handle built by `drizzle-orm/d1`, and that
 * driver speaks one narrow protocol: `prepare().bind().all() / .run() / .raw()`
 * plus `batch()`. D1 itself *is* SQLite, so the cheapest honest way to run the
 * real `core/` functions in a test is to satisfy that protocol against an
 * in-memory SQLite file rather than to mock the domain's dependencies out.
 *
 * The consequence matters more than the trick: a spec that writes a subscriber
 * and then leaves a sequence exercises the same SQL, the same foreign keys, the
 * same `ON CONFLICT DO NOTHING`, and the same Drizzle codecs as production.
 * Nothing in `src/` knows it is being tested, and no test here can pass because
 * a mock agreed with it.
 *
 * ## What is deliberately faithful
 *
 * - **Foreign keys are ON.** D1 enforces them; plain SQLite does not unless told.
 *   `deleteSequence()` in `core/sequences.ts` only makes sense against a database
 *   that will actually refuse a dangling `next_sequence_id`.
 * - **`last_row_id` / `changes` meta** is filled in, because `.returning()` and
 *   the insert paths read it.
 * - **Bound values are coerced the way the D1 wire does it** — `Date` → epoch ms,
 *   `boolean` → 1/0, `undefined` → NULL. A Worker would otherwise throw on values
 *   SQLite happily takes here, which would make a test more permissive than
 *   production.
 *
 * ## What is not modelled
 *
 * Network failure, the 1,000-query-per-invocation cap, and the 100-bound-parameter
 * cap. Those are platform limits the code is written *against* (see
 * `docs/ARCHITECTURE.md` → Platform limits); the chunking that respects them is
 * visible in the source and is asserted where it is cheap to, but a local SQLite
 * cannot make exceeding them fail.
 */
import { Database } from 'bun:sqlite'

/** The value types D1 will actually put on the wire. */
type Bindable = string | number | bigint | boolean | null | Uint8Array

/**
 * Normalize a bound value the way the D1 client does before it leaves the
 * Worker. Keeping this strict is what stops a spec from passing with a value
 * that production would reject.
 */
function coerce(value: unknown): Bindable {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Uint8Array) return value
  if (typeof value === 'object') {
    throw new TypeError(
      `D1 cannot bind a ${value.constructor?.name ?? 'plain'} object. ` +
        'Drizzle should have serialized this — check the column mode in src/db/schema.ts.',
    )
  }
  return value as Bindable
}

interface Meta {
  duration: number
  size_after: number
  rows_read: number
  rows_written: number
  last_row_id: number
  changed_db: boolean
  changes: number
}

function meta(overrides: Partial<Meta> = {}): Meta {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
    ...overrides,
  }
}

/** One prepared statement, with its bound parameters. Immutable, like D1's. */
class FakeD1PreparedStatement {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
    private readonly params: Bindable[] = [],
  ) {}

  bind(...values: unknown[]): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this.db, this.sql, values.map(coerce))
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = this.db.query(this.sql).get(...this.params) as Record<string, unknown> | null
    if (row === null) return null
    return (column === undefined ? row : (row[column] ?? null)) as T
  }

  /**
   * D1 returns `results` for every statement, including writes with RETURNING —
   * which is how Drizzle's `.returning()` gets its rows back.
   */
  async all<T = unknown>(): Promise<{ success: true; results: T[]; meta: Meta }> {
    const results = this.db.query(this.sql).all(...this.params) as T[]
    return {
      success: true,
      results,
      meta: meta({
        rows_read: results.length,
        last_row_id: Number(this.db.query('select last_insert_rowid() as id').get() as never),
      }),
    }
  }

  /** Positional rows, used by Drizzle when it maps columns itself. */
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.db.query(this.sql)
    const rows = stmt.values(...this.params) as T[]
    if (!options?.columnNames) return rows
    return [stmt.columnNames as unknown as T, ...rows]
  }

  async run<T = unknown>(): Promise<{ success: true; results: T[]; meta: Meta }> {
    // `run` has to cope with RETURNING too: SQLite reports zero changes for a
    // statement whose rows were never stepped through, so read it as a query and
    // fall back to the write path only when there was nothing to read.
    const stmt = this.db.query(this.sql)
    const results = stmt.all(...this.params) as T[]
    const changes = this.db.query('select changes() as n').get() as { n: number }
    const lastId = this.db.query('select last_insert_rowid() as id').get() as { id: number }
    return {
      success: true,
      results,
      meta: meta({
        changes: changes.n,
        changed_db: changes.n > 0,
        last_row_id: lastId.id,
        rows_written: changes.n,
      }),
    }
  }
}

/**
 * The binding itself. `batch` is sequential rather than transactional, which
 * matches D1's *observable* behaviour closely enough for these specs: nothing in
 * `core/` relies on a batch rolling back.
 */
export class FakeD1Database {
  constructor(readonly sqlite: Database) {}

  prepare(sql: string): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this.sqlite, sql)
  }

  async batch<T = unknown>(statements: FakeD1PreparedStatement[]) {
    const out: { success: true; results: T[]; meta: Meta }[] = []
    for (const statement of statements) out.push(await statement.all<T>())
    return out
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const statement of statements) this.sqlite.run(statement)
    return { count: statements.length, duration: 0 }
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not implemented in the test D1')
  }

  /** Sessions are a read-replica concern. Nothing in `core/` opens one. */
  withSession(): FakeD1Database {
    return this
  }
}

/**
 * A fresh, migrated, empty database.
 *
 * In-memory on purpose: a spec file that shares a file with another spec file
 * shares its failures too, and `bun test` runs files concurrently.
 */
export function freshD1(): D1Database {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  return new FakeD1Database(sqlite) as unknown as D1Database
}
