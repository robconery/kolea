import { asc, desc, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { type GoalProgress, type Window, goalProgress, windowFor } from './goals.ts'
import { type Component, type RawTotals, type Scored, scoreTotals } from './signal.ts'
import { goals } from '../db/schema.ts'

/**
 * ⭐ Analytics — the measured answer to "am I doing this right?"
 *
 * Everything on the analytics screens is derived here, and derived *once*. The
 * pages are dumb: they take a shape from this file and draw it.
 *
 * ## Three rules the whole file obeys
 *
 * **1. One denominator: reached.** Every rate is over `recipients - bounced`,
 * never over delivered. Resend's delivered webhooks cover a fraction of what
 * goes out and Kit-era rows have no delivered figure at all, so dividing by it
 * reports open rates above 100%. `core/signal.ts` made this rule; this file
 * inherits it without exception.
 *
 * **2. Live and imported are never blended.** A sequence with Kit totals is
 * scored from those totals alone; one with `messages` rows is scored from those
 * alone. Half of each is a number that describes nothing. Every row carries
 * `source` so the UI can label which it is looking at.
 *
 * **3. Unmeasurable is not zero.** Kit-era mail could not have a conversion
 * attached — nothing was sent from here, so no click could be recorded, so no
 * last-touch could ever land. Those rows carry `converted: null`, MONEY drops
 * out of the score, and the remaining components renormalize. Scoring them zero
 * on money would rank every pre-cutover sequence below every post-cutover one
 * for a reason that has nothing to do with the writing.
 *
 * ## Query budget
 *
 * D1 allows 1,000 queries per Worker invocation. Every function here is a fixed
 * number of grouped queries regardless of how many sequences or broadcasts
 * exist — never one query per row. The list screens are the ones that would
 * blow the budget, so they are the ones written as aggregates.
 */

// ────────────────────────────────────────────────────────── shared shapes

const DAY_MS = 86_400_000

/**
 * Below this many people reached, a sequence is not scored at all.
 *
 * A 100% click-to-open across eight people is noise wearing a suit, and it
 * would sit at the top of the leaderboard forever. Unscored is the honest
 * answer, and the rates are still shown beside it so nothing is hidden.
 */
export const MIN_REACH_TO_SCORE = 30

/** Rates that hang off any set of totals. Zero denominators yield 0, not NaN. */
export interface Rates {
  /** Opens over reached. Inflated by Apple MPP; read it as a subject-line signal. */
  open: number
  /** Clicks over reached. The figure Kit reports, so imported rows can join in. */
  click: number
  /** Clicks over opens — "of the people who looked, how many moved". MPP-immune. */
  ctor: number
  /** Unsubscribes over reached. What the send cost. */
  unsub: number
}

export function ratesFrom(t: {
  reached: number
  opened: number
  clicked: number
  unsubscribed: number
}): Rates {
  return {
    open: t.reached ? t.opened / t.reached : 0,
    click: t.reached ? t.clicked / t.reached : 0,
    ctor: t.opened ? t.clicked / t.opened : 0,
    unsub: t.reached ? t.unsubscribed / t.reached : 0,
  }
}

// ────────────────────────────────────────────────────────── sequences

export interface SequenceEnrollment {
  active: number
  completed: number
  cancelled: number
  optedOut: number
  /** Everyone who was ever enrolled — the denominator for completion. */
  total: number
}

export interface SequencePerf {
  id: number
  slug: string
  name: string
  isActive: boolean
  trigger: 'subscribe' | 'tag_added' | 'manual'
  steps: number
  /** Sum of every step's delay — the length of the sequence in days. */
  spanDays: number
  campaignId: number | null
  campaignName: string | null

  source: 'live' | 'imported'
  /** Non-null only for imported rows: Kit's count of who is in it *now*. */
  importedSubscribers: number | null

  reached: number
  opened: number
  clicked: number
  unsubscribed: number
  /** Null when conversions were never measurable here (Kit-era). */
  converted: number | null
  convertedCents: number

  rates: Rates
  enrollment: SequenceEnrollment
  /** Completed over everyone who ever entered. Null when nobody has. */
  completionRate: number | null

  score: number | null
  verdict: string
  components: Component[]
}

/**
 * Every sequence, scored — the leaderboard.
 *
 * Six grouped queries, flat, regardless of how many sequences exist. The Kit
 * screen this replaces showed subscribers, open rate, click rate and
 * unsubscribers; this adds what Kit could not: what each sequence is *worth*,
 * how many people finish it, and one score that folds all of it together.
 *
 * ## Imported rows carry rates, not counts
 *
 * Kit reports sequence engagement as percentages with no denominators anywhere
 * in its UI. Rather than invent counts by multiplying by a "Subscribers" figure
 * that means something else entirely (who is enrolled *now*, not who was ever
 * mailed), imported rows reconstruct counts against the enrollment total that
 * actually exists here, and are labelled `imported` everywhere they surface.
 * The score they produce is directionally honest and clearly marked; a precise
 * number invented out of two incompatible figures would not be either.
 */
export async function sequencePerformance(db: Db): Promise<SequencePerf[]> {
  const rows = (await db.all(sql`
    select s.id, s.slug, s.name, s.is_active, s.trigger, s.campaign_id,
           c.name as campaign_name,
           s.imported_subscribers, s.imported_open_rate,
           s.imported_click_rate, s.imported_unsubscribed,
           (select count(*) from sequence_steps ss where ss.sequence_id = s.id) as steps,
           (select coalesce(sum(ss.delay_days), 0) from sequence_steps ss
             where ss.sequence_id = s.id) as span_days
    from sequences s
    left join campaigns c on c.id = s.campaign_id
    order by s.name collate nocase
  `)) as {
    id: number
    slug: string
    name: string
    is_active: number
    trigger: 'subscribe' | 'tag_added' | 'manual'
    campaign_id: number | null
    campaign_name: string | null
    imported_subscribers: number | null
    imported_open_rate: number | null
    imported_click_rate: number | null
    imported_unsubscribed: number | null
    steps: number
    span_days: number
  }[]

  if (!rows.length) return []

  // Live engagement, per sequence. `count(distinct m.id)` rather than `count(*)`:
  // the left join fans one message out into a row per event, so a well-engaged
  // message would otherwise count as three recipients and deflate every rate.
  const live = (await db.all(sql`
    select ss.sequence_id as id,
           count(distinct m.id) as recipients,
           count(distinct case when e.type = 'open' then e.message_id end) as opened,
           count(distinct case when e.type = 'click' then e.message_id end) as clicked,
           count(distinct case when e.type = 'bounce' then e.message_id end) as bounced,
           count(distinct case when e.type = 'complaint' then e.message_id end) as complained,
           count(distinct case when e.type = 'unsubscribe' then e.message_id end) as unsubscribed
    from messages m
    join sequence_steps ss on ss.id = m.sequence_step_id
    left join events e on e.message_id = m.id
    group by ss.sequence_id
  `)) as ({ id: number } & Omit<RawTotals, 'converted' | 'convertedCents'>)[]
  const liveById = new Map(live.map((r) => [Number(r.id), r]))

  // Separate query, not another join: conversions fan out independently of
  // events, and joining both at once multiplies the two counts together.
  const conv = (await db.all(sql`
    select source_id as id, count(*) as n, coalesce(sum(value_cents), 0) as cents
    from conversions
    where source_kind = 'sequence'
    group by source_id
  `)) as { id: number; n: number; cents: number }[]
  const convById = new Map(conv.map((r) => [Number(r.id), r]))

  const enrol = (await db.all(sql`
    select sequence_id as id, status, count(*) as n
    from sequence_enrollments
    group by sequence_id, status
  `)) as { id: number; status: string; n: number }[]

  const opts = (await db.all(sql`
    select sequence_id as id, count(*) as n from sequence_optouts group by sequence_id
  `)) as { id: number; n: number }[]
  const optById = new Map(opts.map((r) => [Number(r.id), Number(r.n)]))

  return rows.map((r) => {
    const mine = enrol.filter((e) => Number(e.id) === r.id)
    const st = (k: string) => Number(mine.find((e) => e.status === k)?.n ?? 0)
    const enrollment: SequenceEnrollment = {
      active: st('active'),
      completed: st('completed'),
      cancelled: st('cancelled'),
      optedOut: optById.get(r.id) ?? 0,
      total: mine.reduce((n, e) => n + Number(e.n), 0),
    }

    const hit = liveById.get(r.id)
    const isLive = !!hit && Number(hit.recipients) > 0

    let totals: RawTotals
    if (isLive && hit) {
      totals = {
        recipients: Number(hit.recipients),
        opened: Number(hit.opened),
        clicked: Number(hit.clicked),
        bounced: Number(hit.bounced),
        complained: Number(hit.complained),
        unsubscribed: Number(hit.unsubscribed),
        // Live: a zero here is a real, measured zero.
        converted: Number(convById.get(r.id)?.n ?? 0),
        convertedCents: Number(convById.get(r.id)?.cents ?? 0),
      }
    } else {
      // Kit-era. Rates × the population that actually passed through the
      // sequence here. `imported_subscribers` is deliberately NOT the
      // denominator — it is who Kit has enrolled today, which is a different
      // question from who was ever mailed.
      const base = enrollment.total || r.imported_subscribers || 0
      const openRate = r.imported_open_rate ?? 0
      const clickRate = r.imported_click_rate ?? 0
      totals = {
        recipients: base,
        opened: Math.round(base * openRate),
        clicked: Math.round(base * clickRate),
        // Kit's recipient count is already net of bounces, which keeps
        // `recipients - bounced` correct on both paths.
        bounced: 0,
        complained: 0,
        unsubscribed: r.imported_unsubscribed ?? 0,
        // Nothing was sent from here, so no click could be recorded and no
        // last-touch could ever land. Null, not zero — see rule 3 up top.
        converted: null,
        convertedCents: 0,
      }
    }

    const raw: Scored = scoreTotals(totals)
    const reached = raw.reached
    const scored: Scored =
      reached < MIN_REACH_TO_SCORE
        ? {
            ...raw,
            score: null,
            verdict: `Too few people through it to score — ${reached} reached.`,
          }
        : raw

    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      isActive: !!r.is_active,
      trigger: r.trigger,
      steps: Number(r.steps),
      spanDays: Number(r.span_days),
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      source: (isLive ? 'live' : 'imported') as 'live' | 'imported',
      importedSubscribers: r.imported_subscribers,
      reached,
      opened: totals.opened,
      clicked: totals.clicked,
      unsubscribed: totals.unsubscribed,
      converted: totals.converted,
      convertedCents: totals.convertedCents,
      rates: ratesFrom({
        reached,
        opened: totals.opened,
        clicked: totals.clicked,
        unsubscribed: totals.unsubscribed,
      }),
      enrollment,
      completionRate: enrollment.total ? enrollment.completed / enrollment.total : null,
      score: scored.score,
      verdict: scored.verdict,
      components: scored.components,
    }
  })
}

