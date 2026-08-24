import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import {
  type GoalBoardRow,
  type ListHealth,
  attributionIn,
  broadcastCadence,
  conversionMix,
  goalBoard,
  listHealth,
  sequencePerformance,
} from '../core/analytics.ts'
import { currentPeriod, windowFor } from '../core/goals.ts'
import { recentSignals, signalTrend } from '../core/signal.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import {
  Components,
  Dial,
  ScorePill,
  SplitBar,
  Take,
  band,
  num,
  pct,
  sequenceVerdict,
} from './analytics-parts.tsx'
import { ColumnChart } from './charts.tsx'
import { Layout, fmtDay, fmtMoney } from './layout.tsx'

export const analytics = new Hono<{ Bindings: Env }>()

/**
 * ⭐ Analytics — five screens, one question each.
 *
 * The section exists because a mailing list is the one asset here that cannot
 * be inspected by looking at it. You can read every broadcast you ever wrote and
 * still have no idea whether the list is healthy, and no amount of staring at a
 * sequence tells you which mail in it loses people. So:
 *
 *   /analytics              — is the machine working? (the one-screen answer)
 *   /analytics/sequences    — which series earn their keep, and where they leak
 *   /analytics/broadcasts   — which sends landed, against your own median
 *   /analytics/contribution — what is feeding the goals, by channel and by mail
 *   /analytics/health       — is the list itself getting better or worse
 *
 * Nothing on these screens writes. They are read-only by construction, which is
 * why none of them carries a form: an analytics page that can send mail is one
 * misclick from mailing 13,700 people (see CLAUDE.md, and mean it).
 */

/** Every window this section reports over is a *named* one — see core/goals.ts. */
function quarterWindow(now = new Date()) {
  return windowFor(currentPeriod('quarter', now))
}

