import { sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'

/**
 * ⭐ The pulse — what the list is doing *right now*.
 *
 * `core/signal.ts` grades a send once it has settled. This answers the question
 * you have in the hour after pressing send: is it being read, how fast, and
 * which links are people taking? And across the window: which mail is still
 * drawing readers, whatever week it went out.
 *
 * Same rules as `core/analytics.ts`: a fixed number of grouped queries per call,
 * never one per broadcast, and live history only — Kit-era broadcasts have no
 * events, so they can't be in motion.
 *
 * "Readers" is distinct messages with an open, not open events. One person
 * reopening a mail six times is one reader, and a chart of raw opens mostly
 * measures Apple's proxy re-fetching the pixel.
 */

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10)

/** How far the per-send curve runs. Most of a send's opens land inside it. */
export const CURVE_HOURS = 48

/** How long after somebody's first click an action still counts as the send's doing. */
export const ACTION_WINDOW_DAYS = 7
/** How many days after a send its form-view lift is measured over. */
export const LIFT_DAYS = 3

export interface LinkTaken {
  url: string
  /** Distinct people who clicked it. */
  people: number
}

export interface FormLift {
  /** Views across every form in the `LIFT_DAYS` from the send's day. */
  after: number
  /** Mean daily views over the week before, times `LIFT_DAYS`. Null with no history. */
  expected: number | null
}

export interface JustSent {
  id: number
  subject: string
  status: 'sending' | 'sent'
  /** When it started going out — the zero on the curve. */
  startedAt: Date | null
  recipients: number
  reached: number
  readers: number
  clickers: number
  /** Clickers who went on to submit a form within `ACTION_WINDOW_DAYS`. */
  submitted: number
  /** Clickers who entered a sequence within `ACTION_WINDOW_DAYS`. */
  enrolled: number
  /** Clickers who did either — people, not actions, so a form that starts a sequence counts once. */
  acted: number
  /** Last-touch conversions credited to this broadcast. */
  sales: number
  salesCents: number
  /** The links people took, most-taken first. The first is usually the call to action. */
  links: LinkTaken[]
  formLift: FormLift
  /** Distinct readers whose first open landed in the last 24 hours. */
  readersToday: number
  /** Clicks (events, not people) in the last 24 hours. */
  clicksToday: number
  lastEventAt: Date | null
  /** New readers per hour since send, `CURVE_HOURS` long. */
  curve: number[]
  /** Share of all readers so far who arrived inside the first 24 hours. */
  firstDayShare: number | null
}

/**
 * The most recent live broadcasts, in flight or finished: how they were read,
 * hour by hour, and what the people they moved did next — clicked which link,
 * filled in a form, entered a sequence, bought. Eight queries, whatever `limit`
 * is. Unsubscribes are deliberately absent; the broadcast's own page has them.
 */
