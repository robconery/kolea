import type { FC } from 'hono/jsx'
import type { BroadcastSignal, SignalTrend } from '../core/signal.ts'
import { fmtDay } from './layout.tsx'

/**
 * ⭐ The hero: "are my emails any good?"
 *
 * The first thing on the dashboard, because it is the first question. Everything
 * below it — list size, subscriber health, revenue — describes the audience. This
 * describes the work.
 *
 * Three rules held it to this shape:
 *
 *   1. **The number is never alone.** A bare 51 is astrology. The verdict sentence
 *      says what it means, the three bars say what fed it, and the counts under
 *      each bar say where those came from. Any figure here can be traced to two
 *      integers without leaving the card.
 *   2. **No client JavaScript.** The most important element on the page must not
 *      shimmer for 200ms while a 130KB chart bundle boots. Every bar here is a
 *      div with a width.
 *   3. **A missing number is missing, not zero.** Broadcasts with no engagement
 *      data are drawn as gaps in the history strip. A zero-height bar would read
 *      as a catastrophic send rather than an unmeasured one.
 */

const pct = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`
const num = (n: number) => n.toLocaleString('en-US')

/** Bands, not a continuous ramp: a reader should be able to name where they are. */
function band(score: number): { key: string; word: string } {
  if (score >= 75) return { key: 'strong', word: 'Strong' }
  if (score >= 55) return { key: 'good', word: 'Good' }
  if (score >= 35) return { key: 'fair', word: 'Fair' }
  return { key: 'weak', word: 'Weak' }
}

/**
 * The line under the verdict: the two or three facts that justify it, in the
 * reader's own units. Percentages, then the counts behind them — a rate with no
 * denominator is how dashboards mislead people who trust them.
 */
function evidence(s: BroadcastSignal): string {
  const read = s.components.find((c) => c.key === 'read')
  const pull = s.components.find((c) => c.key === 'pull')
  if (!read || !pull) return ''
  return (
    `${pct(read.rate)} of ${num(s.reached)} opened it. ` +
    `${num(s.clicked)} of those ${num(s.opened)} readers clicked — ${pct(pull.rate, 2)}. ` +
    `${s.unsubscribed === 0 ? 'Nobody left.' : `${num(s.unsubscribed)} unsubscribed.`}`
  )
}

/** How this send sits against the median of the ones before it. */
function comparison(score: number, median: number | null): string | null {
  if (median === null) return null
  const delta = score - median
  if (Math.abs(delta) <= 3) return `In line with your median of ${median}`
  return `${delta > 0 ? '+' : ''}${delta} against your median of ${median}`
}

const Bar: FC<{ score: number }> = ({ score }) => (
  <div class="sig-track" role="presentation">
    <div class={`sig-fill ${band(score).key}`} style={`width:${Math.max(score, 1.5)}%`} />
  </div>
)

/**
 * The history strip. Not a chart — one column per recent send, oldest left,
 * newest highlighted. It exists to answer "is this normal for me?", which is the
 * only thing that makes a single score mean anything.
 */
const History: FC<{ trend: SignalTrend }> = ({ trend }) => {
  if (trend.history.length < 2) return null
  const latestId = trend.latest?.id
  return (
    <div class="sig-hist">
      <div class="sig-hist-bars">
        {trend.history.map((h) => (
          <div
            class={`sig-col${h.id === latestId ? ' now' : ''}`}
            title={`${h.subject} — Signal ${h.score}`}
          >
            {/* The past is one neutral hue. Banding every column turns a trend
                into a rainbow, and the eye starts reading colour differences
                that mean nothing — only the send being reported gets its band. */}
            <div
              class={`sig-col-fill${h.id === latestId ? ` ${band(h.score).key}` : ''}`}
              style={`height:${Math.max(h.score, 3)}%`}
            >
              <span class="sr-only">
                {h.subject}: {h.score}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div class="sig-hist-l">
        Last {trend.history.length} sends, oldest first
        {trend.median !== null ? ` · median ${trend.median}` : ''}
      </div>
    </div>
  )
}

export const SignalHero: FC<{ trend: SignalTrend }> = ({ trend }) => {
  const s = trend.latest

  // Nothing sent yet, or nothing measurable. Say which — an empty hero that looks
  // broken is worse than one that explains itself.
  if (!s || s.score === null) {
    return (
      <div class="card sig-card">
        <div class="card-b">
          <div class="eyebrow">Signal</div>
          <h2 class="sig-empty">No sends to score yet.</h2>
          <p class="sub">
            Once a broadcast goes out and readers start opening it, this is where you'll see how it
            did — read rate, click-through, and what it cost you, as one number.
          </p>
        </div>
      </div>
    )
  }

  const b = band(s.score)
  const versus = comparison(s.score, trend.median)

  return (
    <div class="card sig-card">
      <div class="card-b">
        <div class="sig-top">
          <div class="eyebrow">
            Last send{s.sentAt ? ` · ${fmtDay(s.sentAt)}` : ''}
            {s.source === 'imported' ? ' · imported from Kit' : ''}
          </div>
          <a class="sig-subject" href={`/broadcasts/${s.id}`}>
            {s.subject}
          </a>
        </div>

        <div class="sig-grid">
          <div class="sig-score">
            <div class={`sig-n ${b.key}`}>{s.score}</div>
            <div class="sig-den">
              <span class="sig-band">{b.word}</span>
              <span class="sig-outof">Signal, out of 100</span>
            </div>
            {versus ? <div class="sig-vs">{versus}</div> : null}
          </div>

          <div class="sig-read">
            <h2 class="sig-verdict">{s.verdict}</h2>
            <p class="sig-ev">{evidence(s)}</p>
            <History trend={trend} />
          </div>
        </div>

        <div class="sig-parts">
          {s.components.map((c) => (
            <div class="sig-part">
              <div class="sig-part-h">
                <span class="sig-part-l">{c.label}</span>
                <span class="sig-part-n">{c.score}</span>
              </div>
              <Bar score={c.score} />
              <div class="sig-part-d">{c.detail}</div>
              <div class="sig-part-w">weight {c.weight}%</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
