import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { type SegmentRule, purchaseStats, purchases, subscribers } from '../db/schema.ts'
import { countSegment } from './segments.ts'

/**
 * Segments worth building, proposed from what people actually bought.
 *
 * Two kinds live here and they are not the same thing:
 *
 *   - **Shapes** — lifecycle splits every list has (customers, not-yet-customers,
 *     repeat buyers, lapsed). Fixed rules; only their sizes come from the data.
 *   - **Upsells** — pairs of offers derived from real co-purchase behaviour. Not
 *     a list of hunches about what goes with what: for every offer people own,
 *     we measure which other offer its owners *actually* went on to buy, then
 *     surface the ones where a large, reachable group hasn't yet.
 *
 * Every idea reports a size from `countSegment`, the same function a broadcast
 * uses, so a suggestion can never advertise an audience the send won't produce.
 * Nothing here writes anything — an idea becomes real only when Rob clicks.
 */

export interface SegmentIdea {
  /** Stable across runs, so the create form can round-trip one. */
  key: string
  title: string
  /** Why this is worth sending to. Shown under the title. */
  why: string
  group: 'lifecycle' | 'value' | 'upsell'
  rule: SegmentRule
  size: number
}

const DAY = 24 * 60 * 60 * 1000

/** Round a cents threshold to something a human would have chosen. */
function niceMoney(cents: number): number {
  const dollars = cents / 100
  for (const step of [1000, 500, 250, 100, 50, 25]) {
    if (dollars >= step) return Math.floor(dollars / step) * step * 100
  }
  return Math.max(2500, Math.round(dollars) * 100)
}

/**
 * The spend floor that isolates roughly the top decile of reachable customers.
 *
 * Derived rather than hardcoded: a $200 threshold means something different on a
 * list selling $30 books than on one selling $500 courses, and a suggestion that
 * matches four people is noise.
 */
async function bigSpenderFloor(db: Db, now: number): Promise<number> {
  const rows = await db
    .select({ cents: purchaseStats.lifetimeCents })
    .from(purchaseStats)
    .innerJoin(subscribers, eq(subscribers.email, purchaseStats.email))
    .where(eq(subscribers.status, 'active'))
    .orderBy(sql`${purchaseStats.lifetimeCents} desc`)
    .all()

  if (!rows.length) return 10_000
  const idx = Math.min(rows.length - 1, Math.floor(rows.length * 0.1))
  void now
  return niceMoney(Number(rows[idx]?.cents ?? 0))
}

interface Pair {
  ownedSlug: string
  ownedTitle: string
  missingSlug: string
  missingTitle: string
  owners: number
  alsoBought: number
  gap: number
  attachRate: number
}

/**
 * Co-purchase, restricted to people who are on the list.
 *
 * Restricted on purpose: an upsell suggestion is only interesting for an
 * audience that can be mailed, and the unreachable 13k buyers would otherwise
 * dominate every count and propose segments far bigger than any send.
 */
async function upsellPairs(db: Db): Promise<Pair[]> {
  const reachable = sql`(select email from subscribers where status = 'active')`

  const owners = await db
    .select({
      slug: purchases.offerSlug,
      n: sql<number>`count(distinct ${purchases.email})`,
    })
    .from(purchases)
    .where(sql`${purchases.email} in ${reachable} and ${purchases.offerSlug} is not null`)
    .groupBy(purchases.offerSlug)
    .all()

  const ownerCount = new Map(owners.map((o) => [o.slug ?? '', Number(o.n)]))

  // Raw SQL: this is a self-join with two aliases of the same table, which the
  // query builder has no way to express. One statement, grouped in SQLite.
  const pairs = (await db.all(sql`
    select a.offer_slug as a, b.offer_slug as b, count(distinct a.email) as n
    from purchases a
    join purchases b
      on b.email = a.email
     and b.offer_slug <> a.offer_slug
     and b.offer_slug is not null
    where a.email in ${reachable}
      and a.offer_slug is not null
    group by a.offer_slug, b.offer_slug
  `)) as { a: string; b: string; n: number }[]

  const titleRows = (await db.all(sql`select slug, title from offers`)) as {
    slug: string
    title: string
  }[]
  const titles = new Map(titleRows.map((r) => [r.slug, r.title]))

  const out: Pair[] = []
  for (const p of pairs) {
    const total = ownerCount.get(p.a) ?? 0
    const alsoBought = Number(p.n)
    const gap = total - alsoBought
    if (total < 50 || gap < 100) continue

    const attachRate = alsoBought / total
    // Below ~12% the pairing is coincidence, not a pattern worth mailing about.
    if (attachRate < 0.12) continue

    out.push({
      ownedSlug: p.a,
      ownedTitle: titles.get(p.a) ?? p.a,
      missingSlug: p.b,
      missingTitle: titles.get(p.b) ?? p.b,
      owners: total,
      alsoBought,
      gap,
      attachRate,
    })
  }

  // Rank by attach rate × reachable gap: a strong pattern with nobody left to
  // sell to is useless, and so is a big audience with no evidence behind it.
  out.sort((x, y) => y.attachRate * y.gap - x.attachRate * x.gap)
  return out
}

