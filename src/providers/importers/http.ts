/**
 * What every importer adapter shares: a JSON GET that turns HTTP failures into
 * `SourceError`s a person can read, and the small translations (times, text,
 * counts, cursors) that each tool would otherwise reimplement slightly wrong.
 *
 * Pure apart from `getJson`, which uses whatever `HttpFetch` it is handed —
 * global `fetch` in production, a fake in the test suite (`Env.IMPORT_HTTP`).
 */
import { type HttpFetch, type ImportedNote, SourceError } from './types.ts'

export async function getJson(
  http: HttpFetch,
  label: string,
  url: string,
  headers: Record<string, string>,
): Promise<any> {
  let res: Response
  try {
    res = await http(url, { headers: { accept: 'application/json', ...headers } })
  } catch (err) {
    throw new SourceError('unavailable', `${label} could not be reached (${(err as Error).message})`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new SourceError('auth', `${label} refused the key (HTTP ${res.status}). Check it and start again.`)
  }
  if (res.status === 404) throw new SourceError('not_found', `${label} has no such thing (HTTP 404): ${new URL(url).pathname}`)
  if (res.status === 429 || res.status >= 500) {
    throw new SourceError('unavailable', `${label} is busy or down (HTTP ${res.status}); the next tick tries again`)
  }
  if (!res.ok) throw new SourceError('error', `${label} answered HTTP ${res.status}`)
  try {
    return await res.json()
  } catch {
    throw new SourceError('error', `${label} answered with something that is not JSON`)
  }
}

/** Query string from a flat record, skipping null/undefined. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

/** Epoch ms from ISO 8601 (or Kit's `2024-02-27 22:32:19 UTC`); null otherwise. */
export function time(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const t = value.trim()
  const kit = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/.test(t) ? t.replace(' ', 'T').replace(' UTC', 'Z') : t
  const ms = Date.parse(kit)
  return Number.isFinite(ms) ? ms : null
}

/** Trimmed text cut to `max`; null for blank or not text. */
export function text(value: unknown, max: number): string | null {
  if (typeof value === 'number') value = String(value)
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t ? t.slice(0, max) : null
}

/** A non-negative integer from a number or numeric text; 0 otherwise. */
export function count(value: unknown): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0
}

/** A reported rate (0.42 or 42.0) turned back into a count of `recipients`. */
export function fromRate(rate: unknown, recipients: number): number {
  if (typeof rate !== 'number' || !(rate >= 0)) return 0
  const fraction = rate > 1 ? rate / 100 : rate
  return Math.min(Math.round(fraction * recipients), recipients)
}

/** A cursor back to a number, `fallback` for the first page. */
export function cursorNumber(cursor: string | null, fallback: number): number {
  if (cursor === null) return fallback
  const n = Number.parseInt(cursor, 10)
  return Number.isFinite(n) && String(n) === cursor ? n : fallback
}

/** Scalar custom-field values as text; blanks, objects and arrays left out. */
export function attributes(map: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!map || typeof map !== 'object') return out
  for (const [key, raw] of Object.entries(map as Record<string, unknown>)) {
    const k = key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 63)
    const v = typeof raw === 'boolean' ? String(raw) : text(raw, 2000)
    if (k && v) out[k] = v
  }
  return out
}

/** A note for the report, or nothing when the count is zero. */
export function note(key: string, n: number, message: string): ImportedNote[] {
  return n > 0 ? [{ kind: 'note', key, count: n, message }] : []
}

/** First + last name joined, or null. */
export function fullName(first: unknown, last: unknown): string | null {
  return text([text(first, 100), text(last, 100)].filter(Boolean).join(' '), 200)
}
