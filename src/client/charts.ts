/**
 * The chart runtime.
 *
 * Every `<div class="chart" data-chart="...">` on the page is a fully-specified
 * drawing waiting for a renderer. This file is that renderer: it reads the
 * payload the server wrote, turns it into ApexCharts options, and gets out of
 * the way. No data fetching, no state, no re-render — reload the page and the
 * numbers are new.
 *
 * Loaded only on screens that plot something (`Layout`'s `charts` prop).
 */
import ApexCharts from 'apexcharts'

type Fmt = 'money' | 'number'

type Spec =
  | { t: 'column'; labels: string[]; captions: string[]; values: number[]; height: number; fmt: Fmt }
  | { t: 'donut'; labels: string[]; values: number[]; size: number; center: [string, string] }
  | { t: 'spark'; values: number[]; height: number; fmt: Fmt }
  | {
      t: 'traffic'
      labels: string[]
      captions: string[]
      views: number[]
      visitors: number[]
      opens: number[]
      clicks: number[]
      sends: { i: number; subject: string }[]
      height: number
    }

/** The ordinal ramp, mirrored from `src/web/charts.tsx`. Light → deep. */
const RAMP = ['#a5f3fc', '#38bdf8', '#6366f1', '#8b5cf6']
const INK = '#eaf3ff'
const FAINT = '#6d84a8'
const GRID = 'rgba(148,190,255,.10)'
const SANS = "'Inter',ui-sans-serif,system-ui,Helvetica,sans-serif"
const DISPLAY = SANS

const nf = new Intl.NumberFormat('en-US')
const money = (cents: number) => `$${nf.format(Math.round(cents / 100))}`
const fmtOf = (f: Fmt) => (f === 'money' ? money : (n: number) => nf.format(Math.round(n)))

/** Shared chrome: no toolbar, transparent ground, and motion with some weight. */
const chrome = (height: number) => ({
  background: 'transparent',
  fontFamily: SANS,
  foreColor: FAINT,
  height,
  toolbar: { show: false },
  zoom: { enabled: false },
  parentHeightOffset: 0,
  animations: {
    enabled: true,
    speed: 900,
    easing: 'easeinout' as const,
    animateGradually: { enabled: true, delay: 70 },
    dynamicAnimation: { enabled: false },
  },
})

/** The tooltip, rebuilt by hand — Apex's default is a white box with a border. */
function tip(title: string, value: string, colour: string) {
  return (
    `<div class="apexcharts-tooltip-title">${title}</div>` +
    `<div class="ct-row"><span class="ct-dot" style="background:${colour}"></span>` +
    `<span class="ct-val">${value}</span></div>`
  )
}

function columnOptions(s: Spec & { t: 'column' }, width: number) {
  const fmt = fmtOf(s.fmt)
  const peak = Math.max(...s.values, 0)
  // Apex only takes a percentage of the band, so on a full-bleed layout twelve
  // months turn into 70px slabs. Measure the band and ask for whatever
  // percentage lands a 34px column, which is a column and not a wall.
  const band = Math.max(1, (width - 70) / Math.max(1, s.values.length))
  const columnWidth = `${Math.round(Math.max(12, Math.min(60, (34 / band) * 100)))}%`
  return {
    chart: { ...chrome(s.height), type: 'bar' as const },
    series: [{ name: 'Revenue', data: s.values }],
    plotOptions: {
      bar: {
        columnWidth,
        borderRadius: 7,
        borderRadiusApplication: 'end' as const,
      },
    },
    colors: ['#67e8f9'],
    fill: {
      type: 'gradient',
      gradient: {
        type: 'vertical',
        shadeIntensity: 0,
        gradientToColors: ['#7c3aed'],
        inverseColors: false,
        opacityFrom: 1,
        opacityTo: 0.72,
        stops: [0, 100],
      },
    },
    stroke: { width: 0 },
    dataLabels: { enabled: false },
    grid: {
      borderColor: GRID,
      strokeDashArray: 4,
      xaxis: { lines: { show: false } },
      padding: { left: 4, right: 4, top: -8, bottom: -6 },
    },
    xaxis: {
      categories: s.labels,
      axisBorder: { show: false },
      axisTicks: { show: false },
      crosshairs: { show: false },
      tooltip: { enabled: false },
      labels: { style: { colors: FAINT, fontSize: '11px', fontWeight: 600, fontFamily: DISPLAY } },
    },
    yaxis: {
      tickAmount: 4,
      max: peak > 0 ? undefined : 1,
      labels: {
        formatter: (v: number) => fmt(v),
        style: { colors: FAINT, fontSize: '11px', fontFamily: DISPLAY },
      },
    },
    states: {
      hover: { filter: { type: 'lighten', value: 0.18 } },
      active: { filter: { type: 'none' } },
    },
    tooltip: {
      custom: ({ dataPointIndex }: { dataPointIndex: number }) =>
        tip(s.captions[dataPointIndex] ?? '', fmt(s.values[dataPointIndex] ?? 0), '#67e8f9'),
    },
  }
}