export interface StepPerf {
  id: number
  position: number
  subject: string
  delayDays: number
  /** Cumulative days from enrollment to this step landing. */
  dayOffset: number
  sent: number
  reached: number
  opened: number
  clicked: number
  unsubscribed: number
  converted: number
  cents: number
  rates: Rates
  /** Share of the *first* step's recipients that still got this one, 0–1. */
  retention: number
}

/**
 * The step-by-step walk through one sequence — where people fall out.
 *
 * This is the question a sequence can answer that a broadcast cannot: mail four
 * goes to fewer people than mail one, and the shape of that decline is the
 * single most actionable thing on the whole analytics section. A step that
 * halves the retention curve is the step to rewrite.
 *
 * `retention` is measured against step one's recipients, not against the
 * previous step: chained ratios hide a slow bleed across five steps behind five
 * unremarkable-looking numbers.
 */
export async function sequenceSteps(db: Db, sequenceId: number): Promise<StepPerf[]> {
  const rows = (await db.all(sql`
    select ss.id, ss.position, ss.subject, ss.delay_days,
           count(distinct m.id) as sent,
           count(distinct case when e.type = 'open' then e.message_id end) as opened,
           count(distinct case when e.type = 'click' then e.message_id end) as clicked,
           count(distinct case when e.type = 'bounce' then e.message_id end) as bounced,
           count(distinct case when e.type = 'unsubscribe' then e.message_id end) as unsubscribed
    from sequence_steps ss
    left join messages m on m.sequence_step_id = ss.id
    left join events e on e.message_id = m.id
    where ss.sequence_id = ${sequenceId}
    group by ss.id
    order by ss.position
  `)) as {
    id: number
    position: number
    subject: string
    delay_days: number
    sent: number
    opened: number
    clicked: number
    bounced: number
    unsubscribed: number
  }[]

  // Conversions land on a message; the message knows its step. Separate query
  // for the same reason as everywhere else — it fans out independently.
  const conv = (await db.all(sql`
    select m.sequence_step_id as id, count(*) as n,
           coalesce(sum(cv.value_cents), 0) as cents
    from conversions cv
    join messages m on m.id = cv.message_id
    where m.sequence_step_id is not null
      and m.sequence_step_id in (
        select id from sequence_steps where sequence_id = ${sequenceId}
      )
    group by m.sequence_step_id
  `)) as { id: number; n: number; cents: number }[]
  const convById = new Map(conv.map((r) => [Number(r.id), r]))

  const first = Number(rows[0]?.sent ?? 0)
  let offset = 0

  return rows.map((r) => {
    offset += Number(r.delay_days)
    const reached = Math.max(0, Number(r.sent) - Number(r.bounced))
    const c = convById.get(r.id)
    return {
      id: r.id,
      position: Number(r.position),
      subject: r.subject,
      delayDays: Number(r.delay_days),
      dayOffset: offset,
      sent: Number(r.sent),
      reached,
      opened: Number(r.opened),
      clicked: Number(r.clicked),
      unsubscribed: Number(r.unsubscribed),
      converted: Number(c?.n ?? 0),
      cents: Number(c?.cents ?? 0),
      rates: ratesFrom({
        reached,
        opened: Number(r.opened),
        clicked: Number(r.clicked),
        unsubscribed: Number(r.unsubscribed),
      }),
      retention: first ? Number(r.sent) / first : 0,
    }
  })
}

