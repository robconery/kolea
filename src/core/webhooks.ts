import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  WEBHOOK_EVENTS,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEvent,
  sales,
  subscribers,
  webhookDeliveries,
  webhookEndpoints,
} from '../db/schema.ts'
import {
  type WebhookTransport,
  fakeTransportFor,
  fetchTransport,
} from '../providers/webhooks.ts'
import type { Env } from '../types.ts'
import { randomToken } from './ids.ts'
import { postUrl } from './posts.ts'

/**
 * ⭐ Outbound webhooks (Kōlea SPEC 20.2).
 *
 * The operator subscribes https URLs to facts — someone subscribed,
 * unsubscribed, bounced, complained, bought something, a post went up — and
 * each fact is POSTed to each subscribed endpoint, signed, retried with
 * backoff, and logged as a row.
 *
 * The rules, once:
 *
 * - **Emitting never touches the network and never throws.** `emitWebhook`
 *   is called from inside the consent functions, bounce handling,
 *   `recordSale` and `publishPost`. It costs one small query when nobody is
 *   listening and writes `pending` rows when somebody is. A webhook can never
 *   break, or slow, the change it reports.
 * - **Delivery happens later**, from the minutely cron (`deliverDueWebhooks`),
 *   a page at a time so it stays well inside D1's 1,000-query budget. The row
 *   is the queue: it survives restarts and is the delivery log.
 * - **Only public https URLs** (`checkWebhookUrl`), checked on save and again
 *   before every POST. Redirects are never followed, every POST has a timeout.
 * - **Signed** with the endpoint's own secret, shown once:
 *   `Kolea-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`.
 * - **Nothing from a bulk write.** A CSV import is history, not news, and
 *   emits nothing (Kōlea's rule).
 * - **A give-up is visible.** A delivery that uses every attempt is `failed`
 *   and keeps a Redeliver button; an endpoint that keeps failing is switched
 *   off with the reason written on it.
 */

export { WEBHOOK_EVENTS, type WebhookEvent }

export const MAX_ATTEMPTS = 8
/** Failed deliveries in a row before an endpoint is switched off. Kōlea's number. */
export const DISABLE_AFTER = 15
/** How many due deliveries one cron pass takes, POSTed in parallel. */
export const DELIVERY_PAGE = 20
/** Count the attempt, record the answer, settle the endpoint: per delivery. */
export const QUERIES_PER_DELIVERY = 3
/** The due read, the claim and the join, once per pass. */
export const DELIVERY_PASS_OVERHEAD = 3
/** A claimed row is invisible to other passes for this long, in case this one dies mid-POST. */
const LEASE_MS = 5 * 60 * 1000

// ───────────────────────────────────────────────── the transport

/** Which adapter puts the POST on the wire. Production is always `fetch`. */
export function webhookTransportFor(env: Env): WebhookTransport {
  return env.WEBHOOK_TRANSPORT === 'fake' ? fakeTransportFor(env) : fetchTransport
}

// ───────────────────────────────────────────────── the URL policy (SSRF)

const PORTS = new Set(['', '443', '8443'])
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa']

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string }

/**
 * Whether Kōlea will POST to `raw`. Pure.
 *
 * https only, port 443 or 8443, no user or password, no #fragment, a real
 * host name (not `localhost`, not a single label, not `.local`/`.internal`),
 * and if the host is an IP literal it must be a public unicast address — no
 * private, loopback, link-local (the cloud metadata address), CGNAT,
 * multicast, reserved or documentation range, IPv4 or IPv6. The WHATWG parser
 * normalizes `0x7f.1` and `2130706433` to `127.0.0.1` before we look, so those
 * spellings are caught too. Nothing is resolved here: a Worker cannot pin
 * the address it connects to, and Cloudflare's egress does not reach private
 * networks.
 */
