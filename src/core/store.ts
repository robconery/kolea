import { and, asc, count, desc, eq, gt } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  type StoreCheckout,
  type StripePrice,
  type StripeProduct,
  sales,
  storeCheckouts,
  storeOffers,
  stripePrices,
  stripeProducts,
} from '../db/schema.ts'
import type { Env } from '../types.ts'
import { randomToken, slugify } from './ids.ts'
import { getPostById } from './posts.ts'
import type { SaleResult } from './sales.ts'
import { createOneOffCheckoutSession, type StripeCheckoutSession } from './stripe-client.ts'

/**
 * ⭐ The store: offer pages on the public site that start a Stripe Checkout.
 *
 * Ported from Kōlea SPEC 16.7.4.1–16.7.4.3, minus everything hosted (accounts,
 * Connect, platform fees, file delivery by grant). The rules that survive:
 *
 *  1. **Only what the operator put on sale is sold.** Buy names an offer slug,
 *     never a price — the price comes from the listing, and must still be an
 *     active one-time price on an active product. Quantity is always one.
 *  2. **The checkout row is written before Stripe is asked**, and it is what the
 *     webhook trusts. Its token is the session's `metadata.bm_checkout`; a
 *     completed session is matched back only when the session id agrees too.
 *  3. **The converting post is the click's to know.** `from` is a published
 *     post's broadcast id, checked at Buy; anything else is quietly dropped (a
 *     bad `from` must never cost a sale).
 *  4. **The money goes through the one sales door.** Completing a checkout is
 *     the existing `checkout.session.completed` path — `recordSale`, line items,
 *     `recordConversion` — plus marking this row. No mail is sent here; purchase
 *     mail stays a deliberate act (SPEC 16.4).
 *  5. **One IP gets at most 20 Checkouts an hour**, counted before the offer is
 *     looked up, so the answer is the same for any slug.
 */

export const CHECKOUTS_PER_IP_PER_HOUR = 20

/** Fixed paths under `/offers/` that a slug may never take. */
const RESERVED_SLUGS = new Set(['return', 'cancel', 'page'])

const HOUR_MS = 60 * 60 * 1000

// ───────────────────────────────────────────────── the operator's side

export interface CatalogEntry {
  product: StripeProduct
  /** Active one-time prices with an amount: the only ones a store can sell. */
  prices: StripePrice[]
  listing: { slug: string; priceId: string } | null
}

/** Every mirrored product, its sellable prices, and whether it is on sale. */
export async function storeCatalog(db: Db): Promise<CatalogEntry[]> {
  const [products, prices, listings] = await Promise.all([
    db.select().from(stripeProducts).orderBy(asc(stripeProducts.name)).all(),
    db
      .select()
      .from(stripePrices)
      .where(and(eq(stripePrices.active, true), eq(stripePrices.interval, 'one_time')))
      .orderBy(asc(stripePrices.unitAmount))
      .all(),
    db.select().from(storeOffers).all(),
  ])
  const byProduct = new Map<string, StripePrice[]>()
  for (const p of prices) {
    if (p.unitAmount === null) continue
    byProduct.set(p.productId, [...(byProduct.get(p.productId) ?? []), p])
  }
  const listed = new Map(listings.map((l) => [l.productId, l]))
  return products.map((product) => {
    const l = listed.get(product.id)
    return {
      product,
      prices: byProduct.get(product.id) ?? [],
      listing: l ? { slug: l.slug, priceId: l.priceId } : null,
    }
  })
}

export type PutOnSaleResult =
  | { ok: true; slug: string }
  | { ok: false; reason: 'no_product' | 'bad_price' | 'bad_slug' | 'slug_taken' }

/**
 * Put a product on sale at one of its prices, or change the price or slug of
 * one already on sale. The slug defaults to the product's SKU.
 */