/** Enrollments started per month — is anybody still entering this sequence? */
export async function sequenceIntake(
  db: Db,
  sequenceId: number,
  months = 12,
): Promise<{ month: string; n: number }[]> {
  const since = Date.now() - months * 31 * DAY_MS
  const rows = (await db.all(sql`
    select strftime('%Y-%m', enrolled_at / 1000, 'unixepoch') as month, count(*) as n
    from sequence_enrollments
    where sequence_id = ${sequenceId} and enrolled_at >= ${since}
    group by month
    order by month
  `)) as { month: string; n: number }[]
  return rows.map((r) => ({ month: r.month, n: Number(r.n) }))
}

// ────────────────────────────────────────────────────────── contribution

export type SourceKind = 'broadcast' | 'sequence' | 'form' | 'direct'

export interface Contribution {
  sourceKind: SourceKind
  sourceId: number
  /** Resolved name, or a plain description when there is nothing to name. */
  label: string
  /** Where to go to read more. Null for `direct`, which is not a thing you open. */
  href: string | null
  n: number
  cents: number
  /** Share of the window's conversions, 0–1. By count, not by money. */
  share: number
}

export interface ChannelSplit {
  kind: SourceKind
  label: string
  n: number
  cents: number
  share: number
}

export interface Attribution {
  total: number
  cents: number
  channels: ChannelSplit[]
  sources: Contribution[]
}

