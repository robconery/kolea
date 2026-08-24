import { sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'

/**
 * ⭐ Signal — one number for "is my writing landing?"
 *
 * The dashboard's hero question is not "how many did I send" but "was it any
 * good". That needs a single figure a person can read in a second, and a way to
 * see what fed it in the next five.
 *
 * Three components, weighted by how much each one actually reflects the writing:
 *
 *   READ (25) — opens over reached. Weighted LOW on purpose. Apple Mail Privacy
 *     Protection pre-fetches tracking pixels, so a large slice of any open rate is
 *     machines. It measures the subject line and the sending reputation, and it
 *     cannot measure the body at all.
 *
 *   PULL (45) — clicks over opens. The heaviest weight, because it is the only
 *     figure here where a human read the words and then decided to do something.
 *     It is also MPP-immune: a proxy that opens does not click.
 *
 *   COST (30) — unsubscribes and complaints over reached, inverted. A send that
 *     buys clicks by burning readers is not effective, it is borrowing.
 *
 *   MONEY (10) — conversions over reached. The point of the whole project, and
 *     weighted modestly anyway: most sends are not asking for money, and a
 *     newsletter that informs is not failing because nobody bought. It is the
 *     tiebreaker between two sends that read alike, not the headline.
 *
 * MONEY is *unavailable*, not zero, for Kit-era broadcasts — nothing was sent
 * from here, so no conversion could ever attach. An unavailable component is
 * dropped and the remaining weights renormalize, because scoring a broadcast
 * zero on a thing that was never measurable is a lie with a decimal point on it.
 *
 * Every rate is over `recipients - bounced`, never over `delivered`: Resend's
 * delivered webhooks cover only a fraction of what we send, and Kit-era rows have
 * no delivered figure at all. Dividing by it would report open rates above 100%.
 */

/** Rate that scores 0, rate that scores 100. Linear between, clamped outside. */
interface Anchor {
  floor: number
  target: number
}

export const ANCHORS = {
  /** A list this warm reads at ~50%. Below 15% something is wrong with delivery. */
  read: { floor: 0.15, target: 0.5 } satisfies Anchor,
  /** 1 in 100 readers clicking is weak; 1 in 10 is a genuinely good newsletter. */
  pull: { floor: 0.01, target: 0.1 } satisfies Anchor,
  /** Inverted — see `costScore`. Half a percent leaving is bad, 0.05% is normal. */
  cost: { floor: 0.005, target: 0.0005 } satisfies Anchor,
  /** 1 in 1,000 buying is a live funnel; 1 in 50 is an exceptional one. */
  money: { floor: 0.001, target: 0.02 } satisfies Anchor,
}

export const WEIGHTS = { read: 15, pull: 45, cost: 30, money: 10 }

const clamp = (n: number) => Math.max(0, Math.min(100, n))

/** Linear map between the anchors. Works in both directions, so COST inverts cleanly. */
function scoreRate(rate: number, a: Anchor): number {
  if (a.target === a.floor) return 0
  return clamp(((rate - a.floor) / (a.target - a.floor)) * 100)
}

export interface Component {
  key: 'read' | 'pull' | 'cost' | 'money'
  label: string
  /** 0–100, already normalized against the anchors. */
  score: number
  /** The underlying rate, 0–1, for display as a percentage. */
  rate: number
  /** "6,319 of 13,725" — the raw counts, so the score is never a black box. */
  detail: string
  weight: number
}

export interface BroadcastSignal {
  id: number
  subject: string
  sentAt: Date | null
  /** 0–100, or null when the broadcast has no engagement data at all. */
  score: number | null
  verdict: string
  components: Component[]
  reached: number
  /** Null when conversions were never measurable for this send (Kit-era). */
  converted?: number | null
  convertedCents?: number
  opened: number
  clicked: number
  unsubscribed: number
  source: 'live' | 'imported'
}

const pct = (n: number) => `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`
const num = (n: number) => n.toLocaleString('en-US')

/**
 * The sentence that goes next to the number.
 *
 * A score alone tells you where you landed, not what to change. These read off
 * the shape of the components rather than the total, because "51" means something
 * very different when it's a great open rate carrying a dead body than when it's
 * three mediocre thirds.
 */
function verdictFor(read: number, pull: number, cost: number, unsubscribed: number): string {
  const LOW = 40
  const HIGH = 65

  if (cost < 25) return `It moved people — and it cost you ${num(unsubscribed)} of them.`
  if (read >= HIGH && pull < LOW) return "They opened it. They didn't act on it."
  if (read < LOW && pull >= HIGH) return 'Fewer opened than usual — but the ones who did, moved.'
  if (read < LOW && pull < LOW) return "It didn't land. Start with the subject line."
  if (read >= HIGH && pull >= HIGH) return 'Read, clicked, and almost nobody left.'
  if (pull >= HIGH) return 'The body did its job — readers clicked through.'
  return 'A steady one. Nothing broke, nothing caught fire.'
}

export interface RawTotals {
  recipients: number
  opened: number
  clicked: number
  bounced: number
  complained: number
  unsubscribed: number
  /** Null means "not measurable here", which is not the same as zero. */
  converted: number | null
  convertedCents: number
}

/**
 * What the score is, stripped of whatever was being scored.
 *
 * Sequences are scored by exactly the same instrument as broadcasts — "did the
 * writing land" does not become a different question because the mail went out
 * on a delay. Keeping the arithmetic in one place is what makes a sequence's 62
 * and a broadcast's 62 the same 62; two scorers drifting apart would quietly
 * void every comparison on the analytics screens.
 */
export interface Scored {
  /** 0–100, or null when nothing reached anybody and there is nothing to score. */
  score: number | null
  verdict: string
  components: Component[]
  /** Recipients net of bounces. The one denominator used everywhere. */
  reached: number
}

/** Score a set of totals. Exported so it can be unit-tested without a db. */
export function scoreTotals(t: RawTotals): Scored {
  // Bounces never reached a human, so they belong in neither numerator nor
  // denominator. This is the one denominator used everywhere.
  const reached = Math.max(0, t.recipients - t.bounced)

  const readRate = reached ? t.opened / reached : 0
  // Click-to-open, not click-to-sent. "Of the people who actually looked, how
  // many acted" is a question about the writing; over sent it is mostly a
  // question about deliverability again.
  const pullRate = t.opened ? t.clicked / t.opened : 0
  const costRate = reached ? (t.unsubscribed + t.complained) / reached : 0

  const moneyRate = reached && t.converted !== null ? t.converted / reached : 0

  const read = scoreRate(readRate, ANCHORS.read)
  const pull = scoreRate(pullRate, ANCHORS.pull)
  const cost = scoreRate(costRate, ANCHORS.cost)
  const money = scoreRate(moneyRate, ANCHORS.money)

  const components: Component[] = [
    {
      key: 'read',
      label: 'Read',
      score: Math.round(read),
      rate: readRate,
      detail: `${num(t.opened)} of ${num(reached)} opened`,
      weight: WEIGHTS.read,
    },
    {
      key: 'pull',
      label: 'Pull',
      score: Math.round(pull),
      rate: pullRate,
      detail: `${num(t.clicked)} of ${num(t.opened)} readers clicked`,
      weight: WEIGHTS.pull,
    },
    {
      key: 'cost',
      label: 'Cost',
      score: Math.round(cost),
      rate: costRate,
      detail: `${num(t.unsubscribed)} left, ${num(t.complained)} complained`,
      weight: WEIGHTS.cost,
    },
  ]

  // Only present when it could be measured at all — see the header note.
  if (t.converted !== null) {
    components.push({
      key: 'money',
      label: 'Money',
      score: Math.round(money),
      rate: moneyRate,
      detail: t.converted
        ? `${num(t.converted)} converted · ${money0(t.convertedCents)}`
        : `nobody converted of ${num(reached)}`,
      weight: WEIGHTS.money,
    })
  }

  // Renormalize over what was actually measurable, so dropping MONEY raises the
  // other three proportionally instead of capping an old send at 90.
  const weighed = components.reduce(
    (acc, comp) => {
      const raw = comp.key === 'read' ? read : comp.key === 'pull' ? pull : comp.key === 'cost' ? cost : money
      return { sum: acc.sum + raw * comp.weight, weight: acc.weight + comp.weight }
    },
    { sum: 0, weight: 0 },
  )
  const total = weighed.weight ? weighed.sum / weighed.weight : 0

  // A broadcast nobody was recorded as receiving has no score — not a zero. A
  // zero would sit in the sparkline looking like a catastrophic send.
  const scored = reached > 0

  return {
    score: scored ? Math.round(total) : null,
    verdict: scored ? verdictFor(read, pull, cost, t.unsubscribed) : 'No engagement data.',
    components,
    reached,
  }
}

/** The same score, wearing a broadcast's identity. */
export function signalFrom(
  row: { id: number; subject: string; sentAt: Date | null; source: 'live' | 'imported' },
  t: RawTotals,
): BroadcastSignal {
  const scoredTotals = scoreTotals(t)
  return {
    ...row,
    ...scoredTotals,
    opened: t.opened,
    clicked: t.clicked,
    unsubscribed: t.unsubscribed,
    converted: t.converted,
    convertedCents: t.convertedCents,
  }
}

/** Whole dollars. The card has no room for cents and nobody reads them there. */
export function money0(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`
}

/**
 * The last `limit` sent broadcasts, newest first, scored.
 *
 * Two queries total regardless of `limit` — one for the broadcast rows and their
 * carried-over Kit totals, one aggregate over messages and events for the rows
 * that have live history. Calling `broadcastStats()` in a loop would be two
 * queries *each*, and D1 allows 1,000 per Worker invocation for the whole page.
 */
export async function recentSignals(db: Db, limit = 12): Promise<BroadcastSignal[]> {
  const rows = (await db.all(sql`
    select id, subject, sent_at,
           imported_recipients, imported_opened, imported_clicked, imported_unsubscribed
    from broadcasts
    where status = 'sent'
    order by sent_at desc
    limit ${limit}
  `)) as {
    id: number
    subject: string
    sent_at: number | null
    imported_recipients: number | null
    imported_opened: number | null
    imported_clicked: number | null
    imported_unsubscribed: number | null
  }[]

  if (rows.length === 0) return []

  const ids = sql.join(
    rows.map((r) => sql`${r.id}`),
    sql`, `,
  )

  const live = (await db.all(sql`
    select m.broadcast_id as id,
           -- distinct, not count(*): the left join fans a message out into one row
           -- per event, so a well-engaged message would otherwise count as three
           -- recipients and quietly deflate every rate on the card.
           count(distinct m.id) as recipients,
           count(distinct case when e.type = 'open' then e.message_id end) as opened,
           count(distinct case when e.type = 'click' then e.message_id end) as clicked,
           count(distinct case when e.type = 'bounce' then e.message_id end) as bounced,
           count(distinct case when e.type = 'complaint' then e.message_id end) as complained,
           count(distinct case when e.type = 'unsubscribe' then e.message_id end) as unsubscribed
    from messages m
    left join events e on e.message_id = m.id
    where m.broadcast_id in (${ids})
    group by m.broadcast_id
  `)) as ({ id: number } & Omit<RawTotals, 'converted' | 'convertedCents'>)[]

  // Separate query, not another left join: conversions fan out independently of
  // events, and joining both at once multiplies the two counts together.
  const conv = (await db.all(sql`
    select source_id as id, count(*) as converted, coalesce(sum(value_cents), 0) as cents
    from conversions
    where source_kind = 'broadcast' and source_id in (${ids})
    group by source_id
  `)) as { id: number; converted: number; cents: number }[]
  const convById = new Map(conv.map((r) => [Number(r.id), r]))

  const liveById = new Map(live.map((r) => [Number(r.id), r]))

  return rows.map((r) => {
    const hit = liveById.get(r.id)
    const meta = {
      id: r.id,
      subject: r.subject,
      sentAt: r.sent_at ? new Date(r.sent_at) : null,
      source: (hit ? 'live' : 'imported') as 'live' | 'imported',
    }

    if (hit) {
      return signalFrom(meta, {
        recipients: Number(hit.recipients),
        opened: Number(hit.opened),
        clicked: Number(hit.clicked),
        bounced: Number(hit.bounced),
        complained: Number(hit.complained),
        unsubscribed: Number(hit.unsubscribed),
        // Live send: zero conversions is a real, measured zero.
        converted: Number(convById.get(r.id)?.converted ?? 0),
        convertedCents: Number(convById.get(r.id)?.cents ?? 0),
      })
    }

    // Kit-era: totals only. `bounced` is 0 because Kit's "Recipients" is already
    // net of bounces, which keeps `recipients - bounced` correct on both paths.
    return signalFrom(meta, {
      recipients: r.imported_recipients ?? 0,
      opened: r.imported_opened ?? 0,
      clicked: r.imported_clicked ?? 0,
      bounced: 0,
      complained: 0,
      unsubscribed: r.imported_unsubscribed ?? 0,
      // Nothing was sent from here, so no conversion could ever attach. Null, not
      // zero — MONEY drops out and the other three renormalize.
      converted: null,
      convertedCents: 0,
    })
  })
}

export interface SignalTrend {
  /** Newest last, so it reads left-to-right as a sparkline. */
  history: { id: number; score: number; subject: string }[]
  latest: BroadcastSignal | null
  /** Median of everything before `latest`. Null until there are 3 prior sends. */
  median: number | null
}

/** What the hero needs: the last send, and enough history to say whether it's better. */
export async function signalTrend(db: Db, window = 12): Promise<SignalTrend> {
  const signals = await recentSignals(db, window)
  const latest = signals[0] ?? null

  const scored = signals.filter((s): s is BroadcastSignal & { score: number } => s.score !== null)
  const prior = scored.slice(1).map((s) => s.score)

  // Median, not mean: one viral send or one dud should not redefine "normal".
  let median: number | null = null
  if (prior.length >= 3) {
    const sorted = [...prior].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    median =
      sorted.length % 2 === 0
        ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
        : (sorted[mid] ?? null)
  }

  return {
    history: scored
      .map((s) => ({ id: s.id, score: s.score, subject: s.subject }))
      .reverse(),
    latest,
    median,
  }
}

export const formatRate = pct
