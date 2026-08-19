# Naming Conventions

The goal: never quote an identifier in an everyday query. If a name forces
`"FooBar"` quoting, the name is wrong. Postgres folds unquoted identifiers
to lowercase, so `snake_case` is the only style that survives round-trips
unscathed.

## Rules

- **Case:** `snake_case`, all lowercase. No `CamelCase`, no `PascalCase`,
  no quoted mixed-case identifiers anywhere in the schema.
- **Tables:** plural nouns — `users`, `orders`, `order_items`. A table is
  a collection; its name says so.
- **Columns:** singular — `email`, `shipped_at`, `total_cents`. A column
  describes one attribute of one row.
- **Primary key:** always literally `id`. Never `user_id` *in* the
  `users` table, never `pk`, never `uid`.
- **Foreign keys:** `<referenced_table_singular>_id` —
  `user_id` references `users(id)`, `parent_order_id` references
  `orders(id)` for a self-reference. The name states the target.
- **Booleans:** ask a yes/no question — `is_active`, `has_shipped`,
  `is_default`. Never bare `active`/`shipped` (ambiguous) and never
  negatives like `is_not_deleted`.
- **Timestamps:** past-tense event + `_at`, type `timestamptz` —
  `created_at`, `updated_at`, `deleted_at`, `confirmed_at`. Durations are
  `interval`; money is integer minor units (`amount_cents`) or `numeric`,
  never `float`.
- **Junction tables:** the two table names joined, alphabetical, plural is
  fine: `groups_users`, `roles_users`. If the relationship is a domain
  noun in its own right (it carries data, e.g. `enrollments`), name it
  that instead and treat it as a real entity.
- **Indexes:** `ix_<table>_<cols>` (btree), `ux_<table>_<cols>` (unique),
  `gin_<table>_<col>` (GIN). Example: `ix_orders_customer_id`,
  `ux_users_email`.
- **Constraints:** name them explicitly so error messages are legible —
  `ck_<table>_<rule>` for `CHECK`, `fk_<table>_<col>` for foreign keys,
  `uq_<table>_<cols>` for table-level `UNIQUE`. An unnamed constraint
  produces an opaque auto-name in production logs; that is the bug.
- **Enums (types):** singular noun describing the domain —
  `order_status`, `user_role`. See `enums.md`.
- **Functions:** `verb_noun` describing the action —
  `place_order`, `recalculate_cart_total`, `archive_user`.
- **No reserved words.** `user`, `order`, `group`, `end` are SQL keywords.
  `users`, `orders`, `groups` (plural) sidestep the trap; this is a second
  reason tables are plural.
- **No abbreviations** unless they are universal in the domain (`url`,
  `id`, `sku`). `qty`, `desc`, `addr` are not universal — spell them.

## Wrong

```sql
CREATE TABLE "Order" (                       -- quoted, mixed case, reserved, singular
  OrderID      serial,                       -- CamelCase, redundant prefix
  Customer     int,                          -- ambiguous, no _id, nullable by omission
  active       boolean,                      -- ambiguous boolean
  created      timestamp                     -- no tz, not past-tense _at
);
```

## Right

```sql
CREATE TABLE orders (
  id           serial primary key,
  customer_id  int not null references customers (id) on delete restrict,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

CREATE INDEX ix_orders_customer_id ON orders (customer_id);
```

## When to deviate

- A name dictated by an external system you do not control (a replicated
  table, a foreign data wrapper). Quote it, isolate it in its own schema,
  and put a view with conformant names in front of it.
- That is the entire list. Inside your own schema there is no deviation.
