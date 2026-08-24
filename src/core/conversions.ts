import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  broadcasts,
  campaigns,
  conversionKinds,
  conversions,
  events,
  messages,
  offers,
  saleItems,
  sales,
  sequenceSteps,
  sequences,
  stripePrices,
  stripeProducts,
  subscribers,
} from '../db/schema.ts'

/**
 * ⭐ Conversions — the bottom of the funnel.
 *
 * `sales` says money moved. This says a *goal was reached*, and freezes the path
 * the person took to reach it so a report written next year still reads the same.
 *
 * Three rules, all load-bearing (see `schema.ts` for the long form):
 *
 *  1. **One row per sale, first matching kind wins.** Kinds are walked in
 *     priority order, so `subscription_yearly` claims a sale before the
 *     `any_sale` catch-all can. Two rows would double every revenue sum.
 *  2. **Yearly is detected from the price interval**, never from product or
 *     offer. 6 of ~359 live yearly subs sit on the product tagged `sku: yearly`.
 *  3. **Refunds are ignored.** A sale is a sale — Rob refunds for reasons that
 *     say nothing about whether the mail worked. The refund still lives on
 *     `sales.status`, where accounting can find it.
 */

export type SourceKind = 'broadcast' | 'sequence' | 'form' | 'direct'

/**
 * How far back a click may reach to claim a sale.
 *
 * Different per source because the mail behaves differently: a broadcast is a
 * moment — if it worked, it worked that week. A sequence is a slow drip aimed at
 * exactly this outcome, so it gets the longer rope. Without a window at all, a
 * click from March silently credits an August sale, which is how attribution
 * quietly stops meaning anything.
 */
export const WINDOW_DAYS: Record<'broadcast' | 'sequence', number> = {
  broadcast: 7,
  sequence: 30,
}

const DAY_MS = 86_400_000
const MAX_WINDOW_MS = Math.max(...Object.values(WINDOW_DAYS)) * DAY_MS

// ───────────────────────────────────────────────────── kinds

export interface KindRow {
  id: number
  slug: string
  label: string
  ruleType: 'price_interval' | 'offer_in' | 'any_sale' | 'manual'
  ruleValue: string | null
  priority: number
  isActive: boolean
}

/** Active kinds in the order `classifyKind` walks them: lowest priority first. */
export async function listKinds(db: Db, includeInactive = false): Promise<KindRow[]> {
  const rows = await db
    .select()
    .from(conversionKinds)
    .orderBy(asc(conversionKinds.priority), asc(conversionKinds.id))
    .all()
  return (includeInactive ? rows : rows.filter((r) => r.isActive)) as KindRow[]
}

export async function getKind(db: Db, id: number) {
  return await db.select().from(conversionKinds).where(eq(conversionKinds.id, id)).get()
}

export async function createKind(
  db: Db,
  input: {
    slug: string
    label: string
    ruleType: KindRow['ruleType']
    ruleValue: string | null
    priority: number
  },
): Promise<number | null> {
  const slug = input.slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
  if (!slug || !input.label.trim()) return null

  const inserted = await db
    .insert(conversionKinds)
    .values({
      slug,
      label: input.label.trim(),
      ruleType: input.ruleType,
      ruleValue: input.ruleValue?.trim() || null,
      priority: input.priority,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: conversionKinds.id })
  return inserted[0]?.id ?? null
}

export async function updateKind(
  db: Db,
  id: number,
  patch: {
    label?: string
    ruleType?: KindRow['ruleType']
    ruleValue?: string | null
    priority?: number
    isActive?: boolean
  },
) {
  await db.update(conversionKinds).set(patch).where(eq(conversionKinds.id, id))
}

/**
 * Retiring a kind never deletes the conversions counted under it — `kind_id` is
 * `set null` and `kind_slug` is frozen on every row, so last quarter's report
 * still reads the same after a kind is dropped.
 */
