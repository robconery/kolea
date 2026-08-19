# Enums vs Lookup Tables

Most "lookup tables" are a join, an extra migration, and an integrity gap
(nothing stops a typo'd `status_id`) bought to model a list that changes
once a year. For small, stable, code-driven value sets, a native `enum`
type is faster, self-documenting, and impossible to violate.

## Default: native enum

```sql
CREATE TYPE order_status AS ENUM (
  'pending', 'paid', 'shipped', 'delivered', 'cancelled'
);

CREATE TABLE orders (
  id      serial primary key,
  status  order_status not null default 'pending',
  ...
);
```

Why this beats `orders.status_id -> order_statuses(id)`:

- **Integrity for free.** `status = 'shppd'` is a type error at write
  time. A `status_id` of `999` inserts happily.
- **Readable everywhere.** `WHERE status = 'shipped'` — no join to learn
  what `4` means, in queries or in a `psql` session at 2am.
- **Ordered.** Enum values sort in declaration order, so
  `ORDER BY status` and `status < 'shipped'` are meaningful and free.
- **One source of truth.** The type *is* the allowed set; there is no
  table to drift out of sync with application code.

## When a lookup table is correct

Use a table (with `id serial primary key`, the standard conventions) when
**any** of these is true:

- **The value carries data.** It needs a label, a color, a sort weight, a
  description, a feature flag — anything beyond the value itself. An enum
  holds one string; a domain concept with attributes is an entity.
- **End users edit the set at runtime.** Categories, tags, plans the
  admin UI manages. Enum changes are DDL; user-managed sets are data.
- **The set is large or churns frequently.** Hundreds of values, or
  values added/removed every sprint. DDL churn is a smell here.
- **You need to soft-retire values** while preserving history and
  blocking new use (an `is_active` flag on the row). Enums can't do this
  cleanly — you cannot remove an enum value that is still referenced.

If none of those hold, it is an enum.

## Changing an enum safely

This is the real objection to enums; handle it correctly and it
evaporates.

- **Add a value:**

  ```sql
  ALTER TYPE order_status ADD VALUE 'returned';                 -- appended
  ALTER TYPE order_status ADD VALUE 'refunded' AFTER 'returned';
  ```

  Cannot run inside a transaction block in older Postgres; in modern
  versions a newly added value can't be used in the *same* transaction.
  Add it in its own migration step, separate from code that uses it.

- **Rename a value:**

  ```sql
  ALTER TYPE order_status RENAME VALUE 'cancelled' TO 'voided';
  ```

- **Remove a value:** Postgres has no `DROP VALUE`. If removal is a
  recurring need, that is the signal you should have used a lookup table
  with an `is_active` flag — reconsider the modeling rather than fighting
  the type. The supported escape hatch is creating a new type and
  migrating the column:

  ```sql
  CREATE TYPE order_status_new AS ENUM ('pending','paid','shipped','delivered');
  ALTER TABLE orders
    ALTER COLUMN status TYPE order_status_new
    USING status::text::order_status_new;
  DROP TYPE order_status;
  ALTER TYPE order_status_new RENAME TO order_status;
  ```

  Do this in a migration with the table locked briefly; on hot tables,
  prefer adding values over removing them.

## The anti-pattern: don't model an enum as a `CHECK (x IN (...))`

A bare `text` column with `CHECK (status IN ('pending', ...))` gets you
the validation but none of the ordering, none of the type reuse across
tables, and a constraint you must edit in lockstep with every table that
duplicates the list. If it's a fixed set, make it a type.

## When to deviate

- **Shared across services with independent deploys:** if two services
  must agree on the set and deploy on different schedules, a lookup table
  with explicit rows can be safer than coordinating `ALTER TYPE` timing.
  Document the trade.
- **Reporting/BI consumers that can't introspect enum types:** sometimes
  a lookup table is forced by a downstream tool. That is a deviation with
  a name and a reason — write it in a comment.
