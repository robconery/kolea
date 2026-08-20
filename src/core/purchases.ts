import { and, asc, count, desc, eq, gte, inArray, sql, sum } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { offers, purchaseStats, purchases } from '../db/schema.ts'
import { normalizeEmail } from './ids.ts'
import { rebuildPurchaseStatsSql } from './purchase-stats-sql.ts'

/**
 * Reading the commerce mirror.
 *
 * Everything here is read-only against `purchases` / `offers` / `purchase_stats`,
 * which are rebuilt from Neon by the sync. Nothing in this file writes a
 * purchase — if a number looks wrong, it is wrong in Postgres.
 *
 * ⚠️ Do not confuse these with `core/sales.ts`. `sales` is campaign-attributed
 * revenue this mailer can take credit for. `purchases` is the storefront's whole
 * history, unattributed, and reaches back to 2015. Summing both double-counts
 * every Stripe order placed since the mailer went live.
 */

export interface PurchaseRow {
  id: number
  offerSlug: string | null
  offerTitle: string | null
  store: string
  amountCents: number
  currency: string
  confidence: 'high' | 'low' | 'none'
  occurredAt: Date
}

/** Everything this address has ever bought, newest first. */
export async function purchasesForEmail(db: Db, email: string): Promise<PurchaseRow[]> {
  const normalized = normalizeEmail(email)
  if (!normalized) return []

  return await db
    .select({
      id: purchases.id,
      offerSlug: purchases.offerSlug,
      offerTitle: offers.title,
      store: purchases.store,
      amountCents: purchases.amountCents,
      currency: purchases.currency,
      confidence: purchases.confidence,
      occurredAt: purchases.occurredAt,
    })
    .from(purchases)
    .leftJoin(offers, eq(offers.id, purchases.offerId))
    .where(eq(purchases.email, normalized))
    .orderBy(desc(purchases.occurredAt))
    .all()
}

/** The rollup row, or null for somebody who has never bought anything. */
export async function statsForEmail(db: Db, email: string) {
  const normalized = normalizeEmail(email)
  if (!normalized) return null
  return (
    (await db.select().from(purchaseStats).where(eq(purchaseStats.email, normalized)).get()) ?? null
  )
}

/** Offers, active first then by the storefront's own ordering. For pickers. */
export async function listOffers(db: Db) {
  return await db
    .select()
    .from(offers)
    .orderBy(desc(offers.active), asc(offers.sortOrder), asc(offers.title))
    .all()
}

export interface OfferSales {
  slug: string
  title: string
  active: boolean
  orders: number
  buyers: number
  /** Buyers who are also on the list — how many this offer can actually reach. */
  onList: number
  cents: number
}

/**
 * What each offer has sold, all time. Drives the commerce overview page and
 * tells you which slugs are worth putting in front of a segment.
 */
export async function offerLeaderboard(db: Db): Promise<OfferSales[]> {
  const rows = await db
    .select({
      slug: purchases.offerSlug,
      title: offers.title,
      active: offers.active,
      orders: count(),
      buyers: sql<number>`count(distinct ${purchases.email})`,
      onList: sql<number>`count(distinct case when exists (
        select 1 from subscribers s where s.email = ${purchases.email}
      ) then ${purchases.email} end)`,
      cents: sql<number>`coalesce(sum(${purchases.amountCents}), 0)`,
    })
    .from(purchases)
    .leftJoin(offers, eq(offers.id, purchases.offerId))
    .groupBy(purchases.offerSlug)
    .orderBy(desc(sql`coalesce(sum(${purchases.amountCents}), 0)`))
    .all()

  return rows.map((r) => ({
    slug: r.slug ?? '(no offer)',
    title: r.title ?? r.slug ?? 'Unlinked order',
    active: r.active ?? false,
    orders: Number(r.orders),
    buyers: Number(r.buyers),
    onList: Number(r.onList),
    cents: Number(r.cents),
  }))
}

export interface CommerceTotals {
  orders: number
  buyers: number
  cents: number
  /** Buyers who are also on the list — the slice a segment can actually reach. */
  reachable: number
  firstAt: Date | null
  lastAt: Date | null
}

export async function commerceTotals(db: Db): Promise<CommerceTotals> {
  const totals = await db
    .select({
      orders: count(),
      buyers: sql<number>`count(distinct ${purchases.email})`,
      cents: sql<number>`coalesce(sum(${purchases.amountCents}), 0)`,
      firstAt: sql<number | null>`min(${purchases.occurredAt})`,
      lastAt: sql<number | null>`max(${purchases.occurredAt})`,
    })
    .from(purchases)
    .get()

  // Deliberately a raw join against `subscribers`: this is the one number that
  // says how much of the storefront the mailer can actually talk to.
  const reach = await db
    .select({ n: sql<number>`count(*)` })
    .from(purchaseStats)
    .where(sql`${purchaseStats.email} in (select email from subscribers)`)
    .get()

  return {
    orders: Number(totals?.orders ?? 0),
    buyers: Number(totals?.buyers ?? 0),
    cents: Number(totals?.cents ?? 0),
    reachable: Number(reach?.n ?? 0),
    firstAt: totals?.firstAt ? new Date(Number(totals.firstAt)) : null,
    lastAt: totals?.lastAt ? new Date(Number(totals.lastAt)) : null,
  }
}

/** The biggest spenders on the list. `null` email is impossible — it's the PK. */
export async function topBuyers(db: Db, limit = 25) {
  return await db
    .select({
      email: purchaseStats.email,
      orderCount: purchaseStats.orderCount,
      lifetimeCents: purchaseStats.lifetimeCents,
      lastAt: purchaseStats.lastAt,
    })
    .from(purchaseStats)
    .orderBy(desc(purchaseStats.lifetimeCents))
    .limit(limit)
    .all()
}

/**
 * Rebuild the rollup. Call after any write to `purchases`.
 *
 * Two statements, not 21,000 — the aggregate happens inside SQLite, so this
 * stays nowhere near D1's per-invocation query cap however many buyers there are.
 */
export async function rebuildPurchaseStats(db: Db): Promise<number> {
  for (const statement of rebuildPurchaseStatsSql(Date.now())) {
    await db.run(sql.raw(statement))
  }
  const row = await db.select({ n: count() }).from(purchaseStats).get()
  return row?.n ?? 0
}

/**
 * Which of these offer slugs actually exist. Used to warn on a segment that
 * quietly targets a typo — a rule matching a slug nothing was ever sold under
 * resolves to zero people and looks identical to a rule that is simply strict.
 */
export async function unknownOfferSlugs(db: Db, slugs: string[]): Promise<string[]> {
  const wanted = [...new Set(slugs.map((s) => s.trim()).filter(Boolean))]
  if (!wanted.length) return []

  const known = await db
    .select({ slug: offers.slug })
    .from(offers)
    .where(inArray(offers.slug, wanted))
    .all()

  const have = new Set(known.map((r) => r.slug))
  return wanted.filter((s) => !have.has(s))
}

/** Total spend across a set of addresses. Cheap because it reads the rollup. */
export async function spendForEmails(db: Db, emails: string[]): Promise<number> {
  const normalized = [...new Set(emails.map(normalizeEmail).filter(Boolean))]
  if (!normalized.length) return 0

  const row = await db
    .select({ cents: sum(purchaseStats.lifetimeCents) })
    .from(purchaseStats)
    .where(and(inArray(purchaseStats.email, normalized), gte(purchaseStats.lifetimeCents, 0)))
    .get()

  return Number(row?.cents ?? 0)
}