const CHANNEL_LABEL: Record<SourceKind, string> = {
  broadcast: 'Broadcasts',
  sequence: 'Sequences',
  form: 'Forms',
  direct: 'Direct / unattributed',
}

/**
 * Who gets the credit for the conversions inside a window.
 *
 * Split two ways at once, on purpose: by channel (is my mail working at all?)
 * and by individual source (which mail specifically?). Both come off the same
 * two queries.
 *
 * ⚠️ `direct` is not a failure of the system, and the UI must not draw it as
 * one. It means nobody clicked an email inside the attribution window before
 * buying — which for a list this size is most sales, most of the time. It is the
 * honest answer, and the number worth watching is whether the *attributed* share
 * is growing, not whether direct is small.
 */
export async function attributionIn(
  db: Db,
  win: { start: Date; end: Date },
  filters: { kindId?: number | null; campaignId?: number | null } = {},
): Promise<Attribution> {
  const kindClause = filters.kindId ? sql` and kind_id = ${filters.kindId}` : sql``
  const campClause = filters.campaignId ? sql` and campaign_id = ${filters.campaignId}` : sql``

  const rows = (await db.all(sql`
    select source_kind, source_id, count(*) as n, coalesce(sum(value_cents), 0) as cents
    from conversions
    where occurred_at >= ${win.start.getTime()} and occurred_at < ${win.end.getTime()}
      ${kindClause} ${campClause}
    group by source_kind, source_id
  `)) as { source_kind: SourceKind; source_id: number; n: number; cents: number }[]

  const total = rows.reduce((n, r) => n + Number(r.n), 0)
  const cents = rows.reduce((n, r) => n + Number(r.cents), 0)

  const channels: ChannelSplit[] = (
    ['sequence', 'broadcast', 'form', 'direct'] as SourceKind[]
  ).map((kind) => {
    const mine = rows.filter((r) => r.source_kind === kind)
    const n = mine.reduce((acc, r) => acc + Number(r.n), 0)
    return {
      kind,
      label: CHANNEL_LABEL[kind],
      n,
      cents: mine.reduce((acc, r) => acc + Number(r.cents), 0),
      share: total ? n / total : 0,
    }
  })

  const names = await resolveSourceNames(db, rows)

  const sources: Contribution[] = rows
    .filter((r) => r.source_kind !== 'direct')
    .map((r) => ({
      sourceKind: r.source_kind,
      sourceId: Number(r.source_id),
      label: names.get(`${r.source_kind}:${r.source_id}`) ?? `#${r.source_id}`,
      href: sourceHref(r.source_kind, Number(r.source_id)),
      n: Number(r.n),
      cents: Number(r.cents),
      share: total ? Number(r.n) / total : 0,
    }))
    .sort((a, b) => b.cents - a.cents || b.n - a.n)

  return { total, cents, channels, sources }
}