export function checkWebhookUrl(raw: unknown): UrlCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'must be a URL' }
  const trimmed = raw.trim()
  if (trimmed.length > 2048) return { ok: false, reason: 'must be at most 2,048 characters' }

  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'must be a URL' }
  }

  if (u.protocol !== 'https:') return { ok: false, reason: 'must start with https://' }
  if (u.username || u.password) {
    return { ok: false, reason: 'must not carry a user name or password' }
  }
  if (u.hash || trimmed.includes('#')) return { ok: false, reason: 'must not have a #fragment' }
  if (!PORTS.has(u.port)) return { ok: false, reason: 'must use port 443 or 8443' }

  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return { ok: false, reason: 'must name a host' }

  if (host.startsWith('[')) {
    const v6 = parseIpv6(host.slice(1, -1))
    if (!v6 || !isPublicIpv6(v6)) return { ok: false, reason: 'must be a public host' }
    return { ok: true, url: u.toString() }
  }

  const v4 = parseIpv4(host)
  if (v4) {
    if (!isPublicIpv4(v4)) return { ok: false, reason: 'must be a public host' }
    return { ok: true, url: u.toString() }
  }

  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: 'must be a public host' }
  }
  if (!host.includes('.')) return { ok: false, reason: 'must be a public host' }

  return { ok: true, url: u.toString() }
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null
  const n = parts.map(Number)
  return n.every((x) => x <= 255) ? n : null
}

const V4_BLOCKED: [number[], number][] = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
]

const v4int = (ip: number[]) => ((ip[0]! << 24) >>> 0) + (ip[1]! << 16) + (ip[2]! << 8) + ip[3]!

export function isPublicIpv4(ip: number[]): boolean {
  const n = v4int(ip)
  return !V4_BLOCKED.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return ((n & mask) >>> 0) === ((v4int(net) & mask) >>> 0)
  })
}

/** Eight 16-bit groups, or null. Accepts `::` and a trailing dotted IPv4. */
function parseIpv6(raw: string): number[] | null {
  let s = raw.toLowerCase()
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const v4 = parseIpv4(dotted[1]!)
    if (!v4) return null
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16)
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16)
    s = `${s.slice(0, -dotted[1]!.length)}${hi}:${lo}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const group = (part: string) => (part ? part.split(':') : [])
  const head = group(halves[0]!)
  const rest = halves.length === 2 ? group(halves[1]!) : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  return all.map((g) => parseInt(g, 16))
}

export function isPublicIpv6(g: number[]): boolean {
  const zeroes = (n: number) => g.slice(0, n).every((x) => x === 0)
  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::a.b.c.d carry an IPv4 address.
  const embedded = [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]
  if (zeroes(5) && g[5] === 0xffff) return isPublicIpv4(embedded)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPublicIpv4(embedded)
  }
  if (zeroes(6)) return false // ::, ::1, and the deprecated IPv4-compatible block
  const a = g[0]!
  if ((a & 0xfe00) === 0xfc00) return false // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return false // link-local fe80::/10
  if ((a & 0xff00) === 0xff00) return false // multicast
  if (a === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return false // documentation, Teredo
  return true
}

// ───────────────────────────────────────────────── signing

/** A new signing secret: `whsec_` and 48 random characters. */
export function generateWebhookSecret(): string {
  return `whsec_${randomToken(48)}`
}

/** The part of a secret shown after creation. Not enough to sign with. */
export function secretPrefix(secret: string): string {
  return secret.slice(0, 12)
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The `Kolea-Signature` header for `body` signed at `timestamp` (unix seconds). */
export async function signatureHeader(secret: string, body: string, timestamp: number) {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`
}

/**
 * What a receiver does with the header: recompute, compare in constant time,
 * and reject a `t` more than `toleranceSec` from now. Here so the help text
 * and the tests have one reference implementation to point at.
 */
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.trim().split('=', 2) as [string, string]),
  )
  const t = Number(parts.t)
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSec - t) > toleranceSec) return false
  const expected = await hmacHex(secret, `${t}.${body}`)
  if (expected.length !== parts.v1.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i)
  return diff === 0
}

// ───────────────────────────────────────────────── endpoints

/** An endpoint as every screen and tool sees it: never the secret. */
export type WebhookEndpointView = Omit<WebhookEndpoint, 'secret'> & {
  pending: number
  failed: number
}

export type EndpointResult =
  | { ok: true; endpoint: WebhookEndpointView }
  | { ok: false; reason: string }

export interface EndpointInput {
  url?: unknown
  events?: unknown
  description?: unknown
  active?: unknown
}

