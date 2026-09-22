/**
 * Moment.js format strings, the subset themes use. Ghost's `{{date}}` helper
 * takes moment tokens (`format="D MMM YYYY"`), so a theme written for Ghost
 * carries them — and pulling in moment for fifteen tokens is not a trade worth
 * making. Always UTC: the site has one timezone and it isn't the reader's.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Moment's localized presets, in their `en` spelling. */
const PRESETS: Record<string, string> = {
  L: 'MM/DD/YYYY',
  l: 'M/D/YYYY',
  LL: 'MMMM D, YYYY',
  ll: 'MMM D, YYYY',
  LLL: 'MMMM D, YYYY h:mm A',
  lll: 'MMM D, YYYY h:mm A',
  LLLL: 'dddd, MMMM D, YYYY h:mm A',
  llll: 'ddd, MMM D, YYYY h:mm A',
  LT: 'h:mm A',
  LTS: 'h:mm:ss A',
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function ordinal(n: number): string {
  const s = n % 100
  if (s >= 11 && s <= 13) return `${n}th`
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
  return `${n}${suffix}`
}

const TOKENS = /\[([^\]]*)]|YYYY|YY|MMMM|MMM|MM|Mo|M|DDDD|Do|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a|ZZ|Z|X|x/g

export function formatDate(date: Date, format = 'll'): string {
  const fmt = PRESETS[format] ?? format
  const h = date.getUTCHours()
  return fmt.replace(TOKENS, (tok, literal: string | undefined) => {
    if (literal !== undefined) return literal
    switch (tok) {
      case 'YYYY':
        return String(date.getUTCFullYear())
      case 'YY':
        return String(date.getUTCFullYear()).slice(-2)
      case 'MMMM':
        return MONTHS[date.getUTCMonth()] as string
      case 'MMM':
        return (MONTHS[date.getUTCMonth()] as string).slice(0, 3)
      case 'MM':
        return pad(date.getUTCMonth() + 1)
      case 'Mo':
        return ordinal(date.getUTCMonth() + 1)
      case 'M':
        return String(date.getUTCMonth() + 1)
      case 'Do':
        return ordinal(date.getUTCDate())
      case 'DD':
        return pad(date.getUTCDate())
      case 'D':
        return String(date.getUTCDate())
      case 'DDDD': {
        const start = Date.UTC(date.getUTCFullYear(), 0, 1)
        return pad(Math.floor((date.getTime() - start) / 86_400_000) + 1, 3)
      }
      case 'dddd':
        return DAYS[date.getUTCDay()] as string
      case 'ddd':
        return (DAYS[date.getUTCDay()] as string).slice(0, 3)
      case 'dd':
        return (DAYS[date.getUTCDay()] as string).slice(0, 2)
      case 'd':
        return String(date.getUTCDay())
      case 'HH':
        return pad(h)
      case 'H':
        return String(h)
      case 'hh':
        return pad(h % 12 || 12)
      case 'h':
        return String(h % 12 || 12)
      case 'mm':
        return pad(date.getUTCMinutes())
      case 'm':
        return String(date.getUTCMinutes())
      case 'ss':
        return pad(date.getUTCSeconds())
      case 's':
        return String(date.getUTCSeconds())
      case 'A':
        return h < 12 ? 'AM' : 'PM'
      case 'a':
        return h < 12 ? 'am' : 'pm'
      case 'Z':
        return '+00:00'
      case 'ZZ':
        return '+0000'
      case 'X':
        return String(Math.floor(date.getTime() / 1000))
      case 'x':
        return String(date.getTime())
      default:
        return tok
    }
  })
}

/** "3 days ago" — Ghost's `timeago=true`. */
export function timeAgo(date: Date, now = new Date()): string {
  const secs = Math.round((now.getTime() - date.getTime()) / 1000)
  const units: [number, string][] = [
    [31_536_000, 'year'],
    [2_592_000, 'month'],
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ]
  for (const [size, name] of units) {
    const n = Math.floor(Math.abs(secs) / size)
    if (n >= 1) return secs >= 0 ? `${n} ${name}${n === 1 ? '' : 's'} ago` : `in ${n} ${name}${n === 1 ? '' : 's'}`
  }
  return 'a few seconds ago'
}