export async function deleteKind(db: Db, id: number) {
  await db.delete(conversionKinds).where(eq(conversionKinds.id, id))
}

// ───────────────────────────────────────────────────── classification

/**
 * A live Stripe line item, as it arrives on the webhook. Typed loosely on purpose
 * — the payload shape is Stripe's to change.
 */
export interface LiveLineItem {
  price?: { recurring?: { interval?: string } | null } | null
  /** Epoch seconds. Invoice lines have no `price` object — see `intervalsFor`. */
  period?: { start: number; end: number } | null
}

/**
 * A billing period this long or longer counts as yearly.
 *
 * 300 days, not 365: Stripe prorates, and a mid-term upgrade bills a partial year
 * that is unambiguously still a yearly subscription. Nothing in the catalog bills
 * on a period between ten months and a year, so the slack costs nothing and the
 * strictness would cost real renewals.
 */
const YEARLY_PERIOD_SECONDS = 300 * 86_400

/** The intervals a sale actually billed on, from the live payload or the catalog. */
async function intervalsFor(
  db: Db,
  saleId: number,
  liveItems: LiveLineItem[],
): Promise<Set<string>> {
  const found = new Set<string>()

  for (const item of liveItems) {
    // Checkout line items carry an expanded price.
    if (item.price?.recurring?.interval) found.add(item.price.recurring.interval)
    // Invoice line items do not — in this API version the flat `price` object is
    // gone and only `pricing.price_details` remains, which has no interval. The
    // billed period is the signal that survives on the payload itself.
    const span = (item.period?.end ?? 0) - (item.period?.start ?? 0)
    if (span >= YEARLY_PERIOD_SECONDS) found.add('year')
  }

  if (found.size === 0) {
    // Fall back to the synced catalog. Consulted second on purpose: a product
    // bought seconds after it was created in Stripe is not in `stripe_prices`
    // yet, and a stale catalog must never downgrade a subscription.
    const rows = await db
      .select({ interval: stripePrices.interval })
      .from(saleItems)
      .innerJoin(stripePrices, eq(stripePrices.id, saleItems.stripePriceId))
      .where(eq(saleItems.saleId, saleId))
      .all()
    for (const r of rows) found.add(r.interval)
  }

  return found
}

/**
 * Which kind this sale is, by walking the kinds table in priority order.
 *
 * FIRST match wins, which is what keeps "one row per sale, most specific kind"
 * true — a yearly subscription is also a sale, and the `any_sale` catch-all sits
 * at the back of the queue precisely so it only claims what nothing else did.
 *
 * Returns null when nothing matched, which happens only if every kind was retired
 * or all of them are `manual`. The caller records nothing rather than inventing a
 * category.
 */
export async function classifyKind(
  db: Db,
  saleId: number,
  liveItems: LiveLineItem[] = [],
  offerSlug: string | null = null,
): Promise<KindRow | null> {
  const kinds = await listKinds(db)
  if (!kinds.length) return null

  // Only computed if some kind actually asks about intervals — most sales are a
  // plain purchase, and this saves the query on every one of them.
  let intervals: Set<string> | null = null

  for (const kind of kinds) {
    switch (kind.ruleType) {
      case 'price_interval': {
        if (!kind.ruleValue) break
        intervals ??= await intervalsFor(db, saleId, liveItems)
        if (intervals.has(kind.ruleValue)) return kind
        break
      }
      case 'offer_in': {
        if (!kind.ruleValue || !offerSlug) break
        const wanted = kind.ruleValue
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        if (wanted.includes(offerSlug)) return kind
        break
      }
      case 'any_sale':
        return kind
      case 'manual':
        break
    }
  }

  return null
}

/**
 * Which offer this sale was for.
 *
 * Walks `sale_items → stripe_products.metadata.sku → offers.slug`. That sku is
 * the one spine that survives Rob running three separate Stripe accounts — a sku
 * does not care which account issued it, and a price id very much does.
 *
 * Returns null for a membership, which genuinely is not an offer. An honest
 * answer, not a gap to paper over.
 */
