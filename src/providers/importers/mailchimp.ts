/**
 * Mailchimp over its Marketing API 3.0, for one audience, with the operator's
 * API key (HTTP basic). The key's suffix names the data centre (`…-us21`), which
 * becomes the host `us21.api.mailchimp.com`; it is checked to be exactly a
 * data-centre name first, so a key can never point the Worker at another host.
 *
 * Phases: subscribers (members, with their tags and merge fields), broadcasts
 * (sent campaigns for that audience, with content and the report summary).
 *
 * Statuses: `subscribed` → active; `pending` → pending; `unsubscribed` →
 * unsubscribed + `unsubscribed_all` (an audience unsubscribe stops all of that
 * audience's mail, automations included); `cleaned` → bounced + `hard_bounce`.
 * `transactional` contacts never opted in and `archived` ones were removed by
 * the operator: neither imports anybody. Automations and journeys are not
 * carried — the API does not hand over their mail.
 */
import { attributes, count, cursorNumber, fullName, getJson, note, qs, text, time } from './http.ts'
import type { ImportedRecord, ImportedStatus, ImportedSuppression, ImportSource, SourceConnection } from './types.ts'
import { SourceError } from './types.ts'

const MEMBERS_PER_PAGE = 200
const CAMPAIGNS_PER_PAGE = 20

function get(conn: SourceConnection, path: string, params: Record<string, string | number> = {}) {
  const key = conn.credentials.api_key ?? ''
  const dc = key.split('-')[1] ?? ''
  if (!/^[a-z]{2}\d{1,3}$/.test(dc)) throw new SourceError('invalid', 'That Mailchimp key has no data centre suffix.')
  return getJson(conn.http, 'Mailchimp', `https://${dc}.api.mailchimp.com/3.0${path}${qs(params)}`, {
    authorization: `Basic ${btoa(`kolea:${key}`)}`,
  })
}

function next(offset: number, taken: number, total: unknown): string | null {
  return taken > 0 && offset + taken < count(total) ? String(offset + taken) : null
}

function status(s: unknown): [ImportedStatus | null, ImportedSuppression | null] {
  switch (s) {
    case 'subscribed':
      return ['active', null]
    case 'pending':
      return ['pending', null]
    case 'unsubscribed':
      return ['unsubscribed', 'unsubscribed_all']
    case 'cleaned':
      return ['bounced', 'hard_bounce']
    default:
      return [null, null]
  }
}

export const mailchimpSource: ImportSource = {
  id: 'mailchimp',
  label: 'Mailchimp',
  fields: [
    { name: 'api_key', label: 'Mailchimp API key', secret: true, hint: 'Profile → Extras → API keys (ends in -usNN)' },
    { name: 'list_id', label: 'Audience ID', secret: false, hint: 'Audience → Settings → Audience name and defaults' },
  ],

  prepare(params) {
    const key = text(params.api_key, 200)
    const list = text(params.list_id, 40)
    if (!key || !/^[0-9a-zA-Z]{8,64}-[a-z]{2}\d{1,3}$/.test(key)) {
      throw new SourceError('invalid', 'That is not a Mailchimp API key (it ends in -us and a number).')
    }
    if (!list || !/^[0-9a-zA-Z]{1,40}$/.test(list)) throw new SourceError('invalid', 'The audience ID is required.')
    return { settings: { list_id: list }, credentials: { api_key: key } }
  },

  async verify(conn) {
    await get(conn, `/lists/${conn.settings.list_id}`)
  },

  phases: () => ['subscribers', 'broadcasts'],

  async fetchPage(conn, phase, cursor) {
    const offset = cursorNumber(cursor, 0)
    const list = conn.settings.list_id ?? ''
    if (phase === 'subscribers') {
      const body = await get(conn, `/lists/${list}/members`, { count: MEMBERS_PER_PAGE, offset })
      const members: any[] = body.members ?? []
      const records: ImportedRecord[] = members.map((m) => {
        const [st, suppression] = status(m.status)
        const merge = m.merge_fields ?? {}
        const { FNAME, LNAME, ...rest } = merge
        const joined = time(m.timestamp_opt) ?? time(m.timestamp_signup)
        return {
          kind: 'subscriber',
          email: String(m.email_address ?? ''),
          status: st,
          rawStatus: String(m.status ?? ''),
          suppression,
          name: fullName(FNAME, LNAME),
          subscribedAt: joined,
          unsubscribedAt: st === 'unsubscribed' ? (time(m.last_changed) ?? joined) : null,
          confirmedAt: st === 'active' ? time(m.timestamp_opt) : null,
          attributes: attributes(rest),
          tags: (m.tags ?? []).map((t: any) => text(t?.name, 100)).filter(Boolean) as string[],
        }
      })
      if (offset === 0) {
        records.push(
          ...note(
            'mailchimp_automations',
            1,
            'Mailchimp automations and journeys are not in its API with their mail; rebuild them as sequences',
          ),
        )
      }
      return { records, next: next(offset, members.length, body.total_items) }
    }
    if (phase === 'broadcasts') {
      const body = await get(conn, '/campaigns', { list_id: list, status: 'sent', count: CAMPAIGNS_PER_PAGE, offset })
      const campaigns: any[] = body.campaigns ?? []
      const records: ImportedRecord[] = []
      for (const c of campaigns) {
        const content = await get(conn, `/campaigns/${encodeURIComponent(String(c.id))}/content`)
        const settings = c.settings ?? {}
        const report = c.report_summary ?? {}
        const sent = count(c.emails_sent)
        const sentAt = time(c.send_time) ?? time(c.create_time)
        records.push({
          kind: 'broadcast',
          sourceId: String(c.id),
          subject: text(settings.subject_line, 998) ?? text(settings.title, 998) ?? '(no subject)',
          sent: true,
          html: typeof content.html === 'string' ? content.html : null,
          excerpt: text(settings.preview_text, 500),
          sentAt,
          createdAt: time(c.create_time) ?? sentAt,
          totals: {
            recipients: sent,
            opened: Math.min(count(report.unique_opens), sent),
            clicked: Math.min(count(report.subscriber_clicks), sent),
            unsubscribed: 0,
          },
          slug: null,
          featureImage: null,
          featured: false,
        })
      }
      return { records, next: next(offset, campaigns.length, body.total_items) }
    }
    return { records: [], next: null }
  },
}
