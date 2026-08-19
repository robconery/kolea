# Naming Conventions

The names are **exactly** the `postgres-dba` names. SQLite is more
permissive about identifiers than Postgres — it does not fold case, it
tolerates almost anything quoted — and that permissiveness is a trap: a
name that works in SQLite but needs `"FooBar"` quoting in Postgres is a
name that breaks at cutover. Write Postgres-legal names now.

## Rules (same as postgres-dba/references/naming.md)

- **Case:** `snake_case`, all lowercase, in the *database*. No `CamelCase`,
  no quoted mixed-case identifiers.
- **Tables:** plural nouns — `users`, `orders`, `order_items`.
- **Columns:** singular — `email`, `shipped_at`, `total_cents`.
- **Primary key:** always literally `id`.
- **Foreign keys:** `<referenced_table_singular>_id` — `user_id`,
  `parent_order_id`.
- **Booleans:** `is_active`, `has_shipped`, `is_default`. Never bare
  `active`; never negative `is_not_deleted`.
- **Timestamps:** past-tense event + `_at` — `created_at`, `updated_at`,
  `deleted_at`. (Stored as epoch-ms integers — see `types.md` — but the
  *name* is unchanged.)
- **Junction tables:** the two table names, alphabetical, plural:
  `groups_users`. If it carries its own data, name it the domain noun
  (`enrollments`) and treat it as a real entity.
- **Indexes:** `ix_<table>_<cols>`, `ux_<table>_<cols>` (unique).
- **Constraints:** name them — `ck_<table>_<rule>`, `fk_<table>_<col>`,
  `uq_<table>_<cols>`. SQLite auto-names are even less legible than
  Postgres's; name them so a constraint violation is debuggable.
- **No reserved words; no abbreviations** (`url`, `id`, `sku` are the only
  blessed ones).

## The Drizzle two-name rule

Drizzle separates the **TypeScript property** (what your app code reads)
from the **database column name** (what SQL sees). Use that separation:
`camelCase` in TS for ergonomics, `snake_case` in the database for
portability. **The column-name string argument is mandatory and is always
`snake_case`.**

### Wrong

```ts
export const orders = sqliteTable('Orders', {          // PascalCase table
  orderId: integer('orderId').primaryKey(),            // camelCase column, redundant prefix
  customer: integer('customer'),                       // no _id, nullable by omission
  active: integer('active'),                            // ambiguous boolean
  created: text('created'),                             // not _at, not a timestamp type
});
```

### Right

```ts
export const orders = sqliteTable('orders', {
  id:         integer('id').primaryKey({ autoIncrement: true }),
  customerId: integer('customer_id').notNull()
                .references(() => customers.id, { onDelete: 'restrict' }),
  isActive:   integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt:  integer('created_at', { mode: 'timestamp_ms' }).notNull()
                .$defaultFn(() => new Date()),
}, (t) => [
  index('ix_orders_customer_id').on(t.customerId),
]);
```

The Drizzle object is `orders` (matches the table). The property
`customerId` is camelCase for the app; the column is `'customer_id'`. When
the dialect later becomes `pg`, these exact column names already exist in
Postgres unquoted and lowercase — nothing to rename.

## When to deviate

- A name dictated by an external system you do not control. Isolate it,
  put a view/Drizzle alias with conformant names in front of it.
- That is the entire list. See `postgres-dba/references/naming.md` for the
  full rationale; it applies here verbatim.