/** Accepts an array or a comma-separated string; refuses an unknown name by name. */
function readEvents(raw: unknown): { ok: true; events: WebhookEvent[] } | { ok: false; reason: string } {
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [])
    .map((e) => String(e).trim())
    .filter(Boolean)
  const unknown = list.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e))
  if (unknown.length) {
    return {
      ok: false,
      reason: `unknown event "${unknown[0]}" — choose from ${WEBHOOK_EVENTS.join(', ')}`,
    }
  }
  const events = WEBHOOK_EVENTS.filter((e) => list.includes(e))
  if (events.length === 0) return { ok: false, reason: 'choose at least one event' }
  return { ok: true, events }
}

function readDescription(raw: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length > 200) return { ok: false, reason: 'description must be at most 200 characters' }
  return { ok: true, text }
}

function strip(e: WebhookEndpoint, counts?: { pending: number; failed: number }): WebhookEndpointView {
  const { secret: _secret, ...rest } = e
  return { ...rest, pending: counts?.pending ?? 0, failed: counts?.failed ?? 0 }
}

/**
 * Add an endpoint. The URL must pass the SSRF policy. Returns the signing
 * secret, which is never shown again.
 */
export async function createWebhookEndpoint(
  db: Db,
  input: EndpointInput,
): Promise<{ ok: true; endpoint: WebhookEndpointView; secret: string } | { ok: false; reason: string }> {
  const url = checkWebhookUrl(input.url)
  if (!url.ok) return { ok: false, reason: `url ${url.reason}` }
  const events = readEvents(input.events)
  if (!events.ok) return events
  const description = readDescription(input.description)
  if (!description.ok) return description

  const secret = generateWebhookSecret()
  const now = new Date()
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      url: url.url,
      description: description.text,
      events: events.events,
      secret,
      secretPrefix: secretPrefix(secret),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return { ok: true, endpoint: strip(row!), secret }
}

/**
 * Change an endpoint's URL, events, description, or whether it is on. A new
 * URL is checked again. Switching off by hand records why; switching on
 * clears the reason and the failure count.
 */
export async function updateWebhookEndpoint(
  db: Db,
  id: number,
  input: EndpointInput,
): Promise<EndpointResult> {
  const existing = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).get()
  if (!existing) return { ok: false, reason: `no webhook endpoint #${id}` }

  const patch: Partial<typeof webhookEndpoints.$inferInsert> = {}
  if (input.url !== undefined) {
    const url = checkWebhookUrl(input.url)
    if (!url.ok) return { ok: false, reason: `url ${url.reason}` }
    patch.url = url.url
  }
  if (input.events !== undefined) {
    const events = readEvents(input.events)
    if (!events.ok) return events
    patch.events = events.events
  }
  if (input.description !== undefined) {
    const description = readDescription(input.description)
    if (!description.ok) return description
    patch.description = description.text
  }
  if (input.active !== undefined) {
    const on = input.active === true || input.active === 'true' || input.active === 'on'
    if (on && !existing.isActive) {
      Object.assign(patch, { isActive: true, disabledReason: null, disabledAt: null, consecutiveFailures: 0 })
    } else if (!on && existing.isActive) {
      Object.assign(patch, { isActive: false, disabledReason: 'switched off', disabledAt: new Date() })
    }
  }

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = new Date()
    await db.update(webhookEndpoints).set(patch).where(eq(webhookEndpoints.id, id))
  }
  return { ok: true, endpoint: (await getWebhookEndpoint(db, id))! }
}

/** Delete an endpoint and, by cascade, its delivery log. */
export async function deleteWebhookEndpoint(db: Db, id: number): Promise<boolean> {
  const gone = await db
    .delete(webhookEndpoints)
    .where(eq(webhookEndpoints.id, id))
    .returning({ id: webhookEndpoints.id })
  return gone.length > 0
}

async function deliveryCounts(db: Db, ids: number[]) {
  const out = new Map<number, { pending: number; failed: number }>()
  if (ids.length === 0) return out
  const rows = await db
    .select({ endpointId: webhookDeliveries.endpointId, status: webhookDeliveries.status, n: count() })
    .from(webhookDeliveries)
    .where(
      and(
        inArray(webhookDeliveries.endpointId, ids),
        inArray(webhookDeliveries.status, ['pending', 'failed']),
      ),
    )
    .groupBy(webhookDeliveries.endpointId, webhookDeliveries.status)
    .all()
  for (const r of rows) {
    const c = out.get(r.endpointId) ?? { pending: 0, failed: 0 }
    if (r.status === 'pending') c.pending = r.n
    if (r.status === 'failed') c.failed = r.n
    out.set(r.endpointId, c)
  }
  return out
}

