import type { FC } from 'hono/jsx'
import type { TrafficReport } from '../core/traffic.ts'
import { BarRow, TrafficChart } from './charts.tsx'

/**
 * ⭐ Buzz — the top of the dashboard.
 *
 * "How loud is it out there?" in one card: the site's reads per day, the list's
 * opens on the same timeline with every send marked on it, then what was read
 * and who sent the readers. The point of putting both on one chart is the
 * crossing — a send goes out and you can watch the site get busy behind it.
 *
 * Kept deliberately shallow. Anything deeper belongs in a real analytics tool;
 * this is the glance you take before anything else.
 */

const num = (n: number) => Math.round(n).toLocaleString('en-US')

/** Series colours, mirrored from `client/charts.ts`. */
const C = { views: '#22d3ee', visitors: '#818cf8', opens: '#f0abfc' }

export const RANGES = [7, 30, 90] as const

function delta(now: number, before: number): { text: string; up: boolean } | null {
  if (before <= 0) return null
  const d = Math.round(((now - before) / before) * 100)
  return { text: `${d >= 0 ? '▲' : '▼'} ${Math.abs(d)}%`, up: d >= 0 }
}

function duration(s: number | null): string {
  if (s == null) return '—'
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dayLabel(day: string): { label: string; caption: string } {
  const d = new Date(`${day}T00:00:00Z`)
  const label = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  return { label, caption: `${WEEKDAYS[d.getUTCDay()]}, ${label}` }
}

/** 🇺🇸 from `US`: two regional-indicator letters. */
function flag(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return '🌐'
  return String.fromCodePoint(...[...code].map((ch) => 0x1f1a5 + ch.charCodeAt(0)))
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** The sentence under the eyebrow: the number, and whether it's moving. */
function headline(r: TrafficReport): string {
  const t = r.totals
  const d = delta(t.views, t.prevViews)
  const base = `${num(t.views)} ${t.views === 1 ? 'read' : 'reads'} on the site`
  if (!d) return `${base}.`
  return `${base}, ${d.up ? 'up' : 'down'} ${d.text.slice(2)} on the ${r.days} days before.`
}

const Stat: FC<{ n: string; l: string; hint?: string; tint?: string; hi?: boolean; d?: ReturnType<typeof delta> }> = ({
  n,
  l,
  hint,
  tint,
  hi,
  d,
}) => (
  <div class={`stat${hi ? ' hi' : ''}`}>
    <div class="n">
      {n}
      {d ? <span class={`tr-delta ${d.up ? 'up' : 'down'}`}>{d.text}</span> : null}
    </div>
    <div class="l">
      {tint ? <i class="tr-key" style={`background:${tint}`} /> : null}
      {l}
    </div>
    {hint ? <div class="h">{hint}</div> : null}
  </div>
)

export const TrafficHero: FC<{ report: TrafficReport; siteUrl?: string }> = ({ report: r, siteUrl }) => {
  const origin = (siteUrl ?? '').replace(/\/$/, '')
  const t = r.totals
  const sends = r.series.flatMap((d, i) =>
    r.sends.filter((s) => s.day === d.day).map((s) => ({ i, subject: s.subject })),
  )
  const topMax = Math.max(1, ...r.top.map((p) => p.views))
  const refMax = Math.max(1, ...r.referrers.map((x) => x.views))
  const geoMax = Math.max(1, ...r.countries.map((x) => x.views))

  return (
    <div class="card tr-card">
      <div class="card-b">
        <div class="tr-top">
          <div>
            <div class="eyebrow">Buzz · last {r.days} days</div>
            <h2 class="tr-headline">
              {siteUrl ? (t.views ? headline(r) : 'Counting starts with the next reader.') : 'No public site yet.'}
            </h2>
          </div>
          <div class="tr-side">
            <div class={`tr-live${r.live.views ? ' on' : ''}`} title="Page views in the last 30 minutes">
              <span class="tr-pulse" aria-hidden="true" />
              {r.live.visitors
                ? `${num(r.live.visitors)} ${r.live.visitors === 1 ? 'person' : 'people'} reading now`
                : 'Quiet right now'}
            </div>
            <nav class="tr-range" aria-label="Range">
              {RANGES.map((d) => (
                <a href={`/?range=${d}`} class={d === r.days ? 'on' : ''} aria-current={d === r.days ? 'true' : undefined}>
                  {d}d
                </a>
              ))}
            </nav>
          </div>
        </div>

        <div class="stats tr-stats">
          <Stat n={num(t.views)} l="Page views" tint={C.views} hi d={delta(t.views, t.prevViews)} />
          <Stat n={num(t.visitors)} l="Visitors" tint={C.visitors} d={delta(t.visitors, t.prevVisitors)} />
          <Stat n={duration(t.avgSeconds)} l="Avg time on page" />
          <Stat n={num(t.opens)} l="Email opens" tint={C.opens} />
          <Stat
            n={num(t.clicksToSite)}
            l="Email → site"
            hint={t.clicks ? `of ${num(t.clicks)} email clicks` : undefined}
          />
        </div>

        <div class="tr-chart">
          <TrafficChart
            data={r.series.map((d) => ({ ...dayLabel(d.day), views: d.views, visitors: d.visitors, opens: d.opens, clicks: d.clicks }))}
            sends={sends}
          />
          <div class="tr-legend">
            <span><i style={`background:${C.views}`} />Page views</span>
            <span><i style={`background:${C.visitors}`} />Visitors</span>
            <span><i class="dash" style={`background:${C.opens}`} />Email opens</span>
            <span><b>✉</b>A send went out</span>
          </div>
        </div>

        <div class="tr-cols">
          <section>
            <h3 class="tr-h">Top content</h3>
            {r.top.length === 0 ? (
              <p class="faint">Nothing read yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Piece</th>
                    <th class="num">Web</th>
                    <th class="num" title="People who opened the mailed version, all time">Email</th>
                    <th class="num">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {r.top.map((p) => (
                    <tr>
                      <td class="tr-title">
                        {origin ? (
                          <a href={`${origin}${p.path}`} target="_blank" rel="noopener">
                            {p.title}
                          </a>
                        ) : (
                          p.title
                        )}
                        <BarRow value={p.views} max={topMax} />
                      </td>
                      <td class="num">{num(p.views)}</td>
                      <td class="num">{p.emailReads == null ? '—' : num(p.emailReads)}</td>
                      <td class="num faint">{duration(p.avgSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3 class="tr-h">Where they came from</h3>
            {r.referrers.length === 0 ? (
              <p class="faint">No referrers yet.</p>
            ) : (
              <ul class="tr-list">
                {r.referrers.map((x) => (
                  <li>
                    <div class="tr-row">
                      <span class="tr-name">{x.label}</span>
                      <span class="tr-n">{num(x.views)}</span>
                    </div>
                    {x.topUrl ? (
                      <a class="tr-url" href={x.topUrl} target="_blank" rel="noopener noreferrer">
                        {x.topUrl.replace(/^https?:\/\/(www\.)?/, '')}
                      </a>
                    ) : null}
                    <BarRow value={x.views} max={refMax} tint="linear-gradient(90deg,#818cf8,#a855f7)" />
                  </li>
                ))}
              </ul>
            )}
            {r.countries.length ? (
              <>
                <h3 class="tr-h" style="margin-top:28px">Countries</h3>
                <ul class="tr-list">
                  {r.countries.map((x) => (
                    <li>
                      <div class="tr-row">
                        <span class="tr-name">
                          {flag(x.code)} {countryName(x.code)}
                        </span>
                        <span class="tr-n">{num(x.views)}</span>
                      </div>
                      <BarRow value={x.views} max={geoMax} tint="linear-gradient(90deg,#5eead4,#22d3ee)" />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  )
}
