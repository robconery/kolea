/**
 * Ghost over its Admin API: the site URL plus an Admin API key (`id:secret`),
 * signed into a five-minute HS256 token per request with WebCrypto — Ghost's
 * documented "token authentication", no SDK.
 *
 * Phases: members, posts.
 *
 * Members: a member Ghost suppressed after a spam complaint arrives
 * `complained` with a `complaint` suppression; after a failed delivery,
 * `bounced` with a `hard_bounce`. A member who turned the newsletter off arrives
 * `unsubscribed` with **no** suppression: in Ghost that choice is newsletter
 * only — they stay a member and can still get other mail — which is exactly our
 * `unsubscribed` (off broadcasts, not off everything). A suppression would widen
 * it. A member with no newsletter choice recorded at all imports nobody. Labels
 * become tags; the member tier (free, paid, comped) is kept as the
 * `ghost_status` attribute.
 *
 * Posts arrive as sent broadcasts when Ghost published or emailed them, with
 * the slug kept (so the URL survives when the operator publishes it here) but
 * NOT published: `published_at` stays null, publishing is a per-post, deliberate
 * act (schema.ts, `broadcasts.publishedAt`). Drafts and scheduled posts are left
 * behind. Ghost's newsletter numbers come over as imported totals.
 */
import { count, cursorNumber, getJson, qs, text, time } from './http.ts'
import type {
  ImportedBroadcast,
  ImportedRecord,
  ImportedStatus,
  ImportedSuppression,
  ImportSource,
  SourceConnection,
} from './types.ts'
import { SourceError } from './types.ts'

const MEMBERS_PER_PAGE = 100
const POSTS_PER_PAGE = 25

/**
 * The site URL, normalized to its origin, refusing anything that could point a
 * Worker at a private or local address (SSRF): https only, a real hostname, no
 * IP literals, no single-label or `.local`/`.internal`/`.localhost` names.
 */
export function ghostOrigin(raw: string | undefined): string {
  let url: URL
  try {
    url = new URL((raw ?? '').trim())
  } catch {
    throw new SourceError('invalid', 'The Ghost URL is not a URL. It looks like https://yoursite.ghost.io')
  }
  const host = url.hostname.toLowerCase()
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  const ipv6 = host.startsWith('[') || host.includes(':')
  const local = !host.includes('.') || /\.(local|internal|localhost|lan|home|arpa)$/.test(host) || host === 'localhost'
  if (url.protocol !== 'https:' || ipv4 || ipv6 || local || url.username || url.password || url.port) {
    throw new SourceError('invalid', 'The Ghost URL must be a public https:// address with no port or credentials.')
  }
  return `https://${host}`
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const encodeJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)))

/** Ghost's Admin API token: a JWT signed with the key's secret, valid five minutes. */
export async function ghostToken(adminKey: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const [id, secret] = adminKey.split(':') as [string, string]
  const input = `${encodeJson({ alg: 'HS256', typ: 'JWT', kid: id })}.${encodeJson({
    iat: nowSeconds,
    exp: nowSeconds + 300,
    aud: '/admin/',
  })}`
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(secret) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input)))
  return `${input}.${b64url(sig)}`
}

async function get(conn: SourceConnection, path: string, params: Record<string, string | number> = {}) {
  const origin = ghostOrigin(conn.settings.url)
  return getJson(conn.http, 'Ghost', `${origin}/ghost/api/admin${path}${qs(params)}`, {
    authorization: `Ghost ${await ghostToken(conn.credentials.admin_key ?? '')}`,
    'accept-version': 'v5.0',
  })
}

function next(body: any): string | null {
  const n = body?.meta?.pagination?.next
  return typeof n === 'number' ? String(n) : null
}

