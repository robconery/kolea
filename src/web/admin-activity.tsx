import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import {
  type ActivityType,
  type FeedRow,
  activityCounts,
  activityFeed,
  growthByDay,
} from '../core/activity.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { num } from './analytics-parts.tsx'
import { Layout, fmtMoney } from './layout.tsx'

export const activityAdmin = new Hono<{ Bindings: Env }>()

/**
 * ⭐ The story of the list.
 *
 * Every other screen in this app reports a *state*: who is on the list, how a
 * send did, what a sequence is worth. This one reports the *sequence of events*
 * that produced those states — somebody arrived through a form, got tagged, was
 * enrolled, read four of six, and bought.
 *
 * Read-only by construction, like the analytics screens: no form on this page,
 * no route here that writes. A page whose whole job is showing you 13,700
 * people's activity should not also be able to mail them.
 */

/** Grouped the way a person reads them, not the way they're stored. */
const GROUPS: { label: string; types: ActivityType[] }[] = [
  { label: 'Arrivals', types: ['subscribed', 'promoted', 'form_submitted', 'pending_added'] },
  {
    label: 'Departures',
    types: ['unsubscribed', 'unsubscribed_all', 'sequence_opted_out', 'bounced', 'complained'],
  },
  {
    label: 'Sequences',
    types: [
      'sequence_enrolled',
      'sequence_advanced',
      'sequence_completed',
      'sequence_cancelled',
      'sequence_rejoined',
    ],
  },
  { label: 'Money', types: ['purchased', 'refunded'] },
  { label: 'Labels', types: ['tagged', 'untagged', 'touched'] },
]

/** Present tense, human voice. `sequence_advanced` is not a sentence. */
const VERBS: Record<ActivityType, string> = {
  subscribed: 'joined the list',
  pending_added: 'was put on file',
  promoted: 'joined the list',
  imported: 'was imported',
  form_submitted: 'submitted a form',
  unsubscribed: 'left the newsletter',
  resubscribed: 'came back to the newsletter',
  unsubscribed_all: 'unsubscribed from everything',
  suppressed: 'was suppressed',
  unsuppressed: 'was un-suppressed',
  bounced: 'hard bounced',
  complained: 'marked it as spam',
  sequence_enrolled: 'was enrolled in',
  sequence_advanced: 'reached step',
  sequence_completed: 'finished',
  sequence_cancelled: 'was pulled out of',
  sequence_opted_out: 'left',
  sequence_rejoined: 'rejoined',
  tagged: 'was tagged',
  untagged: 'lost the tag',
  touched: 'was touched by',
  refunded: 'was refunded',
  purchased: 'bought',
}

