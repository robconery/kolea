import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { saleItems, stripePrices, stripeProducts, syncRuns } from '../db/schema.ts'
import type { Env } from '../types.ts'
import {
  type StripePriceObject,
  type StripeProductObject,
  idOf,
  requireStripeKey,
  stripeGet,
  stripePages,
} from './stripe-client.ts'

/**
 * A local mirror of the Stripe product catalog.
 *
 * ⚠️ Read `db/schema.ts` on `stripeProducts` before wiring anything to `offers`.
 * These are two different catalogs with two different owners — Stripe's products
 * and the Neon storefront's offers — and this file only ever writes the Stripe one.
 *
 * Why mirror at all, when Stripe's API is right there: a thank-you mail is
 * rendered inside a send, under D1's per-invocation query cap and with no budget
 * for a network round trip per recipient. The download location has to be a local
 * indexed row by the time the mail is built.
 */

/**
 * Products, then their prices. Two list endpoints, a hundred rows a page, and a
 * catalog measured in dozens — the cap is a runaway guard, not a real bound.
 */
const MAX_PAGES = 10

/**
 * Metadata keys that mean "this is where the file lives", in the order we trust
 * them. Stripe metadata is free-form and edited by hand in a dashboard, so this
 * accepts the obvious spellings rather than insisting on one.
 */
const DOWNLOAD_KEYS = ['download_url', 'download', 'file_url', 'file', 'url'] as const

export interface CatalogSummary {
  runId: number | null
  productsSeen: number
  productsWritten: number
  pricesSeen: number
  pricesWritten: number
  /** Products carrying no recognisable download location. Worth seeing. */
  withoutDownload: string[]
  notes: string[]
  pagesExhausted: boolean
}

/**
 * Pull the catalog and overwrite the local copy.
 *
 * Upsert, never delete-then-insert: `sale_items` reference product ids, and a
 * catalog that briefly does not contain a product is a thank-you mail that
 * briefly cannot find its download link. A product archived in Stripe arrives
 * with `active: false` and stays in the table — people who bought it still own it.
 */
export async function syncStripeCatalog(
  env: Env,
  db: Db,
  opts: { trigger?: 'cron' | 'mcp' | 'webhook' } = {},
): Promise<CatalogSummary> {
  requireStripeKey(env)

  const startedAt = new Date()
  const runId = (
    await db
      .insert(syncRuns)
      .values({
        kind: 'stripe_catalog',
        trigger: opts.trigger ?? 'mcp',
        status: 'running',
        startedAt,
      })
      .returning({ id: syncRuns.id })
  )[0]!.id

  const summary: CatalogSummary = {
    runId,
    productsSeen: 0,
    productsWritten: 0,
    pricesSeen: 0,
    pricesWritten: 0,
    withoutDownload: [],
    notes: [],
    pagesExhausted: false,
  }

  try {
    const products = await stripePages<StripeProductObject>(
      env,
      '/products',
      // Archived products included on purpose: somebody bought them, and their
      // download link has to keep resolving long after the product is retired.
      {},
      MAX_PAGES,
      async (page) => {
        for (const product of page) {
          summary.productsSeen++
          await upsertProduct(db, product)
          summary.productsWritten++
          if (!downloadUrlFrom(product.metadata ?? {})) summary.withoutDownload.push(product.id)
        }
      },
    )

    const prices = await stripePages<StripePriceObject>(
      env,
      '/prices',
      {},
      MAX_PAGES,
      async (page) => {
        for (const price of page) {
          summary.pricesSeen++
          if (await upsertPrice(db, price)) summary.pricesWritten++
          else summary.notes.push(`${price.id}: product not in the catalog, skipped`)
        }
      },
    )

    summary.pagesExhausted = products.pagesExhausted || prices.pagesExhausted
    if (summary.pagesExhausted) {
      summary.notes.push(
        `Stopped after ${MAX_PAGES} pages to stay inside the D1 query budget. Run again to pick up the rest.`,
      )
    }
    if (summary.withoutDownload.length) {
      summary.notes.push(
        `${summary.withoutDownload.length} product(s) carry no ${DOWNLOAD_KEYS[0]} metadata: ${summary.withoutDownload.slice(0, 10).join(', ')}`,
      )
    }

    await db
      .update(syncRuns)
      .set({
        status: summary.pagesExhausted ? 'partial' : 'ok',
        // `sync_runs` was shaped for the charge reconcile. Reusing its counters
        // for the catalog keeps one table and one screen: "charges" is products,
        // "sales recorded" is rows written. Named honestly in the notes.
        chargesSeen: summary.productsSeen + summary.pricesSeen,
        salesRecorded: summary.productsWritten + summary.pricesWritten,
        unattributed: summary.withoutDownload.length,
        notes: [
          `${summary.productsWritten}/${summary.productsSeen} products, ${summary.pricesWritten}/${summary.pricesSeen} prices`,
          ...summary.notes.slice(0, 49),
        ],
        finishedAt: new Date(),
      })
      .where(eq(syncRuns.id, runId))

    return summary
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db
      .update(syncRuns)
      .set({
        status: 'failed',
        chargesSeen: summary.productsSeen + summary.pricesSeen,
        salesRecorded: summary.productsWritten + summary.pricesWritten,
        notes: [...summary.notes.slice(0, 49), message],
        finishedAt: new Date(),
      })
      .where(eq(syncRuns.id, runId))
    throw err
  }
}