function sourceHref(kind: SourceKind, id: number): string | null {
  if (kind === 'broadcast') return `/broadcasts/${id}`
  if (kind === 'sequence') return `/analytics/sequences/${id}`
  if (kind === 'form') return `/forms/${id}`
  return null
}

/**
 * Turn (kind, id) pairs into names. Three queries at most, and only for the
 * kinds actually present — `source_id` points at three different tables, which
 * is why it is not a foreign key (see the schema note on `conversions`).
 */
async function resolveSourceNames(
  db: Db,
  rows: { source_kind: SourceKind; source_id: number }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const idsOf = (kind: SourceKind) => [
    ...new Set(rows.filter((r) => r.source_kind === kind).map((r) => Number(r.source_id))),
  ]

  const bcast = idsOf('broadcast')
  if (bcast.length) {
    const ids = sql.join(
      bcast.map((i) => sql`${i}`),
      sql`, `,
    )
    const got = (await db.all(
      sql`select id, subject as name from broadcasts where id in (${ids})`,
    )) as { id: number; name: string }[]
    for (const r of got) out.set(`broadcast:${r.id}`, r.name)
  }

  const seq = idsOf('sequence')
  if (seq.length) {
    const ids = sql.join(
      seq.map((i) => sql`${i}`),
      sql`, `,
    )
    const got = (await db.all(sql`select id, name from sequences where id in (${ids})`)) as {
      id: number
      name: string
    }[]
    for (const r of got) out.set(`sequence:${r.id}`, r.name)
  }

  const form = idsOf('form')
  if (form.length) {
    const ids = sql.join(
      form.map((i) => sql`${i}`),
      sql`, `,
    )
    const got = (await db.all(sql`select id, name from forms where id in (${ids})`)) as {
      id: number
      name: string
    }[]
    for (const r of got) out.set(`form:${r.id}`, r.name)
  }

  return out
}

/** The same split, for one goal's window and filters. */
export async function goalAttribution(
  db: Db,
  goal: typeof goals.$inferSelect,
): Promise<{ window: Window; attribution: Attribution }> {
  const win = windowFor({
    type: goal.periodType,
    year: goal.periodYear,
    index: goal.periodIndex,
  })
  const attribution = await attributionIn(db, win, {
    kindId: goal.kindId,
    campaignId: goal.campaignId,
  })
  return { window: win, attribution }
}

/** Conversions per month, split by channel — the mix, over time. */
export interface MixPoint {
  month: string
  sequence: number
  broadcast: number
  form: number
  direct: number
  cents: number
}

export async function conversionMix(db: Db, months = 12): Promise<MixPoint[]> {
  const since = Date.now() - months * 31 * DAY_MS
  const rows = (await db.all(sql`
    select strftime('%Y-%m', occurred_at / 1000, 'unixepoch') as month,
           source_kind, count(*) as n, coalesce(sum(value_cents), 0) as cents
    from conversions
    where occurred_at >= ${since}
    group by month, source_kind
    order by month
  `)) as { month: string; source_kind: SourceKind; n: number; cents: number }[]

  const byMonth = new Map<string, MixPoint>()
  for (const r of rows) {
    const point = byMonth.get(r.month) ?? {
      month: r.month,
      sequence: 0,
      broadcast: 0,
      form: 0,
      direct: 0,
      cents: 0,
    }
    point[r.source_kind] += Number(r.n)
    point.cents += Number(r.cents)
    byMonth.set(r.month, point)
  }
  return [...byMonth.values()]
}

