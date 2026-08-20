import type { FC } from 'hono/jsx'

/**
 * Charts, as server-rendered SVG.
 *
 * No charting library and no client script — the admin ships zero JS outside the
 * two compose screens, and a dashboard is not worth breaking that for. Hover
 * tooltips are native SVG `<title>` elements, which cost nothing and work with
 * the keyboard and screen readers; every chart is also backed by a real table on
 * the page, so no value is reachable only by pointing at it.
 *
 * Colours come from the validated data-viz palette (blue ramp), not from the
 * app's accent: the accent means "interactive" everywhere else in this UI, and a
 * bar that looks clickable isn't. Text never wears a data colour — identity
 * comes from the swatch beside the label.
 */

/** Ordinal ramp, light→dark. Light end clears the surface at 2.11:1. */
export const RAMP = ['#86b6ef', '#3987e5', '#256abf', '#104281'] as const
/** Single-hue sequential, for one-series magnitude. */
export const HUE = '#2a78d6'
const GRID = '#e8e5e0'
const SURFACE = '#ffffff'

const money = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString('en-US')}`

/** Axis ticks rounded to something a person would have picked. */
function niceTicks(max: number, count = 3): number[] {
  if (max <= 0) return [0]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10
  const out: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v)
  return out
}

export interface Column {
  label: string
  /** Shown in the tooltip above the value. */
  caption?: string
  value: number
}

/**
 * Columns over time. One series, so no legend — the card title says what it is.
 *
 * Bars are capped at 24px however wide the band gets, the tallest is labelled
 * directly, and everything else is carried by the axis and the tooltip. A number
 * on every column would be chaos and would go unread.
 */
export const ColumnChart: FC<{
  data: Column[]
  height?: number
  format?: (n: number) => string
}> = ({ data, height = 230, format = money }) => {
  // The viewBox is sized close to the width this actually renders at (a card in
  // the 1080px shell), so the drawing scales ~1:1. At a much smaller viewBox the
  // whole thing is magnified — bars sail past the 24px cap and 11px axis text
  // lands at 15px, which is how a chart ends up looking chunky for no reason.
  const W = 1000
  const padL = 54
  const padR = 12
  const padT = 16
  const padB = 26
  const plotW = W - padL - padR
  const plotH = height - padT - padB

  const max = Math.max(1, ...data.map((d) => d.value))
  const ticks = niceTicks(max)
  const top = Math.max(max, ticks[ticks.length - 1] ?? max)
  const y = (v: number) => padT + plotH - (v / top) * plotH

  const band = plotW / Math.max(1, data.length)
  // 2px of surface between neighbours, and never a bar fatter than 24px.
  const barW = Math.max(4, Math.min(24, band - 2))
  const peak = data.reduce((a, b) => (b.value > a.value ? b : a), data[0] ?? { value: 0, label: '' })

  // No `height` attribute below, on purpose: with both width:100% and a fixed
  // height, the default `xMidYMid meet` scales the drawing to the *height* and
  // centres it, letterboxing the chart inside its own card. Letting the viewBox
  // set the aspect ratio makes it fill the width instead.
  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      width="100%"
      role="img"
      aria-label="Revenue by month"
      style="display:block;height:auto;overflow:visible"
    >
      {ticks.map((t) => (
        <>
          <line
            x1={String(padL)}
            x2={String(W - padR)}
            y1={String(y(t))}
            y2={String(y(t))}
            stroke={GRID}
            stroke-width="1"
          />
          <text
            x={String(padL - 10)}
            y={String(y(t) + 4)}
            text-anchor="end"
            font-size="11"
            fill="#9aa0a8"
            style="font-variant-numeric:tabular-nums"
          >
            {format(t)}
          </text>
        </>
      ))}

      {data.map((d, i) => {
        const cx = padL + band * i + band / 2
        const x = cx - barW / 2
        const top0 = y(d.value)
        const h = Math.max(0, padT + plotH - top0)
        const r = Math.min(4, barW / 2, h)
        // Rounded at the data end, square at the baseline — the baseline is a
        // real zero and a rounded foot would lift the bar off it.
        const path =
          h <= 0
            ? ''
            : `M${x},${padT + plotH} L${x},${top0 + r} Q${x},${top0} ${x + r},${top0} ` +
              `L${x + barW - r},${top0} Q${x + barW},${top0} ${x + barW},${top0 + r} ` +
              `L${x + barW},${padT + plotH} Z`

        return (
          <>
            {h > 0 ? (
              <path d={path} fill={HUE}>
                <title>{`${d.caption ?? d.label}: ${format(d.value)}`}</title>
              </path>
            ) : null}
            <text
              x={String(cx)}
              y={String(height - 8)}
              text-anchor="middle"
              font-size="11"
              fill="#9aa0a8"
            >
              {d.label}
            </text>
            {d === peak && d.value > 0 ? (
              <text
                x={String(cx)}
                y={String(top0 - 6)}
                text-anchor="middle"
                font-size="11"
                font-weight="600"
                fill="#1a1d21"
                style="font-variant-numeric:tabular-nums"
              >
                {format(d.value)}
              </text>
            ) : null}
          </>
        )
      })}

      <line
        x1={String(padL)}
        x2={String(W - padR)}
        y1={String(padT + plotH)}
        y2={String(padT + plotH)}
        stroke="#d8d4cd"
        stroke-width="1"
      />
    </svg>
  )
}

export interface Slice {
  label: string
  value: number
}

function arc(cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number) {
  const p = (r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  const [x0, y0] = p(rOuter, a0)
  const [x1, y1] = p(rOuter, a1)
  const [x2, y2] = p(rInner, a1)
  const [x3, y3] = p(rInner, a0)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return (
    `M${x0},${y0} A${rOuter},${rOuter} 0 ${large} 1 ${x1},${y1} ` +
    `L${x2},${y2} A${rInner},${rInner} 0 ${large} 0 ${x3},${y3} Z`
  )
}

/**
 * Part-to-whole at a glance. Ordered tiers, so the ramp is ordinal (one hue,
 * light→dark) rather than categorical — these categories have an order, and
 * eight unrelated hues would hide that.
 *
 * Segments are separated by a 2px surface gap rather than a stroke: a border
 * around a mark is ink that isn't data. Kept to four segments; past six a donut
 * stops being readable and wants a bar instead.
 */
export const Donut: FC<{
  slices: Slice[]
  centerValue: string
  centerLabel: string
  size?: number
}> = ({ slices, centerValue, centerLabel, size = 190 }) => {
  const total = slices.reduce((n, s) => n + s.value, 0) || 1
  const cx = size / 2
  const cy = size / 2
  const rOuter = size / 2 - 2
  const rInner = rOuter * 0.62
  // 2px of surface between neighbours, expressed as an angle at the outer edge.
  const gap = 2 / rOuter

  let a = -Math.PI / 2
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={String(size)}
      height={String(size)}
      role="img"
      aria-label={centerLabel}
      style="display:block;flex:0 0 auto"
    >
      {slices.map((s, i) => {
        const sweep = (s.value / total) * Math.PI * 2
        const a0 = a + gap / 2
        const a1 = a + sweep - gap / 2
        a += sweep
        if (a1 <= a0) return null
        return (
          <path d={arc(cx, cy, rOuter, rInner, a0, a1)} fill={RAMP[i % RAMP.length]}>
            <title>{`${s.label}: ${s.value.toLocaleString('en-US')} (${Math.round((s.value / total) * 100)}%)`}</title>
          </path>
        )
      })}
      <text
        x={String(cx)}
        y={String(cy - 2)}
        text-anchor="middle"
        font-size="21"
        font-weight="600"
        fill="#1a1d21"
        style="font-variant-numeric:tabular-nums"
      >
        {centerValue}
      </text>
      <text x={String(cx)} y={String(cy + 15)} text-anchor="middle" font-size="11" fill="#9aa0a8">
        {centerLabel}
      </text>
    </svg>
  )
}

/** The legend — always present, because identity must never be colour alone. */
export const Swatch: FC<{ index: number }> = ({ index }) => (
  <span
    style={`display:inline-block;width:10px;height:10px;border-radius:2px;background:${RAMP[index % RAMP.length]};flex:0 0 auto`}
    aria-hidden="true"
  />
)

/**
 * A single horizontal bar for use inside a table row — magnitude beside the
 * number it belongs to, rather than a second chart the reader has to reconcile.
 */
export const BarRow: FC<{ value: number; max: number; tint?: string }> = ({
  value,
  max,
  tint = HUE,
}) => {
  const pct = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0
  return (
    <div
      style={`height:6px;background:${GRID};border-radius:3px;overflow:hidden;margin-top:6px`}
      aria-hidden="true"
    >
      <div
        style={`height:100%;width:${pct}%;background:${tint};border-radius:0 3px 3px 0;box-shadow:0 0 0 0 ${SURFACE}`}
      />
    </div>
  )
}
