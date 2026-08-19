# Driver, Connection & Migrations

## Driver: `bun:sqlite` + `drizzle-orm/bun-sqlite`

Bun ships a native SQLite driver. It is the fastest option in a Bun
process and needs no native compile step. Use it for dev:

```ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
```

If a non-Bun runtime ever has to open the same file (a Node script, a
migration tool), `better-sqlite3` via `drizzle-orm/better-sqlite3` reads
the identical file and schema — the schema is driver-agnostic, only the
`db.ts` glue differs. Do not use an async/HTTP SQLite driver (libSQL
remote, D1) unless that *is* the production target; those change
transaction semantics and defeat the Postgres-portability goal.

## One `Database` per process

SQLite permits exactly one writer at a time against a file. A Bun web
server is one process; open **one** `Database`, wrap it once with
`drizzle()`, and export that. Importing a connection pool of writers
against one file buys you `SQLITE_BUSY`, not concurrency. Reads are
concurrent under WAL; writes serialize whether you like it or not — so
make it explicit (see `production.md` on `IMMEDIATE` transactions).

## The mandatory pragma block (Rule 3)

Run this immediately after opening, before any query, **on every
connection** (a connection does not inherit another's pragmas):

```ts
db.exec('PRAGMA journal_mode = WAL;');     // concurrent readers + one writer
db.exec('PRAGMA foreign_keys = ON;');      // OFF BY DEFAULT — without this, no FK enforcement
db.exec('PRAGMA busy_timeout = 5000;');    // wait 5s for the write lock instead of throwing
db.exec('PRAGMA synchronous = NORMAL;');   // safe + fast under WAL (FULL is overkill here)
```

`foreign_keys = ON` is the line everyone forgets. Without it, every
`onDelete: 'cascade' | 'restrict' | 'set null'` you carefully wrote is
inert and the database silently accepts orphan rows. Treat a `db.ts`
without this line as a bug report.

`journal_mode = WAL` persists in the database file; the other three are
per-connection and must be re-issued every open. The template re-issues
all four for safety.

## STRICT tables

Plain SQLite tables have *type affinity*: a `TEXT` column will quietly
store the integer `42`. That coercion is exactly the class of bug that
explodes at the Postgres cutover. Declare tables `STRICT` (SQLite ≥ 3.37;
Bun's bundled SQLite is new enough) so the engine rejects wrong types like
Postgres would. Drizzle does not emit `STRICT` for you — add it to the
generated migration (the template shows the one-line edit), or define
tables through a migration that includes `) STRICT;`.

## Migrations with drizzle-kit

- Author the schema in `src/db/schema.ts`. Never hand-write DDL as the
  source of truth — the schema file is the source, migrations are
  generated artifacts.
- `bunx drizzle-kit generate` — diffs the schema, writes a timestamped
  SQL migration into `drizzle/`.
- Review the generated SQL. For SQLite, drizzle-kit uses a
  table-rebuild strategy for many `ALTER`s (create new, copy, drop,
  rename) because SQLite's `ALTER TABLE` is limited. Confirm the rebuild
  preserves data and that `STRICT` survived.
- Apply at application startup with `migrate()` from
  `drizzle-orm/bun-sqlite/migrator` (the dev `db.ts` template does this),
  or `bunx drizzle-kit migrate` in CI.
- Commit `drizzle/` to the repo. Migrations are history; never edit an
  applied one — add a new one.

## When to deviate

- Tests may open an in-memory database (`new Database(':memory:')`) and
  skip WAL (`journal_mode=WAL` is meaningless in memory) — still set
  `foreign_keys=ON`. That is the only sanctioned pragma deviation.
