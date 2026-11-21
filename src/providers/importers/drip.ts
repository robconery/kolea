/**
 * Drip over its v2 API, for one Drip account, with the operator's API token
 * (HTTP basic). The account id must be digits only, since it becomes a path
 * segment.
 *
 * Phases: tags, subscribers (every status, with their tags and custom fields),
 * broadcasts (sent ones).
 *
 * Statuses: `active` → active; `unsubscribed` → unsubscribed +
 * `unsubscribed_all` (Drip's unsubscribe stops every mailing);
 * `bounced`/`undeliverable` → bounced + `hard_bounce`; `complained` →
 * complained + `complaint`. Anything else imports nobody. Drip's API reports no
 * numbers for a broadcast, so none are invented; its campaigns (email series)
 * do not expose their mail, so they are not carried and a note says so.
 */
import { attributes, cursorNumber, fullName, getJson, note, qs, text, time } from './http.ts'
import type { ImportedRecord, ImportedStatus, ImportedSuppression, ImportSource, SourceConnection } from './types.ts'
import { SourceError } from './types.ts'

const BASE = 'https://api.getdrip.com/v2'
const PER_PAGE = 200

function get(conn: SourceConnection, path: string, params: Record<string, string | number> = {}) {
  return getJson(conn.http, 'Drip', `${BASE}${path}${qs(params)}`, {
    authorization: `Basic ${btoa(`${conn.credentials.api_key ?? ''}:`)}`,
  })
}

function next(body: any, page: number): string | null {
  const total = body?.meta?.total_pages
  return typeof total === 'number' && page < total ? String(page + 1) : null
}

function status(s: unknown): [ImportedStatus | null, ImportedSuppression | null] {
  switch (s) {
    case 'active':
      return ['active', null]
    case 'unsubscribed':
      return ['unsubscribed', 'unsubscribed_all']
    case 'bounced':
    case 'undeliverable':
      return ['bounced', 'hard_bounce']
    case 'complained':
      return ['complained', 'complaint']
    default:
      return [null, null]
  }
}

export const dripSource: ImportSource = {
  id: 'drip',
  label: 'Drip',
  fields: [
    { name: 'api_key', label: 'Drip API token', secret: true, hint: 'Drip → User settings → API token' },
    { name: 'account_id', label: 'Account ID', secret: false, hint: 'The number in your Drip URLs' },
  ],

  prepare(params) {
    const token = text(params.api_key, 200)
    const account = text(params.account_id, 20)
    if (!token) throw new SourceError('invalid', 'A Drip API token is required.')
    if (!account || !/^\d{1,20}$/.test(account)) {
      throw new SourceError('invalid', 'The Drip account ID is the number in your Drip URLs.')
    }
    return { settings: { account_id: account }, credentials: { api_key: token } }
  },

  async verify(conn) {
    const body = await get(conn, '/accounts')
    const found = (body.accounts ?? []).some((a: any) => String(a.id) === conn.settings.account_id)
    if (!found) throw new SourceError('not_found', 'That token cannot see a Drip account with that ID.')
  },

  phases: () => ['tags', 'subscribers', 'broadcasts'],

  async fetchPage(conn, phase, cursor) {
    const account = conn.settings.account_id ?? ''
    const page = cursorNumber(cursor, 1)
    if (phase === 'tags') {
      const body = await get(conn, `/${account}/tags`)
      const records: ImportedRecord[] = (body.tags ?? [])
        .map((t: unknown) => text(t, 100))
        .filter(Boolean)
        .map((name: string) => ({ kind: 'tag' as const, name }))
      return { records, next: null }
    }
    if (phase === 'subscribers') {
      const body = await get(conn, `/${account}/subscribers`, { status: 'all', per_page: PER_PAGE, page })
      const records: ImportedRecord[] = (body.subscribers ?? []).map((s: any) => {
        const [st, suppression] = status(s.status)
        const joined = time(s.created_at)
        return {
          kind: 'subscriber',
          email: String(s.email ?? ''),
          status: st,
          rawStatus: String(s.status ?? ''),
          suppression,
          name: fullName(s.first_name, s.last_name),
          subscribedAt: joined,
          unsubscribedAt: st === 'unsubscribed' ? (time(s.unsubscribed_at) ?? joined) : null,
          confirmedAt: null,
          attributes: attributes(s.custom_fields),
          tags: (s.tags ?? []).map((t: unknown) => text(t, 100)).filter(Boolean) as string[],
        }
      })
      if (page === 1) {
        records.push(
          ...note(
            'drip_campaigns',
            1,
            "Drip campaigns (email series) are not in Drip's API with their mail; rebuild them as sequences",
          ),
        )
      }
      return { records, next: next(body, page) }
    }
    if (phase === 'broadcasts') {
      const body = await get(conn, `/${account}/broadcasts`, { status: 'sent', per_page: 50, page })
      const records: ImportedRecord[] = (body.broadcasts ?? []).map((b: any) => {
        const sentAt = time(b.send_at) ?? time(b.created_at)
        return {
          kind: 'broadcast',
          sourceId: String(b.id),
          subject: text(b.subject, 998) ?? text(b.name, 998) ?? '(no subject)',
          sent: true,
          html: typeof b.html_body === 'string' ? b.html_body : null,
          excerpt: text(b.preheader, 500),
          sentAt,
          createdAt: time(b.created_at) ?? sentAt,
          totals: null,
          slug: null,
          featureImage: null,
          featured: false,
        }
      })
      return { records, next: next(body, page) }
    }
    return { records: [], next: null }
  },
}