function donutOptions(s: Spec & { t: 'donut' }) {
  const total = s.values.reduce((a, b) => a + b, 0) || 1
  return {
    chart: {
      ...chrome(s.size),
      type: 'donut' as const,
      width: s.size,
      dropShadow: { enabled: true, top: 0, left: 0, blur: 18, color: '#38bdf8', opacity: 0.28 },
    },
    series: s.values,
    labels: s.labels,
    colors: RAMP,
    // A 2px gap of water between neighbours instead of a stroke: a border around
    // a mark is ink that isn't data.
    stroke: { width: 2, colors: ['rgba(6,14,36,.9)'] },
    // Each slice keeps its own identity and gains depth by falling toward a
    // darker version of itself — not by being washed toward a shared light,
    // which is what a plain shadeIntensity does and it flattens the ordering.
    fill: {
      type: 'gradient',
      gradient: {
        type: 'vertical',
        shadeIntensity: 0,
        gradientToColors: ['#22d3ee', '#1d4ed8', '#4338ca', '#6d28d9'],
        inverseColors: false,
        opacityFrom: 1,
        opacityTo: 1,
        stops: [0, 100],
      },
    },
    dataLabels: { enabled: false },
    legend: { show: false },
    plotOptions: {
      pie: {
        expandOnClick: false,
        donut: {
          size: '72%',
          labels: {
            show: true,
            name: {
              show: true,
              offsetY: -4,
              color: FAINT,
              fontSize: '11px',
              fontWeight: 600,
              fontFamily: DISPLAY,
            },
            value: {
              show: true,
              offsetY: 4,
              color: INK,
              fontSize: '26px',
              fontWeight: 600,
              fontFamily: DISPLAY,
              formatter: (v: string) => nf.format(Number(v)),
            },
            total: {
              show: true,
              showAlways: true,
              label: s.center[1],
              color: FAINT,
              fontSize: '11px',
              fontWeight: 600,
              fontFamily: DISPLAY,
              formatter: () => s.center[0],
            },
          },
        },
      },
    },
    states: {
      hover: { filter: { type: 'lighten', value: 0.14 } },
      active: { filter: { type: 'none' } },
    },
    tooltip: {
      custom: ({ seriesIndex }: { seriesIndex: number }) => {
        const v = s.values[seriesIndex] ?? 0
        return tip(
          s.labels[seriesIndex] ?? '',
          `${nf.format(v)} · ${Math.round((v / total) * 100)}%`,
          RAMP[seriesIndex % RAMP.length] ?? '#38bdf8',
        )
      },
    },
  }
}

function sparkOptions(s: Spec & { t: 'spark' }) {
  const fmt = fmtOf(s.fmt)
  return {
    chart: {
      ...chrome(s.height),
      type: 'area' as const,
      sparkline: { enabled: true },
      dropShadow: { enabled: true, top: 1, left: 0, blur: 6, color: '#38bdf8', opacity: 0.55 },
    },
    series: [{ name: 'Trend', data: s.values }],
    colors: ['#38bdf8'],
    stroke: { curve: 'smooth' as const, width: 2 },
    fill: {
      type: 'gradient',
      gradient: {
        type: 'vertical',
        shadeIntensity: 0,
        gradientToColors: ['#8b5cf6'],
        inverseColors: false,
        opacityFrom: 0.55,
        opacityTo: 0,
        stops: [0, 100],
      },
    },
    markers: { size: 0, hover: { size: 4 } },
    tooltip: {
      custom: ({ dataPointIndex }: { dataPointIndex: number }) =>
        tip('', fmt(s.values[dataPointIndex] ?? 0), '#38bdf8'),
    },
  }
}

const esc = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** Views, visitors, opens: the series colours, mirrored in `web/admin-traffic.tsx`. */
const TRAFFIC = ['#22d3ee', '#818cf8', '#f0abfc']

