---
name: sqlite-dev
description: >-
  Opinionated SQLite conventions for local TypeScript + Bun web development
  with Drizzle ORM, where Postgres is the likely production target. Keeps the
  postgres-dba naming and modeling rules (snake_case, plural tables, `id`
  surrogate keys, NOT NULL FKs with explicit ON DELETE, compound junction
  keys, JSON document store) so the schema ports to Postgres with a dialect
  swap, not a rewrite. Covers the `bun:sqlite` + `drizzle-orm/bun-sqlite`
  driver, mandatory connection pragmas (WAL, foreign_keys, busy_timeout),
  STRICT tables, the SQLite analogues of enums / booleans / timestamps /
  JSONB / generated columns, drizzle-kit migrations, and a full section on
  running SQLite *in production* (single-writer discipline, Litestream/LiteFS
  durability, tuning) plus the Postgres cutover checklist. Use when starting
  or reviewing a Bun+Drizzle app on SQLite, writing the schema or migrations,
  choosing a column type, deciding whether SQLite can be the production
  database, or porting a SQLite schema to Postgres. Ships copy-ready
  `schema.ts`, `db.ts`, production `db.ts`, and `drizzle.config.ts`.
---

# SQLite for Local Dev — Postgres-Portable, Bun + Drizzle

## 🎯 Why: Design for Change

The goal of writing software is to be able to **change it safely** —
including changing the database. Every rule here (snake_case, plural tables,
NOT NULL FKs, JSON document store) exists so the schema ports to Postgres
with a dialect swap, not a rewrite. Portability *is* change-safety: when
SQLite stops fitting, you move with a Drizzle config edit instead of a
month of forensics.


SQLite here is the *development* database for a TypeScript/Bun app whose
production system of record will almost certainly be Postgres. That single
fact drives every rule: write the SQLite schema so that switching to
Postgres is a Drizzle dialect change and a data copy, **not** a redesign.
Use the same names, the same modeling discipline, and the same integrity
rules as `postgres-dba` — SQLite is just a smaller engine running them.

This skill is about *the SQLite schema, the Drizzle layer, and operating
SQLite*. For schema-design philosophy (why NOT NULL FKs, why a surrogate
key) the authority is `postgres-dba`; this skill does not re-argue it, it
ports it. For app-layer TypeScript use the language skills.

## How to use this skill

1. Match the task to a rule below or in the decision guide.
2. Open the matching `references/*.md` for the rationale, the wrong way,
   the right way, and the explicit-override escape hatch.
3. Copy the closest file from `templates/` and adapt it — the templates
   already encode every convention, so you start compliant *and* portable.
4. Apply the rule unless you can state, in a code comment, the specific
   reason it does not apply. "SQLite let me" is not a reason — SQLite lets
   you do almost anything; Postgres will not.

## The hard rules (non-negotiable defaults)

1. **Naming is identical to `postgres-dba`.** `snake_case`, lowercase,
   unquoted. Tables plural (`orders`), columns singular (`shipped_at`),
   primary key literally `id`, FKs `<table_singular>_id`, booleans
   `is_/has_`, timestamps past-tense `_at`. In Drizzle the *TypeScript*
   property may be `camelCase`, but the **column name argument is always
   the `snake_case` name** — `createdAt: integer('created_at', …)`. The
   database never sees a quoted mixed-case identifier. See
   `references/naming.md`.

2. **`bun:sqlite` + `drizzle-orm/bun-sqlite`, one `Database` per process.**
   That is the dev driver. Every connection runs the pragma block (Rule 3)
   at open. SQLite has one writer at a time; a single shared `Database`
   instance plus serialized writes is the model — do not invent a pool of
   writers. See `references/drizzle.md`.

3. **Pragmas are mandatory and per-connection.** Every connection sets, in
   order: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`,
   `synchronous = NORMAL`. **`foreign_keys` is OFF by default in SQLite** —
   forgetting it silently disables every `ON DELETE` you wrote. This is the
   single most common SQLite data-integrity bug. See `references/drizzle.md`.

4. **Tables are `STRICT`, types come from the Postgres-portable set only.**
   Declare `STRICT` (SQLite ≥ 3.37) so a column actually rejects wrong
   types instead of silently coercing. Use only the type vocabulary in
   `references/types.md`: `INTEGER`, `TEXT`, `REAL`, `BLOB` mapped to a
   concrete Postgres target. No `VARCHAR(n)`, no `DATETIME`, no `BOOLEAN`,
   no `NUMERIC` — those are affinity theater in SQLite and lie about the
   Postgres column you will eventually create.

5. **FKs are `NOT NULL` by default with explicit `ON DELETE`.** Same rule
   as `postgres-dba` Rule 4. A nullable FK carries a
   `// nullable-fk: <reason>` comment or it is a defect. Many-to-many is a
   **compound primary key**, no surrogate `id` on a pure junction. See
   `references/portability.md`.

