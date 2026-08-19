# JSONB as a Document Store

Postgres is a perfectly good document database — *when used as one on
purpose*. The failure mode is the two extremes: forcing open-ended,
genuinely document-shaped data into 40 sparse columns or an EAV table, or
dumping the entire entity into one untyped blob and losing every guarantee
the database exists to provide. The discipline is the **hybrid pattern**.

## Always `jsonb`, never `json`

`json` stores the source text verbatim (whitespace, key order, duplicate
keys) and reparses on every access. `jsonb` is decomposed binary: it
dedups keys, normalizes, indexes via GIN, and supports the containment and
path operators. There is no schema-design reason to choose `json`. Use
`jsonb`.

## The hybrid pattern (this is the rule)

A relational **spine** carries identity, relationships, and the fields you
filter/join on as real columns; a `jsonb` **body** carries the
open-ended, document-shaped, or sparsely-populated remainder.

```sql
CREATE TABLE products (
  id          serial primary key,
  sku         text not null,
  category_id int  not null references categories (id) on delete restrict,
  -- open-ended, varies wildly by category: dimensions, specs, certifications…
  attributes  jsonb not null default '{}'::jsonb,

  -- hot fields promoted OUT of the document into indexed generated columns
  price_cents int generated always as ((attributes->>'price_cents')::int) stored,
  brand       text generated always as (attributes->>'brand') stored,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint ux_products_sku unique (sku),
  -- the document still has rules; enforce them
  constraint ck_products_attributes_object
    check (jsonb_typeof(attributes) = 'object'),
  constraint ck_products_price_present
    check (attributes ? 'price_cents')
);

CREATE INDEX gin_products_attributes ON products USING gin (attributes jsonb_path_ops);
CREATE INDEX ix_products_price        ON products (price_cents);
```

What each piece buys you:

- **Spine columns** (`id`, `sku`, `category_id`): real keys, real FKs,
  real integrity. Relationships are never modeled inside JSONB.
- **`attributes jsonb not null default '{}'`**: open-ended data with no
  migration to add a new attribute. `NOT NULL` + default `'{}'` so code
  never branches on `NULL` vs `{}`.
- **Generated columns** (`price_cents`, `brand`): the fields you filter,
  sort, and index get pulled into first-class indexed columns *without*
  duplicating the source of truth — see `generated-columns.md`. This is
  how a document store still gets b-tree range scans.
- **`CHECK` constraints**: a document is not an excuse to abandon
  validation. Enforce shape (`jsonb_typeof = 'object'`), required keys
  (`attributes ? 'price_cents'`), and value rules
  (`(attributes->>'price_cents')::int >= 0`).
- **GIN index** with `jsonb_path_ops`: smaller and faster than the
  default `jsonb_ops` when you only need containment (`@>`), which is the
  common case. Use default `jsonb_ops` if you also need key-existence
  (`?`, `?|`, `?&`) operators indexed.

## Querying — operators that matter

| Operator | Meaning | Indexable by GIN |
|---|---|---|
| `->` | get field as `jsonb` | — |
| `->>` | get field as `text` | via expression/generated col |
| `#>` / `#>>` | get by path | — |
| `@>` | left contains right | **yes** (the workhorse) |
| `?` / `?|` / `?&` | key(s) exist | yes (default `jsonb_ops` only) |
| `@?` / `@@` | JSONPath match/predicate | yes |

Prefer **containment** for filtering — it uses the GIN index:

```sql
-- indexed: products whose document says brand Acme, waterproof true
SELECT * FROM products
WHERE attributes @> '{"brand":"Acme","waterproof":true}';

-- JSONPath for structured/comparison queries
SELECT * FROM products
WHERE attributes @? '$.dimensions.width_mm ? (@ > 100)';
```

Filter on the **generated column**, not the JSON path, for ranges and
ordering — that's why the generated column exists:

```sql
SELECT * FROM products WHERE price_cents BETWEEN 1000 AND 5000
ORDER BY price_cents;                       -- plain b-tree, fast
```

## Updating — don't clobber the document

Build mutations, never overwrite the whole blob (lost-update + loses
keys):

```sql
-- set / add a key
UPDATE products
SET attributes = jsonb_set(attributes, '{brand}', '"Acme"', true)
WHERE id = $1;

-- merge several keys (shallow)
UPDATE products SET attributes = attributes || '{"waterproof":true,"weight_g":210}'
WHERE id = $1;

-- remove a key / a path
UPDATE products SET attributes = attributes - 'discontinued_note' WHERE id = $1;
UPDATE products SET attributes = attributes #- '{dimensions,depth_mm}' WHERE id = $1;
```

`||` is a *shallow* merge; for deep merges write a `plpgsql` function (see
`functions.md`) — that is exactly the kind of reusable data logic that
belongs in one tested place.

## When JSONB, when columns

Reach for the **JSONB body** when:

- Attributes are genuinely open-ended or polymorphic (per-category specs,
  third-party webhook payloads, settings bags, event metadata).
- The shape varies per row and a relational model would be wide and
  sparse.
- You are storing an external document whose schema you don't own.

Keep it a **real column** (in the spine) when:

- You filter, join, sort, or aggregate on it routinely → column, or a
  generated column extracted from JSONB.
- It is a foreign key or participates in a constraint → **always** a real
  column. Relationships and referential integrity never live inside JSONB.
- It has a stable, known shape shared by every row → that's a table, model
  it.

## Anti-patterns this rule kills

- **EAV** (`entity / attribute / value` tables): JSONB is the supported
  replacement. Do not build EAV.
- **The God blob**: entire entity, including ids and FKs, in one `jsonb`
  column. You threw away the database. Keep the spine relational.
- **Querying `->>'x'` in hot `WHERE`/`ORDER BY`** instead of promoting `x`
  to a generated column — works, but unindexed and slow at scale.
- **`json` instead of `jsonb`** — never correct for storage you query.
- **No `CHECK` on the document** — "it's JSON so anything goes" is how
  required fields silently go missing. Validate shape and required keys.

## When to deviate

- **Pure document workload, no relational access at all** (opaque payload
  store keyed only by id): a thin `(id, doc jsonb, created_at)` table is
  fine — but the moment you filter by something inside `doc`, the hybrid
  rule reasserts itself; promote that field.
- **Append-only audit/event JSON** you never query into: store as `jsonb`
  for compactness, skip the generated columns until a query need appears.