/** Departures read red, money reads green, the rest stays quiet. */
const TONE: Partial<Record<ActivityType, string>> = {
  subscribed: 'ok',
  promoted: 'ok',
  purchased: 'ok',
  unsubscribed: 'bad',
  unsubscribed_all: 'bad',
  bounced: 'bad',
  complained: 'bad',
  refunded: 'bad',
  sequence_opted_out: 'warn',
  sequence_cancelled: 'warn',
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const int = (v: unknown): number | null => (typeof v === 'number' ? v : null)

/** The object of the sentence: the thing this happened *to*. */
function detailOf(r: FeedRow): string | null {
  const m = r.meta
  switch (r.type) {
    case 'form_submitted':
      return str(m.formName) ?? str(m.formSlug)
    case 'tagged':
    case 'untagged':
      return str(m.tag)
    case 'sequence_advanced': {
      const pos = int(m.position)
      const subject = str(m.subject)
      return `${pos ?? '?'}${subject ? ` — ${subject}` : ''} of ${r.sequenceName ?? 'a sequence'}`
    }
    case 'sequence_enrolled':
    case 'sequence_completed':
    case 'sequence_cancelled':
    case 'sequence_opted_out':
    case 'sequence_rejoined':
      return r.sequenceName
    case 'purchased':
    case 'refunded': {
      const cents = int(m.amountCents)
      const product = str(m.product)
      const amount = cents === null ? null : fmtMoney(cents, str(m.currency) ?? 'usd')
      return [product, amount].filter(Boolean).join(' · ') || null
    }
    case 'touched':
      return r.campaignName
    default:
      return null
  }
}

/** Why, when we know it. This is the half `sequence_enrollments` throws away. */
function reasonOf(r: FeedRow): string | null {
  const reason = str(r.meta.reason)
  if (!reason) return null
  return reason.replace(/_/g, ' ')
}

const RELATIVE = (d: Date) => {
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  const days = Math.round(mins / (60 * 24))
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const Row: FC<{ r: FeedRow }> = ({ r }) => {
  const detail = detailOf(r)
  const reason = reasonOf(r)
  return (
    <tr>
      <td style="white-space:nowrap">
        <span class={`pill ${TONE[r.type] ?? ''}`}>{r.type.replace(/_/g, ' ')}</span>
      </td>
      <td>
        <a href={`/subscribers/${r.subscriberId}`}>{r.name || r.email}</a>
        {r.name ? <div class="faint">{r.email}</div> : null}
      </td>
      <td>
        {VERBS[r.type]}
        {detail ? <b> {detail}</b> : null}
        {reason ? <div class="faint">{reason}</div> : null}
      </td>
      <td class="faint" style="white-space:nowrap">
        {r.source}
      </td>
      <td class="num faint" style="white-space:nowrap" title={r.occurredAt.toISOString()}>
        {RELATIVE(r.occurredAt)}
      </td>
    </tr>
  )
}

activityAdmin.get('/activity', async (c) => {
  const db = getDb(c.env)

  const group = c.req.query('group') ?? ''
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 30) || 30, 1), 365)
  const beforeId = Number(c.req.query('before')) || undefined
  const selected = GROUPS.find((g) => g.label === group)

  const [rows, counts, growth] = await Promise.all([
    activityFeed(db, {
      types: selected?.types,
      since: Date.now() - days * 24 * 60 * 60 * 1000,
      limit: 200,
      beforeId,
    }),
    activityCounts(db, days),
    growthByDay(db, days),
  ])

  const joined = growth.reduce((n, d) => n + d.joined, 0)
  const left = growth.reduce((n, d) => n + d.left, 0)
  const total = counts.reduce((n, t) => n + t.n, 0)
  const money = counts.find((t) => t.type === 'purchased')?.n ?? 0
  const qs = (extra: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    if (group) p.set('group', group)
    p.set('days', String(days))
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v))
    return `/activity?${p}`
  }

  return c.html(
    <Layout title="Activity" nav="act">
      <div class="head">
        <div>
          <div class="eyebrow">The story</div>
          <h1>Activity</h1>
          <div class="sub">
            Everything that has happened to the people on this list — how they arrived, what they
            were tagged, how far they got, and what they bought. Backfilled history is excluded:
            this is activity, not archaeology.
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-b">
          <div class="stats">
            <div class="stat">
              <div class="n">{num(joined)}</div>
              <div class="l">Joined</div>
              <div class="h">last {days} days</div>
            </div>
            <div class="stat">
              <div class="n">{num(left)}</div>
              <div class="l">Left</div>
              <div class="h">unsubscribes, bounces, complaints</div>
            </div>
            <div class="stat">
              <div class="n">
                {joined - left >= 0 ? '+' : ''}
                {num(joined - left)}
              </div>
              <div class="l">Net</div>
              <div class="h">the only growth number that counts</div>
            </div>
            <div class="stat">
              <div class="n">{num(money)}</div>
              <div class="l">Purchases</div>
              <div class="h">{num(total)} events in all</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>{selected ? selected.label : 'Everything'}</h2>
          <div class="actions">
            <a class={`btn sm ${group ? '' : 'primary'}`} href={qs({ group: undefined })}>
              All
            </a>
            {GROUPS.map((g) => (
              <a class={`btn sm ${group === g.label ? 'primary' : ''}`} href={qs({ group: g.label })}>
                {g.label}
              </a>
            ))}
          </div>
        </div>
        <div class="card-b">
          <div class="actions" style="margin-bottom:14px">
            {[7, 30, 90, 365].map((d) => (
              <a class={`btn sm ${days === d ? 'primary' : ''}`} href={`/activity?${new URLSearchParams({ ...(group ? { group } : {}), days: String(d) })}`}>
                {d === 365 ? '1 year' : `${d} days`}
              </a>
            ))}
          </div>

          {rows.length === 0 ? (
            <div class="empty">
              <p>Nothing here yet.</p>
              <p>
                Activity is recorded from the moment this shipped — it does not reconstruct the
                past. Give it a signup, a tick, or a sale.
              </p>
            </div>
          ) : (
            <>
              <div class="tscroll">
                <table>
                  <thead>
                    <tr>
                      <th>What</th>
                      <th>Who</th>
                      <th>Happened</th>
                      <th>Via</th>
                      <th class="num">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <Row r={r} />
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length === 200 ? (
                <div class="actions" style="margin-top:16px">
                  <a class="btn sm" href={qs({ before: rows[rows.length - 1]?.id })}>
                    Older
                  </a>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Layout>,
  )
})