const MONTH_LABEL = (ym: string) => {
  const [y, m] = ym.split('-')
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[Number(m) - 1] ?? m} ${String(y).slice(2)}`
}

/** The sub-heading every analytics page wears: what this screen is for. */
const Head: FC<{ eyebrow: string; title: string; sub: string }> = ({ eyebrow, title, sub }) => (
  <div class="head">
    <div>
      <div class="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <div class="sub">{sub}</div>
    </div>
  </div>
)

// ───────────────────────────────────────────────────────────── overview

analytics.get('/analytics', async (c) => {
  const db = getDb(c.env)
  const win = quarterWindow()

  const [health, trend, seqs, attribution, mix, board] = await Promise.all([
    listHealth(db),
    signalTrend(db, 14),
    sequencePerformance(db),
    attributionIn(db, win),
    conversionMix(db, 12),
    goalBoard(db, { limit: 3 }),
  ])

  const scored = seqs.filter((s) => s.score !== null)
  const top = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 5)
  const liveSeqs = seqs.filter((s) => s.isActive).length
  const seqRevenue = seqs.reduce((n, s) => n + s.convertedCents, 0)

  const bcastMedian = trend.median
  const health1 = health.metrics.find((m) => m.band === 'weak') ?? null

  return c.html(
    <Layout title="Analytics" nav="an" charts>
      <Head
        eyebrow="Measurement"
        title="Analytics"
        sub="Whether the mail is working, in the two numbers that answer it and the five screens that explain them."
      />

      {/* The hero: the asset on the left, the work on the right. Two different
          questions, deliberately side by side — a healthy list carrying weak
          sends and a weak list carrying great sends look identical on any single
          number, and they need opposite responses. */}
      <div class="card sig-card">
        <div class="card-b">
          <div class="sig-grid lead">
            <div class="dials">
              <Dial score={health.score} label="List" />
              <Dial score={bcastMedian} label="Signal" />
            </div>
            <div class="sig-read">
              <h2 class="sig-verdict">
                {health.score === null
                  ? 'Not enough history to score yet.'
                  : health.score >= 55 && (bcastMedian ?? 0) >= 55
                    ? 'The list is healthy and the writing is landing.'
                    : health.score >= 55
                      ? 'The list is in good shape. The sends are the weaker half.'
                      : (bcastMedian ?? 0) >= 55
                        ? 'The writing lands — the list underneath it is the problem.'
                        : 'Both halves need work. Start with the list.'}
              </h2>
              <p class="sig-ev">
                {num(health.size.active)} active subscribers, {pct(health.engagedRate)} of them
                opened or clicked something in the last 90 days.
                {bcastMedian !== null
                  ? ` Your median broadcast scores ${bcastMedian} out of 100.`
                  : ' No scored broadcasts yet.'}
                {health1 ? ` The weakest link is ${health1.label.toLowerCase()} — ${health1.detail}.` : ''}
              </p>
              <div class="row" style="gap:10px;margin-top:20px;flex-wrap:wrap">
                <a class="btn sm" href="/analytics/health">
                  List health
                </a>
                <a class="btn sm" href="/analytics/sequences">
                  Sequences
                </a>
                <a class="btn sm" href="/analytics/broadcasts">
                  Broadcasts
                </a>
                <a class="btn sm" href="/analytics/contribution">
                  Contribution
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-b flush">
          <div class="stats">
            <div class="stat">
              <div class="n">{num(health.size.active)}</div>
              <div class="l">Active</div>
              <div class="h">{num(health.engaged)} engaged in 90 days</div>
            </div>
            <div class="stat">
              <div class="n">{liveSeqs}</div>
              <div class="l">Live sequences</div>
              <div class="h">{seqs.length} in total</div>
            </div>
            <div class="stat">
              <div class="n">{num(attribution.total)}</div>
              <div class="l">Conversions, {win.label}</div>
              <div class="h">{fmtMoney(attribution.cents)}</div>
            </div>
            <div class="stat">
              <div class="n">
                {pct(attribution.channels.filter((ch) => ch.kind !== 'direct').reduce((n2, ch) => n2 + ch.share, 0), 0)}
              </div>
              <div class="l">Credited to mail</div>
              <div class="h">the rest arrived without a click</div>
            </div>
            <div class="stat">
              <div class="n">{fmtMoney(seqRevenue)}</div>
              <div class="l">Sequence revenue</div>
              <div class="h">all time, last-touch</div>
            </div>
          </div>
        </div>
      </div>

      <div class="bento">
        <div class="card col-7">
          <div class="card-h">
            <h2>Where conversions came from</h2>
            <div class="actions">
              <a class="btn sm" href="/analytics/contribution">
                Against goals
              </a>
            </div>
          </div>
          <div class="card-b">
            <div class="faint" style="font-size:12.5px;margin-bottom:16px">
              {win.label} · {num(attribution.total)} conversions · {fmtMoney(attribution.cents)}
            </div>
            <SplitBar a={attribution} />
            <Take>
              <b>Direct is not a failure.</b> It means nobody clicked an email in the attribution
              window before buying — for a list this size that is most sales, most of the time. The
              number worth watching is whether the credited share <em>grows</em>.
            </Take>
          </div>
        </div>

        <div class="card col-5">
          <div class="card-h">
            <h2>Goals</h2>
            <div class="actions">
              <a class="btn sm" href="/goals">
                Set targets
              </a>
            </div>
          </div>
          <div class="card-b">
            {board.length === 0 ? (
              <div class="empty">
                <p>No goals to measure against.</p>
                <p class="faint">
                  Everything on these screens is a number. A goal is what turns one into a verdict.
                </p>
              </div>
            ) : (
              board.map((row) => <MiniGoal row={row} />)
            )}
          </div>
        </div>
      </div>

      {mix.length > 1 ? (
        <div class="card">
          <div class="card-h">
            <h2>Conversions per month</h2>
          </div>
          <div class="card-b">
            <ColumnChart
              data={mix.map((m) => ({
                label: MONTH_LABEL(m.month),
                caption: `${m.sequence} sequence · ${m.broadcast} broadcast · ${m.direct} direct`,
                value: m.sequence + m.broadcast + m.form + m.direct,
              }))}
              height={240}
              format="number"
            />
            <div class="tscroll" style="margin-top:8px">
              <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th class="num">Sequences</th>
                  <th class="num">Broadcasts</th>
                  <th class="num">Forms</th>
                  <th class="num">Direct</th>
                  <th class="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {[...mix].reverse().map((m) => (
                  <tr>
                    <td>{MONTH_LABEL(m.month)}</td>
                    <td class="num">{num(m.sequence)}</td>
                    <td class="num">{num(m.broadcast)}</td>
                    <td class="num">{num(m.form)}</td>
                    <td class="num faint">{num(m.direct)}</td>
                    <td class="num">{fmtMoney(m.cents)}</td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      <div class="bento">
        <div class="card col-6">
          <div class="card-h">
            <h2>Best sequences</h2>
            <div class="actions">
              <a class="btn sm" href="/analytics/sequences">
                All {seqs.length}
              </a>
            </div>
          </div>
          <div class="card-b">
            {top.length === 0 ? (
              <div class="empty">
                <p>No sequence has enough history to score.</p>
              </div>
            ) : (
              <table>
                <tbody>
                  {top.map((s) => (
                    <tr>
                      <td>
                        <a href={`/analytics/sequences/${s.id}`}>
                          <b>{s.name}</b>
                        </a>
                        <div class="faint" style="font-size:12.5px;margin-top:4px">
                          {sequenceVerdict(s)}
                        </div>
                      </td>
                      <td class="num" style="width:1%">
                        <ScorePill score={s.score} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div class="card col-6">
          <div class="card-h">
            <h2>Last sends</h2>
            <div class="actions">
              <a class="btn sm" href="/analytics/broadcasts">
                All broadcasts
              </a>
            </div>
          </div>
          <div class="card-b">
            {trend.history.length === 0 ? (
              <div class="empty">
                <p>Nothing sent yet.</p>
              </div>
            ) : (
              <table>
                <tbody>
                  {[...trend.history].reverse().slice(0, 5).map((h) => (
                    <tr>
                      <td>
                        <a href={`/broadcasts/${h.id}`}>{h.subject}</a>
                      </td>
                      <td class="num" style="width:1%">
                        <ScorePill score={h.score} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </Layout>,
  )
})

/** A goal, compressed to a line and a bar, with its channel mix under it. */
const MiniGoal: FC<{ row: GoalBoardRow }> = ({ row }) => {
  const g = row.progress
  const p = g.pctCount ?? g.pctCents
  const credited = row.attribution.channels
    .filter((ch) => ch.kind !== 'direct')
    .reduce((n, ch) => n + ch.n, 0)
  return (
    <div style="margin-bottom:22px">
      <div class="row" style="justify-content:space-between;align-items:baseline;gap:12px">
        <a href={`/analytics/contribution#g${g.id}`} style="font-weight:500">
          {g.name}
        </a>
        <span style="font-variant-numeric:tabular-nums">
          {g.targetCount !== null ? num(g.count) : fmtMoney(g.cents)}
          {p !== null ? <span class="faint"> · {p}%</span> : null}
        </span>
      </div>
      {p !== null ? (
        <div class="meter">
          <i style={`width:${Math.min(100, p)}%`} />
        </div>
      ) : null}
      <div class="faint" style="font-size:12.5px;margin-top:6px">
        {g.window.label} · {num(credited)} of {num(g.count)} credited to mail
        {row.behind ? ' · behind pace' : ''}
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────── contribution

