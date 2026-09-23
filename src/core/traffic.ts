import { sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { NOT_A_READER } from './forms.ts'

/**
 * ⭐ Traffic — who is reading the public site, and where they came from.
 *
 * Deliberately small. This is the "how loud is it out there" number that sits
 * at the top of the dashboard, not a replacement for a real analytics product.
 * Three questions: how many reads per day, which pieces, and who sent them.
 *
 * Views are written by a beacon on the rendered page (see `web/site.tsx`), so a
 * row means a browser ran the page. The report then sets those reads beside
 * what the list did in the same days — opens and clicks from `events` — because
 * the interesting story is the one that crosses the two: a send goes out, the
 * opens spike, and the site gets a second wave from people clicking through.
 */

const DAY_MS = 86_400_000

const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/** Lowercase, no `www.` — `www.google.com` and `google.com` are one referrer. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host ? host.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

async function sha(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
}

const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null)

export interface PageViewInput {
  viewKey: string
  path: string
  /** The landing URL's query string, for `ref` / `utm_source`. */
  search?: string | null
  referrer?: string | null
  broadcastId?: number | null
  country?: string | null
  ip?: string | null
  userAgent?: string | null
  now?: Date
}

const VIEW_KEY = /^[A-Za-z0-9-]{8,64}$/

/**
 * Record one view. Never throws — it sits behind a beacon, and a lost datapoint
 * is always better than an error a reader could notice.
 *
 * Returns whether a row was written, which only the tests care about.
 */