/** Every endpoint, newest first, with how many deliveries are waiting or failed. */
export async function listWebhookEndpoints(db: Db): Promise<WebhookEndpointView[]> {
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id))
    .all()
  const counts = await deliveryCounts(db, rows.map((r) => r.id))
  return rows.map((r) => strip(r, counts.get(r.id)))
}

export async function getWebhookEndpoint(db: Db, id: number): Promise<WebhookEndpointView | null> {
  const row = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).get()
  if (!row) return null
  return strip(row, (await deliveryCounts(db, [id])).get(id))
}

/** The delivery log, newest first. Filter by endpoint and/or status. */
export async function listWebhookDeliveries(
  db: Db,
  filter: { endpointId?: number; status?: WebhookDelivery['status']; limit?: number } = {},
): Promise<WebhookDelivery[]> {
  const where = [
    filter.endpointId !== undefined ? eq(webhookDeliveries.endpointId, filter.endpointId) : undefined,
    filter.status ? eq(webhookDeliveries.status, filter.status) : undefined,
  ].filter((w) => w !== undefined)
  return await db
    .select()
    .from(webhookDeliveries)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200))
    .all()
}

// ───────────────────────────────────────────────── payloads

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null)

/**
 * The person an event is about. Ids, never `unsub_token`: that token IS the
 * preference-center credential, and it must not leave the building.
 */
export async function subscriberPayload(db: Db, subscriberId: number) {
  const s = await db.select().from(subscribers).where(eq(subscribers.id, subscriberId)).get()
  if (!s) return null
  return {
    id: s.id,
    email: s.email,
    name: s.name,
    status: s.status,
    source: s.source,
    subscribed_at: iso(s.createdAt),
  }
}

/** A sale, for `purchased`. Money in integer cents with its currency. */
export async function salePayload(db: Db, saleId: number) {
  const s = await db.select().from(sales).where(eq(sales.id, saleId)).get()
  if (!s) return null
  return {
    id: s.id,
    amount: s.amountCents,
    currency: s.currency,
    description: s.product,
    external_id: s.externalId,
    status: s.status,
    occurred_at: iso(s.occurredAt),
  }
}

// ───────────────────────────────────────────────── emitting

type Payload = Record<string, unknown> | null

/**
 * Record that `kind` happened and queue it for every active endpoint that
 * wants it. Writes rows only — delivery is the cron's job.
 *
 * `data` is a function so that when nobody is listening (the usual case) the
 * cost is the one query that finds that out, and no payload is built. It may
 * return null (the person is gone), which emits nothing.
 *
 * ⭐ Never throws. Swallowing here is the point: this runs inside a consent
 * change, and a webhook must never be able to undo or fail the fact it reports.
 */
export async function emitWebhook(
  db: Db,
  kind: WebhookEvent,
  data: () => Payload | Promise<Payload>,
  opts: { dedupeKey?: string; occurredAt?: Date } = {},
): Promise<void> {
  try {
    const endpoints = await db
      .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.isActive, true))
      .all()
    const listening = endpoints.filter((e) => e.events.includes(kind))
    if (listening.length === 0) return

    const payload = await data()
    if (!payload) return

    const now = new Date()
    const eventId = `evt_${randomToken(24)}`
    await db
      .insert(webhookDeliveries)
      .values(
        listening.map((e) => ({
          endpointId: e.id,
          event: kind,
          eventId,
          payload,
          occurredAt: opts.occurredAt ?? now,
          dedupeKey: opts.dedupeKey ?? null,
          status: 'pending' as const,
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
        })),
      )
      .onConflictDoNothing()
  } catch {
    /* see above: the fact already happened, and that is what matters */
  }
}

// ───────────────────────────────────────────────── delivering

/**
 * The JSON body, the same bytes on every attempt. A post's URL is filled in
 * from `SITE_URL` here because `publishPost` runs without the Worker's env.
 */