export async function resolveOffer(
  db: Db,
  saleId: number,
): Promise<{ offerId: number; offerSlug: string } | null> {
  const row = await db
    .select({ id: offers.id, slug: offers.slug })
    .from(saleItems)
    .innerJoin(stripeProducts, eq(stripeProducts.id, saleItems.stripeProductId))
    .innerJoin(offers, eq(offers.slug, sql`json_extract(${stripeProducts.metadata}, '$.sku')`))
    .where(eq(saleItems.saleId, saleId))
    .get()

  return row ? { offerId: row.id, offerSlug: row.slug } : null
}

// ───────────────────────────────────────────────────── attribution

export interface Touch {
  messageId: number
  sourceKind: 'broadcast' | 'sequence'
  sourceId: number
  campaignId: number | null
  occurredAt: Date
}

/**
 * The click that gets the credit: last-touch, inside a per-source window.
 *
 * Reads `events` rather than the `attributions` ledger on purpose. `attributions`
 * only records a touch when the mail carries a campaign, so the newsletter — most
 * of what goes out — leaves no trace there at all. `events` has a row for every
 * tracked click with the message id already on it, which is also the grain the
 * funnel needs.
 *
 * An open is never a touch. Apple's Mail Privacy Protection fires opens from
 * proxies, so crediting them would hand revenue to whoever mailed most recently.
 */
