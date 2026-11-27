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
 * - **A batch is one round trip and one transaction.** `batch()` commits every
 *   statement or none, as D1 documents, and counts as a single trip in
 *   `roundTrips`. Recording a whole send in one write is only worth asserting
 *   against a fake that can tell one trip from a hundred.
 * - **The 100-bound-parameter cap.** A statement binding more than 100 values
 *   throws here as it does on D1, so an unchunked `inArray` fails a spec
 *   instead of production.
 * - **The 5-term compound SELECT cap.** D1 refuses `a union all b union all …`
 *   past five terms (`too many terms in compound SELECT`); stock SQLite allows
 *   500. Modelled by counting compound operators at each nesting level.
 * - **Statements are counted** (`queryCount`), so a spec can hold one
 *   invocation to D1's 1,000-query cap. Every statement counts, batched or not,
 *   which is how D1 charges them. Counting, not refusing: the cap is per Worker
 *   invocation and a spec decides where one begins (`resetQueryCount`).
 *
 * ## What is not modelled
 *
 * Network failure.
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

/** D1's cap on bound parameters per statement. */
export const D1_MAX_PARAMS = 100

/** D1's cap on terms in one compound SELECT (SQLITE_LIMIT_COMPOUND_SELECT). */
export const D1_MAX_COMPOUND_TERMS = 5

/**
 * Throws if any single compound SELECT in `sql` has more than five terms.
 * Counts `union` / `intersect` / `except` per parenthesis level, skipping
 * quoted strings and identifiers, so a subquery's terms are its own.
 */
export function assertCompoundTerms(sql: string): void {
  const stack: number[] = [1]
  let i = 0
  while (i < sql.length) {
    const ch = sql[i] as string
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = sql.indexOf(ch, i + 1)
      i = end === -1 ? sql.length : end + 1
      continue
    }
    if (ch === '(') {
      stack.push(1)
      i++
      continue
    }
    if (ch === ')') {
      if (stack.length > 1) stack.pop()
      i++
      continue
    }
    if (/[a-z]/i.test(ch) && (i === 0 || !/[\w$]/.test(sql[i - 1] as string))) {
      const word = /^[a-z_]\w*/i.exec(sql.slice(i))?.[0] ?? ch
      if (/^(union|intersect|except)$/i.test(word)) {
        const top = stack.length - 1
        stack[top] = (stack[top] as number) + 1
        if ((stack[top] as number) > D1_MAX_COMPOUND_TERMS) {
          throw new Error('D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR')
        }
      }
      i += word.length
      continue
    }
    i++
  }
}

/** What a spec may ask about the traffic to the database. */
interface Traffic {
  /** Trips to the database: one per statement run on its own, one per batch. */
  roundTrips: number
  /** How many of those trips were batches. */
  batches: number
  /** Statements run. D1 counts each one, batched or not, toward its 1,000. */
  queries: number
}

/** One prepared statement, with its bound parameters. Immutable, like D1's. */
class FakeD1PreparedStatement {
  constructor(
    private readonly db: Database,
    private readonly traffic: Traffic,
    private readonly sql: string,
    private readonly params: Bindable[] = [],
  ) {}

  bind(...values: unknown[]): FakeD1PreparedStatement {
    // D1 refuses a statement with more than 100 bound parameters. Modelled,
    // because exceeding it is a production-only 500 that a local SQLite would
    // otherwise run happily (it allows 32,766).
    if (values.length > D1_MAX_PARAMS) {
      throw new Error(`D1_ERROR: too many SQL variables (${values.length} > ${D1_MAX_PARAMS})`)
    }
    return new FakeD1PreparedStatement(this.db, this.traffic, this.sql, values.map(coerce))
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    this.traffic.roundTrips++
    this.traffic.queries++
    const row = this.db.query(this.sql).get(...this.params) as Record<string, unknown> | null
    if (row === null) return null
    return (column === undefined ? row : (row[column] ?? null)) as T
  }

  /**
   * D1 returns `results` for every statement, including writes with RETURNING —
   * which is how Drizzle's `.returning()` gets its rows back.
   */
  async all<T = unknown>(): Promise<{ success: true; results: T[]; meta: Meta }> {
    this.traffic.roundTrips++
    return this.allInBatch<T>()
  }

  /** `all()` without the trip: a batch is charged one trip, by the batch. */
  allInBatch<T = unknown>(): { success: true; results: T[]; meta: Meta } {
    this.traffic.queries++
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
    this.traffic.roundTrips++
    this.traffic.queries++
    const stmt = this.db.query(this.sql)
    const rows = stmt.values(...this.params) as T[]
    if (!options?.columnNames) return rows
    return [stmt.columnNames as unknown as T, ...rows]
  }

  async run<T = unknown>(): Promise<{ success: true; results: T[]; meta: Meta }> {
    // `run` has to cope with RETURNING too: SQLite reports zero changes for a
    // statement whose rows were never stepped through, so read it as a query and
    // fall back to the write path only when there was nothing to read.
    this.traffic.roundTrips++
    this.traffic.queries++
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
 * The binding itself. `batch` runs its statements in order inside one
 * transaction and rolls all of them back if any fails, which is what D1
 * documents for it.
 */
export class FakeD1Database implements Traffic {
  roundTrips = 0
  batches = 0
  queries = 0

  constructor(readonly sqlite: Database) {}

  prepare(sql: string): FakeD1PreparedStatement {
    // D1 refuses a compound SELECT past five terms. Modelled, because local
    // SQLite allows 500 and a page that unions more is a production-only 500.
    assertCompoundTerms(sql)
    return new FakeD1PreparedStatement(this.sqlite, this, sql)
  }

  async batch<T = unknown>(statements: FakeD1PreparedStatement[]) {
    this.roundTrips++
    this.batches++
    const out: { success: true; results: T[]; meta: Meta }[] = []
    this.sqlite.run('BEGIN')
    try {
      for (const statement of statements) out.push(statement.allInBatch<T>())
      this.sqlite.run('COMMIT')
    } catch (err) {
      this.sqlite.run('ROLLBACK')
      throw err
    }
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

/** Statements run against a `freshD1()` since it was made or last reset. */
export function queryCount(d1: D1Database): number {
  return (d1 as unknown as FakeD1Database).queries
}

export function resetQueryCount(d1: D1Database): void {
  ;(d1 as unknown as FakeD1Database).queries = 0
}

/**
 * The same database, refusing its next `times` statements whose SQL matches
 * `pattern` the way an overloaded D1 does. Everything else works. Wrap
 * `env.DB` with it to make one query fail at a chosen moment.
 */
export function refusingQueries(db: D1Database, pattern: RegExp, times = 1): D1Database {
  let left = times
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (text: string) => {
          if (pattern.test(text) && left-- > 0) throw new Error('D1 DB is overloaded. Requests queued for too long.')
          return target.prepare(text)
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
