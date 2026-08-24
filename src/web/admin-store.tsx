import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { commerceTotals, listOffers, offerLeaderboard } from '../core/purchases.ts'
import {
  bestMonths,
  customerTiers,
  headlines,
  revenueByChannel,
  revenueByMonth,
  tagLift,
} from '../core/insights.ts'
import { type SegmentIdea, customerSplit, suggestSegments } from '../core/segment-ideas.ts'
import { createSegment } from '../core/segments.ts'
import { getDb } from '../db/index.ts'
import { type SegmentRule, purchaseStats, purchases, subscribers } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { BarRow, ColumnChart, Donut, RAMP, Sparkline, Swatch } from './charts.tsx'
import { Flash, Layout, fmtDay, fmtMoney } from './layout.tsx'

/**
 * The storefront: what sells, who buys it, and what to do about that.
 *
 * Its own top-nav section rather than a fourth audience tab — this is the CRM
 * side of the house, and it has more than one screen's worth to say.
 *
 * Read-only with one exception: the "Segment ideas" page can create a segment,
 * because a suggestion nobody can act on is decoration. Every other number here
 * is a projection of Neon, and the way to change one is to change it in Neon and
 * re-sync.
 */
export const store = new Hono<{ Bindings: Env }>()

const DAY = 24 * 60 * 60 * 1000

/** "2016-09" → "September 2016". Ten-year-old months need their year. */
export function monthName(key: string): string {
  const [y, m] = key.split('-')
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1))
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** Axis labels are the month initial; the full name rides the tooltip. */
export function monthColumn(m: { month: string; cents: number; orders: number }) {
  const [y, mm] = m.month.split('-')
  const d = new Date(Date.UTC(Number(y), Number(mm) - 1, 1))
  return {
    // Three letters, not the single-letter form: "M A M J J" is unreadable, and
    // twelve columns across 760px have room for the abbreviation.
    label: d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
    caption: `${monthName(m.month)} · ${m.orders} orders`,
    value: m.cents,
  }
}

/** One KPI, in the same tile the dashboard uses. Number first: the label is
 *  what you read second, once the size of the thing has already landed. */
const Stat = ({
  label,
  value,
  hint,
  trend,
}: {
  label: string
  value: string
  hint?: string
  trend?: number[]
}) => (
  <div class="stat">
    <div class="n">{value}</div>
    <div class="l">{label}</div>
    {hint ? <div class="h">{hint}</div> : null}
    {trend && trend.length > 2 ? <Sparkline values={trend} /> : null}
  </div>
)

interface HeadlineNumbers {
  avgOrderCents: number
  reachableCents: number
  reachableAvgLtvCents: number
  repeatBuyers: number
  daysToSecond: number | null
  boughtLast90: number
}

/**
 * The KPI rows.
 *
 * Split into two cards on purpose. The first is the storefront; the second is
 * this list. They are different populations — two thirds of the buyers can't be
 * emailed — and a single undifferentiated row of tiles would quietly invite
 * every one of those numbers to be read as an addressable opportunity.
 */