export async function recordPageView(db: Db, v: PageViewInput): Promise<boolean> {
  if (NOT_A_READER.test(v.userAgent ?? '')) return false
  if (!VIEW_KEY.test(v.viewKey)) return false
  if (!v.path.startsWith('/') || v.path.length > 512) return false

  const now = v.now ?? new Date()
  const day = dayOf(now)
  let source: string | null = null
  try {
    const q = new URLSearchParams(v.search ?? '')
    source = q.get('ref') || q.get('utm_source') || q.get('source')
  } catch {
    /* a malformed query string names no source */
  }
  const referrer = clip(v.referrer, 1024)
  const visitor = await sha(`${day}|${v.ip ?? ''}|${v.userAgent ?? ''}`)
  // A post id is only kept if it is a published post — the beacon is public and
  // the id arrives from the page, so it is checked, not trusted.
  const broadcastId = Number.isInteger(v.broadcastId) ? v.broadcastId : null

  try {
    const r = await db.run(sql`
      insert into page_views
        (view_key, day, occurred_at, path, broadcast_id, referrer, referrer_host, source, country, visitor)
      values (
        ${v.viewKey}, ${day}, ${now.getTime()}, ${v.path},
        (select id from broadcasts where id = ${broadcastId} and published_at is not null),
        ${referrer}, ${hostOf(referrer)}, ${clip(source?.toLowerCase(), 100)},
        ${clip(v.country, 2)}, ${visitor}
      )
      on conflict (view_key) do nothing
    `)
    return (r.meta?.changes ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * How long the tab was visible. Sent every time the page is hidden, so it only
 * ever grows, and capped at an hour — a tab left open over lunch is not a read.
 * Only a view from the last six hours can be updated, which keeps a leaked key
 * from rewriting history.
 */
export async function recordDwell(db: Db, viewKey: string, seconds: number, now = new Date()): Promise<void> {
  if (!VIEW_KEY.test(viewKey) || !Number.isFinite(seconds) || seconds <= 0) return
  const s = Math.min(3600, Math.round(seconds))
  try {
    await db.run(sql`
      update page_views set seconds = max(coalesce(seconds, 0), ${s})
      where view_key = ${viewKey} and occurred_at >= ${now.getTime() - 6 * 3600_000}
    `)
  } catch {
    /* same as above */
  }
}

// ─────────────────────────────────────────────────────────── the report

export interface TrafficDay {
  day: string
  views: number
  visitors: number
  opens: number
  clicks: number
}

export interface TopPiece {
  /** The post, when the page is one. */
  broadcastId: number | null
  title: string
  path: string
  views: number
  visitors: number
  avgSeconds: number | null
  /** Distinct people who opened the mailed version, all time. Null for non-posts. */
  emailReads: number | null
}

export interface Referrer {
  /** `ref:twitter`, a host, or `direct`. */
  key: string
  label: string
  /** The most common full URL under this host, when it said more than its origin. */
  topUrl: string | null
  views: number
}

export interface TrafficReport {
  days: number
  series: TrafficDay[]
  /** Broadcasts that went out inside the window — the annotations on the chart. */
  sends: { day: string; subject: string }[]
  totals: {
    views: number
    visitors: number
    avgSeconds: number | null
    opens: number
    clicks: number
    /** Email clicks whose target was the site: the list feeding the web. */
    clicksToSite: number
    prevViews: number
    prevVisitors: number
  }
  live: { views: number; visitors: number }
  top: TopPiece[]
  referrers: Referrer[]
  countries: { code: string; views: number }[]
}

const PAGE_TITLES: Record<string, string> = {
  '/': 'Front page',
  '/writing': 'Writing',
  '/about': 'About',
  '/subscribe': 'Subscribe',
  '/search': 'Search',
}

type Row = Record<string, unknown>
const n = (v: unknown) => Number(v ?? 0)

/**
 * Everything the dashboard's traffic card shows, in nine queries.
 *
 * `siteUrl` is used twice: to leave the site's own host out of the referrers
 * (a reader clicking from one post to another is not traffic *arriving*), and
 * to tell which email clicks landed on the site.
 */
export async function trafficReport(
  db: Db,
  opts: { siteUrl?: string; days?: number; now?: Date } = {},
): Promise<TrafficReport> {
  const days = opts.days ?? 30
  const now = opts.now ?? new Date()
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * DAY_MS
  const since = dayOf(new Date(startMs))
  const prevSince = dayOf(new Date(startMs - days * DAY_MS))
  const siteHost = hostOf(opts.siteUrl) ?? ''
  const siteOrigin = (opts.siteUrl ?? '').replace(/\/$/, '')

  const [web, mail, sends, totals, prev, live, top, refs, geo] = await Promise.all([
    db.all(sql`
      select day, count(*) as views, count(distinct visitor) as visitors
      from page_views where day >= ${since} group by day
    `),
    db.all(sql`
      select date(occurred_at / 1000, 'unixepoch') as day,
             count(distinct case when type = 'open' then message_id end) as opens,
             sum(case when type = 'click' then 1 else 0 end) as clicks,
             sum(case when type = 'click' and ${siteOrigin} != ''
                       and json_extract(meta, '$.url') like ${`${siteOrigin}%`} then 1 else 0 end) as to_site
      from events
      where occurred_at >= ${startMs} and type in ('open', 'click')
      group by 1
    `),
    db.all(sql`
      select subject, sent_at from broadcasts
      where status = 'sent' and sent_at >= ${startMs}
      order by sent_at
    `),
    db.get(sql`
      select count(*) as views, count(distinct day || visitor) as visitors,
             avg(case when seconds > 0 then seconds end) as avg_seconds
      from page_views where day >= ${since}
    `),
    db.get(sql`
      select count(*) as views, count(distinct day || visitor) as visitors
      from page_views where day >= ${prevSince} and day < ${since}
    `),
    db.get(sql`
      select count(*) as views, count(distinct visitor) as visitors
      from page_views where occurred_at >= ${now.getTime() - 30 * 60_000}
    `),
    db.all(sql`
      select pv.broadcast_id, max(pv.path) as path, b.subject,
             count(*) as views, count(distinct pv.day || pv.visitor) as visitors,
             avg(case when pv.seconds > 0 then pv.seconds end) as avg_seconds
      from page_views pv left join broadcasts b on b.id = pv.broadcast_id
      where pv.day >= ${since}
      group by case when pv.broadcast_id is not null then 'b' || pv.broadcast_id else pv.path end
      order by views desc
      limit 8
    `),
    db.all(sql`
      select case when source is not null then 'ref:' || source
                  when referrer_host is null then 'direct'
                  else referrer_host end as k,
             referrer, count(*) as views
      from page_views
      where day >= ${since} and (referrer_host is null or referrer_host != ${siteHost} or source is not null)
      group by k, referrer
      order by views desc
      limit 400
    `),
    db.all(sql`
      select country, count(*) as views from page_views
      where day >= ${since} and country is not null
      group by country order by views desc limit 6
    `),
  ])

  // Every day in the window, including the silent ones — a gap in a line chart
  // reads as missing data, and a quiet day is data.
  const webBy = new Map((web as Row[]).map((r) => [String(r.day), r]))
  const mailBy = new Map((mail as Row[]).map((r) => [String(r.day), r]))
  const series: TrafficDay[] = []
  for (let i = 0; i < days; i++) {
    const day = dayOf(new Date(startMs + i * DAY_MS))
    const w = webBy.get(day)
    const m = mailBy.get(day)
    series.push({
      day,
      views: n(w?.views),
      visitors: n(w?.visitors),
      opens: n(m?.opens),
      clicks: n(m?.clicks),
    })
  }

  // Email reads for the posts in the top list: the same piece, read in the inbox.
  const topRows = top as Row[]
  const postIds = topRows.map((r) => r.broadcast_id).filter((v): v is number => typeof v === 'number')
  const reads = new Map<number, number>()
  if (postIds.length) {
    const rows = (await db.all(sql`
      select m.broadcast_id as id, count(distinct e.message_id) as n
      from events e join messages m on m.id = e.message_id
      where e.type = 'open' and m.broadcast_id in (${sql.join(postIds.map((id) => sql`${id}`), sql`, `)})
      group by m.broadcast_id
    `)) as Row[]
    for (const r of rows) reads.set(n(r.id), n(r.n))
  }

  // Fold full URLs into their host. The row with the most views under a host
  // is its "top URL", shown only when it is more than the bare origin.
  const byKey = new Map<string, Referrer>()
  for (const r of refs as Row[]) {
    const key = String(r.k)
    const url = r.referrer ? String(r.referrer) : null
    let ref = byKey.get(key)
    if (!ref) {
      ref = {
        key,
        label: key === 'direct' ? 'Direct & email apps' : key.startsWith('ref:') ? `?ref=${key.slice(4)}` : key,
        topUrl: null,
        views: 0,
      }
      byKey.set(key, ref)
    }
    ref.views += n(r.views)
    if (!ref.topUrl && url) {
      try {
        const u = new URL(url)
        if (u.pathname.length > 1 || u.search) ref.topUrl = url
      } catch {
        /* not a URL; leave it out */
      }
    }
  }

  const mailRows = mail as Row[]
  const t = totals as Row | undefined
  const p = prev as Row | undefined
  const l = live as Row | undefined

  return {
    days,
    series,
    sends: (sends as Row[]).map((r) => ({ day: dayOf(new Date(n(r.sent_at))), subject: String(r.subject) })),
    totals: {
      views: n(t?.views),
      visitors: n(t?.visitors),
      avgSeconds: t?.avg_seconds == null ? null : Math.round(n(t.avg_seconds)),
      opens: series.reduce((a, d) => a + d.opens, 0),
      clicks: series.reduce((a, d) => a + d.clicks, 0),
      clicksToSite: mailRows.reduce((a, r) => a + n(r.to_site), 0),
      prevViews: n(p?.views),
      prevVisitors: n(p?.visitors),
    },
    live: { views: n(l?.views), visitors: n(l?.visitors) },
    top: topRows.map((r) => {
      const id = typeof r.broadcast_id === 'number' ? r.broadcast_id : null
      const path = String(r.path)
      return {
        broadcastId: id,
        title: id && r.subject ? String(r.subject) : (PAGE_TITLES[path] ?? path),
        path,
        views: n(r.views),
        visitors: n(r.visitors),
        avgSeconds: r.avg_seconds == null ? null : Math.round(n(r.avg_seconds)),
        emailReads: id ? (reads.get(id) ?? 0) : null,
      }
    }),
    referrers: [...byKey.values()].sort((a, b) => b.views - a.views).slice(0, 8),
    countries: (geo as Row[]).map((r) => ({ code: String(r.country), views: n(r.views) })),
  }
}