export async function lastClick(db: Db, subscriberId: number, at: Date): Promise<Touch | null> {
  const until = at.getTime()

  // Widest window first, then each candidate is held to its own. Twenty is far
  // past the point where an older click could still win.
  const clicks = await db
    .select({
      messageId: messages.id,
      broadcastId: messages.broadcastId,
      sequenceStepId: messages.sequenceStepId,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .innerJoin(messages, eq(messages.id, events.messageId))
    .where(
      and(
        eq(messages.subscriberId, subscriberId),
        eq(events.type, 'click'),
        gte(events.occurredAt, new Date(until - MAX_WINDOW_MS)),
        lte(events.occurredAt, at),
      ),
    )
    .orderBy(desc(events.occurredAt))
    .limit(20)
    .all()

  for (const click of clicks) {
    const ageDays = (until - click.occurredAt.getTime()) / DAY_MS

    if (click.broadcastId) {
      if (ageDays > WINDOW_DAYS.broadcast) continue
      const b = await db
        .select({ campaignId: broadcasts.campaignId })
        .from(broadcasts)
        .where(eq(broadcasts.id, click.broadcastId))
        .get()
      return {
        messageId: click.messageId,
        sourceKind: 'broadcast',
        sourceId: click.broadcastId,
        campaignId: b?.campaignId ?? null,
        occurredAt: click.occurredAt,
      }
    }

    if (click.sequenceStepId) {
      if (ageDays > WINDOW_DAYS.sequence) continue
      const step = await db
        .select({ sequenceId: sequenceSteps.sequenceId })
        .from(sequenceSteps)
        .where(eq(sequenceSteps.id, click.sequenceStepId))
        .get()
      if (!step) continue
      const s = await db
        .select({ campaignId: sequences.campaignId })
        .from(sequences)
        .where(eq(sequences.id, step.sequenceId))
        .get()
      return {
        messageId: click.messageId,
        sourceKind: 'sequence',
        sourceId: step.sequenceId,
        campaignId: s?.campaignId ?? null,
        occurredAt: click.occurredAt,
      }
    }
  }

  return null
}

// ───────────────────────────────────────────────────── ingest

export type ConversionStatus = 'recorded' | 'duplicate' | 'no_sale' | 'no_kind'

export interface ConversionResult {
  status: ConversionStatus
  conversionId?: number
  kindSlug?: string
  offerSlug?: string | null
  campaignId?: number | null
  attributedBy?: 'explicit' | 'last_touch' | 'none'
}

/**
 * Turn a recorded sale into a conversion.
 *
 * Idempotent through `conversions_sale_key`, so a redelivered Stripe webhook is a
 * no-op rather than a doubled figure. Must be called AFTER `attachSaleItems` —
 * both the kind and the offer are read off the line items.
 *
 * A refunded sale still converts. See the header note.
 */
export async function recordConversion(
  db: Db,
  saleId: number,
  liveItems: LiveLineItem[] = [],
): Promise<ConversionResult> {
  const sale = await db.select().from(sales).where(eq(sales.id, saleId)).get()
  if (!sale) return { status: 'no_sale' }

  const existing = await db
    .select({ id: conversions.id, kindSlug: conversions.kindSlug })
    .from(conversions)
    .where(eq(conversions.saleId, saleId))
    .get()
  if (existing) {
    return { status: 'duplicate', conversionId: existing.id, kindSlug: existing.kindSlug }
  }

  // Offer first — an `offer_in` kind (a cohort) needs it to match on.
  const offer = await resolveOffer(db, saleId)
  const kind = await classifyKind(db, saleId, liveItems, offer?.offerSlug ?? null)
  if (!kind) return { status: 'no_kind' }

  // An explicit campaign on the sale is a human decision and outranks the click.
  let campaignId = sale.campaignId
  let attributedBy: 'explicit' | 'last_touch' | 'none' = campaignId ? 'explicit' : 'none'
  let messageId: number | null = null
  let sourceKind: SourceKind = 'direct'
  let sourceId = 0
  let touchLagSeconds: number | null = null

  const touch = await lastClick(db, sale.subscriberId, sale.occurredAt)
  if (touch) {
    messageId = touch.messageId
    sourceKind = touch.sourceKind
    sourceId = touch.sourceId
    touchLagSeconds = Math.round((sale.occurredAt.getTime() - touch.occurredAt.getTime()) / 1000)
    if (!campaignId) {
      campaignId = touch.campaignId
      attributedBy = 'last_touch'
    }
  }

  const inserted = await db
    .insert(conversions)
    .values({
      subscriberId: sale.subscriberId,
      kindId: kind.id,
      kindSlug: kind.slug,
      saleId: sale.id,
      valueCents: sale.amountCents,
      currency: sale.currency,
      messageId,
      sourceKind,
      sourceId,
      campaignId,
      offerId: offer?.offerId ?? null,
      offerSlug: offer?.offerSlug ?? null,
      attributedBy,
      touchLagSeconds,
      occurredAt: sale.occurredAt,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: conversions.id })

  // Lost a race with a concurrent webhook delivery — the other one wrote it.
  if (!inserted.length) {
    const row = await db
      .select({ id: conversions.id })
      .from(conversions)
      .where(eq(conversions.saleId, sale.id))
      .get()
    return { status: 'duplicate', conversionId: row?.id, kindSlug: kind.slug }
  }

  return {
    status: 'recorded',
    conversionId: inserted[0]?.id,
    kindSlug: kind.slug,
    offerSlug: offer?.offerSlug ?? null,
    campaignId,
    attributedBy,
  }
}

// ───────────────────────────────────────────────────── editing

export interface ConversionEdit {
  kindSlug?: string
  campaignId?: number | null
  offerSlug?: string | null
  valueCents?: number
}

/**
 * A human correcting the record.
 *
 * Anything set here is stamped `attributed_by: 'explicit'`. Every automatic pass
 * skips a sale that already has a conversion, so a correction made here is not
 * quietly undone by the next backfill.
 */
export async function editConversion(db: Db, id: number, edit: ConversionEdit): Promise<boolean> {
  const patch: Record<string, unknown> = { attributedBy: 'explicit' }

  if (edit.kindSlug) {
    const kind = await db
      .select({ id: conversionKinds.id, slug: conversionKinds.slug })
      .from(conversionKinds)
      .where(eq(conversionKinds.slug, edit.kindSlug))
      .get()
    if (kind) {
      patch.kindId = kind.id
      patch.kindSlug = kind.slug
    }
  }
  if (edit.valueCents !== undefined && Number.isFinite(edit.valueCents)) {
    patch.valueCents = Math.max(0, Math.round(edit.valueCents))
  }
  if (edit.campaignId !== undefined) patch.campaignId = edit.campaignId
  if (edit.offerSlug !== undefined) {
    if (!edit.offerSlug) {
      patch.offerId = null
      patch.offerSlug = null
    } else {
      const offer = await db
        .select({ id: offers.id, slug: offers.slug })
        .from(offers)
        .where(eq(offers.slug, edit.offerSlug))
        .get()
      if (offer) {
        patch.offerId = offer.id
        patch.offerSlug = offer.slug
      }
    }
  }

  const res = await db
    .update(conversions)
    .set(patch)
    .where(eq(conversions.id, id))
    .returning({ id: conversions.id })
  return res.length > 0
}

export async function deleteConversion(db: Db, id: number): Promise<boolean> {
  const res = await db
    .delete(conversions)
    .where(eq(conversions.id, id))
    .returning({ id: conversions.id })
  return res.length > 0
}

// ───────────────────────────────────────────────────── reads

export interface ConversionRow {
  id: number
  kindSlug: string
  kindLabel: string | null
  valueCents: number
  currency: string
  occurredAt: Date
  subscriberId: number
  email: string
  name: string | null
  offerSlug: string | null
  campaignId: number | null
  campaignName: string | null
  sourceKind: SourceKind
  sourceId: number
  messageId: number | null
  attributedBy: string
  touchLagSeconds: number | null
  saleId: number | null
}

export async function listConversions(db: Db, limit = 100, offset = 0): Promise<ConversionRow[]> {
  return (await db
    .select({
      id: conversions.id,
      kindSlug: conversions.kindSlug,
      kindLabel: conversionKinds.label,
      valueCents: conversions.valueCents,
      currency: conversions.currency,
      occurredAt: conversions.occurredAt,
      subscriberId: conversions.subscriberId,
      email: subscribers.email,
      name: subscribers.name,
      offerSlug: conversions.offerSlug,
      campaignId: conversions.campaignId,
      campaignName: campaigns.name,
      sourceKind: conversions.sourceKind,
      sourceId: conversions.sourceId,
      messageId: conversions.messageId,
      attributedBy: conversions.attributedBy,
      touchLagSeconds: conversions.touchLagSeconds,
      saleId: conversions.saleId,
    })
    .from(conversions)
    .innerJoin(subscribers, eq(subscribers.id, conversions.subscriberId))
    .leftJoin(campaigns, eq(campaigns.id, conversions.campaignId))
    .leftJoin(conversionKinds, eq(conversionKinds.id, conversions.kindId))
    .orderBy(desc(conversions.occurredAt))
    .limit(limit)
    .offset(offset)
    .all()) as ConversionRow[]
}

export async function getConversion(db: Db, id: number) {
  return await db.select().from(conversions).where(eq(conversions.id, id)).get()
}

export interface ConversionTotals {
  kindSlug: string
  label: string | null
  n: number
  cents: number
}

/** Totals per kind, optionally inside a window. The shape every goal reads. */
export async function conversionTotals(
  db: Db,
  since?: Date,
  until?: Date,
): Promise<ConversionTotals[]> {
  const bounds = [
    ...(since ? [gte(conversions.occurredAt, since)] : []),
    ...(until ? [lte(conversions.occurredAt, until)] : []),
  ]

  return (await db
    .select({
      kindSlug: conversions.kindSlug,
      label: conversionKinds.label,
      n: sql<number>`count(*)`,
      cents: sql<number>`coalesce(sum(${conversions.valueCents}), 0)`,
    })
    .from(conversions)
    .leftJoin(conversionKinds, eq(conversionKinds.id, conversions.kindId))
    .where(bounds.length ? and(...bounds) : undefined)
    .groupBy(conversions.kindSlug, conversionKinds.label)
    .all()) as ConversionTotals[]
}

/** Conversions credited to each broadcast, for the funnel's last column. */
export async function conversionsByBroadcast(
  db: Db,
  broadcastIds: number[],
): Promise<Map<number, { n: number; cents: number }>> {
  const out = new Map<number, { n: number; cents: number }>()
  if (!broadcastIds.length) return out

  const rows = await db
    .select({
      sourceId: conversions.sourceId,
      n: sql<number>`count(*)`,
      cents: sql<number>`coalesce(sum(${conversions.valueCents}), 0)`,
    })
    .from(conversions)
    .where(and(eq(conversions.sourceKind, 'broadcast'), inArray(conversions.sourceId, broadcastIds)))
    .groupBy(conversions.sourceId)
    .all()

  for (const r of rows) out.set(r.sourceId, { n: r.n, cents: r.cents })
  return out
}

export interface Funnel {
  reached: number
  opened: number
  clicked: number
  converted: number
  cents: number
}

/** The whole funnel for one broadcast, in the same keyspace end to end. */
export async function broadcastFunnel(db: Db, broadcastId: number): Promise<Funnel> {
  const counts = await db
    .select({
      reached: sql<number>`count(distinct ${messages.id})`,
      opened: sql<number>`count(distinct case when ${events.type} = 'open' then ${messages.id} end)`,
      clicked: sql<number>`count(distinct case when ${events.type} = 'click' then ${messages.id} end)`,
      bounced: sql<number>`count(distinct case when ${events.type} = 'bounce' then ${messages.id} end)`,
    })
    .from(messages)
    .leftJoin(events, eq(events.messageId, messages.id))
    .where(eq(messages.broadcastId, broadcastId))
    .get()

  const conv = await db
    .select({
      n: sql<number>`count(*)`,
      cents: sql<number>`coalesce(sum(${conversions.valueCents}), 0)`,
    })
    .from(conversions)
    .where(and(eq(conversions.sourceKind, 'broadcast'), eq(conversions.sourceId, broadcastId)))
    .get()

  // Rates are always over `reached - bounced`, never over delivered — Resend's
  // delivered webhooks cover only a fraction of what goes out.
  return {
    reached: Math.max(0, (counts?.reached ?? 0) - (counts?.bounced ?? 0)),
    opened: counts?.opened ?? 0,
    clicked: counts?.clicked ?? 0,
    converted: conv?.n ?? 0,
    cents: conv?.cents ?? 0,
  }
}

/** Sales with no conversion row yet — what the backfill would pick up. */
export async function unconvertedSales(db: Db, limit = 200) {
  return await db
    .select({
      id: sales.id,
      subscriberId: sales.subscriberId,
      amountCents: sales.amountCents,
      product: sales.product,
      occurredAt: sales.occurredAt,
    })
    .from(sales)
    .leftJoin(conversions, eq(conversions.saleId, sales.id))
    .where(sql`${conversions.id} is null`)
    .orderBy(desc(sales.occurredAt))
    .limit(limit)
    .all()
}

/** Offers, for the editor's pickers. */
export async function offerOptions(db: Db) {
  return await db
    .select({ id: offers.id, slug: offers.slug, title: offers.title, active: offers.active })
    .from(offers)
    .orderBy(desc(offers.active), offers.title)
    .all()
}

/** Conversions for one person, for the subscriber timeline. */
export async function conversionsForSubscriber(db: Db, subscriberId: number) {
  return await db
    .select()
    .from(conversions)
    .where(eq(conversions.subscriberId, subscriberId))
    .orderBy(desc(conversions.occurredAt))
    .all()
}
