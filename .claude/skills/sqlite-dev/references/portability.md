# Modeling for the Postgres Cutover

Everything in `postgres-dba` about *modeling* (keys, FK nullability,
junctions, JSON-as-document, derived columns) applies unchanged. SQLite
just expresses some of it differently. This file is the difference list
and the cutover checklist.

## Keys & foreign keys (postgres-dba Rules 2–4)

- `id` surrogate key on every base table:
  `integer('id').primaryKey({ autoIncrement: true })`. `AUTOINCREMENT`
  makes ids monotonic and non-reused, matching `serial`. Natural keys get
  a unique index, never the primary key.
- FKs are `NOT NULL` by default with an **explicit** `onDelete`. A
  nullable FK requires a `// nullable-fk: <reason>` comment on the line or
  it is a defect — identical to `postgres-dba` Rule 4.
- `foreign_keys = ON` (the pragma) is what makes any of this real. See
  `drizzle.md`.

## Many-to-many (postgres-dba Rule 3)

A pure junction has a **compound primary key**, no surrogate `id`, both
columns NOT NULL FKs with `onDelete: 'cascade'`:

```ts
export const groupsUsers = sqliteTable('groups_users', {
  groupId: integer('group_id').notNull()
             .references(() => groups.id, { onDelete: 'cascade' }),
  userId:  integer('user_id').notNull()
             .references(() => customers.id, { onDelete: 'cascade' }),
  addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull()
             .$defaultFn(() => new Date()),
}, (t) => [primaryKey({ columns: [t.groupId, t.userId] })]);
```

If the join carries its own data and identity, it is an entity
(`enrollments`) with its own `id`, not a junction.

## Enums (postgres-dba Rule 5)

SQLite has no enum type. Reproduce the Postgres enum with `text` + a
`CHECK` whose value list is **character-for-character** the future
`CREATE TYPE`:

```ts
status: text('status', { enum: ['pending','paid','shipped','delivered','cancelled'] })
          .notNull().default('pending'),
// + check('ck_orders_status', sql`status in ('pending','paid','shipped','delivered','cancelled')`)
```

Drizzle's `enum` gives you the *TypeScript* union; the `CHECK` gives you
the *database* guarantee SQLite otherwise omits. At cutover this becomes a
real `order_status` type — the allowed set already matches.

## JSON as a document store (postgres-dba Rule 8)

Same hybrid pattern, `jsonb` → `text` JSON:

- Keys, FKs, and hot/queried fields are real columns.
- Open-ended or document-shaped data is `text('body', { mode: 'json' }).$type<Body>()`.
- A field you filter or sort on is **lifted out** via a STORED generated
  column and indexed — do not query into JSON in hot paths on either
  engine:

```sql
-- in the migration:
priority TEXT GENERATED ALWAYS AS (json_extract(body, '$.priority')) STORED,
```
```ts
// schema.ts mirror so Drizzle knows the column:
priority: text('priority').generatedAlwaysAs(sql`json_extract(body, '$.priority')`, { mode: 'stored' }),
```

`json_extract(... '$.x')` ports to Postgres `body->>'x'`. No EAV tables on
either engine.

## Generated columns (postgres-dba Rule 6)

SQLite supports `GENERATED ALWAYS AS (expr) STORED` (≥ 3.31). Use
`STORED` for anything indexed or searched (Postgres only has `STORED`, so
never rely on SQLite `VIRTUAL` for a portable column). Derived data you
filter/sort on is a generated column, not app code and not a trigger —
exactly Rule 6.

## The one real gap: no `plpgsql` (postgres-dba Rule 7)

SQLite has no stored procedures. Multi-row business rules and invariants
that `postgres-dba` would put in a `plpgsql` function must live in the
app — but **quarantined**, not scattered:

- One repository/service function per operation, wrapped in
  `db.transaction(...)` (use an `IMMEDIATE` transaction for write paths to
  fail fast on lock contention — see `production.md`).
- Push what you *can* into the schema regardless of engine: `CHECK`
  constraints, `NOT NULL`, `UNIQUE`, generated columns, FK actions. Those
  port directly and need no rewrite.
- Leave a `// pg-candidate: <rule>` comment on each such transaction so
  the cutover has an exact inventory of logic to consider promoting into
  a database function.

## Cutover checklist (SQLite → Postgres)

When production goes to Postgres:

1. **Drizzle config:** `dialect: 'sqlite'` → `'postgresql'`, swap the
   driver in `db.ts` (`drizzle-orm/node-postgres` or `bun-sql`). The
   schema file's column *names* are already Postgres-legal.
2. **Schema file:** swap `sqliteTable`→`pgTable`, the column builders
   (`integer`→`serial`/`integer`, `text` enum → `pgEnum`, timestamp-ms
   integer → `timestamp`/`timestamptz`, JSON `text` → `jsonb`). Names do
   not change. Regenerate migrations against an empty Postgres database.
3. **Enums:** create the `pgEnum` from the exact list already in the
   `CHECK`/Drizzle `enum`.
4. **Timestamps:** migrate stored epoch-ms via
   `to_timestamp(col / 1000.0)` (or parse the ISO text).
5. **`pg-candidate` transactions:** review each; promote to a `plpgsql`
   function where it is genuinely set-based or must hold regardless of
   caller (`postgres-dba/references/functions.md`).
6. **Data copy:** export rows, load into Postgres; verify FK pragma was on
   in SQLite so there are no orphans to reject.
7. Delete this skill's `db.ts` pragma block — Postgres needs none of it.

Because every rule above was followed, this is a mechanical port, not a
redesign. That is the entire point of the skill.