export const StoreHeadline = ({
  totals,
  head,
  yearCents,
  yearOrders,
  liveCount,
  catalogCount,
  trend,
}: {
  totals: { cents: number; buyers: number; orders: number; reachable: number; firstAt: Date | null }
  head: HeadlineNumbers
  yearCents: number
  yearOrders: number
  liveCount: number
  catalogCount: number
  /** Monthly cents behind `yearCents`, drawn as a trend line inside its tile. */
  trend?: number[]
}) => (
  <>
    <div class="card">
      <div class="card-b">
        <div class="stats money">
          <Stat
            label="Gross, all time"
            value={fmtMoney(totals.cents)}
            hint={totals.firstAt ? `since ${fmtDay(totals.firstAt)}` : undefined}
          />
          <Stat
            label="Last 12 months"
            value={fmtMoney(yearCents)}
            hint={`${yearOrders.toLocaleString('en-US')} orders`}
            trend={trend}
          />
          <Stat
            label="Average order"
            value={fmtMoney(head.avgOrderCents)}
            hint={`${totals.orders.toLocaleString('en-US')} orders all time`}
          />
          <Stat
            label="Buyers"
            value={totals.buyers.toLocaleString('en-US')}
            hint={`${(totals.buyers - totals.reachable).toLocaleString('en-US')} not on the list`}
          />
          <Stat
            label="Live offers"
            value={String(liveCount)}
            hint={`of ${catalogCount} in the catalogue`}
          />
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h">
        <h2>What this list is worth</h2>
        <div class="actions">
          <span class="pill">customers you can email</span>
        </div>
      </div>
      <div class="card-b">
        <div class="stats money">
          <Stat
            label="Revenue from this list"
            value={fmtMoney(head.reachableCents)}
            hint={`${totals.reachable.toLocaleString('en-US')} reachable customers`}
          />
          <Stat
            label="Average lifetime value"
            value={fmtMoney(head.reachableAvgLtvCents)}
            hint="per customer on the list"
          />
          <Stat
            label="Bought more than once"
            value={head.repeatBuyers.toLocaleString('en-US')}
            hint={`${totals.reachable ? Math.round((head.repeatBuyers / totals.reachable) * 100) : 0}% came back`}
          />
          <Stat
            label="Gap to order two"
            value={head.daysToSecond === null ? '—' : `${head.daysToSecond} days`}
            hint="median, first purchase to second"
          />
          <Stat
            label="Bought recently"
            value={head.boughtLast90.toLocaleString('en-US')}
            hint="in the last 90 days"
          />
        </div>
      </div>
    </div>
  </>
)

/**
 * List composition as a donut plus the table behind it.
 *
 * The donut is the glance; the table is where the money is, and both live in one
 * card so nobody reconciles a picture against a number on another screen. Ordered
 * tiers get the ordinal ramp — lighter to darker is "buys more often" — because
 * four unrelated hues would throw away the ordering the tiers exist to show.
 */
