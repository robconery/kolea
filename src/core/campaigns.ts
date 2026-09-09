import { and, asc, count, countDistinct, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  attributions,
  broadcasts,
  campaigns,
  forms,
  messages,
  sales,
  sequenceSteps,
  sequences,
  subscribers,
} from '../db/schema.ts'
import { logActivity } from './activity.ts'
import { slugify } from './ids.ts'

export type SourceKind = 'form' | 'broadcast' | 'sequence' | 'manual'

// ───────────────────────────────────────────────── attribution

export interface Touch {
  subscriberId: number
  campaignId: number
  sourceKind: SourceKind
  sourceId?: number | null
  occurredAt?: Date
}

/**
 * Record how somebody arrived.
 *
 * Idempotent by (person, campaign, source) — the unique index does the work, so
 * a form submitted twice is still one touch and the original timestamp survives.
 * Returns true only when the touch was genuinely new.
 */
export async function recordTouch(db: Db, touch: Touch): Promise<boolean> {
  const inserted = await db
    .insert(attributions)
    .values({
      subscriberId: touch.subscriberId,
      campaignId: touch.campaignId,
      sourceKind: touch.sourceKind,
      sourceId: touch.sourceId ?? 0,
      occurredAt: touch.occurredAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: attributions.id })

  // Only the touch that was actually new. `attributions_touch_key` collapses
  // repeats on purpose — one person touching one campaign is one fact — and the
  // activity row has to agree with it, or the feed shows a re-submitted form as
  // a fresh arrival every time.
  if (inserted.length > 0) {
    await logActivity(db, {
      type: 'touched',
      subscriberId: touch.subscriberId,
      campaignId: touch.campaignId,
      occurredAt: touch.occurredAt ?? new Date(),
      meta: { sourceKind: touch.sourceKind, sourceId: touch.sourceId ?? 0 },
    })
  }

  return inserted.length > 0
}

/** The campaign that most recently brought this person back. Drives sale credit. */
export async function lastTouch(db: Db, subscriberId: number) {
  return await db
    .select()
    .from(attributions)
    .where(eq(attributions.subscriberId, subscriberId))
    .orderBy(desc(attributions.occurredAt), desc(attributions.id))
    .get()
}

/** The campaign that first brought this person in. Kept because you'll want it. */
export async function firstTouch(db: Db, subscriberId: number) {
  return await db
    .select()
    .from(attributions)
    .where(eq(attributions.subscriberId, subscriberId))
    .orderBy(asc(attributions.occurredAt), asc(attributions.id))
    .get()
}

export interface TouchRow {
  id: number
  campaignId: number
  campaignName: string
  campaignSlug: string
  sourceKind: SourceKind
  sourceId: number
  occurredAt: Date
}

export async function touchesFor(db: Db, subscriberId: number): Promise<TouchRow[]> {
  return (await db
    .select({
      id: attributions.id,
      campaignId: attributions.campaignId,
      campaignName: campaigns.name,
      campaignSlug: campaigns.slug,
      sourceKind: attributions.sourceKind,
      sourceId: attributions.sourceId,
      occurredAt: attributions.occurredAt,
    })
    .from(attributions)
    .innerJoin(campaigns, eq(campaigns.id, attributions.campaignId))
    .where(eq(attributions.subscriberId, subscriberId))
    .orderBy(asc(attributions.occurredAt))
    .all()) as TouchRow[]
}

/**
 * Turn an engagement event into a touch, if the message belongs to a campaign.
 *
 * Called from `recordEvent` on the click path, which is why it never throws at
 * its caller and does at most two indexed lookups before giving up. An open is
 * deliberately not a touch — it's too weak a signal to move revenue credit.
 */
