import { type SQL, and, asc, count, eq, gt, gte, inArray, lte, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  type Offer,
  type SegmentRule,
  type Tag,
  broadcasts,
  purchaseStats,
  purchases,
  segments,
  subscriberTags,
  subscribers,
} from '../db/schema.ts'
import { slugify } from './ids.ts'

export type { SegmentRule }

/** Rows resolved per invocation. Keeps us clear of D1's per-invocation query cap. */
const PAGE = 400

/**
 * Build the WHERE clauses for a rule.
 *
 * Shared by `resolveSegment` and `countSegment` so the number shown next to a
 * broadcast can never drift from the people it actually sends to.
 */
function ruleFilters(db: Db, rule: SegmentRule): SQL[] {
  const filters: SQL[] = [eq(subscribers.status, 'active')]

  const include = rule.includeTagIds ?? []
  if (include.length) {
    const tagged = db
      .select({ id: subscriberTags.subscriberId })
      .from(subscriberTags)
      .where(inArray(subscriberTags.tagId, include))

    if (rule.match === 'all' && include.length > 1) {
      // Must carry every tag, not just one of them.
      filters.push(
        inArray(
          subscribers.id,
          tagged
            .groupBy(subscriberTags.subscriberId)
            .having(sql`count(distinct ${subscriberTags.tagId}) = ${include.length}`),
        ),
      )
    } else {
      filters.push(inArray(subscribers.id, tagged))
    }
  }

  if (rule.excludeTagIds?.length) {
    const excluded = db
      .select({ id: subscriberTags.subscriberId })
      .from(subscriberTags)
      .where(inArray(subscriberTags.tagId, rule.excludeTagIds))
    filters.push(notInArray(subscribers.id, excluded))
  }

  if (rule.joinedAfter) filters.push(gte(subscribers.createdAt, new Date(rule.joinedAfter)))
  if (rule.joinedBefore) filters.push(lte(subscribers.createdAt, new Date(rule.joinedBefore)))

  filters.push(...purchaseFilters(db, rule))

  return filters
}

/**
 * The purchase half of a rule, resolved against the commerce mirror.
 *
 * Every clause is `subscribers.email IN (<indexed subquery>)`, never a join:
 * `purchases` is keyed by email rather than subscriber id (21k people have
 * bought something, 13.7k are on the list — see the schema comment), and the
 * spend and recency tests read the pre-aggregated `purchase_stats` rollup so a
 * segment count never aggregates 31k order rows.
 *
 * A buyer with no `purchase_stats` row simply isn't in any of these subqueries,
 * so "spent at least anything" correctly excludes people who never bought.
 */
function purchaseFilters(db: Db, rule: SegmentRule): SQL[] {
  const filters: SQL[] = []

  // Tested against `purchases` rather than the rollup: the rollup is derived, and
  // "has this person ever given me money" should not depend on a rebuild having
  // run. Cheap either way — `purchases_email_idx` covers it.
  if (typeof rule.hasPurchased === 'boolean') {
    const buyers = db.select({ email: purchases.email }).from(purchases)
    filters.push(
      rule.hasPurchased
        ? inArray(subscribers.email, buyers)
        : notInArray(subscribers.email, buyers),
    )
  }

  const bought = (rule.boughtOffers ?? []).map((s) => s.trim()).filter(Boolean)
  if (bought.length) {
    const buyers = db
      .select({ email: purchases.email })
      .from(purchases)
      .where(inArray(purchases.offerSlug, bought))

    if (rule.offerMatch === 'all' && bought.length > 1) {
      filters.push(
        inArray(
          subscribers.email,
          buyers
            .groupBy(purchases.email)
            .having(sql`count(distinct ${purchases.offerSlug}) = ${bought.length}`),
        ),
      )
    } else {
      filters.push(inArray(subscribers.email, buyers))
    }
  }

  // The "they already own it, stop pitching" filter. Note this excludes on ANY
  // match, always — "hasn't bought all of these" is not a thing anyone means.
  const notBought = (rule.notBoughtOffers ?? []).map((s) => s.trim()).filter(Boolean)
  if (notBought.length) {
    filters.push(
      notInArray(
        subscribers.email,
        db
          .select({ email: purchases.email })
          .from(purchases)
          .where(inArray(purchases.offerSlug, notBought)),
      ),
    )
  }

  // `confidentPurchasesOnly` swaps which column the money test reads. Both are
  // maintained by the same rebuild, so they can never disagree about a person.
  const spendColumn = rule.confidentPurchasesOnly
    ? purchaseStats.confidentCents
    : purchaseStats.lifetimeCents

  const statsWhere: SQL[] = []
  if (typeof rule.spentAtLeastCents === 'number') {
    statsWhere.push(gte(spendColumn, rule.spentAtLeastCents))
  }
  if (typeof rule.spentAtMostCents === 'number') {
    statsWhere.push(lte(spendColumn, rule.spentAtMostCents))
  }
  if (typeof rule.orderCountAtLeast === 'number') {
    statsWhere.push(gte(purchaseStats.orderCount, rule.orderCountAtLeast))
  }
  if (typeof rule.orderCountAtMost === 'number') {
    statsWhere.push(lte(purchaseStats.orderCount, rule.orderCountAtMost))
  }
  if (rule.purchasedAfter) {
    statsWhere.push(gte(purchaseStats.lastAt, new Date(rule.purchasedAfter)))
  }
  if (rule.purchasedBefore) {
    statsWhere.push(lte(purchaseStats.lastAt, new Date(rule.purchasedBefore)))
  }

  if (statsWhere.length) {
    filters.push(
      inArray(
        subscribers.email,
        db.select({ email: purchaseStats.email }).from(purchaseStats).where(and(...statsWhere)),
      ),
    )
  }

  return filters
}

