import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { campaigns, sales, sequenceEnrollments, sequences, subscribers } from '../db/schema.ts'
import { getCampaignBySlug, lastTouch, recordTouch } from './campaigns.ts'
import { isValidEmail, normalizeEmail } from './ids.ts'
import { addTags, findOrCreateTag, upsertSubscriber } from './subscribers.ts'

export interface SaleInput {
  email: string
  name?: string | null
  amountCents: number
  currency?: string
  product?: string | null
  /** Your checkout's id. Makes this call idempotent and lets a refund find the sale. */
  externalId?: string | null
  /** Overrides last-touch attribution when you already know the campaign. */
  campaignSlug?: string | null
  /** Applied through the normal path, so a `tag_added` sequence can fire off a purchase. */
  tagNames?: string[]
  /** Slug of a sequence to stop — the "you already bought it, stop selling" case. */
  endSequenceSlug?: string | null
  status?: 'paid' | 'refunded'
  occurredAt?: Date
  meta?: Record<string, unknown>
}

export type SaleStatus = 'recorded' | 'refunded' | 'duplicate' | 'invalid_email' | 'invalid_amount'

export interface SaleResult {
  status: SaleStatus
  saleId?: number
  subscriberId?: number
  campaignId?: number | null
  campaignSlug?: string | null
  /** How the campaign was chosen — worth returning, because silent attribution lies. */
  attributedBy?: 'explicit' | 'last_touch' | 'none'
  tagsApplied?: number
  endedSequence?: boolean
  /** Non-fatal problems. The sale is still recorded; the warning says what was ignored. */
  warnings?: string[]
}

/**
 * Record money against a person.
 *
 * Idempotent on `externalId`: replaying the same charge returns the original
 * sale instead of double-counting revenue. Re-posting a known `externalId` with
 * `status: 'refunded'` flips that sale rather than inserting a second row, which
 * is exactly the shape a Stripe `charge.refunded` webhook arrives in.
 */
export async function recordSale(db: Db, input: SaleInput): Promise<SaleResult> {
  const warnings: string[] = []

  const email = normalizeEmail(input.email ?? '')
  if (!isValidEmail(email)) return { status: 'invalid_email' }

  const cents = Math.round(Number(input.amountCents))
  if (!Number.isFinite(cents) || cents < 0) return { status: 'invalid_amount' }

  const externalId = input.externalId?.trim() || null
  const wantsRefund = input.status === 'refunded'

  // ── replay / refund of a sale we already have
  if (externalId) {
    const existing = await db.select().from(sales).where(eq(sales.externalId, externalId)).get()
    if (existing) {
      // Report the attribution the original sale already has, rather than a bare
      // null — a replay that answers "no campaign" reads like a lost credit.
      const slug = existing.campaignId
        ? ((
            await db
              .select({ slug: campaigns.slug })
              .from(campaigns)
              .where(eq(campaigns.id, existing.campaignId))
              .get()
          )?.slug ?? null)
        : null

      if (wantsRefund && existing.status !== 'refunded') {
        await db.update(sales).set({ status: 'refunded' }).where(eq(sales.id, existing.id))
        return {
          status: 'refunded',
          saleId: existing.id,
          subscriberId: existing.subscriberId,
          campaignId: existing.campaignId,
          campaignSlug: slug,
        }
      }
      return {
        status: 'duplicate',
        saleId: existing.id,
        subscriberId: existing.subscriberId,
        campaignId: existing.campaignId,
        campaignSlug: slug,
      }
    }
  }

  // ── the buyer
  const existingSub = await db.select().from(subscribers).where(eq(subscribers.email, email)).get()
  let subscriberId = existingSub?.id
  if (!subscriberId) {
    const { id } = await upsertBuyer(db, email, input.name ?? null)
    if (!id) return { status: 'invalid_email' }
    subscriberId = id
  } else if (input.name && !existingSub?.name) {
    await db.update(subscribers).set({ name: input.name }).where(eq(subscribers.id, subscriberId))
  }

  // ── which campaign gets the credit
  let campaignId: number | null = null
  let campaignSlug: string | null = null
  let attributedBy: SaleResult['attributedBy'] = 'none'
  let explicit = false

  if (input.campaignSlug) {
    const campaign = await getCampaignBySlug(db, input.campaignSlug)
    if (campaign) {
      campaignId = campaign.id
      campaignSlug = campaign.slug
      attributedBy = 'explicit'
      explicit = true
    } else {
      // Never lose the sale over a typo — record it, and say loudly what happened.
      warnings.push(`unknown campaign "${input.campaignSlug}" — falling back to last touch`)
    }
  }

  if (!campaignId) {
    const touch = await lastTouch(db, subscriberId)
    if (touch) {
      const campaign = await db
        .select({ id: campaigns.id, slug: campaigns.slug })
        .from(campaigns)
        .where(eq(campaigns.id, touch.campaignId))
        .get()
      if (campaign) {
        campaignId = campaign.id
        campaignSlug = campaign.slug
        attributedBy = 'last_touch'
      }
    }
  }

  // ── the money
  const now = new Date()
  const inserted = await db
    .insert(sales)
    .values({
      subscriberId,
      campaignId,
      product: input.product?.trim() || null,
      amountCents: cents,
      currency: (input.currency || 'usd').toLowerCase(),
      status: wantsRefund ? 'refunded' : 'paid',
      externalId,
      meta: input.meta ?? {},
      occurredAt: input.occurredAt ?? now,
      createdAt: now,
    })
    .returning({ id: sales.id })

  const saleId = inserted[0]!.id

  // A campaign named on the sale itself is a touch we hadn't seen — record it so
  // the campaign's people count includes the person who bought from it.
  if (explicit && campaignId) {
    await recordTouch(db, {
      subscriberId,
      campaignId,
      sourceKind: 'manual',
      sourceId: null,
      occurredAt: input.occurredAt ?? now,
    })
  }

  // ── the consequences
  let tagsApplied = 0
  if (input.tagNames?.length) {
    const tagIds: number[] = []
    for (const name of input.tagNames.map((t) => t.trim()).filter(Boolean)) {
      tagIds.push(await findOrCreateTag(db, name))
    }
    // Through `addTags`, so a `tag_added` sequence fires: bought → tagged →
    // enrolled in onboarding. Same chain the auto-tagging rules use.
    tagsApplied = await addTags(db, subscriberId, tagIds)
  }

  let endedSequence = false
  if (input.endSequenceSlug) {
    endedSequence = await endSequenceFor(db, subscriberId, input.endSequenceSlug)
    if (!endedSequence) warnings.push(`no active enrollment in "${input.endSequenceSlug}" to end`)
  }

  return {
    status: 'recorded',
    saleId,
    subscriberId,
    campaignId,
    campaignSlug,
    attributedBy,
    tagsApplied,
    endedSequence,
    ...(warnings.length ? { warnings } : {}),
  }
}