export async function justSent(db: Db, limit = 6, now = Date.now()): Promise<JustSent[]> {
  const rows = (await db.all(sql`
    select id, subject, status, coalesce(started_at, sent_at) as started_at
    from broadcasts
    where status in ('sending', 'sent') and imported_recipients is null
    order by coalesce(started_at, sent_at) desc
    limit ${limit}
  `)) as { id: number; subject: string; status: 'sending' | 'sent'; started_at: number | null }[]
  if (!rows.length) return []

  const ids = sql.join(
    rows.map((r) => sql`${r.id}`),
    sql`, `,
  )
  const dayAgo = now - DAY_MS

  const totals = (await db.all(sql`
    select m.broadcast_id as id,
           count(distinct m.id) as recipients,
           count(distinct case when e.type = 'open' then e.message_id end) as readers,
           count(distinct case when e.type = 'click' then e.message_id end) as clickers,
           count(distinct case when e.type = 'bounce' then e.message_id end) as bounced,
           sum(case when e.type = 'click' and e.occurred_at >= ${dayAgo} then 1 else 0 end) as clicks_today,
           max(case when e.type in ('open', 'click') then e.occurred_at end) as last_event
    from messages m
    left join events e on e.message_id = m.id
    where m.broadcast_id in (${ids})
    group by m.broadcast_id
  `)) as {
    id: number
    recipients: number
    readers: number
    clickers: number
    bounced: number
    clicks_today: number | null
    last_event: number | null
  }[]
  const totalsById = new Map(totals.map((t) => [Number(t.id), t]))

  // First open per message, bucketed by hours since the broadcast started.
  // Everything past the curve is collapsed into one bucket so the share of
  // late readers is still countable without a row per hour of the year.
  const firsts = (await db.all(sql`
    select m.broadcast_id as id,
           min(max(cast((f.first_at - coalesce(b.started_at, b.sent_at)) / ${HOUR_MS} as integer), 0), ${CURVE_HOURS}) as h,
           count(*) as n,
           sum(case when f.first_at >= ${dayAgo} then 1 else 0 end) as today
    from (
      select message_id, min(occurred_at) as first_at
      from events
      where type = 'open'
        and message_id in (select id from messages where broadcast_id in (${ids}))
      group by message_id
    ) f
    join messages m on m.id = f.message_id
    join broadcasts b on b.id = m.broadcast_id
    group by 1, 2
  `)) as { id: number; h: number; n: number; today: number }[]

  // What clickers did next. Anchored on each person's FIRST click on this
  // broadcast, so a form filled in the week after reading it counts, and one
  // filled the week before doesn't. Not attribution — a person who clicked two
  // sends and then subscribed counts for both — it answers "did the people this
  // mail moved go on to do something", which is the question on this screen.
  const acts = (await db.all(sql`
    with firsts as (
      select m.broadcast_id as bid, m.subscriber_id as sid, min(e.occurred_at) as at
      from events e
      join messages m on m.id = e.message_id
      where e.type = 'click' and m.broadcast_id in (${ids})
      group by 1, 2
    )
    select f.bid as id,
           count(distinct case when a.type = 'form_submitted' then a.subscriber_id end) as submitted,
           count(distinct case when a.type = 'sequence_enrolled' then a.subscriber_id end) as enrolled,
           count(distinct a.subscriber_id) as acted
    from firsts f
    join activities a on a.subscriber_id = f.sid
      and a.occurred_at >= f.at
      and a.occurred_at < f.at + ${ACTION_WINDOW_DAYS * DAY_MS}
      and a.type in ('form_submitted', 'sequence_enrolled')
      and a.source <> 'import'
    group by 1
  `)) as { id: number; submitted: number; enrolled: number; acted: number }[]
  const actsById = new Map(acts.map((a) => [Number(a.id), a]))

  // Money is attribution, so it comes from the one ledger that does that.
  const conv = (await db.all(sql`
    select source_id as id, count(*) as n, coalesce(sum(value_cents), 0) as cents
    from conversions
    where source_kind = 'broadcast' and source_id in (${ids})
    group by source_id
  `)) as { id: number; n: number; cents: number }[]
  const convById = new Map(conv.map((c) => [Number(c.id), c]))

  const linkRows = (await db.all(sql`
    select m.broadcast_id as id, json_extract(e.meta, '$.url') as url,
           count(distinct m.subscriber_id) as people
    from events e
    join messages m on m.id = e.message_id
    where e.type = 'click' and m.broadcast_id in (${ids})
      and json_extract(e.meta, '$.url') is not null
    group by 1, 2
    order by people desc
  `)) as { id: number; url: string; people: number }[]

  // Form views are anonymous, so the only honest link to a send is timing: how
  // many views landed in the days after it against the week before.
  const origins = rows.map((r) => r.started_at).filter((t): t is number => t !== null)
  const earliest = origins.length ? Math.min(...origins) : now
  const viewDays = (await db.all(sql`
    select day, sum(views) as views from form_views
    where day >= ${utcDay(earliest - 7 * DAY_MS)}
    group by day
  `)) as { day: string; views: number }[]
  const viewsOn = new Map(viewDays.map((v) => [v.day, Number(v.views)]))
  const firstTracked = viewDays.map((v) => v.day).sort()[0] ?? null

  const liftFor = (start: number | null): FormLift => {
    if (start === null) return { after: 0, expected: null }
    let after = 0
    for (let i = 0; i < LIFT_DAYS; i++) after += viewsOn.get(utcDay(start + i * DAY_MS)) ?? 0
    let before = 0
    let days = 0
    for (let i = 1; i <= 7; i++) {
      const d = utcDay(start - i * DAY_MS)
      // Days before the pixel existed are unknown, not zero.
      if (firstTracked === null || d < firstTracked) continue
      before += viewsOn.get(d) ?? 0
      days++
    }
    return { after, expected: days ? (before / days) * LIFT_DAYS : null }
  }

  return rows.map((r) => {
    const t = totalsById.get(r.id)
    const a = actsById.get(r.id)
    const cv = convById.get(r.id)
    const mine = firsts.filter((f) => Number(f.id) === r.id)
    const curve = Array.from({ length: CURVE_HOURS }, (_, h) =>
      Number(mine.find((f) => Number(f.h) === h)?.n ?? 0),
    )
    const readers = Number(t?.readers ?? 0)
    const firstDay = curve.slice(0, 24).reduce((a, b) => a + b, 0)
    const recipients = Number(t?.recipients ?? 0)
    return {
      id: r.id,
      subject: r.subject,
      status: r.status,
      startedAt: r.started_at ? new Date(r.started_at) : null,
      recipients,
      reached: Math.max(0, recipients - Number(t?.bounced ?? 0)),
      readers,
      clickers: Number(t?.clickers ?? 0),
      submitted: Number(a?.submitted ?? 0),
      enrolled: Number(a?.enrolled ?? 0),
      acted: Number(a?.acted ?? 0),
      sales: Number(cv?.n ?? 0),
      salesCents: Number(cv?.cents ?? 0),
      links: linkRows
        .filter((l) => Number(l.id) === r.id)
        .slice(0, 4)
        .map((l) => ({ url: String(l.url), people: Number(l.people) })),
      formLift: liftFor(r.started_at),
      readersToday: mine.reduce((n, f) => n + Number(f.today ?? 0), 0),
      clicksToday: Number(t?.clicks_today ?? 0),
      lastEventAt: t?.last_event ? new Date(Number(t.last_event)) : null,
      curve,
      firstDayShare: readers ? firstDay / readers : null,
    }
  })
}