export async function putOnSale(
  db: Db,
  input: { productId: string; priceId: string; slug?: string | null },
): Promise<PutOnSaleResult> {
  const product = await db
    .select()
    .from(stripeProducts)
    .where(eq(stripeProducts.id, input.productId))
    .get()
  if (!product || !product.active) return { ok: false, reason: 'no_product' }

  const price = await db.select().from(stripePrices).where(eq(stripePrices.id, input.priceId)).get()
  if (!price || !isSellablePrice(price, product.id)) return { ok: false, reason: 'bad_price' }

  const slug = slugify(input.slug?.trim() || product.metadata.sku || product.name)
  if (!slug || RESERVED_SLUGS.has(slug)) return { ok: false, reason: 'bad_slug' }

  const clash = await db.select().from(storeOffers).where(eq(storeOffers.slug, slug)).get()
  if (clash && clash.productId !== product.id) return { ok: false, reason: 'slug_taken' }

  const now = new Date()
  await db
    .insert(storeOffers)
    .values({ productId: product.id, priceId: price.id, slug, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: storeOffers.productId,
      set: { priceId: price.id, slug, updatedAt: now },
    })
  return { ok: true, slug }
}

/** Take a product off sale. Checkouts already started are untouched. */
export async function takeOffSale(db: Db, productId: string): Promise<void> {
  await db.delete(storeOffers).where(eq(storeOffers.productId, productId))
}

// ───────────────────────────────────────────────── the reader's side

export interface SellableOffer {
  slug: string
  product: StripeProduct
  price: StripePrice & { unitAmount: number }
}

function isSellablePrice(price: StripePrice, productId: string): price is StripePrice & {
  unitAmount: number
} {
  return (
    price.productId === productId &&
    price.active &&
    price.interval === 'one_time' &&
    price.unitAmount !== null &&
    price.unitAmount > 0
  )
}

/** The offer at `/offers/<slug>`, or null when it is not for sale right now. */
export async function sellableOffer(db: Db, slug: string): Promise<SellableOffer | null> {
  const row = await db
    .select({ offer: storeOffers, product: stripeProducts, price: stripePrices })
    .from(storeOffers)
    .innerJoin(stripeProducts, eq(stripeProducts.id, storeOffers.productId))
    .innerJoin(stripePrices, eq(stripePrices.id, storeOffers.priceId))
    .where(eq(storeOffers.slug, slug))
    .get()
  if (!row || !row.product.active || !isSellablePrice(row.price, row.product.id)) return null
  return { slug: row.offer.slug, product: row.product, price: row.price }
}

/** Everything on sale, for `/offers`. */
export async function sellableOffers(db: Db): Promise<SellableOffer[]> {
  const rows = await db
    .select({ offer: storeOffers, product: stripeProducts, price: stripePrices })
    .from(storeOffers)
    .innerJoin(stripeProducts, eq(stripeProducts.id, storeOffers.productId))
    .innerJoin(stripePrices, eq(stripePrices.id, storeOffers.priceId))
    .orderBy(asc(stripeProducts.name))
    .all()
  const out: SellableOffer[] = []
  for (const r of rows) {
    if (r.product.active && isSellablePrice(r.price, r.product.id)) {
      out.push({ slug: r.offer.slug, product: r.product, price: r.price })
    }
  }
  return out
}

/**
 * A `from` value from a URL or a form, as the converting post's broadcast id —
 * or null. Only a published post counts: a draft's id in a URL is a guess, and
 * crediting it would put a post nobody can read on the conversion record.
 */
export async function convertingPost(db: Db, raw: string | null | undefined): Promise<number | null> {
  if (!raw || !/^\d{1,10}$/.test(raw)) return null
  const post = await getPostById(db, Number(raw))
  return post ? post.id : null
}

export type StartCheckoutResult =
  | { ok: true; url: string; token: string }
  | { ok: false; reason: 'not_for_sale' | 'throttled' | 'not_configured' | 'stripe_error' }

/**
 * Buy: write the checkout row, then ask Stripe for a payment-mode session.
 *
 * The row comes first so a Stripe failure is a `failed` row with the reason on
 * it, not a click that left no trace.
 */
