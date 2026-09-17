import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import {
  type ActivityType,
  type FeedRow,
  activityFeed,
} from '../core/activity.ts'
import { formViewStats } from '../core/forms.ts'
import {
  ACTION_WINDOW_DAYS,
  CURVE_HOURS,
  LIFT_DAYS,
  type JustSent,
  engagementByDay,
  justSent,
  mostRead,
  pulseNow,
  topLinks,
} from '../core/pulse.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Take, num, pct } from './analytics-parts.tsx'
import { BarRow, ColumnChart, Sparkline } from './charts.tsx'
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
 * The top half is the pulse (`core/pulse.ts`): how the last few sends are being
 * read, hour by hour, what is drawing readers this week, which links they take,
 * and how often each form is shown against how often it is filled in. The
 * bottom half is the feed — the individual events those numbers are made of.
 *
 * Read-only by construction, like the analytics screens: no form on this page,
 * no route here that writes. A page whose whole job is showing you 13,700
 * people's activity should not also be able to mail them.
 */

/** Grouped the way a person reads them, not the way they're stored. */
const GROUPS: { label: string; types: ActivityType[] }[] = [
  { label: 'Arrivals', types: ['subscribed', 'promoted', 'form_submitted', 'pending_added'] },
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

/**
 * Everything the feed shows by default. Departures are left out on purpose:
 * this screen is for whether the mail is working, and what a send cost is on
 * that broadcast's own page.
 */
const DEPARTURES: ActivityType[] = [
  'unsubscribed',
  'unsubscribed_all',
  'sequence_opted_out',
  'bounced',
  'complained',
  'suppressed',
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

const SHOWN = (Object.keys(VERBS) as ActivityType[]).filter((t) => !DEPARTURES.includes(t))

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

/** "+12%" against the previous period, or nothing when there is no base. */
const delta = (now: number, before: number) => {
  if (!before) return now ? 'nothing the day before' : 'quiet'
  const d = (now - before) / before
  return `${d >= 0 ? '+' : ''}${Math.round(d * 100)}% on the day before`
}

/** Host and path, which is what a person recognises a link by. */
const shortUrl = (u: string) => {
  try {
    const x = new URL(u)
    return `${x.host.replace(/^www\./, '')}${x.pathname === '/' ? '' : x.pathname}`
  } catch {
    return u
  }
}

const running = (xs: number[]) => {
  let n = 0
  return xs.map((x) => (n += x))
}

/** "4 of 52" style share, or a dash when there is nothing to divide by. */
const shareOf = (n: number, of: number, dp = 0) => (of ? pct(n / of, dp) : '-')

/** The sentence one send's numbers add up to. What worked, not what it cost. */
function sendVerdict(s: JustSent): string {
  if (!s.reached) return 'Still going out — nothing to read yet.'
  if (!s.readers) return `Reached ${num(s.reached)} people. Nobody has opened it yet.`
  if (!s.clickers)
    return `${num(s.readers)} people have read it. Nobody has clicked through yet — the call to action isn't landing.`
  const top = s.links[0]
  const parts = [
    `${num(s.clickers)} people clicked through`,
    top ? `, ${shareOf(top.people, s.clickers)} of them to ${shortUrl(top.url)}` : '',
    s.acted
      ? `. ${num(s.acted)} went on to fill in a form or start a sequence`
      : '. None has filled in a form or started a sequence yet',
    s.sales ? `, and it has earned ${num(s.sales)} sale${s.sales === 1 ? '' : 's'}.` : '.',
  ]
  return parts.join('')
}

/**
 * One step of the funnel, on the waterfall's shape: the bar is the population
 * against everybody reached, and the right-hand figure is the rate from the step
 * before — which is the number you can actually move with the writing.
 */
const Step: FC<{
  i: number
  label: string
  n: number
  base: number
  of: number | null
  ofLabel: string
  detail?: string
  fill: 'wf-sent' | 'wf-open' | 'wf-click'
}> = ({ i, label, n, base, of, ofLabel, detail, fill }) => (
  <div class="wf-row">
    <div class="wf-i">{String(i).padStart(2, '0')}</div>
    <div class="wf-b">
      <span class="wf-s">{label}</span>
      <div class="wf-track" role="img" aria-label={`${label}: ${num(n)}`}>
        {/* Nothing drawn for zero — a sliver reads as "a little". */}
        {n ? (
          <i class={fill} style={`width:${Math.max((n / Math.max(base, 1)) * 100, 0.8)}%`} />
        ) : null}
      </div>
      {detail ? (
        <div class="faint" style="font-size:12px;margin-top:8px">
          {detail}
        </div>
      ) : null}
    </div>
    {/* Fixed width, so every step's track starts and ends in the same place. */}
    <div class="wf-n" style="min-width:128px">
      <b>{num(n)}</b>
      {of === null ? ofLabel : `${shareOf(n, of, 1)} ${ofLabel}`}
    </div>
  </div>
)

/** The focused send: how far down the funnel people got, and where they went. */
const SendFocus: FC<{ s: JustSent }> = ({ s }) => {
  const maxLink = Math.max(1, ...s.links.map((l) => l.people))
  const lift = s.formLift
  return (
    <>
      <a class="sig-subject" href={`/broadcasts/${s.id}`}>
        {s.subject}
      </a>
      <div class="faint" style="font-size:12.5px;margin-top:6px">
        {s.status === 'sending' ? <span class="pill warn">sending</span> : null}{' '}
        {s.startedAt ? `went out ${RELATIVE(s.startedAt)}` : 'not started'}
        {s.lastEventAt ? ` · last activity ${RELATIVE(s.lastEventAt)}` : ''}
        {s.readersToday || s.clicksToday
          ? ` · last 24h: ${num(s.readersToday)} new readers, ${num(s.clicksToday)} clicks`
          : ''}
      </div>
      <p class="sig-ev">{sendVerdict(s)}</p>

      <div class="bento" style="margin-top:26px">
        <div class="col-7">
          <div class="wf">
            <Step i={1} label="Reached" n={s.reached} base={s.reached} of={null} ofLabel="inboxes" fill="wf-sent" />
            <Step i={2} label="Read it" n={s.readers} base={s.reached} of={s.reached} ofLabel="of reached" fill="wf-open" />
            <Step i={3} label="Clicked through" n={s.clickers} base={s.reached} of={s.readers} ofLabel="of readers" fill="wf-click" />
            <Step
              i={4}
              label="Took action"
              n={s.acted}
              base={s.reached}
              of={s.clickers}
              ofLabel="of clickers"
              detail={`${num(s.submitted)} filled in a form · ${num(s.enrolled)} started a sequence · within ${ACTION_WINDOW_DAYS} days of clicking`}
              fill="wf-click"
            />
            <Step
              i={5}
              label="Bought"
              n={s.sales}
              base={s.reached}
              of={null}
              ofLabel={s.sales ? fmtMoney(s.salesCents) : 'no sales yet'}
              detail="credited to this send, last click wins"
              fill="wf-click"
            />
          </div>
        </div>

        <div class="col-5">
          <div class="hm-l">Where they went</div>
          {s.links.length === 0 ? (
            <p class="faint">No clicks yet.</p>
          ) : (
            <div style="margin-top:12px">
              {s.links.map((l) => (
                <div style="margin-bottom:14px">
                  <div class="row" style="justify-content:space-between;gap:12px;align-items:baseline">
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noreferrer"
                      title={l.url}
                      style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                    >
                      {shortUrl(l.url)}
                    </a>
                    <span style="font-variant-numeric:tabular-nums;white-space:nowrap">
                      <b>{num(l.people)}</b>
                      <span class="faint"> · {shareOf(l.people, s.clickers)}</span>
                    </span>
                  </div>
                  <div class="rt-b" style="margin-top:6px">
                    <i style={`width:${Math.round((l.people / maxLink) * 100)}%`} />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div class="hm-l" style="margin-top:26px">Form views on your site</div>
          <div class="hm-v" style="margin-top:10px">{num(lift.after)}</div>
          <div class="hm-d">
            in the {LIFT_DAYS} days from the send
            {lift.expected === null
              ? ' · no earlier views to compare against yet'
              : lift.expected < 1
                ? ' · against almost none the week before'
                : ` · ${lift.after >= lift.expected ? '+' : ''}${pct(lift.after / lift.expected - 1, 0)} on a normal ${LIFT_DAYS} days (${num(lift.expected)})`}
          </div>

          <div class="hm-l" style="margin-top:26px">Readers, first {CURVE_HOURS} hours</div>
          {s.readers ? (
            <>
              <Sparkline values={running(s.curve)} height={56} format="number" />
              <div class="hm-d">
                {s.firstDayShare === null
                  ? ''
                  : `${pct(s.firstDayShare, 0)} of its readers came in the first day`}
              </div>
            </>
          ) : (
            <p class="faint">No opens yet.</p>
          )}
        </div>
      </div>
    </>
  )
}

/** Earlier sends, side by side on the same funnel. Click one to put it in focus. */
const SendCompare: FC<{ sends: JustSent[]; days: number }> = ({ sends, days }) => (
  <div class="tscroll">
    <table>
      <thead>
        <tr>
          <th>Earlier sends</th>
          <th class="num">Read</th>
          <th class="num">Clicked</th>
          <th class="num">Took action</th>
          <th class="num">Sales</th>
          <th class="num">Form views</th>
        </tr>
      </thead>
      <tbody>
        {sends.map((s) => (
          <tr>
            <td>
              <a href={`/activity?days=${days}&send=${s.id}`}>
                <b>{s.subject}</b>
              </a>
              <div class="faint" style="font-size:12px;margin-top:4px">
                {s.startedAt ? RELATIVE(s.startedAt) : 'not started'} · {num(s.reached)} reached
                {s.links[0] ? ` · top link ${shortUrl(s.links[0].url)}` : ''}
              </div>
            </td>
            <td class="num">
              {shareOf(s.readers, s.reached)}
              <div class="faint" style="font-size:11.5px">{num(s.readers)}</div>
            </td>
            <td class="num">
              {shareOf(s.clickers, s.readers, 1)}
              <div class="faint" style="font-size:11.5px">{num(s.clickers)} of readers</div>
            </td>
            <td class="num">
              {s.clickers ? shareOf(s.acted, s.clickers, 1) : '-'}
              <div class="faint" style="font-size:11.5px">{num(s.acted)} of clickers</div>
            </td>
            <td class="num">
              {s.sales ? (
                <>
                  {num(s.sales)}
                  <div class="faint" style="font-size:11.5px">{fmtMoney(s.salesCents)}</div>
                </>
              ) : (
                <span class="faint">-</span>
              )}
            </td>
            <td class="num">
              {num(s.formLift.after)}
              <div class="faint" style="font-size:11.5px">
                {s.formLift.expected ? `vs ${num(s.formLift.expected)} usual` : `first ${LIFT_DAYS} days`}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

activityAdmin.get('/activity', async (c) => {
  const db = getDb(c.env)

  const group = c.req.query('group') ?? ''
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 30) || 30, 1), 365)
  const beforeId = Number(c.req.query('before')) || undefined
  const focusId = Number(c.req.query('send')) || undefined
  const selected = GROUPS.find((g) => g.label === group)
  // A year of daily columns is a barcode. The chart stops at a quarter.
  const chartDays = Math.min(days, 90)

  const [rows, now, sends, read, perDay, links, formStats] = await Promise.all([
    activityFeed(db, {
      // Departures stay off this screen — the broadcast's own page carries them.
      types: selected?.types ?? SHOWN,
      since: Date.now() - days * 24 * 60 * 60 * 1000,
      limit: 200,
      beforeId,
    }),
    pulseNow(db),
    justSent(db, 8),
    mostRead(db, days, 10),
    engagementByDay(db, chartDays),
    topLinks(db, days, 10),
    formViewStats(db, days),
  ])

  const focus = sends.find((x) => x.id === focusId) ?? sends[0] ?? null
  const earlier = sends.filter((x) => x !== focus)
  const formViews = formStats.reduce((n, f) => n + f.views, 0)
  const formSubmits = formStats.reduce((n, f) => n + f.submits, 0)
  const tracked = formStats.filter((f) => f.rate !== null)
  const trackedViews = tracked.reduce((n, f) => n + f.views, 0)
  const formRate = trackedViews
    ? tracked.reduce((n, f) => n + (f.rate ?? 0) * f.views, 0) / trackedViews
    : null
  const maxRead = Math.max(1, ...read.map((r) => r.readers))
  const maxLink = Math.max(1, ...links.map((l) => l.people))
  const qs = (extra: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    if (group) p.set('group', group)
    p.set('days', String(days))
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v))
    return `/activity?${p}`
  }
  const span = days === 365 ? 'the last year' : `the last ${days} days`

  return c.html(
    <Layout title="Activity" nav="act" charts>
      <div class="head">
        <div>
          <div class="eyebrow">The pulse</div>
          <h1>Activity</h1>
          <div class="sub">
            Whether the mail is working: who read the last send, who clicked through, and who went
            on to fill in a form, start a sequence or buy. Underneath, every event it is made of.
          </div>
        </div>
        <div class="actions">
          {[7, 30, 90, 365].map((d) => (
            <a
              class={`btn sm ${days === d ? 'primary' : ''}`}
              href={`/activity?${new URLSearchParams({ ...(group ? { group } : {}), days: String(d) })}`}
            >
              {d === 365 ? '1 year' : `${d} days`}
            </a>
          ))}
        </div>
      </div>

      <div class="card">
        <div class="card-b flush">
          <div class="stats">
            <div class="stat">
              <div class="n">{num(now.readers24)}</div>
              <div class="l">Readers, 24h</div>
              <div class="h">{delta(now.readers24, now.readersPrev24)}</div>
            </div>
            <div class="stat">
              <div class="n">{num(now.clicks24)}</div>
              <div class="l">Clicks, 24h</div>
              <div class="h">{delta(now.clicks24, now.clicksPrev24)}</div>
            </div>
            <div class="stat">
              <div class="n">{num(formViews)}</div>
              <div class="l">Form views</div>
              <div class="h">in {span}</div>
            </div>
            <div class="stat">
              <div class="n">{num(formSubmits)}</div>
              <div class="l">Form submits</div>
              <div class="h">
                {formRate === null ? `in ${span}` : `${pct(formRate, 1)} of tracked views`}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>{focus && focus === sends[0] ? 'Latest send' : 'Send in focus'}</h2>
          <div class="actions">
            {focus && focus !== sends[0] ? (
              <a class="btn sm" href={`/activity?days=${days}`}>
                Back to latest
              </a>
            ) : null}
            <a class="btn sm" href="/analytics/broadcasts">
              Scored sends
            </a>
          </div>
        </div>
        <div class="card-b">
          {focus === null ? (
            <div class="empty">
              <p>Nothing has gone out from here yet.</p>
            </div>
          ) : (
            <>
              <SendFocus s={focus} />
              {earlier.length ? (
                <div style="margin-top:34px">
                  <SendCompare sends={earlier} days={days} />
                </div>
              ) : null}
              <Take label="Read it as">
                Each step is a share of the one before it, because that is the number the writing
                moves: <b>read</b> is the subject line, <b>clicked</b> is the body and the call to
                action, <b>took action</b> is the page they landed on. Opens are inflated by Apple's
                mail proxy; clicks and forms aren't.
              </Take>
            </>
          )}
        </div>
      </div>

      <div class="bento">
        <div class="card col-7">
          <div class="card-h">
            <h2>Readers per day</h2>
          </div>
          <div class="card-b">
            <div class="faint" style="font-size:12.5px;margin-bottom:16px">
              People who opened any mail, the last {chartDays} days · sends show up as spikes, and
              the tail after each one is the list still reading.
            </div>
            <ColumnChart
              data={perDay.map((d) => ({
                label: d.day.slice(5),
                caption: `${d.day} · ${num(d.clickers)} clicked`,
                value: d.readers,
              }))}
              height={220}
              format="number"
            />
          </div>
        </div>

        <div class="card col-5">
          <div class="card-h">
            <h2>What's being read</h2>
          </div>
          <div class="card-b">
            <div class="faint" style="font-size:12.5px;margin-bottom:12px">
              Readers in {span}, whenever the mail went out.
            </div>
            {read.length === 0 ? (
              <div class="empty">
                <p>No opens in this window.</p>
              </div>
            ) : (
              <table>
                <tbody>
                  {read.map((r) => (
                    <tr>
                      <td>
                        <a href={r.href}>{r.label}</a>
                        <div class="faint" style="font-size:12px;margin-top:3px">
                          {r.kind === 'sequence'
                            ? 'sequence'
                            : r.sentAt
                              ? `sent ${RELATIVE(r.sentAt)}`
                              : 'broadcast'}{' '}
                          · {num(r.clickers)} clicked
                        </div>
                        <BarRow value={r.readers} max={maxRead} />
                      </td>
                      <td class="num" style="width:1%">
                        <b>{num(r.readers)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div class="bento">
        <div class="card col-7">
          <div class="card-h">
            <h2>Links people took</h2>
          </div>
          <div class="card-b">
            {links.length === 0 ? (
              <div class="empty">
                <p>No clicks in this window.</p>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Link</th>
                    <th class="num">People</th>
                    <th class="num">Clicks</th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((l) => (
                    <tr>
                      <td style="max-width:0;width:100%">
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noreferrer"
                          title={l.url}
                          style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                        >
                          {shortUrl(l.url)}
                        </a>
                        {l.topSubject ? (
                          <div
                            class="faint"
                            style="font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                          >
                            mostly from “{l.topSubject}”
                          </div>
                        ) : null}
                        <BarRow value={l.people} max={maxLink} />
                      </td>
                      <td class="num">
                        <b>{num(l.people)}</b>
                      </td>
                      <td class="num faint">{num(l.clicks)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div class="card col-5">
          <div class="card-h">
            <h2>Forms</h2>
            <div class="actions">
              <a class="btn sm" href="/forms">
                All forms
              </a>
            </div>
          </div>
          <div class="card-b">
            {formStats.length === 0 ? (
              <div class="empty">
                <p>No forms yet.</p>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Form</th>
                    <th class="num">Views</th>
                    <th class="num">Submits</th>
                    <th class="num">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {formStats.map((f) => (
                    <tr style={f.isActive ? '' : 'opacity:.55'}>
                      <td>
                        <a href={`/forms/${f.id}`}>{f.name}</a>
                      </td>
                      <td class="num">{num(f.views)}</td>
                      <td class="num">{num(f.submits)}</td>
                      <td class="num">
                        {f.rate === null ? <span class="faint">-</span> : pct(f.rate, 1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div class="faint" style="font-size:12.5px;margin-top:14px">
              Views come from the pixel in each form's snippet, and only started counting when it
              shipped — re-paste the snippet on your site for a form to show any. The rate only
              counts submits from a form's first recorded view.
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>{selected ? selected.label : 'Every event'}</h2>
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