/**
 * Buying something adds you to the list, but it does not make you a newsletter
 * signup — so `subscribe`-triggered sequences stay out of it. Post-purchase mail
 * comes from the tags on the sale, which is the explicit, visible path.
 */
async function upsertBuyer(db: Db, email: string, name: string | null) {
  return await upsertSubscriber(db, {
    email,
    name,
    source: 'sale',
    triggerSubscribeSequences: false,
  })
}

/**
 * Stop selling somebody a thing they just bought.
 *
 * Cancels the enrollment only. It deliberately does *not* write a
 * `sequence_optout` — that row means "this person chose to leave", and a
 * purchase is not that choice. They can be enrolled again later.
 */
async function endSequenceFor(db: Db, subscriberId: number, slug: string): Promise<boolean> {
  const seq = await db.select({ id: sequences.id }).from(sequences).where(eq(sequences.slug, slug)).get()
  if (!seq) return false

  const enrollment = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.sequenceId, seq.id),
        eq(sequenceEnrollments.subscriberId, subscriberId),
        eq(sequenceEnrollments.status, 'active'),
      ),
    )
    .get()
  if (!enrollment) return false

  await db
    .update(sequenceEnrollments)
    .set({ status: 'cancelled', nextRunAt: null })
    .where(eq(sequenceEnrollments.id, enrollment.id))
  return true
}

// ───────────────────────────────────────────────── reading

export async function listSales(db: Db, limit = 100) {
  return await db
    .select({
      sale: sales,
      email: subscribers.email,
      subscriberName: subscribers.name,
      campaignName: campaigns.name,
    })
    .from(sales)
    .innerJoin(subscribers, eq(subscribers.id, sales.subscriberId))
    .leftJoin(campaigns, eq(campaigns.id, sales.campaignId))
    .orderBy(desc(sales.occurredAt), desc(sales.id))
    .limit(limit)
    .all()
}

export async function salesForSubscriber(db: Db, subscriberId: number) {
  return await db
    .select({ sale: sales, campaignName: campaigns.name })
    .from(sales)
    .leftJoin(campaigns, eq(campaigns.id, sales.campaignId))
    .where(eq(sales.subscriberId, subscriberId))
    .orderBy(desc(sales.occurredAt))
    .all()
}

export async function salesForCampaign(db: Db, campaignId: number, limit = 50) {
  return await db
    .select({ sale: sales, email: subscribers.email, subscriberName: subscribers.name })
    .from(sales)
    .innerJoin(subscribers, eq(subscribers.id, sales.subscriberId))
    .where(eq(sales.campaignId, campaignId))
    .orderBy(desc(sales.occurredAt))
    .limit(limit)
    .all()
}

export interface RevenueTotals {
  currency: string
  cents: number
  orders: number
}

/**
 * Net revenue across everything, split by currency.
 *
 * A refund flips its sale's row rather than adding an offsetting one, so a
 * refunded row simply stops counting — see `campaignStats` for the same rule.
 */
export async function revenueTotals(db: Db, sinceMs?: number): Promise<RevenueTotals[]> {
  const rows = await db
    .select({
      currency: sales.currency,
      status: sales.status,
      n: sql<number>`count(*)`,
      cents: sql<number>`coalesce(sum(${sales.amountCents}), 0)`,
    })
    .from(sales)
    .where(sinceMs ? sql`${sales.occurredAt} >= ${sinceMs}` : undefined)
    .groupBy(sales.currency, sales.status)
    .all()

  const net = new Map<string, RevenueTotals>()
  for (const row of rows) {
    const entry = net.get(row.currency) ?? { currency: row.currency, cents: 0, orders: 0 }
    if (row.status !== 'refunded') {
      entry.cents += Number(row.cents)
      entry.orders += Number(row.n)
    }
    net.set(row.currency, entry)
  }
  return [...net.values()]
}