analytics.get('/analytics/contribution', async (c) => {
  const db = getDb(c.env)
  const win = quarterWindow()

  const [board, overall, seqs] = await Promise.all([
    goalBoard(db, { limit: 8 }),
    attributionIn(db, win),
    sequencePerformance(db),
  ])

  const seqById = new Map(seqs.map((s) => [s.id, s]))

  return c.html(
    <Layout title="Contribution" nav="ancon">
      <Head
        eyebrow="Attribution"
        title="Contribution"
        sub="Which mail is moving the targets — the same windows the goals use, split by what earned the credit."
      />

      <div class="note">
        <strong>Last-touch, inside a window.</strong> A conversion is credited to the last email
        the person <em>clicked</em> before it — never to an open, because Apple's proxies open mail
        nobody read. Broadcasts get a shorter window than sequences. Nothing clicked in the window
        means the sale is <em>direct</em>, which is an honest answer and not a hole.
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Everything, {win.label}</h2>
        </div>
        <div class="card-b">
          <div class="faint" style="font-size:12.5px;margin-bottom:16px">
            {num(overall.total)} conversions · {fmtMoney(overall.cents)} · every goal below reads
            the same log through a narrower window.
          </div>
          <SplitBar a={overall} />
        </div>
      </div>

      {board.length === 0 ? (
        <div class="card">
          <div class="card-b">
            <div class="empty">
              <p>No goals set.</p>
              <p class="faint">
                A goal is what makes a conversion count mean something. <a href="/goals">Set one</a>{' '}
                and this page fills in.
              </p>
            </div>
          </div>
        </div>
      ) : (
        board.map((row) => <GoalPanel row={row} seqById={seqById} />)
      )}
    </Layout>,
  )
})

