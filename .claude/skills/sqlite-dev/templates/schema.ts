// Reference Drizzle SQLite schema — demonstrates every sqlite-dev rule and
// is deliberately Postgres-portable. Copy, rename, delete what you don't
// need. Change a convention only with a comment saying why.

import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  integer,
  text,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/sqlite-core';

// NOTE: declare tables `STRICT` in the generated migration (drizzle-kit
// does not emit STRICT). See references/drizzle.md.

// Rule 1: snake_case columns under camelCase keys, plural table name.
// Rule 4/Rule 2 (types/keys): id = serial-equivalent surrogate key.
export const customers = sqliteTable(
  'customers',
  {
    id:        integer('id').primaryKey({ autoIncrement: true }),
    email:     text('email').notNull(),
    fullName:  text('full_name').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('ux_customers_email').on(t.email),
    check('ck_customers_email_shape', sql`instr(${t.email}, '@') > 1`),
  ],
);

export const coupons = sqliteTable(
  'coupons',
  {
    id:        integer('id').primaryKey({ autoIncrement: true }),
    code:      text('code').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('ux_coupons_code').on(t.code)],
);

// Rule 6: enum = text + CHECK whose list IS the future Postgres CREATE TYPE.
// Rule 7: timestamps = app-set epoch-ms integers, never CURRENT_TIMESTAMP.
export const orders = sqliteTable(
  'orders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    // Rule 5: FK is NOT NULL by default, ON DELETE explicit.
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),

    // Rule 5 override: a nullable FK MUST carry this comment or it is a defect.
    // nullable-fk: a coupon is genuinely optional; cleared if the coupon is removed.
    couponId: integer('coupon_id').references(() => coupons.id, { onDelete: 'set null' }),

    status: text('status', {
      enum: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'],
    })
      .notNull()
      .default('pending'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index('ix_orders_customer_id').on(t.customerId),
    index('ix_orders_status').on(t.status),
    check(
      'ck_orders_status',
      sql`${t.status} in ('pending','paid','shipped','delivered','cancelled')`,
    ),
  ],
);

export const products = sqliteTable(
  'products',
  {
    id:    integer('id').primaryKey({ autoIncrement: true }),
    sku:   text('sku').notNull(),
    name:  text('name').notNull(),
    // Rule: money is integer minor units, never REAL.
    priceCents: integer('price_cents').notNull(),
    isActive:   integer('is_active', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    uniqueIndex('ux_products_sku').on(t.sku),
    check('ck_products_price_cents', sql`${t.priceCents} >= 0`),
    check('ck_products_is_active_bool', sql`${t.isActive} in (0, 1)`),
  ],
);

export const orderItems = sqliteTable(
  'order_items',
  {
    id:        integer('id').primaryKey({ autoIncrement: true }),
    orderId:   integer('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
    productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'restrict' }),
    quantity:  integer('quantity').notNull(),
    unitCents: integer('unit_cents').notNull(),
    // Rule 6 (postgres-dba): derived value we aggregate on -> STORED generated
    // column. Cannot drift; ports to Postgres GENERATED ... STORED.
    lineCents: integer('line_cents').generatedAlwaysAs(
      sql`quantity * unit_cents`,
      { mode: 'stored' },
    ),
  },
  (t) => [
    uniqueIndex('uq_order_items_order_product').on(t.orderId, t.productId),
    index('ix_order_items_order_id').on(t.orderId),
    check('ck_order_items_quantity', sql`${t.quantity} > 0`),
    check('ck_order_items_unit_cents', sql`${t.unitCents} >= 0`),
  ],
);

// Rule 3 (postgres-dba): pure many-to-many -> compound primary key, NO
// surrogate id, both sides NOT NULL FKs with CASCADE.
export const groups = sqliteTable(
  'groups',
  {
    id:   integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('ux_groups_name').on(t.name)],
);

export const groupsUsers = sqliteTable(
  'groups_users',
  {
    groupId: integer('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
    userId:  integer('user_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })], // the pair IS the identity
);

// Rule 8: JSON document store — relational spine + JSON body, a hot field
// lifted into a STORED generated column and indexed. Ports to Postgres jsonb.
type ProfileBody = { priority?: 'low' | 'normal' | 'high'; tags?: string[]; [k: string]: unknown };

export const customerProfiles = sqliteTable(
  'customer_profiles',
  {
    id:         integer('id').primaryKey({ autoIncrement: true }),
    customerId: integer('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    body:       text('body', { mode: 'json' }).$type<ProfileBody>().notNull(),
    // Lifted hot field. json_extract(...) -> Postgres body->>'priority'.
    priority: text('priority').generatedAlwaysAs(
      sql`json_extract(body, '$.priority')`,
      { mode: 'stored' },
    ),
  },
  (t) => [
    uniqueIndex('ux_customer_profiles_customer_id').on(t.customerId),
    index('ix_customer_profiles_priority').on(t.priority),
  ],
);
