/**
 * ⭐ A sequence's send-time window: "only between 08:00 and 18:00, my time"
 * (Kōlea SPEC 12.1.2).
 *
 * Pure. A window is two minutes-after-local-midnight, start inclusive and end
 * exclusive, read in the operator's one install-wide time zone. A start after
 * the end wraps past midnight (22:00–06:00). No window is always open, which is
 * how every sequence behaved before this existed.
 *
 * Time zones go through `Intl.DateTimeFormat`, which workerd ships with full ICU
 * data, so daylight saving is the platform's problem and not a table in here.
 */

export interface SendWindow {
  /** Minutes after local midnight, 0–1439. Inclusive. */
  start: number
  /** Minutes after local midnight, 0–1439. Exclusive. Never equal to `start`. */
  end: number
}

export const DEFAULT_TIME_ZONE = 'UTC'

const MINUTE_MS = 60_000
const DAY_MINUTES = 24 * 60

/** "08:30" → 510. Blank → null. Anything else → 'invalid'. */
export function parseClock(text: string | null | undefined): number | null | 'invalid' {
  const t = (text ?? '').trim()
  if (!t) return null
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t)
  if (!m) return 'invalid'
  return Number(m[1]) * 60 + Number(m[2])
}

/** 510 → "08:30". */
export function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

/**
 * Check a window before it is stored: both ends or neither, each a real minute
 * of the day, and not the same minute (which would be a window that is never,
 * or always, open — say which you mean by clearing it instead).
 */
export function checkWindow(
  start: number | null,
  end: number | null,
): { ok: true; window: SendWindow | null } | { ok: false; reason: string } {
  if (start === null && end === null) return { ok: true, window: null }
  if (start === null || end === null) {
    return { ok: false, reason: 'a send window needs both a start and an end, as HH:MM' }
  }
  const real = (n: number) => Number.isInteger(n) && n >= 0 && n < DAY_MINUTES
  if (!real(start) || !real(end)) return { ok: false, reason: 'send window times must be HH:MM, 00:00 to 23:59' }
  if (start === end) return { ok: false, reason: 'the send window’s end must differ from its start' }
  return { ok: true, window: { start, end } }
}

/** Whether a name is a time zone this runtime knows (`Pacific/Honolulu`, `UTC`). */
export function isTimeZone(zone: string): boolean {
  if (!zone.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** Every zone the runtime knows, UTC first, for a picker. */
export function timeZones(): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return [DEFAULT_TIME_ZONE, ...all.filter((z) => z !== DEFAULT_TIME_ZONE)]
}

/** Whether the window is open at `minute` after local midnight. */
export function windowOpenAt(window: SendWindow | null, minute: number): boolean {
  if (!window) return true
  const { start, end } = window
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/** Whether the window is open at instant `at`, read in `zone`. */
export function windowOpen(window: SendWindow | null, at: Date, zone: string): boolean {
  if (!window) return true
  const p = zonedParts(at.getTime(), zone)
  return windowOpenAt(window, p.hour * 60 + p.minute)
}

/**
 * The first instant at or after `now` when the window is open.
 *
 * `now` itself when it is already open. Otherwise the window's start on today's
 * or tomorrow's local date, converted back to an instant through the zone's real
 * offset on that date — so a window that opens at 08:00 opens at 08:00 local on
 * both sides of a daylight-saving change. A start that falls inside a
 * spring-forward gap (02:30 on the night clocks jump 02:00 → 03:00) lands on the
 * first open minute after the gap.
 */
export function nextWindowOpen(window: SendWindow | null, now: Date, zone: string): Date {
  if (windowOpen(window, now, zone) || !window) return now
  const today = zonedParts(now.getTime(), zone)
  for (let day = 0; day <= 2; day++) {
    let t = localToInstant(today.year, today.month, today.day + day, window.start, zone)
    if (t <= now.getTime()) continue
    // A gap: the local start minute does not exist that day. Step forward until
    // the window really is open; a gap is an hour at most (30 minutes in a few zones).
    for (let i = 0; i < 8 && !windowOpen(window, new Date(t), zone); i++) t += 15 * MINUTE_MS
    return new Date(t)
  }
  // Unreachable for a valid window: some start in the next three local days is
  // always in the future. Wait a day rather than send outside the window.
  return new Date(now.getTime() + DAY_MINUTES * MINUTE_MS)
}

interface Parts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function zonedParts(ms: number, zone: string): Parts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(ms))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
}

/** The zone's offset from UTC at instant `ms`, in ms (Honolulu: −10 h). */
function offsetAt(ms: number, zone: string): number {
  const p = zonedParts(ms, zone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  return asUtc - Math.floor(ms / MINUTE_MS) * MINUTE_MS
}

/** Local wall-clock (day may overflow; Date.UTC normalises it) → instant. */
function localToInstant(year: number, month: number, day: number, minuteOfDay: number, zone: string): number {
  const wall = Date.UTC(year, month - 1, day, 0, minuteOfDay)
  // Two passes: the first guess uses the offset at the wrong instant when a
  // transition sits between them; the second corrects it.
  let t = wall - offsetAt(wall, zone)
  t = wall - offsetAt(t, zone)
  return t
}