export async function suggestSegments(db: Db, now = Date.now()): Promise<SegmentIdea[]> {
  const floor = await bigSpenderFloor(db, now)
  const pairs = await upsellPairs(db)

  const drafts: Omit<SegmentIdea, 'size'>[] = [
    {
      key: 'not-yet-customers',
      title: 'Not yet customers',
      why: 'On the list, has never bought anything. The audience for an introductory offer — and the one segment no list of offer slugs can express.',
      group: 'lifecycle',
      rule: { hasPurchased: false },
    },
    {
      key: 'customers',
      title: 'Customers',
      why: 'Everyone on the list who has ever bought. Worth having saved simply so a broadcast can exclude it.',
      group: 'lifecycle',
      rule: { hasPurchased: true },
    },
    {
      key: 'repeat-buyers',
      title: 'Repeat buyers',
      why: 'Bought more than once. The people who already proved a second purchase is possible.',
      group: 'lifecycle',
      rule: { orderCountAtLeast: 2 },
    },
    {
      key: 'recent-buyers',
      title: 'Bought in the last 90 days',
      why: 'Warm, and the most likely to open. Also the group to suppress from a discount on something they just paid full price for.',
      group: 'lifecycle',
      rule: { purchasedAfter: now - 90 * DAY },
    },
    {
      key: 'lapsed',
      title: 'Lapsed customers',
      why: 'Bought at some point, nothing in two years. Re-engagement, not a hard sell.',
      group: 'lifecycle',
      rule: { hasPurchased: true, purchasedBefore: now - 730 * DAY },
    },
    {
      key: 'best-customers',
      title: `Best customers ($${(floor / 100).toLocaleString('en-US')}+)`,
      why: `Roughly the top tenth of customers you can email, by lifetime spend. Counts only orders we're sure about, so the number is safe to quote back to them.`,
      group: 'value',
      rule: { spentAtLeastCents: floor, confidentPurchasesOnly: true },
    },
    {
      key: 'one-and-done',
      title: 'Bought once, long ago',
      why: 'A single purchase, nothing in the last year. The biggest untapped group on most lists.',
      group: 'value',
      rule: { orderCountAtMost: 1, purchasedBefore: now - 365 * DAY },
    },
  ]

  for (const p of pairs.slice(0, 6)) {
    drafts.push({
      key: `upsell:${p.ownedSlug}:${p.missingSlug}`,
      title: `Owns ${p.ownedTitle}, not ${p.missingTitle}`,
      why:
        `${Math.round(p.attachRate * 100)}% of the ${p.owners.toLocaleString('en-US')} people here who own ` +
        `${p.ownedTitle} went on to buy ${p.missingTitle}. These ones haven't.`,
      group: 'upsell',
      rule: { boughtOffers: [p.ownedSlug], notBoughtOffers: [p.missingSlug] },
    })
  }

  const sized = await Promise.all(
    drafts.map(async (d) => ({ ...d, size: await countSegment(db, d.rule) })),
  )

  // An idea matching nobody is not an idea. Usually means the shape doesn't
  // apply to this list — which is itself worth not saying out loud.
  return sized.filter((d) => d.size > 0)
}

/** What the list looks like split by customer status. Header stats for the ideas page. */
export async function customerSplit(db: Db) {
  const active = await db
    .select({ n: sql<number>`count(*)` })
    .from(subscribers)
    .where(eq(subscribers.status, 'active'))
    .get()

  const buyers = await db
    .select({ n: sql<number>`count(*)` })
    .from(purchaseStats)
    .innerJoin(subscribers, eq(subscribers.email, purchaseStats.email))
    .where(and(eq(subscribers.status, 'active')))
    .get()

  const total = Number(active?.n ?? 0)
  const customers = Number(buyers?.n ?? 0)
  return { total, customers, prospects: total - customers }
}
