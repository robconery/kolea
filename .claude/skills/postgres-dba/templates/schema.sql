-- Reference schema — demonstrates every postgres-dba rule.
-- Copy, rename, delete what you don't need. Every choice here is deliberate;
-- if you change one, leave a comment saying why (that is the whole point).

BEGIN;

-- Rule 5: small, stable, code-driven set -> native enum, not a lookup table.
CREATE TYPE order_status AS ENUM (
  'pending', 'paid', 'shipped', 'delivered', 'cancelled'
);

-- Rule 1/2: plural table, `id serial primary key`, natural key is UNIQUE.
CREATE TABLE customers (
  id          serial primary key,
  email       text        not null,
  full_name   text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ux_customers_email unique (email),
  constraint ck_customers_email_shape check (position('@' in email) > 1)
);

CREATE TABLE products (
  id          serial primary key,
  sku         text        not null,
  name        text        not null,
  price_cents int         not null check (price_cents >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ux_products_sku unique (sku)
);

CREATE TABLE coupons (
  id          serial primary key,
  code        text        not null,
  created_at  timestamptz not null default now(),
  constraint ux_coupons_code unique (code)
);

CREATE TABLE orders (
  id           serial primary key,
  -- Rule 4: FK is NOT NULL by default, ON DELETE is explicit (RESTRICT:
  -- never delete a customer with order history).
  customer_id  int          not null references customers (id) on delete restrict,
  -- Rule 4 override: a nullable FK MUST carry this comment or it is a defect.
  -- nullable-fk: a coupon is genuinely optional; cleared if the coupon is removed.
  coupon_id    int          references coupons (id) on delete set null,
  status       order_status not null default 'pending',
  created_at   timestamptz  not null default now(),
  updated_at   timestamptz  not null default now()
);
CREATE INDEX ix_orders_customer_id ON orders (customer_id);
CREATE INDEX ix_orders_status      ON orders (status);

CREATE TABLE order_items (
  id          serial primary key,
  order_id    int not null references orders   (id) on delete cascade,  -- child dies with parent
  product_id  int not null references products (id) on delete restrict, -- can't delete a sold product
  quantity    int not null check (quantity > 0),
  unit_cents  int not null check (unit_cents >= 0),
  -- Rule 6: derived value we aggregate on -> STORED generated column,
  -- never an app concern, never a trigger; cannot drift.
  line_cents  int generated always as (quantity * unit_cents) stored,
  constraint uq_order_items_order_product unique (order_id, product_id)
);
CREATE INDEX ix_order_items_order_id ON order_items (order_id);

-- Rule 3: pure many-to-many -> compound primary key, NO surrogate id,
-- both sides NOT NULL FKs, CASCADE so a membership never orphans.
CREATE TABLE groups (
  id          serial primary key,
  name        text not null,
  constraint ux_groups_name unique (name)
);

CREATE TABLE groups_users (
  group_id    int not null references groups    (id) on delete cascade,
  user_id     int not null references customers (id) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (group_id, user_id)            -- the pair IS the identity
);

COMMIT;