// ────────────────────────────────────────────────────────── list health

export interface HealthMetric {
  key: string
  label: string
  /** Pre-formatted, because the unit differs per metric (%, count, money). */
  value: string
  /** 0–100 for the bar. Null when the metric is a plain count with no target. */
  score: number | null
  band: 'strong' | 'good' | 'fair' | 'weak' | 'none'
  detail: string
  /** What to do about it, when there is something to do. */
  note: string | null
}

export interface ListHealth {
  /** 0–100, the mean of the scored metrics. Null when nothing is measurable. */
  score: number | null
  metrics: HealthMetric[]
  size: { total: number; active: number; unsubscribed: number; bounced: number }
  growth: { month: string; joined: number; left: number }[]
  /** People with an open or click in the last 90 days, over active. */
  engaged: number
  engagedRate: number
}

function bandOf(score: number | null): HealthMetric['band'] {
  if (score === null) return 'none'
  if (score >= 75) return 'strong'
  if (score >= 55) return 'good'
  if (score >= 35) return 'fair'
  return 'weak'
}

/** Linear map between two anchors, clamped. Works inverted (floor > target). */
function anchor(rate: number, floor: number, target: number): number {
  if (floor === target) return 0
  return Math.max(0, Math.min(100, ((rate - floor) / (target - floor)) * 100))
}

const pct1 = (n: number) => `${(n * 100).toFixed(1)}%`

/**
 * ⭐ "Is my list healthy?" — five metrics and one number.
 *
 * Deliberately *not* the same instrument as Signal. Signal scores one send;
 * this scores the asset. A list can be growing beautifully while the last
 * broadcast flopped, and the two questions want different answers.
 *
 * The five, and why each earns its place:
 *
 *   GROWTH — net adds over the last 90 days against list size. A list that
 *     isn't growing is shrinking; bounces and unsubscribes never stop.
 *   ENGAGED — share of active subscribers who opened or clicked anything in 90
 *     days. The single best predictor of inbox placement there is, and the one
 *     number that says how much of the list is real.
 *   CHURN — unsubscribes over mail reached, inverted. What sending costs.
 *   DELIVERY — bounces and complaints over reached, inverted. Complaints are
 *     weighted into this one because a complaint is a deliverability event
 *     first and an opinion second.
 *   MONEY — conversions per thousand reached over 90 days. Whether the list
 *     does anything beyond existing.
 */