/**
 * Resolve a rule to eligible broadcast recipients, after `afterId`.
 *
 * Broadcast eligibility only — sequence eligibility is a different question with
 * a different answer (see `consent.ts`).
 */
export async function resolveSegment(
  db: Db,
  rule: SegmentRule,
  afterId = 0,
  limit = PAGE,
): Promise<{ id: number; email: string; status: string }[]> {
  return await db
    .select({ id: subscribers.id, email: subscribers.email, status: subscribers.status })
    .from(subscribers)
    .where(and(...ruleFilters(db, rule), gt(subscribers.id, afterId)))
    .orderBy(asc(subscribers.id))
    .limit(limit)
    .all()
}

export async function countSegment(db: Db, rule: SegmentRule): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(subscribers)
    .where(and(...ruleFilters(db, rule)))
    .get()
  return row?.n ?? 0
}

// ───────────────────────────────────────────────── saved segments

export async function listSegments(db: Db) {
  return await db.select().from(segments).orderBy(asc(segments.name)).all()
}

export async function getSegment(db: Db, id: number) {
  return await db.select().from(segments).where(eq(segments.id, id)).get()
}

export async function createSegment(db: Db, name: string, rule: SegmentRule): Promise<number> {
  const inserted = await db
    .insert(segments)
    .values({ slug: await uniqueSlug(db, name), name, rule, createdAt: new Date() })
    .returning({ id: segments.id })
  return inserted[0]!.id
}

export async function updateSegment(
  db: Db,
  id: number,
  name: string,
  rule: SegmentRule,
): Promise<void> {
  await db.update(segments).set({ name, rule }).where(eq(segments.id, id))
}

export async function deleteSegment(db: Db, id: number): Promise<void> {
  await db.delete(segments).where(eq(segments.id, id))
}

/** Slugs are unique; a second "Customers" becomes `customers-2` rather than failing. */
async function uniqueSlug(db: Db, name: string): Promise<string> {
  const base = slugify(name) || 'segment'
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    const clash = await db.select({ id: segments.id }).from(segments).where(eq(segments.slug, slug)).get()
    if (!clash) return slug
  }
  return `${base}-${Date.now()}`
}

/** Point a rule's tag references at a different tag. Null when nothing changed. */
export function swapTagInRule(
  rule: SegmentRule,
  fromTagId: number,
  intoTagId: number,
): SegmentRule | null {
  const swap = (ids?: number[]) =>
    ids?.length ? [...new Set(ids.map((id) => (id === fromTagId ? intoTagId : id)))] : ids

  const next: SegmentRule = {
    ...rule,
    includeTagIds: swap(rule.includeTagIds),
    excludeTagIds: swap(rule.excludeTagIds),
  }
  return JSON.stringify(next) === JSON.stringify(rule) ? null : next
}

/**
 * Rewrite tag references after a merge, so merging `Customer` into `customers`
 * doesn't quietly leave segments pointing at a tag that no longer exists.
 */
