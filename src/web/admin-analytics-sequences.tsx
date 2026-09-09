import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import { sequenceExits } from '../core/activity.ts'
import {
  type SequencePerf,
  goalBoard,
  sequenceIntake,
  sequencePerformance,
  sequenceSteps,
} from '../core/analytics.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import {
  Components,
  Dial,
  RateCell,
  ScorePill,
  StepWaterfall,
  Take,
  num,
  pct,
  sequenceVerdict,
} from './analytics-parts.tsx'
import { ColumnChart } from './charts.tsx'
import { Layout, fmtMoney } from './layout.tsx'

export const analyticsSequences = new Hono<{ Bindings: Env }>()

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_LABEL = (ym: string) => {
  const [y, m] = ym.split('-')
  return `${MONTHS[Number(m) - 1] ?? m} ${String(y).slice(2)}`
}

/**
 * ⭐ Sequence analytics — the screen Kit could not draw.
 *
 * Kit's sequence report gives four columns: subscribers, open rate, click rate,
 * unsubscribers. Every one of them is a rate with no denominator and no money
 * attached, which makes the table impossible to act on: a 76% open rate on a
 * sequence nobody finishes and that has never earned a dollar looks better than
 * a 60% one that pays for the year.
 *
 * So this screen adds the three things that turn the table into a decision:
 *
 *   1. **What it's worth.** Conversions and revenue, credited last-touch.
 *   2. **Who finishes.** Completion against everyone who ever entered — the
 *      number that says whether the back half of a sequence is even read.
 *   3. **One score.** The same Signal instrument broadcasts are graded by, so
 *      "is this sequence better than my newsletter" is a question with an answer.
 *
 * The drill-down then answers the only question a sequence can answer that a
 * broadcast can't: *which mail in it loses people.*
 */

/** How a sequence starts, said the way a person would say it. */
const TRIGGER_WORDS: Record<SequencePerf['trigger'], string> = {
  subscribe: 'starts when somebody subscribes',
  tag_added: 'starts when a tag is added',
  manual: 'started by hand',
}

type SortKey = 'score' | 'people' | 'open' | 'click' | 'money' | 'churn' | 'name'

const SORTS: Record<SortKey, (a: SequencePerf, b: SequencePerf) => number> = {
  score: (a, b) => (b.score ?? -1) - (a.score ?? -1),
  people: (a, b) => b.enrollment.total - a.enrollment.total,
  open: (a, b) => b.rates.open - a.rates.open,
  click: (a, b) => b.rates.ctor - a.rates.ctor,
  money: (a, b) => b.convertedCents - a.convertedCents || (b.converted ?? 0) - (a.converted ?? 0),
  churn: (a, b) => b.rates.unsub - a.rates.unsub,
  name: (a, b) => a.name.localeCompare(b.name),
}

/** A column header that sorts. A link, because that is exactly what it is. */
const SortTh: FC<{ k: SortKey; on: SortKey; label: string; num?: boolean }> = ({
  k,
  on,
  label,
  num: isNum,
}) => (
  <th class={isNum ? 'num' : ''}>
    <a href={`/analytics/sequences?sort=${k}`} class={on === k ? 'on' : ''}>
      {label}
    </a>
  </th>
)

// ─────────────────────────────────────────────────────────── leaderboard