// ───────────────────────────────────────────────── single-object upserts

/** Also the `product.created` / `product.updated` webhook path. */
export async function upsertProduct(db: Db, product: StripeProductObject): Promise<void> {
  const now = new Date()
  const values = {
    id: product.id,
    name: product.name,
    description: product.description ?? null,
    active: product.active,
    defaultPriceId: idOf(product.default_price),
    metadata: product.metadata ?? {},
    stripeUpdated: product.updated ?? null,
    syncedAt: now,
  }

  await db
    .insert(stripeProducts)
    .values(values)
    .onConflictDoUpdate({ target: stripeProducts.id, set: { ...values, id: undefined } })
}

/**
 * Returns false when the price names a product we have never seen — which
 * happens the moment somebody creates a product and a price together and the
 * price webhook lands first. The caller notes it; the next catalog sync fixes it.
 */
export async function upsertPrice(db: Db, price: StripePriceObject): Promise<boolean> {
  const productId = idOf(price.product)
  if (!productId) return false

  const known = await db
    .select({ id: stripeProducts.id })
    .from(stripeProducts)
    .where(eq(stripeProducts.id, productId))
    .get()
  if (!known) return false

  const interval = price.recurring?.interval
  const values = {
    id: price.id,
    productId,
    nickname: price.nickname ?? null,
    unitAmount: price.unit_amount ?? null,
    currency: (price.currency || 'usd').toLowerCase(),
    interval: (interval === 'day' || interval === 'week' || interval === 'month' || interval === 'year'
      ? interval
      : 'one_time') as 'one_time' | 'day' | 'week' | 'month' | 'year',
    intervalCount: price.recurring?.interval_count ?? 1,
    active: price.active,
    metadata: price.metadata ?? {},
    syncedAt: new Date(),
  }

  await db
    .insert(stripePrices)
    .values(values)
    .onConflictDoUpdate({ target: stripePrices.id, set: { ...values, id: undefined } })
  return true
}

/** Fetch one product straight from Stripe and mirror it. For webhook handlers. */
export async function refreshProduct(env: Env, db: Db, productId: string): Promise<void> {
  const product = await stripeGet<StripeProductObject>(env, `/products/${productId}`, {})
  await upsertProduct(db, product)
}

// ───────────────────────────────────────────────── reading

/**
 * The download location on a product, or null.
 *
 * Kept as a function rather than a column so renaming the metadata key in the
 * Stripe dashboard is a one-line change here instead of a migration.
 */
export function downloadUrlFrom(metadata: Record<string, string>): string | null {
  for (const key of DOWNLOAD_KEYS) {
    const value = metadata[key]?.trim()
    if (value) return value
  }
  return null
}

export interface OwnedProduct {
  productId: string
  name: string
  description: string | null
  downloadUrl: string | null
  metadata: Record<string, string>
  purchasedAt: Date
}

/**
 * Everything this sale actually contained, with download links resolved.
 *
 * This is the query a thank-you mail is built from: one indexed join, no
 * network, safe to run per-recipient inside a send.
 */
export async function productsInSale(db: Db, saleId: number): Promise<OwnedProduct[]> {
  const rows = await db
    .select({
      productId: saleItems.stripeProductId,
      description: saleItems.description,
      createdAt: saleItems.createdAt,
      name: stripeProducts.name,
      productDescription: stripeProducts.description,
      metadata: stripeProducts.metadata,
    })
    .from(saleItems)
    .leftJoin(stripeProducts, eq(stripeProducts.id, saleItems.stripeProductId))
    .where(eq(saleItems.saleId, saleId))
    .orderBy(asc(saleItems.id))
    .all()

  return rows.map((r) => {
    const metadata = r.metadata ?? {}
    return {
      productId: r.productId ?? '',
      // Falls back to the line-item description: a product the catalog has not
      // caught up with should still show up by the name Stripe charged for it.
      name: r.name ?? r.description,
      description: r.productDescription,
      downloadUrl: downloadUrlFrom(metadata),
      metadata,
      purchasedAt: r.createdAt,
    }
  })
}

export async function listStripeProducts(db: Db, activeOnly = false) {
  return await db
    .select()
    .from(stripeProducts)
    .where(activeOnly ? eq(stripeProducts.active, true) : undefined)
    .orderBy(desc(stripeProducts.active), asc(stripeProducts.name))
    .all()
}

export async function pricesForProducts(db: Db, productIds: string[]) {
  const wanted = [...new Set(productIds.filter(Boolean))]
  if (!wanted.length) return []
  return await db
    .select()
    .from(stripePrices)
    .where(and(inArray(stripePrices.productId, wanted), eq(stripePrices.active, true)))
    .orderBy(asc(stripePrices.productId), asc(stripePrices.unitAmount))
    .all()
}