export function webhookEnvelope(d: WebhookDelivery, env: Pick<Env, 'SITE_URL'>) {
  let data = d.payload
  const post = data.post as Record<string, unknown> | undefined
  if (post && post.url == null) {
    data = { ...data, post: { ...post, url: postUrl(env.SITE_URL, (post.slug as string) ?? null) } }
  }
  return { id: d.eventId, type: d.event, created_at: iso(d.occurredAt), data }
}

/** Seconds before attempt `attempt + 1`: 30 s, 2 min, 8 min, 32 min, … capped at 6 hours. */
export function backoffSeconds(attempt: number): number {
  return Math.min(Math.trunc(30 * 4 ** (attempt - 1)), 6 * 3600)
}

interface Judged {
  state: 'delivered' | 'pending' | 'failed'
  statusCode: number | null
  error: string | null
  response: string | null
}

async function attempt(
  env: Env,
  db: Db,
  d: WebhookDelivery,
  e: WebhookEndpoint,
  now: Date,
): Promise<Judged['state']> {
  const n = d.attempts + 1
  const last = n >= MAX_ATTEMPTS

  // ⭐ Count the attempt BEFORE the POST, with its backoff. If writing down the
  // answer afterwards fails, the row is already one attempt further on and
  // waits its backoff; it is not re-sent at every lease expiry, uncounted,
  // forever. The last attempt is pre-marked `failed` for the same reason: a
  // result that never lands must still end in a visible give-up (with its
  // Redeliver button), never a row that stays pending for good.
  await db
    .update(webhookDeliveries)
    .set({
      attempts: n,
      lastAttemptAt: now,
      nextAttemptAt: last ? null : new Date(now.getTime() + backoffSeconds(n) * 1000),
      ...(last ? { status: 'failed' as const, lastError: 'the result of the last attempt was never recorded' } : {}),
    })
    .where(eq(webhookDeliveries.id, d.id))

  let judged: Judged

  if (!e.isActive) {
    // Visible, and redeliverable once the endpoint is back on.
    judged = { state: 'failed', statusCode: null, error: 'the endpoint is switched off', response: null }
  } else {
    const url = checkWebhookUrl(e.url)
    if (!url.ok) {
      judged = {
        state: last ? 'failed' : 'pending',
        statusCode: null,
        error: `refused before sending: url ${url.reason}`,
        response: null,
      }
    } else {
      const body = JSON.stringify(webhookEnvelope(d, env))
      const t = Math.floor(now.getTime() / 1000)
      const res = await webhookTransportFor(env).post({
        url: url.url,
        body,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Kolea-Webhooks/1',
          'kolea-event': d.event,
          'kolea-event-id': d.eventId,
          'kolea-delivery-attempt': String(n),
          'kolea-signature': await signatureHeader(e.secret, body, t),
        },
      })
      if (res.ok && res.status >= 200 && res.status < 300) {
        judged = { state: 'delivered', statusCode: res.status, error: null, response: res.body.slice(0, 1000) }
      } else if (res.ok) {
        judged = {
          state: last ? 'failed' : 'pending',
          statusCode: res.status,
          error:
            res.status >= 300 && res.status < 400
              ? `the endpoint answered ${res.status}; redirects are not followed`
              : `the endpoint answered ${res.status}`,
          response: res.body.slice(0, 1000),
        }
      } else {
        judged = { state: last ? 'failed' : 'pending', statusCode: null, error: res.error.slice(0, 500), response: null }
      }
    }
  }

  await db
    .update(webhookDeliveries)
    .set({
      status: judged.state,
      attempts: n,
      lastAttemptAt: now,
      lastStatusCode: judged.statusCode,
      lastError: judged.error,
      lastResponse: judged.response,
      deliveredAt: judged.state === 'delivered' ? now : null,
      nextAttemptAt:
        judged.state === 'pending' ? new Date(now.getTime() + backoffSeconds(n) * 1000) : null,
    })
    .where(eq(webhookDeliveries.id, d.id))

  await settleEndpoint(db, e, judged.state, now)
  return judged.state
}

/**
 * A success resets the failure count; a give-up adds one, and too many switch
 * it off. Both are atomic on the row: deliveries to one endpoint settle in
 * parallel, so a count read earlier and written back would lose the others'.
 */
