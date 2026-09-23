import type { FC } from 'hono/jsx'

/**
 * Charts.
 *
 * Rendered by ApexCharts in the browser, configured entirely on the server: a
 * chart is a `<div>` carrying a compact JSON payload, and `/charts.js` turns
 * every one of them into a drawing on load. Nothing about the chart's shape is
 * decided client-side, so the page is still a document — view-source tells you
 * the numbers, and the payload is the whole contract.
 *
 * The bundle is ~130KB gzipped, so `Layout` only links it on the screens that
 * actually plot something (`charts` prop). Every chart is also backed by a real
 * table on the same card, so no value is reachable only by pointing at it.
 *
 * Colour comes from the data-viz ramp below, never from the interface accent —
 * a bar that looks clickable isn't. Text never wears a data colour; identity
 * comes from the swatch beside the label.
 */

/** Ordinal ramp, light→dark. Reads as one hue family travelling into depth. */
export const RAMP = ['#a5f3fc', '#38bdf8', '#6366f1', '#8b5cf6'] as const
/** Single-hue sequential, for one-series magnitude. */
export const HUE = '#38bdf8'

export interface Column {
  label: string
  /** Shown in the tooltip above the value. */
  caption?: string
  value: number
}

/** The payload every chart ships to the client. Small, flat, JSON-safe. */
type ChartSpec =
  | {
      t: 'column'
      labels: string[]
      captions: string[]
      values: number[]
      height: number
      fmt: 'money' | 'number'
    }
  | {
      t: 'donut'
      labels: string[]
      values: number[]
      size: number
      center: [string, string]
    }
  | { t: 'spark'; values: number[]; height: number; fmt: 'money' | 'number' }
  | {
      t: 'traffic'
      labels: string[]
      captions: string[]
      views: number[]
      visitors: number[]
      opens: number[]
      clicks: number[]
      /** Index into `labels` of each day a broadcast went out, and what it was. */
      sends: { i: number; subject: string }[]
      height: number
    }

/**
 * The mount point. Height is reserved up front so the card doesn't jolt when
 * the drawing lands, and the placeholder shimmer inside it is what a reader
 * sees for the ~200ms before it does.
 */
const Mount: FC<{ spec: ChartSpec; height: number; label: string; style?: string }> = ({
  spec,
  height,
  label,
  style,
}) => (
  <div
    class="chart"
    role="img"
    aria-label={label}
    data-chart={JSON.stringify(spec)}
    style={`height:${height}px;${style ?? ''}`}
  >
    <div class="chart-wait" aria-hidden="true" />
  </div>
)

/**
 * Columns over time. One series, so no legend — the card title says what it is.
 *
 * Bars are capped so a twelve-point series doesn't turn into slabs, the fill
 * runs light at the data end into the water at the baseline, and hovering lifts
 * the neighbours out of the way rather than dropping a crosshair on them.
 */
export const ColumnChart: FC<{
  data: Column[]
  height?: number
  format?: 'money' | 'number'
}> = ({ data, height = 280, format = 'money' }) => (
  <Mount
    height={height}
    label="Revenue by month"
    spec={{
      t: 'column',
      labels: data.map((d) => d.label),
      captions: data.map((d) => d.caption ?? d.label),
      values: data.map((d) => d.value),
      height,
      fmt: format,
    }}
  />
)

export interface Slice {
  label: string
  value: number
}

/**
 * Part-to-whole at a glance. Ordered tiers, so the ramp is ordinal (one hue
 * family, light→dark) rather than categorical — these categories have an order,
 * and four unrelated hues would hide it.
 *
 * Kept to four segments; past six a donut stops being readable and wants a bar.
 */
export const Donut: FC<{
  slices: Slice[]
  centerValue: string
  centerLabel: string
  size?: number
}> = ({ slices, centerValue, centerLabel, size = 236 }) => (
  <Mount
    height={size}
    label={centerLabel}
    style={`width:${size}px;flex:0 0 auto`}
    spec={{
      t: 'donut',
      labels: slices.map((s) => s.label),
      values: slices.map((s) => s.value),
      size,
      center: [centerValue, centerLabel],
    }}
  />
)

/** A trend line small enough to live inside a stat tile. No axes, no grid. */
export const Sparkline: FC<{
  values: number[]
  height?: number
  format?: 'money' | 'number'
}> = ({ values, height = 46, format = 'money' }) => (
  <Mount
    height={height}
    label="Trend"
    style="margin:6px -6px -8px"
    spec={{ t: 'spark', values, height, fmt: format }}
  />
)

/** The legend — always present, because identity must never be colour alone. */
export const Swatch: FC<{ index: number }> = ({ index }) => (
  <span
    style={`display:inline-block;width:9px;height:9px;border-radius:3px;flex:0 0 auto;background:${RAMP[index % RAMP.length]};box-shadow:0 0 10px -1px ${RAMP[index % RAMP.length]}`}
    aria-hidden="true"
  />
)

/**
 * A single horizontal bar for use inside a table row — magnitude beside the
 * number it belongs to, rather than a second chart the reader has to reconcile.
 * Pure CSS: a thousand of these as chart instances would be absurd.
 */
export const BarRow: FC<{ value: number; max: number; tint?: string }> = ({ value, max, tint }) => {
  const pct = max > 0 ? Math.max(1, Math.min(100, Math.round((value / max) * 100))) : 0
  return (
    <div class="meter" aria-hidden="true">
      <i style={`width:${pct}%${tint ? `;background:${tint}` : ''}`} />
    </div>
  )
}

export interface TrafficPoint {
  label: string
  caption: string
  views: number
  visitors: number
  opens: number
  clicks: number
}

/**
 * The buzz chart: the site and the list on one timeline.
 *
 * Web views and visitors are areas on the left axis; email opens are a dashed
 * line on their own right axis, because a send day's opens outnumber a normal
 * day's page views by an order of magnitude and would flatten them to the floor
 * on a shared scale. Each send is a marker on the axis, so the eye can walk from
 * "the mail went out" to "the site got busy" without being told to.
 */
export const TrafficChart: FC<{
  data: TrafficPoint[]
  sends: { i: number; subject: string }[]
  height?: number
}> = ({ data, sends, height = 300 }) => (
  <Mount
    height={height}
    label="Site views, visitors and email opens per day"
    spec={{
      t: 'traffic',
      labels: data.map((d) => d.label),
      captions: data.map((d) => d.caption),
      views: data.map((d) => d.views),
      visitors: data.map((d) => d.visitors),
      opens: data.map((d) => d.opens),
      clicks: data.map((d) => d.clicks),
      sends,
      height,
    }}
  />
)
