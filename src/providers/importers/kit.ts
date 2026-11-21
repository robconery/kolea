/**
 * Kit (ConvertKit) over its v4 API, with the operator's API key
 * (`X-Kit-Api-Key`). The background, resumable version of the old one-off Kit
 * import scripts, and it keeps their rules: Kit's own "Imported <date>" bookkeeping tags are dropped, completed
 * broadcasts are the only ones that ever sent, sequences arrive manual and off.
 *
 * Phases: tags, subscribers (every state), taggings (walked tag by tag),
 * broadcasts (with Kit's reported stats), sequences (with their emails). Kit
 * paginates with an opaque `end_cursor`, which is the cursor we store.
 *
 * States: `active` → active; `inactive` (never confirmed) → pending;
 * `cancelled` → unsubscribed + an `unsubscribed_all` suppression, because Kit's
 * unsubscribe stops every mail, sequences included, and carrying it over as
 * anything narrower would let a sequence mail somebody who said stop;
 * `bounced` / `complained` carry their suppressions. Any other state imports
 * nobody.
 *
 * Kit keeps sequence triggers in visual automations its API does not expose,
 * so a sequence's trigger is never guessed — guessing could mail live people.
 */
import { attributes, count, fromRate, getJson, note, qs, text, time } from './http.ts'
import type {
  ImportedBroadcast,
  ImportedRecord,
  ImportedSequence,
  ImportedStatus,
  ImportedStep,
  ImportedSuppression,
  ImportPage,
  ImportSource,
  SourceConnection,
} from './types.ts'
import { SourceError } from './types.ts'

const BASE = 'https://api.kit.com/v4'
const PER_PAGE = 200
const CONTENT_PER_PAGE = 25

/** Kit stamps an "Imported <date>" tag on every list upload. Not a segment. */
const isBookkeeping = (name: string) => /^Imported /i.test(name)

function get(conn: SourceConnection, path: string, params: Record<string, string | number | null> = {}) {
  return getJson(conn.http, 'Kit', `${BASE}${path}${qs(params)}`, {
    'x-kit-api-key': conn.credentials.api_key ?? '',
  })
}

function next(body: any): string | null {
  const p = body?.pagination
  return p?.has_next_page === true && typeof p.end_cursor === 'string' ? p.end_cursor : null
}

function state(s: unknown): [ImportedStatus | null, ImportedSuppression | null] {
  switch (s) {
    case 'active':
      return ['active', null]
    case 'inactive':
      return ['pending', null]
    case 'cancelled':
      return ['unsubscribed', 'unsubscribed_all']
    case 'bounced':
      return ['bounced', 'hard_bounce']
    case 'complained':
      return ['complained', 'complaint']
    default:
      return [null, null]
  }
}

async function allTags(conn: SourceConnection): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = []
  let cursor: string | null = null
  // Bounded: a Kit account with more than 20,000 tags is not a real one.
  for (let i = 0; i < 20; i++) {
    const body = await get(conn, '/tags', { per_page: 1000, after: cursor })
    for (const t of body.tags ?? []) {
      const name = text(t.name, 100)
      if (name && !isBookkeeping(name)) out.push({ id: String(t.id), name })
    }
    cursor = next(body)
    if (!cursor) break
  }
  return out
}

/** Cursor "tagId|kitCursor": the tag being walked, and where in it. */
async function taggings(conn: SourceConnection, cursor: string | null): Promise<ImportPage> {
  const tags = await allTags(conn)
  if (tags.length === 0) return { records: [], next: null }
  let index = 0
  let after: string | null = null
  if (cursor) {
    const [id, rest] = cursor.split('|', 2) as [string, string | undefined]
    index = tags.findIndex((t) => t.id === id)
    if (index === -1) return { records: [], next: null }
    after = rest ? rest : null
  }
  const tag = tags[index]!
  const body = await get(conn, `/tags/${encodeURIComponent(tag.id)}/subscribers`, {
    per_page: PER_PAGE,
    status: 'all',
    after,
  })
  const records: ImportedRecord[] = []
  for (const s of body.subscribers ?? []) {
    if (typeof s.email_address === 'string') records.push({ kind: 'tagging', email: s.email_address, tag: tag.name })
  }
  const more = next(body)
  const following = tags[index + 1]
  return {
    records,
    next: more ? `${tag.id}|${more}` : following ? `${following.id}|` : null,
  }
}

