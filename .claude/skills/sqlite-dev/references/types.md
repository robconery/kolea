# Type Vocabulary — SQLite → Postgres

SQLite has four storage classes (`INTEGER`, `TEXT`, `REAL`, `BLOB`) and
lies about everything else via affinity. The job here is to pick, for each
*conceptual* type, the one SQLite representation that maps cleanly to the
Postgres column you will eventually create. Use only this table. The
"Drizzle" column is the canonical `schema.ts` declaration.

| Concept | SQLite (STRICT) | Drizzle (sqlite) | Postgres target | Notes |
|---|---|---|---|---|
| Surrogate key | `INTEGER PRIMARY KEY AUTOINCREMENT` | `integer('id').primaryKey({ autoIncrement: true })` | `id serial primary key` | `AUTOINCREMENT` ⇒ ids never reused, matching `serial` semantics. Worth the tiny cost. |
| Foreign key | `INTEGER` + `REFERENCES` | `integer('x_id').references(...)` | `int ... references` | Requires `foreign_keys = ON`. |
| Short/long string | `TEXT` | `text('name')` | `text` | Never `VARCHAR(n)`. Length limits are a `CHECK`, not a type. |
| Enum | `TEXT` + `CHECK (c IN (...))` | `text('status', { enum: [...] })` + `check()` | `CREATE TYPE ... AS ENUM` | Keep the TS enum list and the Postgres type list identical. |
| Boolean | `INTEGER` + `CHECK (c IN (0,1))` | `integer('is_x', { mode: 'boolean' })` | `boolean` | Drizzle marshals 0/1 ↔ JS boolean. |
| Timestamp (default) | `INTEGER` (epoch ms) | `integer('x_at', { mode: 'timestamp_ms' })` | `timestamptz` | App-set, always UTC. Arithmetic- and sort-correct. See below. |
| Date-only | `TEXT` `'YYYY-MM-DD'` | `text('x_on')` | `date` | Zero-padded, lexicographically sortable. |
| Money | `INTEGER` minor units | `integer('amount_cents')` | `int` / `bigint` | Never `REAL` for money — float drift is non-negotiable. |
| Exact decimal | `TEXT` (canonical form) | `text('rate')` | `numeric` | Compute in a decimal lib, store as text; `REAL` is not exact. |
| Float / measure | `REAL` | `real('weight_kg')` | `double precision` | Only where lossy is acceptable. |
| JSON document | `TEXT` (JSON) | `text('body', { mode: 'json' }).$type<T>()` | `jsonb` | See `portability.md` Rule 8. |
| Binary blob | `BLOB` | `blob('payload')` | `bytea` | Prefer object storage + a `text` URL for anything large. |
| UUID | `TEXT` (canonical 8-4-4-4-12) | `text('public_id')` | `uuid` | Generate in the app (`crypto.randomUUID()`); store as text. |

## Timestamps (Rule 7) — why epoch-ms integer

`CURRENT_TIMESTAMP` / `datetime('now')` produce `'2026-05-18 14:03:00'`:
no `T`, no `Z`, no timezone, second precision. That string ports to
Postgres `timestamptz` as a guess, not a value. Instead:

- Store `INTEGER` epoch **milliseconds**, set by the app
  (`new Date()` via Drizzle `mode: 'timestamp_ms'`).
- It compares and sorts correctly as an integer, needs no parsing, and
  converts to Postgres `timestamptz` with one
  `to_timestamp(col / 1000.0)` expression at cutover.
- The column name still ends in `_at` (naming is unchanged).

Acceptable alternative: ISO-8601 UTC `TEXT`
(`new Date().toISOString()` → `'2026-05-18T14:03:00.000Z'`). It is
human-readable and sorts correctly because it is fixed-width UTC. Pick one
representation per project and never mix.

## STRICT enforcement

Every table is `STRICT` (see `drizzle.md`). Under `STRICT`, the storage
class in this table is enforced — an `INTEGER` column rejects `'oops'`
instead of silently storing the string, which is precisely the Postgres
behavior you are rehearsing for.

## When to deviate

- A `REAL` for genuinely approximate scientific/measurement data is fine —
  document the precision tolerance in a comment so the Postgres
  `double precision` choice is intentional.
- Storing UUIDv7 as a 16-byte `BLOB` for index density is allowed *if* a
  comment records the Postgres plan (`uuid` column + app-side decode).