analyticsSequences.get('/analytics/sequences', async (c) => {
  const db = getDb(c.env)
  const seqs = await sequencePerformance(db)

  const raw = c.req.query('sort')
  const sort: SortKey = raw && raw in SORTS ? (raw as SortKey) : 'score'
  const rows = [...seqs].sort(SORTS[sort])

  const live = seqs.filter((s) => s.isActive)
  const enrolled = seqs.reduce((n, s) => n + s.enrollment.active, 0)
  const opened = seqs.reduce((n, s) => n + s.opened, 0)
  const clicked = seqs.reduce((n, s) => n + s.clicked, 0)
  const cents = seqs.reduce((n, s) => n + s.convertedCents, 0)
  const converted = seqs.reduce((n, s) => n + (s.converted ?? 0), 0)

  const scored = seqs.filter((s) => s.score !== null).map((s) => s.score as number)
  const median = scored.length
    ? [...scored].sort((a, b) => a - b)[Math.floor(scored.length / 2)] ?? null
    : null

  // The one worth acting on: switched off, but people are still inside it.
  const stranded = seqs.filter((s) => !s.isActive && s.enrollment.active > 0)
  // Earning nothing while running is worth naming too, but only once there is
  // enough traffic through it for "nothing" to mean anything.
  const idle = seqs.filter((s) => s.isActive && s.reached > 50 && (s.converted ?? 0) === 0)

  return c.html(
    <Layout title="Sequences" nav="anseq">
      <div class="head">
        <div>
          <div class="eyebrow">Automated mail</div>
          <h1>Sequence performance</h1>
          <div class="sub">
            Every series, scored on the same instrument as a broadcast — plus the two things a rate
            can't tell you: who finishes, and what it earned.
          </div>
        </div>
        <div class="actions">
          <a class="btn sm" href="/sequences">
            Edit sequences
          </a>
        </div>
      </div>

      <div class="card">
        <div class="card-b flush">
          <div class="stats">
            <div class="stat">
              <div class="n">{live.length}</div>
              <div class="l">Live</div>
              <div class="h">{seqs.length} in total</div>
            </div>
            <div class="stat">
              <div class="n">{num(enrolled)}</div>
              <div class="l">Mid-sequence</div>
              <div class="h">people with mail still to come</div>
            </div>
            <div class="stat">
              <div class="n">{median ?? '—'}</div>
              <div class="l">Median signal</div>
              <div class="h">out of 100</div>
            </div>
            <div class="stat">
              <div class="n">{opened ? pct(clicked / opened, 1) : '—'}</div>
              <div class="l">Click-to-open</div>
              <div class="h">
                {num(clicked)} of {num(opened)} readers
              </div>
            </div>
            <div class="stat">
              <div class="n">{fmtMoney(cents)}</div>
              <div class="l">Credited</div>
              <div class="h">{num(converted)} conversions, last-touch</div>
            </div>
          </div>
        </div>
      </div>

      {stranded.length || idle.length ? (
        <div class="note">
          {stranded.length ? (
            <p>
              <strong>
                {stranded.length} sequence{stranded.length === 1 ? '' : 's'} switched off with people
                still inside.
              </strong>{' '}
              {stranded.map((s, i) => (
                <>
                  {i ? ', ' : ''}
                  <a href={`/analytics/sequences/${s.id}`}>{s.name}</a> ({num(s.enrollment.active)})
                </>
              ))}{' '}
              — they will never receive the rest of it. That is not a bug, but it is rarely what
              anyone meant.
            </p>
          ) : null}
          {idle.length ? (
            <p style="margin-top:10px">
              <strong>Running, earning nothing:</strong>{' '}
              {idle.map((s, i) => (
                <>
                  {i ? ', ' : ''}
                  <a href={`/analytics/sequences/${s.id}`}>{s.name}</a>
                </>
              ))}
              . Fine for a welcome series. Worth a look on anything that was meant to sell.
            </p>
          ) : null}
        </div>
      ) : null}

      <div class="card">
        <div class="card-h">
          <h2>{seqs.length} sequences</h2>
          <div class="actions">
            <span class="faint" style="font-size:12.5px">
              sorted by {sort === 'click' ? 'click-to-open' : sort === 'churn' ? 'unsubscribes' : sort}
            </span>
          </div>
        </div>
        <div class="card-b">
          {seqs.length === 0 ? (
            <div class="empty">
              <p>No sequences yet.</p>
              <p class="faint">
                A sequence is the only mail here that works while you are asleep.{' '}
                <a href="/sequences/new">Write one</a>.
              </p>
            </div>
          ) : (
            <div class="tscroll">
              <table>
              <thead>
                <tr>
                  <SortTh k="name" on={sort} label="Sequence" />
                  <SortTh k="people" on={sort} label="People" num />
                  <SortTh k="open" on={sort} label="Opened" num />
                  <SortTh k="click" on={sort} label="Clicked" num />
                  <SortTh k="churn" on={sort} label="Left" num />
                  <SortTh k="money" on={sort} label="Earned" num />
                  <SortTh k="score" on={sort} label="Signal" num />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr>
                    <td>
                      <a href={`/analytics/sequences/${s.id}`}>
                        <b>{s.name}</b>
                      </a>
                      <div class="faint" style="font-size:12px;margin-top:4px">
                        {s.steps} email{s.steps === 1 ? '' : 's'} over {s.spanDays} day
                        {s.spanDays === 1 ? '' : 's'}
                        {s.isActive ? '' : ' · inactive'}
                        {s.source === 'imported' ? ' · Kit figures' : ''}
                        {s.campaignName ? ` · ${s.campaignName}` : ''}
                      </div>
                    </td>
                    <td class="num">
                      {/* Kit rows have no enrollments here — nobody was ever
                          enrolled *in this system*. Showing its own count under
                          its own label beats printing a zero that is not one. */}
                      <b>
                        {num(
                          s.source === 'imported'
                            ? (s.importedSubscribers ?? 0)
                            : s.enrollment.total,
                        )}
                      </b>
                      <div class="faint" style="font-size:11.5px">
                        {s.source === 'imported'
                          ? 'in Kit today'
                          : `${num(s.enrollment.active)} mid-way`}
                      </div>
                    </td>
                    <td class="num" style="min-width:110px">
                      <RateCell
                        value={s.rates.open}
                        title={`${num(s.opened)} of ${num(s.reached)} reached`}
                      />
                    </td>
                    <td class="num" style="min-width:110px">
                      <RateCell
                        value={s.rates.ctor}
                        max={0.35}
                        title={`${num(s.clicked)} of ${num(s.opened)} readers`}
                      />
                    </td>
                    <td class="num" style="min-width:110px">
                      <RateCell
                        value={s.rates.unsub}
                        max={0.05}
                        warm
                        title={`${num(s.unsubscribed)} unsubscribed`}
                      />
                    </td>
                    <td class="num">
                      {s.converted === null ? (
                        <span
                          class="faint"
                          title="Kit-era: nothing was sent from here, so no conversion could ever attach"
                        >
                          n/a
                        </span>
                      ) : (
                        <>
                          <b>{fmtMoney(s.convertedCents)}</b>
                          <div class="faint" style="font-size:11.5px">
                            {num(s.converted)} conversion{s.converted === 1 ? '' : 's'}
                          </div>
                        </>
                      )}
                    </td>
                    <td class="num">
                      <ScorePill score={s.score} />
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          )}

          <Take label="How to read it">
            <b>Opened</b> is over people reached and is inflated by Apple's proxies — treat it as a
            subject-line signal, not an audience count. <b>Clicked</b> is over people who opened,
            which is the only figure here where a human read the words and then decided to do
            something. When the two disagree, believe the second one.
          </Take>
        </div>
      </div>
    </Layout>,
  )
})