function trafficOptions(s: Spec & { t: 'traffic' }) {
  const sentOn = new Map<number, string[]>()
  for (const x of s.sends) sentOn.set(x.i, [...(sentOn.get(x.i) ?? []), x.subject])
  const row = (colour: string, label: string, v: number, dashed = false) =>
    `<div class="ct-row" style="padding:5px 14px"><span class="ct-dot" style="background:${colour}${dashed ? ';border-radius:1px;height:3px' : ''}"></span>` +
    `<span style="color:${FAINT};font-weight:500;min-width:92px">${label}</span><span class="ct-val">${nf.format(v)}</span></div>`

  return {
    chart: {
      ...chrome(s.height),
      type: 'line' as const,
      dropShadow: { enabled: true, enabledOnSeries: [0], top: 2, left: 0, blur: 10, color: '#22d3ee', opacity: 0.45 },
    },
    series: [
      { name: 'Views', type: 'area', data: s.views },
      { name: 'Visitors', type: 'area', data: s.visitors },
      { name: 'Email opens', type: 'line', data: s.opens },
    ],
    colors: TRAFFIC,
    stroke: { curve: 'smooth' as const, width: [2.6, 1.6, 2], dashArray: [0, 0, 5] },
    fill: {
      type: ['gradient', 'gradient', 'solid'],
      gradient: {
        type: 'vertical',
        shadeIntensity: 0,
        inverseColors: false,
        opacityFrom: 0.5,
        opacityTo: 0.02,
        stops: [0, 96],
      },
    },
    markers: { size: 0, strokeWidth: 0, hover: { size: 5 } },
    dataLabels: { enabled: false },
    legend: { show: false },
    grid: {
      borderColor: GRID,
      strokeDashArray: 4,
      xaxis: { lines: { show: false } },
      padding: { left: 6, right: 6, top: -4, bottom: -4 },
    },
    // A send is a mark on the timeline, not a series: it has no magnitude, only a
    // moment. Violet so it reads as belonging to the email line.
    annotations: {
      xaxis: [...sentOn.keys()].map((i) => ({
        x: s.labels[i],
        borderColor: 'rgba(240,171,252,.45)',
        strokeDashArray: 3,
        label: {
          text: '✉',
          orientation: 'horizontal',
          borderWidth: 0,
          offsetY: -4,
          style: { background: 'transparent', color: '#f0abfc', fontSize: '13px' },
        },
      })),
    },
    xaxis: {
      categories: s.labels,
      tickAmount: Math.min(8, s.labels.length),
      axisBorder: { show: false },
      axisTicks: { show: false },
      crosshairs: { stroke: { color: 'rgba(148,190,255,.25)', width: 1, dashArray: 3 } },
      tooltip: { enabled: false },
      labels: {
        rotate: 0,
        hideOverlappingLabels: true,
        style: { colors: FAINT, fontSize: '11px', fontWeight: 600, fontFamily: DISPLAY },
      },
    },
    yaxis: [
      {
        seriesName: 'Views',
        tickAmount: 4,
        min: 0,
        forceNiceScale: true,
        labels: { formatter: (v: number) => nf.format(Math.round(v)), style: { colors: FAINT, fontSize: '11px' } },
      },
      { seriesName: 'Views', show: false },
      {
        seriesName: 'Email opens',
        opposite: true,
        tickAmount: 4,
        min: 0,
        forceNiceScale: true,
        labels: { formatter: (v: number) => nf.format(Math.round(v)), style: { colors: '#b98bc4', fontSize: '11px' } },
      },
    ],
    tooltip: {
      shared: true,
      intersect: false,
      custom: ({ dataPointIndex: i }: { dataPointIndex: number }) => {
        const sent = sentOn.get(i)
        return (
          `<div class="apexcharts-tooltip-title">${esc(s.captions[i] ?? '')}</div>` +
          `<div style="padding:4px 0 8px">` +
          row(TRAFFIC[0]!, 'Page views', s.views[i] ?? 0) +
          row(TRAFFIC[1]!, 'Visitors', s.visitors[i] ?? 0) +
          row(TRAFFIC[2]!, 'Email opens', s.opens[i] ?? 0, true) +
          row('rgba(148,190,255,.4)', 'Email clicks', s.clicks[i] ?? 0) +
          (sent
            ? `<div style="padding:8px 14px 2px;max-width:280px;font-size:12px;color:#f0abfc;white-space:normal">✉ ${sent.map(esc).join('<br>✉ ')}</div>`
            : '') +
          `</div>`
        )
      },
    },
  }
}

function optionsFor(spec: Spec, width: number) {
  if (spec.t === 'column') return columnOptions(spec, width)
  if (spec.t === 'donut') return donutOptions(spec)
  if (spec.t === 'traffic') return trafficOptions(spec)
  return sparkOptions(spec)
}

function boot() {
  const nodes = document.querySelectorAll<HTMLElement>('[data-chart]')
  for (const el of Array.from(nodes)) {
    const raw = el.dataset.chart
    if (!raw) continue
    let spec: Spec
    try {
      spec = JSON.parse(raw) as Spec
    } catch {
      continue
    }
    // Measured before the placeholder is cleared, while the box still has its
    // reserved height and its final width.
    const width = el.clientWidth || 900
    // The shimmer is a stand-in for the drawing, not part of it.
    el.replaceChildren()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chart = new ApexCharts(el, optionsFor(spec, width) as any)
    void chart.render()
    el.classList.add('is-live')
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
} else {
  boot()
}