export async function retagSegments(db: Db, fromTagId: number, intoTagId: number): Promise<number> {
  const all = await db.select().from(segments).all()
  let touched = 0

  for (const s of all) {
    const next = swapTagInRule(s.rule, fromTagId, intoTagId)
    if (!next) continue
    await db.update(segments).set({ rule: next }).where(eq(segments.id, s.id))
    touched++
  }
  return touched
}

/**
 * Same repointing for broadcasts that haven't gone out yet.
 *
 * Drafts only — a sent broadcast's stored rule is a record of who it went to,
 * and rewriting that would be falsifying history.
 */
export async function retagDraftBroadcasts(
  db: Db,
  fromTagId: number,
  intoTagId: number,
): Promise<number> {
  const drafts = await db
    .select({ id: broadcasts.id, segment: broadcasts.segment })
    .from(broadcasts)
    .where(eq(broadcasts.status, 'draft'))
    .all()
  let touched = 0

  for (const b of drafts) {
    const next = swapTagInRule(b.segment ?? {}, fromTagId, intoTagId)
    if (!next) continue
    await db.update(broadcasts).set({ segment: next }).where(eq(broadcasts.id, b.id))
    touched++
  }
  return touched
}

/**
 * Plain-English rule summary for tables and audience labels.
 *
 * `offers` is optional so every existing caller keeps working; pass it and offer
 * slugs render as the titles Rob knows them by instead of as kebab-case.
 */
export function describeRule(
  rule: SegmentRule,
  tags: Pick<Tag, 'id' | 'name'>[],
  offers: Pick<Offer, 'slug' | 'title'>[] = [],
): string {
  const name = (id: number) => tags.find((t) => t.id === id)?.name ?? `tag ${id}`
  const offerName = (slug: string) => offers.find((o) => o.slug === slug)?.title ?? slug
  const parts: string[] = []

  if (rule.includeTagIds?.length) {
    const joiner = rule.match === 'all' ? ' and ' : ' or '
    parts.push(`tagged ${rule.includeTagIds.map(name).join(joiner)}`)
  }
  if (rule.excludeTagIds?.length) {
    parts.push(`not tagged ${rule.excludeTagIds.map(name).join(' or ')}`)
  }
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { dateStyle: 'medium' })
  if (rule.joinedAfter) parts.push(`joined after ${day(rule.joinedAfter)}`)
  if (rule.joinedBefore) parts.push(`joined before ${day(rule.joinedBefore)}`)

  if (rule.hasPurchased === true) parts.push('has bought something')
  if (rule.hasPurchased === false) parts.push('has never bought anything')
  if (rule.boughtOffers?.length) {
    const joiner = rule.offerMatch === 'all' ? ' and ' : ' or '
    parts.push(`bought ${rule.boughtOffers.map(offerName).join(joiner)}`)
  }
  if (rule.notBoughtOffers?.length) {
    parts.push(`hasn't bought ${rule.notBoughtOffers.map(offerName).join(' or ')}`)
  }

  const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US')}`
  const qualifier = rule.confidentPurchasesOnly ? ' (confirmed orders only)' : ''
  if (typeof rule.spentAtLeastCents === 'number' && typeof rule.spentAtMostCents === 'number') {
    parts.push(
      `spent ${money(rule.spentAtLeastCents)}–${money(rule.spentAtMostCents)}${qualifier}`,
    )
  } else if (typeof rule.spentAtLeastCents === 'number') {
    parts.push(`spent ${money(rule.spentAtLeastCents)}+${qualifier}`)
  } else if (typeof rule.spentAtMostCents === 'number') {
    parts.push(`spent under ${money(rule.spentAtMostCents)}${qualifier}`)
  }

  if (rule.orderCountAtLeast === 1 && rule.orderCountAtMost === 1) {
    parts.push('bought exactly once')
  } else {
    if (typeof rule.orderCountAtLeast === 'number') {
      parts.push(
        rule.orderCountAtLeast === 2 ? 'bought more than once' : `${rule.orderCountAtLeast}+ orders`,
      )
    }
    if (typeof rule.orderCountAtMost === 'number') {
      parts.push(
        rule.orderCountAtMost === 1 ? 'only one order' : `${rule.orderCountAtMost} orders or fewer`,
      )
    }
  }
  if (rule.purchasedAfter) parts.push(`bought since ${day(rule.purchasedAfter)}`)
  if (rule.purchasedBefore) parts.push(`nothing since ${day(rule.purchasedBefore)}`)

  return parts.length === 0 ? 'Everyone active' : `Active, ${parts.join(', ')}`
}