async function broadcast(conn: SourceConnection, b: any): Promise<ImportedBroadcast> {
  const body = await get(conn, `/broadcasts/${encodeURIComponent(String(b.id))}/stats`)
  const stats = body?.broadcast?.stats ?? {}
  const status = stats.status ?? b.status
  const sendAt = time(b.send_at)
  // `completed` is the only state that was ever on the wire. A draft or a
  // future send arrives as not-sent and is left behind by the writer.
  const sent = status === 'completed' || (status == null && sendAt !== null && sendAt < Date.now())
  const recipients = count(stats.recipients)
  const createdAt = time(b.created_at)
  return {
    kind: 'broadcast',
    sourceId: String(b.id),
    subject: text(b.subject, 998) ?? '(no subject)',
    sent,
    html: typeof b.content === 'string' ? b.content : null,
    excerpt: text(b.preview_text, 500),
    sentAt: sent ? (sendAt ?? time(b.published_at) ?? createdAt) : null,
    createdAt,
    totals: sent
      ? {
          recipients,
          opened: Math.min(count(stats.emails_opened), recipients),
          clicked: fromRate(stats.click_rate, recipients),
          unsubscribed: count(stats.unsubscribes),
        }
      : null,
    slug: null,
    featureImage: null,
    featured: false,
  }
}

/** Whole days only here. Kit can say hours; a part-day rounds UP, never to "immediately". */
function step(e: any): ImportedStep {
  const value = count(e.delay_value)
  let days = value
  let rounded = false
  if (e.delay_unit === 'hours') {
    days = value === 0 ? 0 : Math.max(1, Math.ceil(value / 24))
    rounded = value % 24 !== 0
  } else if (e.delay_unit === 'weeks') days = value * 7
  if (days > 365) {
    days = 365
    rounded = true
  }
  return {
    subject: text(e.subject, 998) ?? '(no subject)',
    html: typeof e.content === 'string' ? e.content : null,
    delayDays: days,
    rounded,
  }
}

async function sequence(conn: SourceConnection, s: any): Promise<ImportedSequence> {
  const body = await get(conn, `/sequences/${encodeURIComponent(String(s.id))}/emails`, {
    per_page: 500,
    include_content: 'true',
  })
  const emails = [...(body.emails ?? [])].sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
  return {
    kind: 'sequence',
    sourceId: String(s.id),
    name: text(s.name, 200) ?? `Kit sequence ${s.id}`,
    createdAt: time(s.created_at),
    steps: emails.map(step),
  }
}

export const kitSource: ImportSource = {
  id: 'kit',
  label: 'Kit',
  fields: [{ name: 'api_key', label: 'Kit API key (v4)', secret: true, hint: 'Kit → Settings → Developer → API keys' }],

  prepare(params) {
    const key = text(params.api_key, 200)
    if (!key) throw new SourceError('invalid', 'A Kit API key is required.')
    return { settings: {}, credentials: { api_key: key } }
  },

  async verify(conn) {
    await get(conn, '/account')
  },

  phases: () => ['tags', 'subscribers', 'taggings', 'broadcasts', 'sequences'],

  async fetchPage(conn, phase, cursor) {
    switch (phase) {
      case 'tags': {
        const body = await get(conn, '/tags', { per_page: 1000, after: cursor })
        const records: ImportedRecord[] = []
        for (const t of body.tags ?? []) {
          const name = text(t.name, 100)
          if (name && !isBookkeeping(name)) records.push({ kind: 'tag', name })
        }
        return { records, next: next(body) }
      }
      case 'subscribers': {
        const body = await get(conn, '/subscribers', { per_page: PER_PAGE, status: 'all', after: cursor })
        const records: ImportedRecord[] = (body.subscribers ?? []).map((s: any) => {
          const [status, suppression] = state(s.state)
          const joined = time(s.created_at)
          return {
            kind: 'subscriber',
            email: String(s.email_address ?? ''),
            status,
            rawStatus: String(s.state ?? ''),
            suppression,
            name: text(s.first_name, 200),
            subscribedAt: joined,
            unsubscribedAt: status === 'unsubscribed' ? (time(s.updated_at) ?? joined) : null,
            confirmedAt: status === 'active' ? joined : null,
            attributes: attributes(s.fields),
            tags: [],
          }
        })
        return { records, next: next(body) }
      }
      case 'taggings':
        return await taggings(conn, cursor)
      case 'broadcasts': {
        const body = await get(conn, '/broadcasts', { per_page: CONTENT_PER_PAGE, after: cursor })
        const records: ImportedRecord[] = []
        for (const b of body.broadcasts ?? []) records.push(await broadcast(conn, b))
        return { records, next: next(body) }
      }
      case 'sequences': {
        const body = await get(conn, '/sequences', { per_page: CONTENT_PER_PAGE, after: cursor })
        const records: ImportedRecord[] = []
        for (const s of body.sequences ?? []) records.push(await sequence(conn, s))
        if (cursor === null && records.length > 0) {
          records.push(
            ...note(
              'kit_sequence_triggers',
              1,
              "Kit keeps sequence triggers in automations its API does not expose; every sequence arrived manual and off",
            ),
          )
        }
        return { records, next: next(body) }
      }
      default:
        return { records: [], next: null }
    }
  },
}