export async function startCheckout(
  env: Env,
  db: Db,
  input: {
    slug: string
    from?: string | null
    ip?: string | null
    userAgent?: string | null
    now?: Date
  },
): Promise<StartCheckoutResult> {
  const now = input.now ?? new Date()
  if (!env.STRIPE_SECRET_KEY || !env.SITE_URL) return { ok: false, reason: 'not_configured' }

  if (input.ip) {
    const started = await db
      .select({ n: count() })
      .from(storeCheckouts)
      .where(
        and(
          eq(storeCheckouts.ip, input.ip),
          gt(storeCheckouts.createdAt, new Date(now.getTime() - HOUR_MS)),
        ),
      )
      .get()
    if ((started?.n ?? 0) >= CHECKOUTS_PER_IP_PER_HOUR) return { ok: false, reason: 'throttled' }
  }

  const offer = await sellableOffer(db, input.slug)
  if (!offer) return { ok: false, reason: 'not_for_sale' }

  const token = randomToken(40)
  const inserted = await db
    .insert(storeCheckouts)
    .values({
      token,
      stripePriceId: offer.price.id,
      stripeProductId: offer.product.id,
      offerSlug: offer.slug,
      amountCents: offer.price.unitAmount,
      currency: offer.price.currency,
      convertedFromBroadcastId: await convertingPost(db, input.from),
      status: 'started',
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 400) ?? null,
      createdAt: now,
    })
    .returning({ id: storeCheckouts.id })
  const id = inserted[0]!.id

  const origin = env.SITE_URL.replace(/\/$/, '')
  try {
    const session = await createOneOffCheckoutSession(env, {
      priceId: offer.price.id,
      token,
      successUrl: `${origin}/offers/return?token=${token}`,
      cancelUrl: `${origin}/offers/cancel?token=${token}`,
    })
    await db
      .update(storeCheckouts)
      .set({ status: 'open', stripeSessionId: session.id })
      .where(eq(storeCheckouts.id, id))
    return { ok: true, url: session.url, token }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db
      .update(storeCheckouts)
      .set({ status: 'failed', lastError: message.slice(0, 500) })
      .where(eq(storeCheckouts.id, id))
    return { ok: false, reason: 'stripe_error' }
  }
}

export async function checkoutByToken(db: Db, token: string): Promise<StoreCheckout | null> {
  if (!/^[a-z0-9]{40}$/.test(token)) return null
  return (await db.select().from(storeCheckouts).where(eq(storeCheckouts.token, token)).get()) ?? null
}

// ───────────────────────────────────────────────── the webhook's side

/** The store token a completed session carries, if it is one of ours. */
export function storeTokenOf(session: StripeCheckoutSession): string | null {
  const token = session.metadata?.bm_checkout
  return typeof token === 'string' && token ? token : null
}

/**
 * Mark a store checkout completed against the sale the webhook just booked,
 * and copy the converting post onto the sale's meta so a sale reads whole
 * without a join.
 *
 * Idempotent: a redelivered event finds the row already completed and changes
 * nothing. A token whose row opened a different session completes nothing —
 * that is a session somebody else's token was pasted into.
 */
export async function completeStoreCheckout(
  db: Db,
  session: StripeCheckoutSession,
  sale: SaleResult,
): Promise<'completed' | 'already' | 'no_checkout' | 'session_mismatch'> {
  const token = storeTokenOf(session)
  if (!token || !sale.saleId) return 'no_checkout'

  const row = await db.select().from(storeCheckouts).where(eq(storeCheckouts.token, token)).get()
  if (!row) return 'no_checkout'
  if (row.stripeSessionId !== session.id) return 'session_mismatch'
  if (row.status === 'completed') return 'already'

  await db
    .update(storeCheckouts)
    .set({
      status: 'completed',
      saleId: sale.saleId,
      subscriberId: sale.subscriberId ?? null,
      completedAt: new Date(),
    })
    .where(eq(storeCheckouts.id, row.id))

  const current = await db
    .select({ meta: sales.meta })
    .from(sales)
    .where(eq(sales.id, sale.saleId))
    .get()
  await db
    .update(sales)
    .set({
      meta: {
        ...(current?.meta ?? {}),
        storeCheckoutId: row.id,
        offerSlug: row.offerSlug,
        convertedFromBroadcastId: row.convertedFromBroadcastId,
      },
    })
    .where(eq(sales.id, sale.saleId))

  return 'completed'
}

/** The newest checkouts, for the admin's For sale screen. */
export async function recentCheckouts(db: Db, limit = 25): Promise<StoreCheckout[]> {
  return await db
    .select()
    .from(storeCheckouts)
    .orderBy(desc(storeCheckouts.id))
    .limit(limit)
    .all()
}