export async function listHealth(db: Db, now = Date.now()): Promise<ListHealth> {
  const since90 = now - 90 * DAY_MS

  const size = (await db.get(sql`
    select count(*) as total,
           sum(case when status = 'active' then 1 else 0 end) as active,
           sum(case when status = 'unsubscribed' then 1 else 0 end) as unsubscribed,
           sum(case when status in ('bounced', 'complained') then 1 else 0 end) as bounced
    from subscribers
  `)) as { total: number; active: number; unsubscribed: number; bounced: number } | undefined

  const total = Number(size?.total ?? 0)
  const active = Number(size?.active ?? 0)

  const growth = (await db.all(sql`
    select strftime('%Y-%m', created_at / 1000, 'unixepoch') as month, count(*) as n
    from subscribers
    where created_at >= ${now - 365 * DAY_MS}
    group by month order by month
  `)) as { month: string; n: number }[]

  const left = (await db.all(sql`
    select strftime('%Y-%m', unsubscribed_at / 1000, 'unixepoch') as month, count(*) as n
    from subscribers
    where unsubscribed_at is not null and unsubscribed_at >= ${now - 365 * DAY_MS}
    group by month order by month
  `)) as { month: string; n: number }[]
  const leftBy = new Map(left.map((r) => [r.month, Number(r.n)]))

  const series = growth.map((r) => ({
    month: r.month,
    joined: Number(r.n),
    left: leftBy.get(r.month) ?? 0,
  }))

  // Engagement over the last 90 days. Distinct people, not events — somebody who
  // opens every send is one engaged subscriber, not forty.
  const eng = (await db.get(sql`
    select count(distinct m.subscriber_id) as n
    from events e join messages m on m.id = e.message_id
    where e.type in ('open', 'click') and e.occurred_at >= ${since90}
  `)) as { n: number } | undefined
  const engaged = Number(eng?.n ?? 0)

  // Mail sent in the window, and what it cost. One query, same denominator rule.
  const mail = (await db.get(sql`
    select count(distinct m.id) as recipients,
           count(distinct case when e.type = 'bounce' then e.message_id end) as bounced,
           count(distinct case when e.type = 'complaint' then e.message_id end) as complained,
           count(distinct case when e.type = 'unsubscribe' then e.message_id end) as unsubscribed
    from messages m
    left join events e on e.message_id = m.id
    where m.created_at >= ${since90}
  `)) as
    | { recipients: number; bounced: number; complained: number; unsubscribed: number }
    | undefined

  const reached = Math.max(0, Number(mail?.recipients ?? 0) - Number(mail?.bounced ?? 0))

  const conv = (await db.get(sql`
    select count(*) as n, coalesce(sum(value_cents), 0) as cents
    from conversions where occurred_at >= ${since90}
  `)) as { n: number; cents: number } | undefined

  const joined90 = (await db.get(sql`
    select count(*) as n from subscribers where created_at >= ${since90}
  `)) as { n: number } | undefined
  const left90 = (await db.get(sql`
    select count(*) as n from subscribers
    where unsubscribed_at is not null and unsubscribed_at >= ${since90}
  `)) as { n: number } | undefined

  const netAdds = Number(joined90?.n ?? 0) - Number(left90?.n ?? 0)
  // Annualized against list size: +2% a quarter is a real list growing steadily,
  // +10% is a launch, flat is decay once bounces are counted.
  const growthRate = total ? netAdds / total : 0
  const engagedRate = active ? engaged / active : 0
  const churnRate = reached ? Number(mail?.unsubscribed ?? 0) / reached : 0
  const deliveryRate = reached
    ? (Number(mail?.bounced ?? 0) + Number(mail?.complained ?? 0)) / reached
    : 0
  const moneyRate = reached ? Number(conv?.n ?? 0) / reached : 0

  const metrics: HealthMetric[] = [
    {
      key: 'growth',
      label: 'Growth',
      value: `${netAdds >= 0 ? '+' : ''}${netAdds.toLocaleString('en-US')}`,
      score: total ? Math.round(anchor(growthRate, 0, 0.06)) : null,
      band: 'none',
      detail: `net over 90 days · ${pct1(growthRate)} of the list`,
      note:
        netAdds <= 0
          ? 'The list shrank this quarter. Every list does without a working way in — check the forms.'
          : null,
    },
    {
      key: 'engaged',
      label: 'Engaged',
      value: pct1(engagedRate),
      score: active ? Math.round(anchor(engagedRate, 0.1, 0.45)) : null,
      band: 'none',
      detail: `${engaged.toLocaleString('en-US')} of ${active.toLocaleString('en-US')} active opened or clicked in 90 days`,
      note:
        engagedRate < 0.2 && active > 0
          ? 'Under a fifth of the list is responding. Mailbox providers read that the same way you would.'
          : null,
    },
    {
      key: 'churn',
      label: 'Churn',
      value: pct1(churnRate),
      // Inverted: 0.5% leaving per send is bad, 0.05% is normal.
      score: reached ? Math.round(anchor(churnRate, 0.005, 0.0005)) : null,
      band: 'none',
      detail: `${Number(mail?.unsubscribed ?? 0).toLocaleString('en-US')} left of ${reached.toLocaleString('en-US')} reached`,
      note:
        churnRate > 0.004
          ? 'Sending is costing more readers than it should. Look at what went out, not at the list.'
          : null,
    },
    {
      key: 'delivery',
      label: 'Delivery',
      value: pct1(deliveryRate),
      score: reached ? Math.round(anchor(deliveryRate, 0.02, 0.001)) : null,
      band: 'none',
      detail: `${Number(mail?.bounced ?? 0).toLocaleString('en-US')} bounced, ${Number(mail?.complained ?? 0).toLocaleString('en-US')} complained`,
      note:
        deliveryRate > 0.01
          ? 'Bounces and complaints are above the line where providers start throttling.'
          : null,
    },
    {
      key: 'money',
      label: 'Money',
      value: `${(moneyRate * 1000).toFixed(1)}`,
      score: reached ? Math.round(anchor(moneyRate, 0.001, 0.02)) : null,
      band: 'none',
      detail: `conversions per 1,000 reached · ${Number(conv?.n ?? 0).toLocaleString('en-US')} in 90 days`,
      note: null,
    },
  ].map((m) => ({ ...m, band: bandOf(m.score) }))

  const scored = metrics.filter((m) => m.score !== null).map((m) => m.score as number)
  const score = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null

  return {
    score,
    metrics,
    size: {
      total,
      active,
      unsubscribed: Number(size?.unsubscribed ?? 0),
      bounced: Number(size?.bounced ?? 0),
    },
    growth: series,
    engaged,
    engagedRate,
  }
}

