import { sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'

/**
 * The numbers a dashboard leads with.
 *
 * Every query here is scoped one of two ways, and the difference matters more
 * than any single figure:
 *
 *   - **Storefront-wide** — all 21k buyers. What the business did.
 *   - **Reachable** — buyers who are active subscribers. What this mailer can
 *     act on.
 *
 * Each function says which it is. Mixing them produces a dashboard that quietly
 * overstates every opportunity, because two thirds of the buyers can't be mailed.
 */

const DAY = 24 * 60 * 60 * 1000
const REACHABLE = sql`(select email from subscribers where status = 'active')`

export interface MonthPoint {
  month: string
  orders: number
  cents: number
}

/** Storefront-wide revenue by month, oldest first, gap-filled. */
export async function revenueByMonth(db: Db, months = 12, now = Date.now()): Promise<MonthPoint[]> {
  const since = now - months * 31 * DAY
  const rows = (await db.all(sql`
    select strftime('%Y-%m', occurred_at / 1000, 'unixepoch') as month,
           count(*) as orders,
           sum(amount_cents) as cents
    from purchases
    where occurred_at >= ${since}
    group by month
  `)) as { month: string; orders: number; cents: number }[]

  const found = new Map(rows.map((r) => [r.month, r]))

  // Gap-filled from a real calendar walk, not from the rows that exist. A month
  // with no sales is data — dropping it silently compresses the axis and makes a
  // quiet stretch look like continuous trading.
  const out: MonthPoint[] = []
  const cursor = new Date(now)
  cursor.setUTCDate(1)
  cursor.setUTCMonth(cursor.getUTCMonth() - (months - 1))
  for (let i = 0; i < months; i++) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`
    const hit = found.get(key)
    out.push({
      month: key,
      orders: Number(hit?.orders ?? 0),
      cents: Number(hit?.cents ?? 0),
    })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return out
}

export interface Tier {
  key: 'none' | 'once' | 'few' | 'loyal'
  label: string
  hint: string
  people: number
  cents: number
  avgCents: number
}

/**
 * The list split by how often people have bought. **Reachable only** — this is a
 * picture of the audience, not of the storefront.
 *
 * Four ordered tiers rather than customers-vs-not: the interesting story on most
 * lists is the gap between one-time and repeat, and a two-slice split hides it.
 */
export async function customerTiers(db: Db): Promise<Tier[]> {
  const rows = (await db.all(sql`
    select
      case
        when coalesce(ps.order_count, 0) = 0 then 'none'
        when ps.order_count = 1 then 'once'
        when ps.order_count <= 4 then 'few'
        else 'loyal'
      end as k,
      count(*) as people,
      coalesce(sum(ps.lifetime_cents), 0) as cents
    from subscribers s
    left join purchase_stats ps on ps.email = s.email
    where s.status = 'active'
    group by k
  `)) as { k: Tier['key']; people: number; cents: number }[]

  const meta: { key: Tier['key']; label: string; hint: string }[] = [
    { key: 'none', label: 'Never bought', hint: 'on the list, no purchase' },
    { key: 'once', label: 'Bought once', hint: 'the biggest upsell pool' },
    { key: 'few', label: 'Bought 2–4 times', hint: 'came back at least once' },
    { key: 'loyal', label: 'Bought 5+ times', hint: 'buy almost anything you make' },
  ]

  return meta.map((m) => {
    const hit = rows.find((r) => r.k === m.key)
    const people = Number(hit?.people ?? 0)
    const cents = Number(hit?.cents ?? 0)
    return { ...m, people, cents, avgCents: people ? Math.round(cents / people) : 0 }
  })
}

export interface Channel {
  store: string
  orders: number
  cents: number
}

/** Storefront-wide, by where the money was taken. */
export async function revenueByChannel(db: Db, limit = 7): Promise<Channel[]> {
  const rows = (await db.all(sql`
    select store, count(*) as orders, sum(amount_cents) as cents
    from purchases
    group by store
    order by cents desc
  `)) as { store: string; orders: number; cents: number }[]

  const head = rows.slice(0, limit).map((r) => ({
    store: r.store,
    orders: Number(r.orders),
    cents: Number(r.cents),
  }))
  const tail = rows.slice(limit)
  // Folded rather than truncated — a chart that silently drops the tail claims a
  // total it isn't showing.
  if (tail.length) {
    head.push({
      store: `${tail.length} others`,
      orders: tail.reduce((n, r) => n + Number(r.orders), 0),
      cents: tail.reduce((n, r) => n + Number(r.cents), 0),
    })
  }
  return head
}

export interface TagLift {
  id: number
  name: string
  tagged: number
  buyers: number
  cents: number
  /** Share of tagged people who have bought, 0–1. */
  rate: number
}

/**
 * Which tags actually predict a buyer. **Reachable only** — a tag is a fact
 * about a subscriber, so people not on the list have none.
 *
 * Compared against the list-wide buy rate, this is the most directly useful
 * thing on the dashboard: it says which interest signals are worth money and
 * which are just clicks. Tags under `floor` people are excluded — a 100% buy
 * rate across six people is noise wearing a suit.
 */
export async function tagLift(db: Db, floor = 100, limit = 10): Promise<TagLift[]> {
  const rows = (await db.all(sql`
    select t.id as id,
           t.name as name,
           count(*) as tagged,
           sum(case when ps.email is not null then 1 else 0 end) as buyers,
           coalesce(sum(ps.lifetime_cents), 0) as cents
    from subscriber_tags st
    join subscribers s on s.id = st.subscriber_id and s.status = 'active'
    join tags t on t.id = st.tag_id
    left join purchase_stats ps on ps.email = s.email
    group by t.id
    having count(*) >= ${floor}
    order by (sum(case when ps.email is not null then 1.0 else 0 end) / count(*)) desc
    limit ${limit}
  `)) as { id: number; name: string; tagged: number; buyers: number; cents: number }[]

  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    tagged: Number(r.tagged),
    buyers: Number(r.buyers),
    cents: Number(r.cents),
    rate: Number(r.tagged) ? Number(r.buyers) / Number(r.tagged) : 0,
  }))
}

export interface Headline {
  /** Storefront-wide. */
  avgOrderCents: number
  bestMonth: { month: string; cents: number } | null
  /** Reachable only. */
  reachableCents: number
  reachableAvgLtvCents: number
  repeatBuyers: number
  /** Median days between a buyer's first and second order. */
  daysToSecond: number | null
  boughtLast90: number
}

export async function headlines(db: Db, now = Date.now()): Promise<Headline> {
  const store = (await db.get(sql`
    select
      coalesce(round(avg(amount_cents)), 0) as aov,
      count(*) as n
    from purchases
    where amount_cents > 0
  `)) as { aov: number; n: number }

  const best = (await db.get(sql`
    select strftime('%Y-%m', occurred_at / 1000, 'unixepoch') as month,
           sum(amount_cents) as cents
    from purchases
    group by month
    order by cents desc
    limit 1
  `)) as { month: string; cents: number } | undefined

  const reach = (await db.get(sql`
    select coalesce(sum(ps.lifetime_cents), 0) as cents,
           count(*) as people,
           sum(case when ps.order_count >= 2 then 1 else 0 end) as repeat_buyers,
           sum(case when ps.last_at >= ${now - 90 * DAY} then 1 else 0 end) as recent
    from purchase_stats ps
    where ps.email in ${REACHABLE}
  `)) as { cents: number; people: number; repeat_buyers: number; recent: number }

  // Median, not mean: a handful of people who bought twice eight years apart
  // drag an average into meaninglessness.
  const gaps = (await db.all(sql`
    with ranked as (
      select email, occurred_at,
             row_number() over (partition by email order by occurred_at) as rn
      from purchases
      where email in ${REACHABLE}
    )
    select (b.occurred_at - a.occurred_at) / ${DAY} as gap
    from ranked a
    join ranked b on b.email = a.email and a.rn = 1 and b.rn = 2
    where b.occurred_at > a.occurred_at
    order by gap
  `)) as { gap: number }[]

  const people = Number(reach?.people ?? 0)

  return {
    avgOrderCents: Number(store?.aov ?? 0),
    bestMonth: best ? { month: best.month, cents: Number(best.cents) } : null,
    reachableCents: Number(reach?.cents ?? 0),
    reachableAvgLtvCents: people ? Math.round(Number(reach?.cents ?? 0) / people) : 0,
    repeatBuyers: Number(reach?.repeat_buyers ?? 0),
    daysToSecond: gaps.length ? Math.round(Number(gaps[Math.floor(gaps.length / 2)]?.gap ?? 0)) : null,
    boughtLast90: Number(reach?.recent ?? 0),
  }
}

export interface BigMonth {
  month: string
  orders: number
  cents: number
}

/** The best months the storefront ever had. Context for the last-12-months chart. */
export async function bestMonths(db: Db, limit = 5): Promise<BigMonth[]> {
  const rows = (await db.all(sql`
    select strftime('%Y-%m', occurred_at / 1000, 'unixepoch') as month,
           count(*) as orders,
           sum(amount_cents) as cents
    from purchases
    group by month
    order by cents desc
    limit ${limit}
  `)) as { month: string; orders: number; cents: number }[]

  return rows.map((r) => ({
    month: r.month,
    orders: Number(r.orders),
    cents: Number(r.cents),
  }))
}