export const TierCard = ({
  tiers,
  listSize,
  customers,
}: {
  tiers: {
    key: string
    label: string
    hint: string
    people: number
    cents: number
    avgCents: number
  }[]
  listSize: number
  customers: number
}) => (
  <div class="card">
    <div class="card-h">
      <h2>Who's on the list</h2>
      <div class="actions">
        <span class="pill ok">
          {listSize ? Math.round((customers / listSize) * 100) : 0}% have bought something
        </span>
      </div>
    </div>
    <div class="card-b">
      <div style="display:flex;gap:28px;align-items:center;flex-wrap:wrap">
        <Donut
          slices={tiers.map((t) => ({ label: t.label, value: t.people }))}
          centerValue={listSize.toLocaleString('en-US')}
          centerLabel="on the list"
        />
        <div style="flex:1 1 340px;min-width:300px">
          <table>
            <thead>
              <tr>
                <th>Tier</th>
                <th class="num">People</th>
                <th class="num">Revenue</th>
                <th class="num">Avg LTV</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t, i) => (
                <tr>
                  <td>
                    <span style="display:flex;align-items:center;gap:8px">
                      <Swatch index={i} />
                      <span style="font-weight:500">{t.label}</span>
                    </span>
                    <div class="faint" style="font-size:12px;margin-left:18px">
                      {t.hint}
                    </div>
                  </td>
                  <td class="num">{t.people.toLocaleString('en-US')}</td>
                  <td class="num">{t.cents ? fmtMoney(t.cents) : '—'}</td>
                  <td class="num">{t.avgCents ? fmtMoney(t.avgCents) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div class="note" style="margin-top:16px">
        The tiers are ordered, so the shading is too — lighter to darker is "buys more often".{' '}
        <a href="/store/ideas">Turn any of these into a segment →</a>
      </div>
    </div>
  </div>
)

// ───────────────────────────────────────────────────────── overview

store.get('/store', async (c) => {
  const db = getDb(c.env)
  const now = Date.now()

  const [totals, byOffer, catalog, months, tiers, channels, lift, head, best] = await Promise.all([
    commerceTotals(db),
    offerLeaderboard(db),
    // The catalogue, not the leaderboard: `byOffer` is grouped from orders, so
    // it only knows offers that have actually sold. Counting "live" from it
    // silently omits anything listed but not yet bought.
    listOffers(db),
    revenueByMonth(db, 12, now),
    customerTiers(db),
    revenueByChannel(db),
    tagLift(db),
    headlines(db, now),
    bestMonths(db),
  ])

  const liveCatalog = catalog.filter((o) => o.active)
  const live = byOffer.filter((o) => o.active)
  const neverSold = liveCatalog.filter((o) => !byOffer.some((b) => b.slug === o.slug))
  const maxOfferCents = Math.max(1, ...byOffer.map((o) => o.cents))
  const yearCents = months.reduce((sum, m) => sum + m.cents, 0)
  const yearOrders = months.reduce((sum, m) => sum + m.orders, 0)

  const listSize = tiers.reduce((n, t) => n + t.people, 0)
  const customers = listSize - (tiers.find((t) => t.key === 'none')?.people ?? 0)
  const baseRate = listSize ? customers / listSize : 0
  const maxChannel = Math.max(1, ...channels.map((ch) => ch.cents))

  return c.html(
    <Layout title="Store overview" charts>
      <div class="head">
        <div>
          <h1>Store</h1>
          <div class="sub">
            Mirrored from Neon, read-only here.
            {totals.lastAt ? ` Newest order ${fmtDay(totals.lastAt)}.` : ''}
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <StoreHeadline
        totals={totals}
        head={head}
        yearCents={yearCents}
        yearOrders={yearOrders}
        liveCount={liveCatalog.length}
        catalogCount={catalog.length}
        trend={months.map((m) => m.cents)}
      />

      <div class="card">
        <div class="card-h">
          <h2>Revenue, last 12 months</h2>
          <div class="actions">
            <span class="pill">
              {fmtMoney(yearCents)} · {yearOrders.toLocaleString('en-US')} orders
            </span>
          </div>
        </div>
        <div class="card-b">
          <ColumnChart data={months.map(monthColumn)} />
          <div class="faint" style="font-size:12px;margin-top:8px;text-align:right">
            The last column is the current month so far, not a finished one.
          </div>
          {head.bestMonth && head.bestMonth.cents > 0 ? (
            <div class="note" style="margin-top:14px">
              For scale: the best month this store ever had was{' '}
              <strong>{monthName(head.bestMonth.month)}</strong> at{' '}
              <strong>{fmtMoney(head.bestMonth.cents)}</strong> —{' '}
              {Math.round(head.bestMonth.cents / Math.max(1, yearCents / 12))}× the current
              monthly average.
            </div>
          ) : null}
        </div>
      </div>

      <TierCard tiers={tiers} listSize={listSize} customers={customers} />

      <div class="card">
        <div class="card-h">
          <h2>Which tags predict a buyer</h2>
          <div class="actions">
            <span class="pill">list average {Math.round(baseRate * 100)}%</span>
          </div>
        </div>
        <div class="card-b flush">
          <div class="note" style="margin:12px 18px 0">
            Share of each tag's people who have ever bought, against the {Math.round(baseRate * 100)}%
            list-wide rate. Tags under 100 people are left out — a perfect rate across six people is
            noise wearing a suit.
          </div>
          <table>
            <thead>
              <tr>
                <th>Tag</th>
                <th class="num">People</th>
                <th class="num">Buy rate</th>
                <th class="num">vs list</th>
                <th class="num">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {lift.map((t) => {
                const delta = baseRate ? t.rate / baseRate - 1 : 0
                return (
                  <tr>
                    <td>
                      <a href={`/subscribers?tag=${t.id}`}>{t.name}</a>
                      <BarRow value={t.rate} max={1} />
                    </td>
                    <td class="num">{t.tagged.toLocaleString('en-US')}</td>
                    <td class="num">{Math.round(t.rate * 100)}%</td>
                    <td class="num">
                      {delta >= 0.05 ? (
                        <span class="pill ok">+{Math.round(delta * 100)}%</span>
                      ) : delta <= -0.05 ? (
                        <span class="pill warn">{Math.round(delta * 100)}%</span>
                      ) : (
                        <span class="faint">even</span>
                      )}
                    </td>
                    <td class="num">{fmtMoney(t.cents)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Where the money came from</h2>
        </div>
        <div class="card-b flush">
          <div class="note" style="margin:12px 18px 0">
            Ten years across nine checkouts. Provenance only — nothing here changes who can be
            emailed.
          </div>
          <table>
            <thead>
              <tr>
                <th>Checkout</th>
                <th class="num">Orders</th>
                <th class="num">Gross</th>
                <th class="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((ch) => (
                <tr>
                  <td>
                    <span class="mono">{ch.store}</span>
                    <BarRow value={ch.cents} max={maxChannel} />
                  </td>
                  <td class="num">{ch.orders.toLocaleString('en-US')}</td>
                  <td class="num">{fmtMoney(ch.cents)}</td>
                  <td class="num">
                    {totals.cents ? Math.round((ch.cents / totals.cents) * 100) : 0}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>What's live</h2>
          <div class="actions">
            <a class="btn sm" href="/store/offers">
              All {byOffer.length} that have sold
            </a>
          </div>
        </div>
        <div class="card-b flush">
          {neverSold.length ? (
            <div class="note" style="margin:12px 18px 0">
              Listed but never sold:{' '}
              {neverSold.map((o, i) => (
                <>
                  {i ? ', ' : ''}
                  <strong>{o.title}</strong>
                </>
              ))}
              .
            </div>
          ) : null}
          {live.length === 0 ? (
            <div class="empty">
              <p>Nothing active in the storefront has sold yet.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Offer</th>
                  <th class="num">Buyers</th>
                  <th class="num">On the list</th>
                  <th class="num">Gross</th>
                </tr>
              </thead>
              <tbody>
                {live.map((o) => (
                  <tr>
                    <td>
                      <div style="font-weight:500">{o.title}</div>
                      <BarRow value={o.cents} max={maxOfferCents} />
                    </td>
                    <td class="num">{o.buyers.toLocaleString('en-US')}</td>
                    <td class="num">{o.onList.toLocaleString('en-US')}</td>
                    <td class="num">{fmtMoney(o.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Best months ever</h2>
        </div>
        <div class="card-b flush">
          <table>
            <tbody>
              {best.map((m) => (
                <tr>
                  <td>
                    <span style="font-weight:500">{monthName(m.month)}</span>
                    <BarRow value={m.cents} max={Math.max(1, ...best.map((x) => x.cents))} />
                  </td>
                  <td class="num" style="width:120px">
                    {fmtMoney(m.cents)}
                  </td>
                  <td class="faint" style="width:120px;text-align:right">
                    {m.orders.toLocaleString('en-US')} orders
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>,
  )
})

// ───────────────────────────────────────────────────────── offers

store.get('/store/offers', async (c) => {
  const db = getDb(c.env)
  const [byOffer, offers] = await Promise.all([offerLeaderboard(db), listOffers(db)])
  const priced = new Map(offers.map((o) => [o.slug, o.priceCents]))
  const maxCents = Math.max(1, ...byOffer.map((o) => o.cents))

  return c.html(
    <Layout title="Offers" nav="offers" charts>
      <div class="head">
        <div>
          <h1>Offers</h1>
          <div class="sub">Everything ever sold, by what it earned.</div>
        </div>
      </div>


      <div class="card">
        <div class="card-b flush">
          <table>
            <thead>
              <tr>
                <th>Offer</th>
                <th class="num">Orders</th>
                <th class="num">Buyers</th>
                <th class="num">On the list</th>
                <th class="num">Gross</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {byOffer.map((o) => (
                <tr>
                  <td>
                    <div style="font-weight:500">
                      {o.title}
                      {o.active ? (
                        <span class="pill ok" style="margin-left:6px">
                          live
                        </span>
                      ) : (
                        <span class="faint"> · retired</span>
                      )}
                    </div>
                    <div class="faint mono">
                      {o.slug}
                      {priced.get(o.slug) ? ` · list ${fmtMoney(priced.get(o.slug) ?? 0)}` : ''}
                    </div>
                    <BarRow value={o.cents} max={maxCents} />
                  </td>
                  <td class="num">{o.orders.toLocaleString('en-US')}</td>
                  <td class="num">{o.buyers.toLocaleString('en-US')}</td>
                  <td class="num">{o.onList.toLocaleString('en-US')}</td>
                  <td class="num">{fmtMoney(o.cents)}</td>
                  <td style="text-align:right">
                    {/* Straight from "who bought this" to a rule targeting them. */}
                    <a class="btn sm" href={`/segments/new?bought=${encodeURIComponent(o.slug)}`}>
                      Segment
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>,
  )
})

// ───────────────────────────────────────────────────────── customers

store.get('/store/customers', async (c) => {
  const db = getDb(c.env)
  const now = Date.now()

  // Reachable customers only. A leaderboard of people you cannot email is
  // trivia; this page exists to be acted on.
  const rows = await db
    .select({
      id: subscribers.id,
      email: subscribers.email,
      name: subscribers.name,
      orderCount: purchaseStats.orderCount,
      lifetimeCents: purchaseStats.lifetimeCents,
      confidentCents: purchaseStats.confidentCents,
      firstAt: purchaseStats.firstAt,
      lastAt: purchaseStats.lastAt,
    })
    .from(purchaseStats)
    .innerJoin(subscribers, eq(subscribers.email, purchaseStats.email))
    .where(eq(subscribers.status, 'active'))
    .orderBy(desc(purchaseStats.lifetimeCents))
    .limit(100)
    .all()

  const recent = await db
    .select({ n: sql<number>`count(*)` })
    .from(purchaseStats)
    .innerJoin(subscribers, eq(subscribers.email, purchaseStats.email))
    .where(and(eq(subscribers.status, 'active'), gte(purchaseStats.lastAt, new Date(now - 90 * DAY))))
    .get()

  const top = rows[0]?.lifetimeCents ?? 1

  return c.html(
    <Layout title="Customers" nav="cust" charts>
      <div class="head">
        <div>
          <h1>Customers</h1>
          <div class="sub">
            Your best customers who are on the list — the top {rows.length} by lifetime spend.
          </div>
        </div>
      </div>


      <div class="card">
        <div class="card-b">
          <div style="display:flex;flex-wrap:wrap;gap:22px">
            <Stat
              label="Bought recently"
              value={Number(recent?.n ?? 0).toLocaleString('en-US')}
              hint="in the last 90 days"
            />
            <Stat
              label="Top customer"
              value={fmtMoney(top)}
              hint={rows[0]?.email ?? undefined}
            />
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-b flush">
          {rows.length === 0 ? (
            <div class="empty">
              <p>Nobody on the list has bought anything yet.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th class="num">Orders</th>
                  <th class="num">Lifetime</th>
                  <th>First bought</th>
                  <th>Last bought</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr>
                    <td>
                      <a href={`/subscribers/${s.id}`}>{s.name ?? s.email}</a>
                      {s.name ? <div class="faint mono">{s.email}</div> : null}
                      <BarRow value={s.lifetimeCents} max={top} />
                    </td>
                    <td class="num">{s.orderCount}</td>
                    <td class="num">
                      {fmtMoney(s.lifetimeCents)}
                      {/* Only worth mentioning when the two disagree — otherwise
                          it's a caveat on a number that has none. */}
                      {s.confidentCents !== s.lifetimeCents ? (
                        <div class="faint">{fmtMoney(s.confidentCents)} confirmed</div>
                      ) : null}
                    </td>
                    <td class="faint">{fmtDay(s.firstAt)}</td>
                    <td class="faint">{fmtDay(s.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>,
  )
})

// ───────────────────────────────────────────────────────── segment ideas

const GROUPS: { key: SegmentIdea['group']; title: string; blurb: string }[] = [
  {
    key: 'lifecycle',
    title: 'Where people are',
    blurb: 'The splits every list has. Worth saving even if you never send to them — a broadcast can exclude a saved segment.',
  },
  {
    key: 'value',
    title: 'What they’re worth',
    blurb: 'Spend and recency. These are the ones to be careful with: check the wording before telling anyone what they’ve spent.',
  },
  {
    key: 'upsell',
    title: 'What they bought, and what they didn’t',
    blurb: 'Derived from real co-purchase behaviour — for each thing people own, what its owners actually went on to buy. Ranked by how strong the pattern is against how many are left to sell to.',
  },
]

store.get('/store/ideas', async (c) => {
  const db = getDb(c.env)
  const ideas = await suggestSegments(db)

  return c.html(
    <Layout title="Segment ideas" nav="ideas" charts>
      <div class="head">
        <div>
          <h1>Segment ideas</h1>
          <div class="sub">
            Suggestions from what people actually bought. Every count is the real audience — the
            same number a broadcast would send to.
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      {GROUPS.map((g) => {
        const mine = ideas.filter((i) => i.group === g.key)
        if (!mine.length) return null
        return (
          <div class="card">
            <div class="card-h">
              <h2>{g.title}</h2>
            </div>
            <div class="card-b">
              <div class="note">{g.blurb}</div>
              <table>
                <tbody>
                  {mine.map((idea) => (
                    <tr>
                      <td>
                        <div style="font-weight:500">{idea.title}</div>
                        <div class="faint">{idea.why}</div>
                      </td>
                      <td class="num" style="width:90px;vertical-align:middle">
                        {idea.size.toLocaleString('en-US')}
                        <div class="faint">people</div>
                      </td>
                      <td style="text-align:right;width:150px;vertical-align:middle">
                        <form method="post" action="/store/ideas/create">
                          <input type="hidden" name="name" value={idea.title} />
                          <input type="hidden" name="rule" value={JSON.stringify(idea.rule)} />
                          <button class="btn sm primary">Create segment</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      {ideas.length === 0 ? (
        <div class="card">
          <div class="card-b">
            <div class="empty">
              <p>No suggestions yet — there isn't enough purchase history to find a pattern.</p>
            </div>
          </div>
        </div>
      ) : null}
    </Layout>,
  )
})

/**
 * Rules arrive from the page as JSON in a hidden field, so they are rebuilt
 * field by field rather than trusted wholesale. This route is already behind
 * operator auth; the point is that a stray key can't end up persisted in a rule
 * and quietly change who a broadcast reaches later.
 */
function safeRule(raw: string): SegmentRule | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const src = parsed as Record<string, unknown>
  const rule: SegmentRule = {}

  const posInt = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined
  const slugs = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []

  if (typeof src.hasPurchased === 'boolean') rule.hasPurchased = src.hasPurchased
  if (slugs(src.boughtOffers).length) rule.boughtOffers = slugs(src.boughtOffers)
  if (slugs(src.notBoughtOffers).length) rule.notBoughtOffers = slugs(src.notBoughtOffers)
  if (src.offerMatch === 'all') rule.offerMatch = 'all'
  if (posInt(src.spentAtLeastCents) !== undefined) rule.spentAtLeastCents = posInt(src.spentAtLeastCents)
  if (posInt(src.spentAtMostCents) !== undefined) rule.spentAtMostCents = posInt(src.spentAtMostCents)
  if (posInt(src.orderCountAtLeast) !== undefined) rule.orderCountAtLeast = posInt(src.orderCountAtLeast)
  if (posInt(src.orderCountAtMost) !== undefined) rule.orderCountAtMost = posInt(src.orderCountAtMost)
  if (posInt(src.purchasedAfter) !== undefined) rule.purchasedAfter = posInt(src.purchasedAfter)
  if (posInt(src.purchasedBefore) !== undefined) rule.purchasedBefore = posInt(src.purchasedBefore)
  if (src.confidentPurchasesOnly === true) rule.confidentPurchasesOnly = true

  return Object.keys(rule).length ? rule : null
}

store.post('/store/ideas/create', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const name = String(form.get('name') ?? '').trim()
  const rule = safeRule(String(form.get('rule') ?? ''))

  if (!name || !rule) {
    return c.redirect('/store/ideas?flash=That suggestion did not survive the trip.&kind=warn')
  }

  // Saved, not sent. The segment is a draft audience — deciding to mail it is a
  // separate, deliberate act.
  const id = await createSegment(db, name, rule)
  return c.redirect(`/segments/${id}?flash=${encodeURIComponent(`Segment "${name}" created.`)}`)
})