export async function touchFromMessage(db: Db, messageId: number): Promise<boolean> {
  const msg = await db
    .select({
      subscriberId: messages.subscriberId,
      broadcastId: messages.broadcastId,
      sequenceStepId: messages.sequenceStepId,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()
  if (!msg) return false

  if (msg.broadcastId) {
    const b = await db
      .select({ campaignId: broadcasts.campaignId })
      .from(broadcasts)
      .where(eq(broadcasts.id, msg.broadcastId))
      .get()
    if (!b?.campaignId) return false
    return await recordTouch(db, {
      subscriberId: msg.subscriberId,
      campaignId: b.campaignId,
      sourceKind: 'broadcast',
      sourceId: msg.broadcastId,
    })
  }

  if (msg.sequenceStepId) {
    const step = await db
      .select({ sequenceId: sequenceSteps.sequenceId })
      .from(sequenceSteps)
      .where(eq(sequenceSteps.id, msg.sequenceStepId))
      .get()
    if (!step) return false
    const s = await db
      .select({ campaignId: sequences.campaignId })
      .from(sequences)
      .where(eq(sequences.id, step.sequenceId))
      .get()
    if (!s?.campaignId) return false
    return await recordTouch(db, {
      subscriberId: msg.subscriberId,
      campaignId: s.campaignId,
      sourceKind: 'sequence',
      sourceId: step.sequenceId,
    })
  }

  return false
}

// ───────────────────────────────────────────────── campaigns

export async function listCampaigns(db: Db) {
  return await db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).all()
}

export async function getCampaign(db: Db, id: number) {
  return await db.select().from(campaigns).where(eq(campaigns.id, id)).get()
}

export async function getCampaignBySlug(db: Db, slug: string) {
  return await db.select().from(campaigns).where(eq(campaigns.slug, slug)).get()
}

/** Slugs are unique, so a repeated name gets a numeric suffix rather than a 500. */
async function uniqueSlug(db: Db, name: string): Promise<string> {
  const base = slugify(name) || 'campaign'
  let slug = base
  for (let n = 2; await getCampaignBySlug(db, slug); n++) slug = `${base}-${n}`
  return slug
}

export async function createCampaign(
  db: Db,
  name: string,
  opts: { description?: string | null; goalCents?: number | null } = {},
): Promise<number> {
  const inserted = await db
    .insert(campaigns)
    .values({
      slug: await uniqueSlug(db, name),
      name,
      description: opts.description ?? null,
      goalCents: opts.goalCents ?? null,
      status: 'active',
      startedAt: new Date(),
      createdAt: new Date(),
    })
    .returning({ id: campaigns.id })
  return inserted[0]!.id
}

export interface Money {
  currency: string
  cents: number
}

export interface CampaignStats {
  /** Distinct people with at least one touch. */
  people: number
  orders: number
  refunds: number
  /** Net (paid minus refunded), one entry per currency seen. */
  revenue: Money[]
  forms: number
}

export async function campaignStats(db: Db, campaignId: number): Promise<CampaignStats> {
  const [people, byStatus, formCount] = await Promise.all([
    db
      .select({ n: countDistinct(attributions.subscriberId) })
      .from(attributions)
      .where(eq(attributions.campaignId, campaignId))
      .get(),
    db
      .select({
        currency: sales.currency,
        status: sales.status,
        n: count(),
        cents: sql<number>`coalesce(sum(${sales.amountCents}), 0)`,
      })
      .from(sales)
      .where(eq(sales.campaignId, campaignId))
      .groupBy(sales.currency, sales.status)
      .all(),
    db.select({ n: count() }).from(forms).where(eq(forms.campaignId, campaignId)).get(),
  ])

  // A refund flips its sale's row in place rather than adding a second one, so a
  // refunded row contributes nothing — it does NOT subtract. Subtracting would
  // count the reversal twice and report -$49 on a sale that netted zero.
  const net = new Map<string, number>()
  let orders = 0
  let refunds = 0
  for (const row of byStatus) {
    if (row.status === 'refunded') {
      refunds += row.n
      // Still register the currency, so a fully-refunded campaign shows $0.00.
      net.set(row.currency, net.get(row.currency) ?? 0)
      continue
    }
    net.set(row.currency, (net.get(row.currency) ?? 0) + Number(row.cents))
    orders += row.n
  }

  return {
    people: people?.n ?? 0,
    orders,
    refunds,
    revenue: [...net].map(([currency, cents]) => ({ currency, cents })),
    forms: formCount?.n ?? 0,
  }
}

/**
 * Everyone a campaign has touched, most recent touch first, one row per person.
 *
 * Deduped here rather than with a GROUP BY: SQLite would happily hand back the
 * bare columns from the max() row, but Postgres won't, and this schema is
 * written to survive that move.
 */
export async function campaignPeople(db: Db, campaignId: number, limit = 50) {
  const rows = await db
    .select({
      id: subscribers.id,
      email: subscribers.email,
      name: subscribers.name,
      status: subscribers.status,
      sourceKind: attributions.sourceKind,
      occurredAt: attributions.occurredAt,
    })
    .from(attributions)
    .innerJoin(subscribers, eq(subscribers.id, attributions.subscriberId))
    .where(eq(attributions.campaignId, campaignId))
    .orderBy(desc(attributions.occurredAt))
    .limit(limit * 4)
    .all()

  const seen = new Set<number>()
  const out: typeof rows = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
    if (out.length === limit) break
  }
  return out
}

export async function setCampaignStatus(db: Db, id: number, status: 'active' | 'archived') {
  await db
    .update(campaigns)
    .set({ status, endedAt: status === 'archived' ? new Date() : null })
    .where(eq(campaigns.id, id))
}

export async function updateCampaign(
  db: Db,
  id: number,
  patch: { name?: string; description?: string | null; goalCents?: number | null },
) {
  await db.update(campaigns).set(patch).where(eq(campaigns.id, id))
}

/**
 * Deleting a campaign throws away the label and its touches — never the mail
 * and never the money. Sales keep their rows and fall back to unattributed.
 */
export async function deleteCampaign(db: Db, id: number) {
  await db.delete(campaigns).where(eq(campaigns.id, id))
}

/** Campaigns a person has been touched by, deduped, for a compact summary line. */
export async function campaignsForSubscriber(db: Db, subscriberId: number) {
  return await db
    .selectDistinct({ id: campaigns.id, name: campaigns.name })
    .from(attributions)
    .innerJoin(campaigns, eq(campaigns.id, attributions.campaignId))
    .where(and(eq(attributions.subscriberId, subscriberId)))
    .all()
}