function memberStatus(m: any): [ImportedStatus | null, ImportedSuppression | null] {
  if (m.email_suppression?.suppressed === true) {
    return m.email_suppression?.info?.reason === 'spam' ? ['complained', 'complaint'] : ['bounced', 'hard_bounce']
  }
  // Ghost says whether a member takes the newsletter through `subscribed` (old)
  // or `newsletters` (5.x). Neither recorded = no choice made = no consent assumed.
  if (typeof m.subscribed === 'boolean') return [m.subscribed ? 'active' : 'unsubscribed', null]
  if (Array.isArray(m.newsletters)) return [m.newsletters.length > 0 ? 'active' : 'unsubscribed', null]
  return [null, null]
}

function post(p: any): ImportedBroadcast {
  const status = p.status
  // `published` = on the web (and maybe mailed); `sent` = email-only. Both went out.
  const sent = status === 'published' || status === 'sent'
  const email = p.email && typeof p.email === 'object' ? p.email : {}
  const createdAt = time(p.created_at)
  const recipients = count(email.email_count)
  return {
    kind: 'broadcast',
    sourceId: String(p.id),
    subject: text(p.title, 998) ?? '(untitled)',
    sent,
    html: typeof p.html === 'string' ? p.html : null,
    excerpt: text(p.custom_excerpt, 500),
    sentAt: sent ? (time(email.submitted_at) ?? time(p.published_at) ?? createdAt) : null,
    createdAt,
    totals:
      recipients > 0
        ? {
            recipients,
            opened: Math.min(count(email.opened_count), recipients),
            clicked: 0,
            unsubscribed: 0,
          }
        : null,
    // An email-only post was never on the web and keeps no address.
    slug: status === 'sent' ? null : text(p.slug, 200),
    featureImage: text(p.feature_image, 2000),
    featured: p.featured === true,
  }
}

export const ghostSource: ImportSource = {
  id: 'ghost',
  label: 'Ghost',
  fields: [
    { name: 'url', label: 'Ghost site URL', secret: false, hint: 'https://yoursite.ghost.io' },
    {
      name: 'admin_key',
      label: 'Admin API key',
      secret: true,
      hint: 'Ghost → Settings → Integrations → Add custom integration',
    },
  ],

  prepare(params) {
    const url = ghostOrigin(params.url)
    const key = (params.admin_key ?? '').trim()
    if (!/^[0-9a-f]{24}:[0-9a-f]{64}$/i.test(key)) {
      throw new SourceError('invalid', 'That is not a Ghost Admin API key (it looks like 24 hex characters, a colon, 64 more).')
    }
    return { settings: { url }, credentials: { admin_key: key } }
  },

  async verify(conn) {
    await get(conn, '/site/')
  },

  phases: () => ['members', 'posts'],

  async fetchPage(conn, phase, cursor) {
    const page = cursorNumber(cursor, 1)
    if (phase === 'members') {
      const body = await get(conn, '/members/', { limit: MEMBERS_PER_PAGE, page, include: 'labels,newsletters' })
      const records: ImportedRecord[] = (body.members ?? []).map((m: any) => {
        const [status, suppression] = memberStatus(m)
        const joined = time(m.created_at)
        const tier = text(m.status, 40)
        return {
          kind: 'subscriber',
          email: String(m.email ?? ''),
          status,
          rawStatus: status === null ? 'no newsletter choice recorded' : String(m.status ?? ''),
          suppression,
          name: text(m.name, 200),
          subscribedAt: joined,
          unsubscribedAt: status === 'unsubscribed' ? (time(m.updated_at) ?? joined) : null,
          confirmedAt: null,
          attributes: tier ? { ghost_status: tier } : {},
          tags: (m.labels ?? []).map((l: any) => text(l?.name, 100)).filter(Boolean) as string[],
        }
      })
      return { records, next: next(body) }
    }
    if (phase === 'posts') {
      const body = await get(conn, '/posts/', {
        limit: POSTS_PER_PAGE,
        page,
        formats: 'html',
        include: 'tags,email',
      })
      return { records: (body.posts ?? []).map(post), next: next(body) }
    }
    return { records: [], next: null }
  },
}