export interface MostRead {
  /** 'broadcast' or 'sequence' — both are mail somebody can be reading this week. */
  kind: 'broadcast' | 'sequence'
  id: number
  label: string
  href: string
  sentAt: Date | null
  readers: number
  opens: number
  clickers: number
  clicks: number
}

/**
 * Which mail drew readers inside the window, whenever it was sent.
 *
 * Counts only engagement that *happened* in the window, so a broadcast from
 * last month that is still being opened shows up, and one that went out
 * yesterday to silence doesn't. Sequences are rolled up to the series, because
 * "step 3 of Welcome" is a line in the sequence screen, not here.
 */
export async function mostRead(db: Db, days = 30, limit = 10, now = Date.now()): Promise<MostRead[]> {
  const since = now - days * DAY_MS
  const rows = (await db.all(sql`
    select case when m.broadcast_id is not null then 'broadcast' else 'sequence' end as kind,
           coalesce(m.broadcast_id, ss.sequence_id) as id,
           coalesce(b.subject, s.name) as label,
           b.sent_at as sent_at,
           count(distinct case when e.type = 'open' then e.message_id end) as readers,
           sum(case when e.type = 'open' then 1 else 0 end) as opens,
           count(distinct case when e.type = 'click' then e.message_id end) as clickers,
           sum(case when e.type = 'click' then 1 else 0 end) as clicks
    from events e
    join messages m on m.id = e.message_id
    left join broadcasts b on b.id = m.broadcast_id
    left join sequence_steps ss on ss.id = m.sequence_step_id
    left join sequences s on s.id = ss.sequence_id
    where e.occurred_at >= ${since}
      and e.type in ('open', 'click')
      and (m.broadcast_id is not null or m.sequence_step_id is not null)
    group by 1, 2
    order by readers desc, clickers desc
    limit ${limit}
  `)) as {
    kind: 'broadcast' | 'sequence'
    id: number
    label: string | null
    sent_at: number | null
    readers: number
    opens: number
    clickers: number
    clicks: number
  }[]

  return rows.map((r) => ({
    kind: r.kind,
    id: Number(r.id),
    label: r.label ?? `#${r.id}`,
    href: r.kind === 'broadcast' ? `/broadcasts/${r.id}` : `/analytics/sequences/${r.id}`,
    sentAt: r.sent_at ? new Date(r.sent_at) : null,
    readers: Number(r.readers),
    opens: Number(r.opens),
    clickers: Number(r.clickers),
    clicks: Number(r.clicks),
  }))
}

