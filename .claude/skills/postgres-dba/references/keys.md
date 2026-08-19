# Keys & Foreign Keys

Identity, relationships, and referential integrity belong to the database.
The application never invents IDs, never enforces a relationship "by
convention", and never deletes a parent and hopes.

## Primary keys: `id serial primary key`

Every base table gets a synthetic surrogate key named `id`:

```sql
CREATE TABLE customers (
  id    serial primary key,
  email text not null,
  ...
  constraint ux_customers_email unique (email)
);
```

- The surrogate key is the row's *identity*; it never changes and carries
  no business meaning, so business changes never cascade into PK changes.
- **Natural keys get `UNIQUE`, never `PRIMARY KEY`.** Email, SKU, slug —
  they are real and must be enforced, but they change and they leak into
  every FK if used as the PK. `UNIQUE` enforces them without that cost.
- **`serial` is the default.** Use `bigserial` or `generated always as
  identity` only with a stated reason (you genuinely expect to exhaust
  ~2.1B rows, or you need identity-column semantics). Put the reason in a
  comment:

  ```sql
  id bigserial primary key,  -- bigserial: event table, ~50M rows/day
  ```

- A `uuid` PK is allowed only when IDs must be generated *outside* the
  database (offline clients, sharding, public-facing opaque IDs). It is
  not the default; it costs index locality. Comment the reason.

## Many-to-many: compound primary key, no surrogate

A pure junction table's identity *is* the pair. Do not add an `id`.

```sql
CREATE TABLE groups_users (
  group_id int not null references groups (id) on delete cascade,
  user_id  int not null references users  (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
```

- The compound PK `(group_id, user_id)` *is* the uniqueness rule — no
  separate `UNIQUE` needed, and a duplicate membership is impossible by
  construction rather than by application check.
- Both columns are FKs and both are `NOT NULL`. A junction row with a
  null side is meaningless.
- `ON DELETE CASCADE` on a pure junction is usually correct: removing
  either parent removes the membership, never orphans it.
- The moment the junction grows its own attributes that have a lifecycle
  (status, paid_at, role-within-group), it is no longer a pure junction —
  it is an entity. Promote it: give it a name (`enrollments`,
  `memberships`), give it `id serial primary key`, and keep a
  `UNIQUE (group_id, user_id)` to preserve the pairing rule. Column order
  in the compound key/index should match your most common lookup
  direction.

## Foreign keys are `NOT NULL` by default

A foreign key column is `NOT NULL` unless optionality is a deliberate,
documented modeling decision.

```sql
CREATE TABLE order_items (
  id         serial primary key,
  order_id   int not null references orders   (id) on delete cascade,
  product_id int not null references products (id) on delete restrict,
  quantity   int  not null check (quantity > 0)
);
```

Every FK declares two things explicitly:

1. **Nullability.** Default `NOT NULL`. An order item with no order is
   not a thing.
2. **`ON DELETE` behavior.** Never rely on the default (`NO ACTION`).
   State intent:
   - `CASCADE` — child cannot outlive parent (order_items vs orders).
   - `RESTRICT` — parent must not be deleted while referenced (product
     still on orders).
   - `SET NULL` — only legal on a column that is itself a documented
     nullable FK (see below).

### The nullable-FK override

A nullable FK says "this relationship is genuinely optional." That is
sometimes true and must be *declared*, not achieved by forgetting
`NOT NULL`:

```sql
CREATE TABLE orders (
  id              serial primary key,
  customer_id     int not null references customers (id) on delete restrict,
  -- nullable-fk: guest checkout — coupon is optional and applied post-creation
  coupon_id       int references coupons (id) on delete set null,
  ...
);
```

The rule for reviewers and tools: **a nullable FK without a
`-- nullable-fk: <reason>` comment is a defect.** No comment → add
`NOT NULL`. The comment forces the author to justify the optionality and
makes it auditable. `ON DELETE SET NULL` is only valid on such a column.

## When to deviate

- **Partitioned / append-only event tables:** `bigserial` or identity is
  the rule, not the exception — comment it and move on.
- **Cross-database / sharded systems:** UUID PKs are appropriate; the
  database can't enforce cross-shard FKs, so document where integrity is
  enforced instead.
- **Distributed PK generation** (clients create rows offline): UUID is
  fine. Everything else stays the same.
- Never deviate on "FKs are NOT NULL by default" silently. The override
  exists *so that* deviation is always visible.
