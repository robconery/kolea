# Generated Columns

A generated column is a column whose value the database computes from
other columns in the same row. Use it to make derived data *queryable and
indexable* without a trigger, without application duplication, and without
the value ever drifting out of sync.

The discipline is one sentence: **don't store what you can compute for
free; do store what you filter, sort, join, or search on.**

## STORED, always

Postgres supports only `GENERATED ALWAYS AS (...) STORED`. The value is
computed on write and persisted, so it indexes like any column and reads
cost nothing extra.

```sql
CREATE TABLE order_items (
  id          serial primary key,
  order_id    int     not null references orders (id) on delete cascade,
  quantity    int     not null check (quantity > 0),
  unit_cents  int     not null check (unit_cents >= 0),
  line_cents  int     generated always as (quantity * unit_cents) stored
);
```

`line_cents` cannot disagree with `quantity * unit_cents` — there is no
code path that updates one without the other, because there is no code
path at all. This is the entire value proposition: the invariant is
structural, not aspirational.

## The canonical use: full-text search

Do not maintain a `tsvector` with a trigger. Generate it.

```sql
CREATE TABLE articles (
  id        serial primary key,
  title     text not null,
  body      text not null,
  search    tsvector generated always as (
              setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
              setweight(to_tsvector('english', coalesce(body,  '')), 'B')
            ) stored
);

CREATE INDEX gin_articles_search ON articles USING gin (search);
```

`WHERE search @@ websearch_to_tsquery('english', $1)` is now an
index scan that can never be stale. The pre-generated-column trigger
recipe for this is obsolete; do not reproduce it.

## Good uses

- **Money/quantity math** you filter or aggregate on (`line_cents`).
- **Search vectors** (`tsvector`, above).
- **Normalized forms for lookup**: `lower(email)`,
  `unaccent(lower(name))` — then `UNIQUE`/index the generated column so
  case-insensitive uniqueness is enforced by the database.
- **Extracted JSONB hot fields** — see `jsonb.md`; this is how a JSONB
  document still gets first-class indexed columns.
- **Cheap classification** used in `WHERE`: `is_overdue` from
  `due_at < now()`? No — that depends on `now()` and is **not
  immutable**, so it is not allowed (see below). `total_cents >= 100000`
  is fine.

## Hard constraints (these are errors, not style)

- The expression must be **`IMMUTABLE`**. No `now()`, no `current_user`,
  no other columns' generated values that aren't immutable, no
  non-immutable functions. "Is this row overdue *right now*" is a query
  predicate, not a generated column.
- A generated column **cannot reference another generated column** and
  cannot have a `DEFAULT`.
- You **cannot `INSERT`/`UPDATE` it directly** — that is the point.
  Application code that tries is wrong and should be fixed, not
  worked around.

## Don't store what's free

Do **not** generate a column that is a trivial rename or a projection you
never filter/sort/index on — that is just a wider row. Compute it in the
`SELECT` list or a view instead. The test: *would you put an index on it
or filter by it?* If no, it doesn't earn a stored column.

## Generated column vs view vs trigger vs app code

| Need | Use |
|---|---|
| Derived value you filter/sort/index on, immutable expr | **Generated column** |
| Derived value for display only, never filtered | View / `SELECT` expr |
| Derivation needs other rows or non-immutable input | Function / view |
| "Keep two columns in sync on write" | **Generated column** (not a trigger) |
| Multi-row side effects on write | Trigger (last resort) or explicit function call |

A trigger to maintain a derived *single-row* value is legacy practice
that generated columns replaced. Reach for a trigger only when the effect
genuinely spans rows or tables and a function call from the app won't do.

## When to deviate

- Pre-Postgres-12 targets have no generated columns; you are forced to a
  trigger. Note the version constraint in a comment so it's removed on
  upgrade.
- An extremely wide, write-hot table where the extra stored bytes matter
  more than read convenience: compute in a view instead. Measure first;
  this is rare.