export interface DayEngagement {
  day: string
  readers: number
  clickers: number
}

/** Distinct readers and clickers per UTC day across all mail. */
export async function engagementByDay(db: Db, days = 30, now = Date.now()): Promise<DayEngagement[]> {
  const since = now - days * DAY_MS
  const rows = (await db.all(sql`
    select date(occurred_at / 1000, 'unixepoch') as day,
           count(distinct case when type = 'open' then message_id end) as readers,
           count(distinct case when type = 'click' then message_id end) as clickers
    from events
    where occurred_at >= ${since} and type in ('open', 'click')
    group by 1
    order by 1
  `)) as { day: string; readers: number; clickers: number }[]

  // Fill the gaps: a quiet day is a zero on the chart, not a missing column
  // that makes the busy days look adjacent.
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const out: DayEngagement[] = []
  for (let t = since; t <= now; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10)
    const r = byDay.get(day)
    out.push({ day, readers: Number(r?.readers ?? 0), clickers: Number(r?.clickers ?? 0) })
  }
  return out
}

export interface TopLink {
  url: string
  clicks: number
  /** Distinct messages — near enough distinct people for one window. */
  people: number
  /** The mail that sent the most of those clicks. */
  topSubject: string | null
}

/** The links people actually took, inside the window. */
export async function topLinks(db: Db, days = 30, limit = 10, now = Date.now()): Promise<TopLink[]> {
  const since = now - days * DAY_MS
  const rows = (await db.all(sql`
    select json_extract(e.meta, '$.url') as url,
           count(*) as clicks,
           count(distinct e.message_id) as people,
           (select m2.subject from events e2
              join messages m2 on m2.id = e2.message_id
             where e2.type = 'click' and e2.occurred_at >= ${since}
               and json_extract(e2.meta, '$.url') = json_extract(e.meta, '$.url')
             group by m2.subject order by count(*) desc limit 1) as top_subject
    from events e
    where e.type = 'click' and e.occurred_at >= ${since}
      and json_extract(e.meta, '$.url') is not null
    group by 1
    order by people desc, clicks desc
    limit ${limit}
  `)) as { url: string; clicks: number; people: number; top_subject: string | null }[]
  return rows.map((r) => ({
    url: String(r.url),
    clicks: Number(r.clicks),
    people: Number(r.people),
    topSubject: r.top_subject,
  }))
}

export interface PulseNow {
  readers24: number
  readersPrev24: number
  clicks24: number
  clicksPrev24: number
}

/** The last 24 hours against the 24 before them. One query. */
export async function pulseNow(db: Db, now = Date.now()): Promise<PulseNow> {
  const a = now - DAY_MS
  const b = now - 2 * DAY_MS
  const r = (await db.get(sql`
    select count(distinct case when type = 'open' and occurred_at >= ${a} then message_id end) as r24,
           count(distinct case when type = 'open' and occurred_at < ${a} then message_id end) as rp,
           sum(case when type = 'click' and occurred_at >= ${a} then 1 else 0 end) as c24,
           sum(case when type = 'click' and occurred_at < ${a} then 1 else 0 end) as cp
    from events
    where occurred_at >= ${b} and type in ('open', 'click')
  `)) as { r24: number; rp: number; c24: number | null; cp: number | null } | undefined
  return {
    readers24: Number(r?.r24 ?? 0),
    readersPrev24: Number(r?.rp ?? 0),
    clicks24: Number(r?.c24 ?? 0),
    clicksPrev24: Number(r?.cp ?? 0),
  }
}