// ────────────────────────────────────────────────────────── broadcast roll-up

export interface SendingCadence {
  month: string
  sends: number
  reached: number
}

/** How often mail actually goes out. Cadence is half of what a list responds to. */
export async function broadcastCadence(db: Db, months = 12): Promise<SendingCadence[]> {
  const since = Date.now() - months * 31 * DAY_MS
  const rows = (await db.all(sql`
    select strftime('%Y-%m', b.sent_at / 1000, 'unixepoch') as month,
           count(*) as sends,
           coalesce(sum(
             case when b.imported_recipients is not null then b.imported_recipients
             else (select count(*) from messages m where m.broadcast_id = b.id) end
           ), 0) as reached
    from broadcasts b
    where b.status = 'sent' and b.sent_at is not null and b.sent_at >= ${since}
    group by month order by month
  `)) as { month: string; sends: number; reached: number }[]
  return rows.map((r) => ({
    month: r.month,
    sends: Number(r.sends),
    reached: Number(r.reached),
  }))
}

// ────────────────────────────────────────────────────────── the goal board

export interface GoalBoardRow {
  progress: GoalProgress
  attribution: Attribution
  /** Pace, as a sentence, when the period is open and a target exists. */
  pace: string | null
  /** True when the goal is behind where the calendar says it should be. */
  behind: boolean
}

/**
 * ⭐ Goals, and what is actually feeding them.
 *
 * The join this whole section exists for. `core/goals.ts` answers "how far
 * along is this target"; this answers "and which mail got it there" — the same
 * window, the same filters, split by the channel that earned the credit.
 *
 * Open goals first and capped, because the board is read, not audited: six
 * scored goals is a page you look at, twenty is a spreadsheet you don't.
 */
export async function goalBoard(
  db: Db,
  opts: { limit?: number; includeClosed?: boolean } = {},
): Promise<GoalBoardRow[]> {
  const limit = opts.limit ?? 6
  const now = new Date()

  const rows = await db
    .select()
    .from(goals)
    .orderBy(desc(goals.periodYear), desc(goals.periodIndex), asc(goals.id))
    .all()

  const open: (typeof goals.$inferSelect)[] = []
  const closed: (typeof goals.$inferSelect)[] = []
  for (const g of rows) {
    const win = windowFor({ type: g.periodType, year: g.periodYear, index: g.periodIndex })
    const t = now.getTime()
    if (t >= win.start.getTime() && t < win.end.getTime()) open.push(g)
    else if (t >= win.end.getTime()) closed.push(g)
  }

  // Falls back to the most recently closed ones so the board is never empty just
  // because a quarter rolled over before anything was set up for the new one.
  const picked = (open.length ? open : opts.includeClosed === false ? [] : closed).slice(0, limit)

  return await Promise.all(
    picked.map(async (g) => {
      const progress = await goalProgress(db, g, now)
      const attribution = await attributionIn(db, progress.window, {
        kindId: g.kindId,
        campaignId: g.campaignId,
      })

      // Pace only means something while the window is open and a target exists.
      const actual = progress.targetCount !== null ? progress.count : progress.cents
      const goalTarget = progress.targetCount ?? progress.targetCents
      let pace: string | null = null
      let behind = false
      if (progress.state === 'open' && goalTarget && progress.elapsed !== null) {
        const expected = goalTarget * progress.elapsed
        behind = actual < expected
        const share = goalTarget ? actual / goalTarget : 0
        pace = `${Math.round(share * 100)}% of the way there, ${Math.round(progress.elapsed * 100)}% through the period`
      }
      return { progress, attribution, pace, behind }
    }),
  )
}
