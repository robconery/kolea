-- The hybrid document pattern (Rule 8): relational spine + jsonb body.
-- Keys/FKs are real columns; hot fields are generated columns extracted
-- from the document; the document still has CHECK-enforced shape rules.
-- Always jsonb, never json.

BEGIN;

CREATE TABLE products (
  -- ---- relational spine: identity, relationships, integrity ----
  id          serial primary key,
  sku         text        not null,
  category_id int         not null references categories (id) on delete restrict,

  -- ---- open-ended body: varies wildly per category ----
  -- NOT NULL + default '{}' so callers never branch on NULL vs {}.
  attributes  jsonb       not null default '{}'::jsonb,

  -- ---- hot fields promoted OUT of the document ----
  -- Filtered/sorted -> first-class indexed columns, source of truth still
  -- the document. (See generated-columns.md.)
  price_cents int  generated always as ((attributes->>'price_cents')::int) stored,
  brand       text generated always as (attributes->>'brand') stored,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint ux_products_sku unique (sku),

  -- A document is not an excuse to abandon validation.
  constraint ck_products_attributes_object
    check (jsonb_typeof(attributes) = 'object'),
  constraint ck_products_price_present
    check (attributes ? 'price_cents'),
  constraint ck_products_price_nonneg
    check ((attributes->>'price_cents')::int >= 0)
);

-- Containment queries (@>) ride this index. jsonb_path_ops: smaller/faster
-- when you only need @>. Use default jsonb_ops if you also index ? / ?| / ?&.
CREATE INDEX gin_products_attributes ON products USING gin (attributes jsonb_path_ops);
CREATE INDEX ix_products_price       ON products (price_cents);
CREATE INDEX ix_products_brand       ON products (brand);

COMMIT;

-- ---------------------------------------------------------------------------
-- Query idioms
-- ---------------------------------------------------------------------------

-- Filter by document content: containment, uses the GIN index.
-- SELECT * FROM products WHERE attributes @> '{"brand":"Acme","waterproof":true}';

-- Structured / comparison filter: JSONPath.
-- SELECT * FROM products WHERE attributes @? '$.dimensions.width_mm ? (@ > 100)';

-- Range / order: hit the generated column, never the raw path.
-- SELECT * FROM products WHERE price_cents BETWEEN 1000 AND 5000 ORDER BY price_cents;

-- ---------------------------------------------------------------------------
-- Mutation idioms — build the document, never overwrite the whole blob
-- ---------------------------------------------------------------------------

-- set/add one key
-- UPDATE products SET attributes = jsonb_set(attributes,'{brand}','"Acme"',true) WHERE id = $1;

-- shallow-merge several keys
-- UPDATE products SET attributes = attributes || '{"waterproof":true,"weight_g":210}' WHERE id = $1;

-- remove a key / a nested path
-- UPDATE products SET attributes = attributes - 'discontinued_note' WHERE id = $1;
-- UPDATE products SET attributes = attributes #- '{dimensions,depth_mm}' WHERE id = $1;

-- Deep merge is not built in: put it in a plpgsql function (see function.sql)
-- so the rule lives in one tested place.