6. **Enums are `text` + a `CHECK (col IN (...))`, mirroring the Postgres
   enum.** SQLite has no enum type. Use Drizzle `text({ enum: [...] })`
   *and* an explicit check constraint so the values match the
   `CREATE TYPE` you will write in Postgres. Booleans are
   `integer({ mode: 'boolean' })` + `CHECK (col IN (0,1))`. See
   `references/portability.md`.

7. **Timestamps are one chosen representation, app-set, always UTC.**
   SQLite has no `timestamptz`. Default: `integer` epoch-milliseconds via
   Drizzle `{ mode: 'timestamp_ms' }`, set by the app, never
   `CURRENT_TIMESTAMP` (which emits a non-ISO, tz-ambiguous string). This
   ports to Postgres `timestamptz` mechanically. See `references/types.md`.

8. **JSON is `text({ mode: 'json' })` with a relational spine, mirroring
   the JSONB rule.** Keys/FKs/hot fields are real columns; open-ended data
   is a JSON document, hot fields lifted out via a `GENERATED ... STORED`
   column and indexed. This is `postgres-dba` Rule 8 with `jsonb` → `text`
   JSON. See `references/portability.md`.

9. **Set-based / multi-row business logic lives in an explicit
   transaction in a named module — *not* scattered across callers.** This
   is the one place SQLite cannot match `postgres-dba` Rule 7 (no
   `plpgsql`). Quarantine that logic in one repository/service function
   wrapped in a `db.transaction(...)` so the Postgres cutover has exactly
   one place to consider promoting to a function. See
   `references/portability.md`.

## Decision guide

| Situation | Rule | Reference |
|---|---|---|
| Naming any table/column/index/constraint | Rule 1 | `references/naming.md` |
| Drizzle TS property vs DB column name | Rule 1 | `references/naming.md` |
| Choosing the driver / opening the DB | Rule 2 | `references/drizzle.md` |
| WAL / foreign_keys / busy_timeout setup | Rule 3 | `references/drizzle.md` |
| Picking a column type | Rule 4 | `references/types.md` |
| `STRICT` table or not | Rule 4 | `references/types.md` |
| FK nullability and `ON DELETE` | Rule 5 | `references/portability.md` |
| Many-to-many junction | Rule 5 | `references/portability.md` |
| Status / role / kind column | Rule 6 | `references/portability.md` |
| Boolean column | Rule 6 | `references/types.md` |
| Storing a timestamp / date / money | Rule 7 | `references/types.md` |
| Open-ended / document-shaped data | Rule 8 | `references/portability.md` |
| Indexing a value inside a JSON document | Rule 8 | `references/portability.md` |
| Multi-row business rule / invariant | Rule 9 | `references/portability.md` |
| Generating & applying migrations | — | `references/drizzle.md` |
| "Can SQLite *be* production here?" | — | `references/production.md` |
| Backups / durability / replication | — | `references/production.md` |
| Cutting over from SQLite to Postgres | — | `references/portability.md` |

## Templates

- `templates/schema.ts` — a Drizzle SQLite schema demonstrating every
  rule: snake_case columns under camelCase keys, `id` surrogate key, a
  `text`+`CHECK` enum, integer boolean, epoch-ms timestamps, NOT NULL FKs
  with explicit `onDelete`, one annotated nullable-FK override, a
  compound-key junction, a STORED generated column, and a JSON body with a
  lifted+indexed hot field.
- `templates/db.ts` — the dev connection: `bun:sqlite` + Drizzle, the
  mandatory pragma block applied at open, and startup migration.
- `templates/db.production.ts` — the production connection: pragmas tuned
  for a server (mmap, cache), single-writer discipline, `IMMEDIATE`
  transaction helper, and a `VACUUM INTO` backup hook.
- `templates/drizzle.config.ts` — drizzle-kit config for the SQLite
  dialect, with the one-line change that points it at Postgres later.

## What this skill will not do

- Bless a SQLite-only construct that has no Postgres equivalent in the
  schema (e.g. relying on rowid aliasing, type affinity coercion, or
  `WITHOUT ROWID` for a normal table). If Postgres can't express it, it
  doesn't belong in a portable schema.
- Bless `foreign_keys` left at the default. An app that doesn't set the
  pragma has no referential integrity, full stop.
- Bless `CURRENT_TIMESTAMP` / `DATETIME('now')` for stored timestamps —
  the format is not ISO-8601 and not tz-aware (Rule 7).
- Bless a multi-writer connection pool against one SQLite file.
- Bless SQLite in production *by default*. It can be production — under
  the explicit conditions in `references/production.md`, and only there.
- Re-derive schema-design philosophy. That is `postgres-dba`'s job; this
  skill ports its conclusions to a smaller engine.