// ────────────────────────────────────────────────────────────── one sequence

analyticsSequences.get('/analytics/sequences/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))

  const all = await sequencePerformance(db)
  const s = all.find((x) => x.id === id)
  if (!s) return c.notFound()

  const [steps, intake, board, exits] = await Promise.all([
    sequenceSteps(db, id),
    sequenceIntake(db, id, 12),
    goalBoard(db, { limit: 8 }),
    sequenceExits(db, id),
  ])

  // Which goals this sequence is currently feeding — read off the same
  // attribution the contribution screen uses, so the two can never disagree.
  const feeding = board
    .map((row) => ({
      row,
      mine: row.attribution.sources.find(
        (src) => src.sourceKind === 'sequence' && src.sourceId === id,
      ),
    }))
    .filter((x) => x.mine)

  const worst = [...steps]
    .filter((x) => x.reached > 0)
    .sort((a, b) => a.rates.ctor - b.rates.ctor)[0]
  const leakiest = steps
    .map((step, i) => ({
      step,
      drop: i > 0 && (steps[i - 1]?.sent ?? 0) > 0 ? 1 - step.sent / (steps[i - 1]?.sent ?? 1) : 0,
    }))
    .sort((a, b) => b.drop - a.drop)[0]

  return c.html(
    <Layout title={s.name} nav="anseq" charts>
      <div class="head">
        <div>
          <div class="eyebrow">
            Sequence
            {s.isActive ? ' · live' : ' · inactive'}
            {s.source === 'imported' ? ' · Kit figures' : ''}
          </div>
          <h1>{s.name}</h1>
          <div class="sub">
            {s.steps} email{s.steps === 1 ? '' : 's'} over {s.spanDays} day
            {s.spanDays === 1 ? '' : 's'} · {TRIGGER_WORDS[s.trigger]}
            {s.campaignName ? ` · ${s.campaignName}` : ''}
          </div>
        </div>
        <div class="actions">
          <a class="btn sm" href={`/sequences/${s.id}`}>
            Edit
          </a>
          <a class="btn sm" href="/analytics/sequences">
            All sequences
          </a>
        </div>
      </div>

      <div class="card sig-card">
        <div class="card-b">
          <div class="sig-grid lead">
            <Dial score={s.score} label="Signal" size={148} />
            <div class="sig-read">
              <h2 class="sig-verdict">{sequenceVerdict(s)}</h2>
              <p class="sig-ev">
                {num(s.enrollment.total)} people have entered this sequence.{' '}
                {num(s.reached)} pieces of mail reached somebody, {pct(s.rates.open)} were opened,
                and {num(s.clicked)} readers clicked — {pct(s.rates.ctor, 2)} of the people who
                looked.{' '}
                {s.unsubscribed === 0
                  ? 'Nobody left over the course of it.'
                  : `${num(s.unsubscribed)} left over the course of it.`}
              </p>
              {s.source === 'imported' ? (
                <p class="faint" style="font-size:12.5px;margin-top:12px">
                  These figures are carried over from Kit, which reports rates without
                  denominators. Counts here are reconstructed against the people who actually
                  passed through the sequence, and conversions were never measurable for pre-cutover
                  mail — so MONEY is dropped from the score rather than counted as zero.
                </p>
              ) : null}
            </div>
          </div>
          <Components components={s.components} />
        </div>
      </div>

      <div class="card">
        <div class="card-b flush">
          <div class="stats">
            <div class="stat">
              <div class="n">{num(s.enrollment.active)}</div>
              <div class="l">Mid-sequence</div>
              <div class="h">still have mail coming</div>
            </div>
            <div class="stat">
              <div class="n">{num(s.enrollment.completed)}</div>
              <div class="l">Finished</div>
              <div class="h">
                {s.completionRate === null ? '—' : `${pct(s.completionRate, 0)} of everyone`}
              </div>
            </div>
            <div class="stat">
              <div class="n">{num(s.enrollment.optedOut)}</div>
              <div class="l">Opted out</div>
              <div class="h">of this sequence only</div>
            </div>
            <div class="stat">
              <div class="n">{num(s.enrollment.cancelled)}</div>
              <div class="l">Cancelled</div>
              <div class="h">pulled out before the end</div>
            </div>
            <div class="stat">
              <div class="n">
                {s.converted === null ? 'n/a' : fmtMoney(s.convertedCents)}
              </div>
              <div class="l">Credited</div>
              <div class="h">
                {s.converted === null
                  ? 'not measurable for Kit-era mail'
                  : `${num(s.converted)} conversions`}
              </div>
            </div>
          </div>
        </div>
      </div>

      {exits.cancelled + exits.optedOut > 0 ? (
        <div class="card">
          <div class="card-h">
            <h2>Why people left</h2>
          </div>
          <div class="card-b">
            <p class="faint" style="margin:0 0 16px">
              The step chart below says <b>where</b>. This says <b>why</b> — and the difference
              matters, because "they asked to leave", "they bounced" and "they bought the thing and
              we stopped selling it to them" all look identical in an enrollment's status.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Reason</th>
                  <th class="num">People</th>
                </tr>
              </thead>
              <tbody>
                {exits.optedOut > 0 ? (
                  <tr>
                    <td>
                      Chose to leave this sequence
                      <div class="faint">and stayed on everything else</div>
                    </td>
                    <td class="num">{num(exits.optedOut)}</td>
                  </tr>
                ) : null}
                {exits.cancelledBy.map((r) => (
                  <tr>
                    <td>{r.reason.replace(/_/g, ' ')}</td>
                    <td class="num">{num(r.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div class="card">
        <div class="card-h">
          <h2>Where people fall out</h2>
        </div>
        <div class="card-b">
          {steps.length === 0 ? (
            <div class="empty">
              <p>This sequence has no steps yet.</p>
            </div>
          ) : (
            <>
              <div class="lg" style="margin:0 0 20px">
                <span class="lg-i">
                  <i style="background:rgba(99,102,241,.6)" /> Sent
                </span>
                <span class="lg-i">
                  <i style="background:rgba(56,189,248,.7)" /> Opened
                </span>
                <span class="lg-i">
                  <i style="background:#22d3ee" /> Clicked
                </span>
              </div>
              <StepWaterfall steps={steps} />
              <Take label="The fix">
                {leakiest && leakiest.drop > 0.15 ? (
                  <>
                    The biggest single drop is at <b>#{leakiest.step.position}</b> —{' '}
                    <em>{leakiest.step.subject}</em> — where {pct(leakiest.drop, 0)} of the people
                    who got the previous mail never received this one. A gap that size is usually a
                    delay that is too long, not a subject line that is too weak.
                  </>
                ) : worst ? (
                  <>
                    Nothing is leaking badly. The weakest mail by pull is{' '}
                    <b>#{worst.position}</b> — <em>{worst.subject}</em> — at{' '}
                    {pct(worst.rates.ctor, 1)} of readers clicking. That is the one to rewrite
                    first.
                  </>
                ) : (
                  <>Not enough has been sent through this sequence to judge the steps yet.</>
                )}
              </Take>
            </>
          )}
        </div>
      </div>

      <div class="bento">
        <div class="card col-6">
          <div class="card-h">
            <h2>Who is still entering</h2>
          </div>
          <div class="card-b">
            {intake.length === 0 ? (
              <div class="empty">
                <p>Nobody has entered this sequence in the last year.</p>
                <p class="faint">
                  {s.isActive
                    ? 'It is switched on, so the trigger is the thing to check.'
                    : 'It is switched off, which is the likely reason.'}
                </p>
              </div>
            ) : (
              <>
                <ColumnChart
                  data={intake.map((m) => ({ label: MONTH_LABEL(m.month), value: m.n }))}
                  height={200}
                  format="number"
                />
                <div class="faint" style="font-size:12.5px;margin-top:12px">
                  Enrollments per month. A sequence with no intake is a sequence that has quietly
                  stopped mattering, however good its numbers look.
                </div>
              </>
            )}
          </div>
        </div>

        <div class="card col-6">
          <div class="card-h">
            <h2>Goals it is feeding</h2>
            <div class="actions">
              <a class="btn sm" href="/analytics/contribution">
                All contribution
              </a>
            </div>
          </div>
          <div class="card-b">
            {feeding.length === 0 ? (
              <div class="empty">
                <p>Not currently credited toward any open goal.</p>
                <p class="faint">
                  Either nothing has converted through it inside an open period, or there is no goal
                  covering what it sells.
                </p>
              </div>
            ) : (
              <table>
                <tbody>
                  {feeding.map(({ row, mine }) => (
                    <tr>
                      <td>
                        <a href={`/analytics/contribution#g${row.progress.id}`}>
                          <b>{row.progress.name}</b>
                        </a>
                        <div class="faint" style="font-size:12px;margin-top:4px">
                          {row.progress.window.label} · {pct(mine?.share ?? 0, 0)} of everything
                          credited in the period
                        </div>
                      </td>
                      <td class="num">
                        <b>{num(mine?.n ?? 0)}</b>
                        <div class="faint" style="font-size:11.5px">
                          {fmtMoney(mine?.cents ?? 0)}
                        </div>
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