async function settleEndpoint(db: Db, e: WebhookEndpoint, state: Judged['state'], now: Date) {
  if (state === 'pending') return
  if (state === 'delivered') {
    await db
      .update(webhookEndpoints)
      .set({ consecutiveFailures: 0, lastDeliveredAt: now })
      .where(eq(webhookEndpoints.id, e.id))
    return
  }
  const [row] = await db
    .update(webhookEndpoints)
    .set({ consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1` })
    .where(and(eq(webhookEndpoints.id, e.id), eq(webhookEndpoints.isActive, true)))
    .returning({ failures: webhookEndpoints.consecutiveFailures })
  if (!row || row.failures < DISABLE_AFTER) return
  await db
    .update(webhookEndpoints)
    .set({
      isActive: false,
      disabledReason: `switched off after ${row.failures} failed deliveries in a row`,
      disabledAt: now,
    })
    .where(
      and(
        eq(webhookEndpoints.id, e.id),
        eq(webhookEndpoints.isActive, true),
        gte(webhookEndpoints.consecutiveFailures, DISABLE_AFTER),
      ),
    )
}

export interface DeliveryPass {
  claimed: number
  delivered: number
  retrying: number
  failed: number
}

/**
 * One page of due deliveries: claim, POST in parallel, record. Called by the
 * minutely cron with `limit` sized from what the tick's `QueryBudget` has left
 * (`DELIVERY_PASS_OVERHEAD` + `QUERIES_PER_DELIVERY` each). Mail goes first, so
 * in a minute a broadcast spends the budget, `limit` is 0 and nothing starts;
 * a backlog drains a page a minute, oldest first.
 */
export async function deliverDueWebhooks(
  env: Env,
  db: Db,
  opts: { limit?: number; now?: Date } = {},
): Promise<DeliveryPass> {
  const now = opts.now ?? new Date()
  const pass: DeliveryPass = { claimed: 0, delivered: 0, retrying: 0, failed: 0 }
  const limit = opts.limit ?? DELIVERY_PAGE
  if (limit <= 0) return pass

  const due = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now)))
    .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
    .limit(limit)
    .all()
  if (due.length === 0) return pass

  // The claim. Guarded on the same predicate, so a row another pass already
  // pushed forward is not ours.
  const claimed = await db
    .update(webhookDeliveries)
    .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
    .where(
      and(
        inArray(webhookDeliveries.id, due.map((d) => d.id)),
        eq(webhookDeliveries.status, 'pending'),
        lte(webhookDeliveries.nextAttemptAt, now),
      ),
    )
    .returning({ id: webhookDeliveries.id })
  if (claimed.length === 0) return pass

  const rows = await db
    .select({ d: webhookDeliveries, e: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(inArray(webhookDeliveries.id, claimed.map((c) => c.id)))
    .all()

  pass.claimed = rows.length
  const outcomes = await Promise.all(
    rows.map(async ({ d, e }) => {
      try {
        return await attempt(env, db, d, e, now)
      } catch {
        return 'pending' as const // the lease expires and a later pass tries again
      }
    }),
  )
  for (const o of outcomes) {
    if (o === 'delivered') pass.delivered++
    else if (o === 'failed') pass.failed++
    else pass.retrying++
  }
  return pass
}

/**
 * Send one delivery again, now, with a fresh set of attempts. The answer
 * lands on the row; returns it. Works on a delivered row too — a receiver
 * that lost its copy is a reason to ask.
 */
export async function redeliverWebhook(
  env: Env,
  db: Db,
  id: number,
): Promise<WebhookDelivery | null> {
  const row = await db
    .select({ d: webhookDeliveries, e: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(eq(webhookDeliveries.id, id))
    .get()
  if (!row) return null

  const now = new Date()
  const fresh = { ...row.d, attempts: 0, status: 'pending' as const }
  await db
    .update(webhookDeliveries)
    .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(now.getTime() + LEASE_MS), deliveredAt: null })
    .where(eq(webhookDeliveries.id, id))
  try {
    await attempt(env, db, fresh, row.e, now)
  } catch {
    // Leave it pending with the lease; the cron picks it up.
  }
  return (await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).get()) ?? null
}