/** One goal, with the channel split and the individual mail behind it. */
const GoalPanel: FC<{
  row: GoalBoardRow
  seqById: Map<number, { isActive: boolean; steps: number }>
}> = ({ row, seqById }) => {
  const g = row.progress
  const p = g.pctCount ?? g.pctCents
  const a = row.attribution
  const maxCents = Math.max(1, ...a.sources.map((s) => s.cents))

  return (
    <div class="card" style="margin-top:18px" id={`g${g.id}`}>
      <div class="card-h">
        <h2>{g.name}</h2>
        <div class="actions">
          <span class="pill">{g.window.label}</span>
          <a class="btn sm" href={`/goals/${g.id}`}>
            Edit target
          </a>
        </div>
      </div>
      <div class="card-b">
        <div class="row" style="justify-content:space-between;align-items:baseline;gap:14px">
          <div class="faint" style="font-size:12.5px">
            {g.kindLabel}
            {g.campaignName ? ` · ${g.campaignName}` : ''}
          </div>
          <div style="font-variant-numeric:tabular-nums">
            <strong>{g.targetCount !== null ? num(g.count) : fmtMoney(g.cents)}</strong>
            {g.targetCount !== null && g.targetCount ? (
              <span class="faint"> / {num(g.targetCount)}</span>
            ) : g.targetCents ? (
              <span class="faint"> / {fmtMoney(g.targetCents)}</span>
            ) : null}
            {p !== null ? <span class="faint"> · {p}%</span> : null}
          </div>
        </div>

        {p !== null ? (
          <div class="meter">
            <i style={`width:${Math.min(100, p)}%`} />
          </div>
        ) : null}
        {row.pace ? (
          <div class="faint" style="font-size:12.5px;margin-top:6px">
            {row.pace}
            {row.behind ? ' — behind pace' : ' — on or ahead of pace'}
          </div>
        ) : null}

        <div style="margin-top:26px">
          <SplitBar a={a} />
        </div>

        {a.sources.length ? (
          <div class="tscroll" style="margin-top:26px">
            <table>
            <thead>
              <tr>
                <th>Mail that earned it</th>
                <th class="num">Conversions</th>
                <th class="num">Share</th>
                <th class="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {a.sources.map((s) => (
                <tr>
                  <td>
                    {s.href ? <a href={s.href}>{s.label}</a> : s.label}
                    <div class="faint" style="font-size:12px;margin-top:4px">
                      {s.sourceKind}
                      {s.sourceKind === 'sequence' && seqById.get(s.sourceId)
                        ? seqById.get(s.sourceId)?.isActive
                          ? ' · live'
                          : ' · switched off'
                        : ''}
                    </div>
                    <div class="rt-b" style="margin-top:8px">
                      <i style={`width:${Math.round((s.cents / maxCents) * 100)}%`} />
                    </div>
                  </td>
                  <td class="num">{num(s.n)}</td>
                  <td class="num">{pct(s.share, 0)}</td>
                  <td class="num">{fmtMoney(s.cents)}</td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
        ) : null}

        <Take label="Read it as">
          {a.total === 0 ? (
            <>Nothing has converted in this window yet, so there is nothing to attribute.</>
          ) : a.channels.find((ch) => ch.kind === 'sequence')?.n ? (
            <>
              <b>
                {num(a.channels.find((ch) => ch.kind === 'sequence')?.n ?? 0)} of {num(a.total)}
              </b>{' '}
              conversions toward this goal came from a sequence — mail that went out on its own,
              while you were doing something else. That is the part of the machine worth
              compounding.
            </>
          ) : (
            <>
              No sequence has fed this goal yet. Sequences are the only mail here that works without
              you pressing send — if this target matters, one of them should be pointed at it.
            </>
          )}
        </Take>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────── list health

analytics.get('/analytics/health', async (c) => {
  const db = getDb(c.env)
  const health = await listHealth(db)
  const cadence = await broadcastCadence(db, 12)

  return c.html(
    <Layout title="List health" nav="anhl" charts>
      <Head
        eyebrow="The asset"
        title="List health"
        sub="Five measures of whether the list itself is getting better or worse — separate from whether any one send landed."
      />
      <HealthCard health={health} />

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>Growth</h2>
        </div>
        <div class="card-b">
          {health.growth.length === 0 ? (
            <div class="empty">
              <p>No sign-ups in the last year.</p>
            </div>
          ) : (
            <>
              <ColumnChart
                data={health.growth.map((g) => ({
                  label: MONTH_LABEL(g.month),
                  caption: `${g.joined} joined · ${g.left} left`,
                  value: g.joined - g.left,
                }))}
                height={230}
                format="number"
              />
              <table style="margin-top:8px">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th class="num">Joined</th>
                    <th class="num">Left</th>
                    <th class="num">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {[...health.growth].reverse().map((g) => (
                    <tr>
                      <td>{MONTH_LABEL(g.month)}</td>
                      <td class="num">{num(g.joined)}</td>
                      <td class="num faint">{num(g.left)}</td>
                      <td class="num">
                        <b>
                          {g.joined - g.left >= 0 ? '+' : ''}
                          {num(g.joined - g.left)}
                        </b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>Cadence</h2>
        </div>
        <div class="card-b">
          {cadence.length === 0 ? (
            <div class="empty">
              <p>No broadcasts in the last year.</p>
            </div>
          ) : (
            <>
              <div class="faint" style="font-size:12.5px;margin-bottom:16px">
                How often mail actually goes out. A list forgets you in about three weeks — the
                shape of this chart explains more open rates than any subject line does.
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th class="num">Sends</th>
                    <th class="num">Recipients</th>
                  </tr>
                </thead>
                <tbody>
                  {[...cadence].reverse().map((m) => (
                    <tr>
                      <td>{MONTH_LABEL(m.month)}</td>
                      <td class="num">
                        <b>{num(m.sends)}</b>
                      </td>
                      <td class="num faint">{num(m.reached)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </Layout>,
  )
})

const HealthCard: FC<{ health: ListHealth }> = ({ health }) => (
  <div class="card sig-card">
    <div class="card-b">
      <div class="sig-grid lead">
        <Dial score={health.score} label="Health" size={148} />
        <div class="sig-read">
          <h2 class="sig-verdict">
            {health.score === null
              ? 'Not enough history to score the list yet.'
              : health.score >= 75
                ? 'This is a list in good shape.'
                : health.score >= 55
                  ? 'Solid, with one or two things worth fixing.'
                  : health.score >= 35
                    ? 'Working, but decaying at the edges.'
                    : 'The list needs attention before the next send.'}
          </h2>
          <p class="sig-ev">
            {num(health.size.total)} people on file — {num(health.size.active)} active,{' '}
            {num(health.size.unsubscribed)} unsubscribed, {num(health.size.bounced)} bounced or
            complained. {pct(health.engagedRate)} of the active list did something in the last 90
            days.
          </p>
        </div>
      </div>

      <div style="margin-top:30px">
        {health.metrics.map((m) => (
          <div class="hm">
            <div>
              <div class="hm-l">{m.label}</div>
              <div class="hm-v">{m.value}</div>
            </div>
            <div>
              <div class="row" style="justify-content:space-between;align-items:baseline;gap:12px">
                <span class="faint" style="font-size:12.5px">
                  {m.detail}
                </span>
                <ScorePill score={m.score} />
              </div>
              <div class="sig-track">
                <div
                  class={`sig-fill ${band(m.score).key}`}
                  style={`width:${Math.max(m.score ?? 0, 1.5)}%`}
                />
              </div>
              {m.note ? <div class="hm-note">{m.note}</div> : null}
            </div>
          </div>
        ))}
      </div>

      <Take label="Note">
        This is not the Signal score. Signal grades one <b>send</b>; this grades the{' '}
        <b>list underneath it</b>. A brilliant broadcast to a list that stopped opening is still a
        brilliant broadcast, and it is still not working.
      </Take>
    </div>
  </div>
)

// ─────────────────────────────────────────────────────────── broadcasts

analytics.get('/analytics/broadcasts', async (c) => {
  const db = getDb(c.env)
  const [signals, trend] = await Promise.all([recentSignals(db, 60), signalTrend(db, 14)])

  const scored = signals.filter((s) => s.score !== null)
  const best = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null
  const worst = [...scored].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0] ?? null
  const totalReached = signals.reduce((n, s) => n + s.reached, 0)
  const totalClicks = signals.reduce((n, s) => n + s.clicked, 0)
  const totalOpens = signals.reduce((n, s) => n + s.opened, 0)
  const totalCents = signals.reduce((n, s) => n + (s.convertedCents ?? 0), 0)

  return c.html(
    <Layout title="Broadcasts" nav="anbc">
      <Head
        eyebrow="One-offs"
        title="Broadcast performance"
        sub="Every send, scored by the same instrument, against your own median — which is the only benchmark that means anything."
      />

      <div class="card">
        <div class="card-b flush">
          <div class="stats">
            <div class="stat">
              <div class="n">{signals.length}</div>
              <div class="l">Sends analysed</div>
            </div>
            <div class="stat">
              <div class="n">{trend.median ?? '—'}</div>
              <div class="l">Median signal</div>
              <div class="h">out of 100</div>
            </div>
            <div class="stat">
              <div class="n">{num(totalReached)}</div>
              <div class="l">Recipients</div>
              <div class="h">net of bounces</div>
            </div>
            <div class="stat">
              <div class="n">{totalOpens ? pct(totalClicks / totalOpens, 1) : '—'}</div>
              <div class="l">Click-to-open</div>
              <div class="h">
                {num(totalClicks)} of {num(totalOpens)}
              </div>
            </div>
            <div class="stat">
              <div class="n">{fmtMoney(totalCents)}</div>
              <div class="l">Credited</div>
              <div class="h">last-touch, live sends only</div>
            </div>
          </div>
        </div>
      </div>

      {best && worst && best.id !== worst.id ? (
        <div class="bento">
          <div class="card col-6">
            <div class="card-h">
              <h2>Your best send</h2>
              <div class="actions">
                <ScorePill score={best.score} />
              </div>
            </div>
            <div class="card-b">
              <a class="sig-subject" href={`/broadcasts/${best.id}`}>
                {best.subject}
              </a>
              <p class="sig-ev">{best.verdict}</p>
              <Components components={best.components} />
            </div>
          </div>
          <div class="card col-6">
            <div class="card-h">
              <h2>Your weakest</h2>
              <div class="actions">
                <ScorePill score={worst.score} />
              </div>
            </div>
            <div class="card-b">
              <a class="sig-subject" href={`/broadcasts/${worst.id}`}>
                {worst.subject}
              </a>
              <p class="sig-ev">{worst.verdict}</p>
              <Components components={worst.components} />
            </div>
          </div>
        </div>
      ) : null}

      <div class="card">
        <div class="card-h">
          <h2>Every send</h2>
        </div>
        <div class="card-b">
          {signals.length === 0 ? (
            <div class="empty">
              <p>Nothing has been sent yet.</p>
            </div>
          ) : (
            <div class="tscroll">
              <table>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th class="num">Reached</th>
                  <th class="num">Opened</th>
                  <th class="num">Clicked</th>
                  <th class="num">Left</th>
                  <th class="num">Value</th>
                  <th class="num">Signal</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => {
                  const openRate = s.reached ? s.opened / s.reached : 0
                  const ctor = s.opened ? s.clicked / s.opened : 0
                  return (
                    <tr>
                      <td>
                        <a href={`/broadcasts/${s.id}`}>
                          <b>{s.subject}</b>
                        </a>
                        <div class="faint" style="font-size:12px;margin-top:4px">
                          {fmtDay(s.sentAt)}
                          {s.source === 'imported' ? ' · imported from Kit' : ''}
                        </div>
                      </td>
                      <td class="num">{num(s.reached)}</td>
                      <td class="num">
                        {pct(openRate, 0)}
                        <div class="faint" style="font-size:11.5px">
                          {num(s.opened)}
                        </div>
                      </td>
                      <td class="num">
                        {pct(ctor, 1)}
                        <div class="faint" style="font-size:11.5px">
                          {num(s.clicked)}
                        </div>
                      </td>
                      <td class="num faint">{num(s.unsubscribed)}</td>
                      <td class="num">
                        {s.converted === null ? (
                          <span class="faint" title="Nothing was sent from here, so no conversion could ever attach">
                            n/a
                          </span>
                        ) : (
                          fmtMoney(s.convertedCents ?? 0)
                        )}
                      </td>
                      <td class="num">
                        <ScorePill score={s.score} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              </table>
            </div>
          )}
          <Take>
            <b>Compare down the column, not against an industry average.</b> A 42% open rate is
            excellent on one list and a failure on another
            {trend.median !== null
              ? `; the only benchmark that survives contact with reality is your own median, ${trend.median}.`
              : '. Once a few sends have been scored, your own median becomes the benchmark.'}
          </Take>
        </div>
      </div>
    </Layout>,
  )
})
