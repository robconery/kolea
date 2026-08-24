import type { FC, PropsWithChildren } from 'hono/jsx'
import type { Attribution, SequencePerf, StepPerf } from '../core/analytics.ts'
import type { Component } from '../core/signal.ts'
import { fmtMoney } from './layout.tsx'

/**
 * The shared vocabulary of the analytics screens.
 *
 * Every one of these is server-rendered and CSS-only. The rule for this whole
 * section: **the number a reader came for must be on the page before any script
 * runs.** Charts are allowed for shape-over-time, never for the figure itself.
 *
 * The second rule: **no bare numbers.** Every score carries its band as a word,
 * every rate carries the two integers underneath it, and every claim carries the
 * thing that would falsify it. A dashboard people cannot audit is a dashboard
 * people quietly stop trusting, and then it may as well not exist.
 */

export const pct = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`
export const num = (n: number) => Math.round(n).toLocaleString('en-US')

/** Bands, not a gradient. A reader should be able to *name* where they are. */
export function band(score: number | null): { key: string; word: string } {
  if (score === null) return { key: 'none', word: 'Unscored' }
  if (score >= 75) return { key: 'strong', word: 'Strong' }
  if (score >= 55) return { key: 'good', word: 'Good' }
  if (score >= 35) return { key: 'fair', word: 'Fair' }
  return { key: 'weak', word: 'Weak' }
}

/** The score chip: number, word, colour — in that order of importance. */
export const ScorePill: FC<{ score: number | null }> = ({ score }) => {
  const b = band(score)
  return (
    <span class={`score ${b.key}`} title={`${b.word}${score === null ? '' : ` — ${score} of 100`}`}>
      <i />
      {score === null ? '—' : score}
      <span class="faint" style="font-weight:500">
        {b.word}
      </span>
    </span>
  )
}

/**
 * The ring. Used once per screen, for the one number that screen is about.
 *
 * A conic gradient with a hole masked out of it — no canvas, no runtime, and it
 * paints in the first frame alongside the text.
 */
export const Dial: FC<{ score: number | null; label: string; size?: number }> = ({
  score,
  label,
  size = 132,
}) => {
  const b = band(score)
  return (
    <div class="dial-w" style={`width:${size}px;height:${size}px`}>
      <div
        class={`dial ${b.key}`}
        style={`--d:${size}px;--p:${score ?? 0}`}
        role="img"
        aria-label={`${label}: ${score === null ? 'not scored' : `${score} out of 100, ${b.word}`}`}
      />
      <div class="dial-n" aria-hidden="true">
        <div>
          {score === null ? '—' : score}
          <small>{label}</small>
        </div>
      </div>
    </div>
  )
}

/** A rate with its meter and its denominator. Never one without the others. */
export const RateCell: FC<{ value: number; max?: number; warm?: boolean; title?: string }> = ({
  value,
  max = 1,
  warm,
  title,
}) => (
  <div class="rt" title={title}>
    <span style="min-width:46px">{pct(value)}</span>
    <span class={`rt-b${warm ? ' warm' : ''}`}>
      <i style={`width:${Math.min(100, max > 0 ? (value / max) * 100 : 0)}%`} />
    </span>
  </div>
)

/** The channel split, as one rule plus a legend that carries the numbers. */
export const SplitBar: FC<{ a: Attribution }> = ({ a }) => {
  if (a.total === 0) {
    return (
      <div class="empty">
        <p>Nothing converted in this window.</p>
        <p class="faint">
          There is no attribution to split until a sale lands inside the period.
        </p>
      </div>
    )
  }
  return (
    <>
      <div class="split" role="img" aria-label="Conversions by channel">
        {a.channels.map((ch) => (
          <i
            hidden={ch.n === 0}
            style={`width:${(ch.share * 100).toFixed(2)}%`}
            title={`${ch.label}: ${num(ch.n)}`}
          />
        ))}
      </div>
      <div class="lg">
        {a.channels.map((ch) => (
          <span class="lg-i">
            <i
              style={`background:${
                ch.kind === 'sequence'
                  ? '#22d3ee'
                  : ch.kind === 'broadcast'
                    ? '#6366f1'
                    : ch.kind === 'form'
                      ? '#a855f7'
                      : 'rgba(148,190,255,.22)'
              }`}
            />
            {ch.label} <b>{num(ch.n)}</b>
            <span class="faint">
              {pct(ch.share, 0)} · {fmtMoney(ch.cents)}
            </span>
          </span>
        ))}
      </div>
    </>
  )
}

/**
 * The waterfall down a sequence: one row per step, bars nested inside one
 * another so sent/opened/clicked share a single baseline.
 *
 * Retention is measured against step one, never against the previous step —
 * chained ratios hide a slow bleed across five mails behind five unremarkable
 * numbers.
 */
export const StepWaterfall: FC<{ steps: StepPerf[] }> = ({ steps }) => {
  const first = steps[0]?.sent ?? 0
  return (
    <div class="wf">
      {steps.map((s, i) => {
        const prev = steps[i - 1]
        const dropFromPrev = prev && prev.sent > 0 ? 1 - s.sent / prev.sent : 0
        return (
          <div class="wf-row">
            <div class="wf-i">{String(s.position).padStart(2, '0')}</div>
            <div class="wf-b">
              <span class="wf-s">{s.subject}</span>
              <div class="wf-track" role="img" aria-label={`${num(s.sent)} sent, ${num(s.opened)} opened, ${num(s.clicked)} clicked`}>
                <i class="wf-sent" style={`width:${first ? (s.sent / first) * 100 : 0}%`} />
                <i class="wf-open" style={`width:${first ? (s.opened / first) * 100 : 0}%`} />
                <i class="wf-click" style={`width:${first ? (s.clicked / first) * 100 : 0}%`} />
              </div>
              <div class="faint" style="font-size:12px;margin-top:8px">
                day {s.dayOffset} · {pct(s.rates.open)} opened · {pct(s.rates.ctor, 1)} of readers
                clicked
                {s.unsubscribed ? ` · ${num(s.unsubscribed)} left here` : ''}
                {s.converted ? ` · ${num(s.converted)} converted, ${fmtMoney(s.cents)}` : ''}
              </div>
              {/* Only called out past 15%: every step loses a few to the ordinary
                  churn of a list, and flagging that as a problem trains the reader
                  to ignore the flag. */}
              {dropFromPrev > 0.15 ? (
                <div class="wf-drop">
                  {pct(dropFromPrev, 0)} fewer people got this than the one before it
                </div>
              ) : null}
            </div>
            <div class="wf-n">
              <b>{num(s.sent)}</b>
              {pct(s.retention, 0)} still here
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** The Signal components, in the same shape the dashboard hero uses. */
export const Components: FC<{ components: Component[] }> = ({ components }) => (
  <div class="sig-parts">
    {components.map((c) => (
      <div class="sig-part">
        <div class="sig-part-h">
          <span class="sig-part-l">{c.label}</span>
          <span class="sig-part-n">{c.score}</span>
        </div>
        <div class="sig-track">
          <div
            class={`sig-fill ${band(c.score).key}`}
            style={`width:${Math.max(c.score, 1.5)}%`}
          />
        </div>
        <div class="sig-part-d">{c.detail}</div>
        <div class="sig-part-w">weight {c.weight}%</div>
      </div>
    ))}
  </div>
)

/** The closing line of a card: what the numbers above it mean you should do. */
export const Take: FC<PropsWithChildren<{ label?: string }>> = ({ label, children }) => (
  <div class="take">
    <em>{label ?? 'So'}</em>
    <div>{children}</div>
  </div>
)

/**
 * The sentence a sequence's numbers add up to.
 *
 * Reads off the *shape* of the components rather than the total, for the same
 * reason the broadcast verdict does: a 51 built from a great open rate and a
 * dead body is a completely different problem from three mediocre thirds, and
 * the two want opposite fixes.
 */
export function sequenceVerdict(s: SequencePerf): string {
  if (s.reached === 0) return 'Nobody has been through this one yet.'
  if (!s.isActive && s.enrollment.active > 0)
    return `Switched off with ${num(s.enrollment.active)} people still mid-way through it.`
  // Money first when there is any: it is the least ambiguous thing a sequence
  // can be said to have done.
  if ((s.converted ?? 0) > 0)
    return `${num(s.converted ?? 0)} conversions and ${fmtMoney(s.convertedCents)} credited to this sequence.`
  // Then cost, but only past 3% — every sequence loses a few, and flagging the
  // ordinary rate as a problem trains the reader to ignore the flag.
  if (s.rates.unsub > 0.03)
    return `${pct(s.rates.unsub)} of the people it reached left — ${num(s.unsubscribed)} of them.`
  if (s.completionRate !== null && s.completionRate < 0.5 && s.enrollment.total > 20)
    return 'Under half finish it. The drop-off is where the money is.'
  if (s.rates.ctor >= 0.2) return `Unusually persuasive — ${pct(s.rates.ctor)} of readers click.`
  if (s.rates.ctor >= 0.1) return 'Readers act on this one. It is doing its job.'
  if (s.rates.open >= 0.5) return 'Opened widely, acted on rarely — the ask is the weak part.'
  return 'Steady. Nothing broken, nothing remarkable.'
}
