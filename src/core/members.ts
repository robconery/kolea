import { and, count, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  broadcasts,
  memberSessions,
  memberSignInLinks,
  memberSubscriptions,
  messages,
  premiumCheckouts,
  subscribers,
} from '../db/schema.ts'
import type { Env } from '../types.ts'
import { normalizeEmail, randomToken, sha256 } from './ids.ts'
import type { ViewerKind } from './member-access.ts'
import { EPHEMERAL_PREFIX, sendMessages } from './sending.ts'
import { loadSiteConfig } from './theme/site.ts'

/**
 * ⭐ Members: readers signing in on the public site (Kōlea SPEC 15.11).
 *
 * A member IS a subscriber; this module adds signing in and signing out, and
 * nothing here writes a consent record or a subscriber status (15.11.3). The
 * sign-in page never creates a subscriber either: an unknown address gets the
 * same answer as a known one and nothing else happens (15.11.2). New people
 * join through the site's ordinary signup form, where consent is collected.
 *
 * The link is system mail: a `messages` row of kind `transactional`, sent
 * through the one send path and its transactional consent rule (only a hard
 * bounce or a complaint stops it — an unsubscribed reader can still sign in).
 * The token is never stored: the row's body carries `{{sign_in_link}}` and the
 * real link rides in memory for the one send (`SendOptions.extras`).
 *
 * The provider is called with no write half-done: the link row is committed
 * first, then the mail goes, then the row records what happened. A link whose
 * mail did not go has its token hash cleared, so it can never be used.
 */

export const LINK_MINUTES = 20
export const SESSION_DAYS = 60
/** Links one address may be sent in an hour. Over it, the request is recorded and not mailed. */
export const LINKS_PER_ADDRESS_PER_HOUR = 5
/** Sign-in links and Premium checkouts together, per IP per hour (SPEC 16.7.2.1). */
export const REQUESTS_PER_IP_PER_HOUR = 20

const HOUR = 3_600_000
const DAY = 86_400_000

/** Members exist only with a public site and a secret to sign sessions with. */
export function membersEnabled(env: Env): boolean {
  return Boolean(env.SITE_URL && env.MEMBER_SESSION_SECRET)
}

// ───────────────────────────────────────────────── limits

/**
 * Sign-in links and Premium checkouts one IP started since `since`. One count
 * for both, so an "already premium" answer on the Premium form and a sign-in
 * request are bounded by the same limit whichever way a probe goes.
 */
export async function requestsFromIpSince(db: Db, ip: string | null, since: Date): Promise<number> {
  if (!ip) return 0
  const [links, checkouts] = await Promise.all([
    db
      .select({ n: count() })
      .from(memberSignInLinks)
      .where(and(eq(memberSignInLinks.requestedIp, ip), gt(memberSignInLinks.createdAt, since)))
      .get(),
    db
      .select({ n: count() })
      .from(premiumCheckouts)
      .where(and(eq(premiumCheckouts.ip, ip), gt(premiumCheckouts.createdAt, since)))
      .get(),
  ])
  return (links?.n ?? 0) + (checkouts?.n ?? 0)
}

// ───────────────────────────────────────────────── asking for a link

export interface SignInRequest {
  email: string
  ip?: string | null
  userAgent?: string | null
  /** The slug of the post the reader was on. Unknown slugs are ignored. */
  fromSlug?: string | null
  now?: Date
}

/**
 * What happened. The page shows the same "check your inbox" for every one of
 * these but `disabled`; the distinction exists for the rows and the tests.
 */
export type SignInRequestOutcome = 'sent' | 'unknown' | 'throttled' | 'blocked' | 'failed' | 'disabled'

export async function requestSignIn(env: Env, db: Db, req: SignInRequest): Promise<SignInRequestOutcome> {
  if (!membersEnabled(env)) return 'disabled'
  const now = req.now ?? new Date()
  const ip = req.ip ?? null

  // Counted before the address is looked at, so the answer over the limit is
  // the same for every address.
  if ((await requestsFromIpSince(db, ip, new Date(now.getTime() - HOUR))) >= REQUESTS_PER_IP_PER_HOUR) {
    return 'throttled'
  }

  const email = normalizeEmail(req.email ?? '')
  const sub = email
    ? await db
        .select({ id: subscribers.id, email: subscribers.email })
        .from(subscribers)
        .where(eq(subscribers.email, email))
        .get()
    : undefined
  if (!sub) return 'unknown'

  const returnPostId = req.fromSlug ? await publishedPostId(db, req.fromSlug) : null
  const base = {
    subscriberId: sub.id,
    returnPostId,
    requestedIp: ip,
    requestedUserAgent: req.userAgent ? req.userAgent.slice(0, 400) : null,
    createdAt: now,
  }

  const recent = await db
    .select({ n: count() })
    .from(memberSignInLinks)
    .where(
      and(
        eq(memberSignInLinks.subscriberId, sub.id),
        gt(memberSignInLinks.createdAt, new Date(now.getTime() - HOUR)),
        inArray(memberSignInLinks.status, ['sent', 'used', 'requested']),
      ),
    )
    .get()
  if ((recent?.n ?? 0) >= LINKS_PER_ADDRESS_PER_HOUR) {
    await db.insert(memberSignInLinks).values({ ...base, status: 'throttled' })
    return 'throttled'
  }

  // 1. The link, committed with its token's hash, before anything is sent.
  const token = randomToken(40)
  const [link] = await db
    .insert(memberSignInLinks)
    .values({
      ...base,
      status: 'requested',
      tokenHash: await sha256(token),
      expiresAt: new Date(now.getTime() + LINK_MINUTES * 60_000),
    })
    .returning({ id: memberSignInLinks.id })
  const linkId = link!.id

  // 2. The system mail: a messages row, through the one send path.
  const cfg = await loadSiteConfig(db, env)
  const url = `${cfg.origin}/members/verify?token=${token}`
  const [msg] = await db
    .insert(messages)
    .values({
      subscriberId: sub.id,
      kind: 'transactional',
      toEmail: sub.email,
      subject: `Your sign-in link for ${cfg.title}`,
      bodyMd: signInBody(cfg.title),
      status: 'queued',
      idempotencyKey: `${EPHEMERAL_PREFIX}member-sign-in:${linkId}`,
      createdAt: now,
    })
    .returning({ id: messages.id })
  const messageId = msg!.id
  await db.update(memberSignInLinks).set({ messageId }).where(eq(memberSignInLinks.id, linkId))

  const outcomes = await sendMessages(env, db, [messageId], {
    extras: new Map([[messageId, { sign_in_link: url }]]),
  })
  const outcome = outcomes.get(messageId)

  // 3. Record what happened. Anything but `sent` clears the hash: that link is dead.
  if (outcome?.status === 'sent') {
    await db.update(memberSignInLinks).set({ status: 'sent' }).where(eq(memberSignInLinks.id, linkId))
    return 'sent'
  }
  if (outcome?.status === 'suppressed') {
    await db
      .update(memberSignInLinks)
      .set({ status: 'blocked', tokenHash: null, blockedReason: outcome.reason })
      .where(eq(memberSignInLinks.id, linkId))
    return 'blocked'
  }
  // A retryable failure put the message back to `queued`. Nothing can ever send
  // it with the link (the token is gone), so close it as failed — visibly — and
  // let the reader ask again.
  const error = outcome?.status === 'failed' ? outcome.error : 'not sent'
  await db
    .update(messages)
    .set({ status: 'failed', error: `sign-in link not delivered: ${error}`.slice(0, 500), claimedAt: null })
    .where(and(eq(messages.id, messageId), eq(messages.status, 'queued')))
  await db
    .update(memberSignInLinks)
    .set({ status: 'failed', tokenHash: null, blockedReason: error.slice(0, 200) })
    .where(eq(memberSignInLinks.id, linkId))
  return 'failed'
}

function signInBody(title: string): string {
  return [
    `Here is your link to sign in to ${title}. It works once, for the next ${LINK_MINUTES} minutes.`,
    '',
    '[Sign in]({{sign_in_link}})',
    '',
    'If you did not ask for this, ignore it. Nothing happens without the link.',
  ].join('\n')
}

async function publishedPostId(db: Db, slug: string): Promise<number | null> {
  const row = await db
    .select({ id: broadcasts.id, publishedAt: broadcasts.publishedAt })
    .from(broadcasts)
    .where(eq(broadcasts.slug, slug))
    .get()
  return row?.publishedAt ? row.id : null
}

// ───────────────────────────────────────────────── using the link

/** Junk never reaches a query. */
function tokenShape(token: unknown): token is string {
  return typeof token === 'string' && /^[a-z0-9]{20,80}$/.test(token)
}

/**
 * Whether a link would sign somebody in, without spending it. The link opens a
 * confirmation page whose button signs in, so a mail scanner that fetches the
 * link spends nothing.
 */
export async function signInLinkIsLive(db: Db, token: unknown, now = new Date()): Promise<boolean> {
  if (!tokenShape(token)) return false
  const row = await db
    .select({ status: memberSignInLinks.status, expiresAt: memberSignInLinks.expiresAt })
    .from(memberSignInLinks)
    .where(eq(memberSignInLinks.tokenHash, await sha256(token)))
    .get()
  return Boolean(row && row.status === 'sent' && row.expiresAt && row.expiresAt > now)
}

export type SignInResult =
  | { ok: true; cookieValue: string; subscriberId: number; returnTo: string | null }
  | { ok: false }

/**
 * Spend a link and open a session. Single use by construction: the link is
 * claimed by one conditional UPDATE (`status = 'sent'` and unexpired), so two
 * clicks racing each other get one session between them.
 */
export async function signIn(
  env: Env,
  db: Db,
  input: { token: unknown; ip?: string | null; userAgent?: string | null; now?: Date },
): Promise<SignInResult> {
  const secret = env.MEMBER_SESSION_SECRET
  if (!secret || !tokenShape(input.token)) return { ok: false }
  const now = input.now ?? new Date()

  const claimed = await db
    .update(memberSignInLinks)
    .set({ status: 'used', usedAt: now, tokenHash: null })
    .where(
      and(
        eq(memberSignInLinks.tokenHash, await sha256(input.token)),
        eq(memberSignInLinks.status, 'sent'),
        gt(memberSignInLinks.expiresAt, now),
      ),
    )
    .returning({
      id: memberSignInLinks.id,
      subscriberId: memberSignInLinks.subscriberId,
      returnPostId: memberSignInLinks.returnPostId,
    })
  const link = claimed[0]
  if (!link) return { ok: false }

  const token = randomToken(40)
  await db.insert(memberSessions).values({
    subscriberId: link.subscriberId,
    tokenHash: await sha256(token),
    signInLinkId: link.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ? input.userAgent.slice(0, 400) : null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_DAYS * DAY),
    lastSeenAt: now,
  })

  let returnTo: string | null = null
  if (link.returnPostId) {
    const post = await db
      .select({ slug: broadcasts.slug, publishedAt: broadcasts.publishedAt })
      .from(broadcasts)
      .where(eq(broadcasts.id, link.returnPostId))
      .get()
    // The bare slug: the site redirects it to the post's canonical path.
    if (post?.slug && post.publishedAt) returnTo = `/${post.slug}`
  }

  return { ok: true, cookieValue: await seal(secret, token), subscriberId: link.subscriberId, returnTo }
}

// ───────────────────────────────────────────────── the session cookie

/**
 * `__Host-` wherever the cookie is `Secure`, so no other host under the same
 * domain can set it. Plain `http://site.localhost` in dev cannot use the prefix.
 */
export function sessionCookieName(env: Env): string {
  return sessionCookieSecure(env) ? '__Host-kolea_member' : 'kolea_member'
}

export function sessionCookieSecure(env: Env): boolean {
  return (env.SITE_URL ?? '').startsWith('https://')
}

export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 86_400

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function seal(secret: string, token: string): Promise<string> {
  return `${token}.${await hmac(secret, token)}`
}

async function unseal(secret: string, value: string | undefined | null): Promise<string | null> {
  if (!value) return null
  const dot = value.indexOf('.')
  if (dot <= 0) return null
  const token = value.slice(0, dot)
  if (!tokenShape(token)) return null
  const expected = await hmac(secret, token)
  const given = value.slice(dot + 1)
  if (given.length !== expected.length) return null
  let diff = 0
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0 ? token : null
}

// ───────────────────────────────────────────────── who is reading

export interface Viewer {
  kind: ViewerKind
  subscriberId: number | null
  email: string | null
}

export const ANONYMOUS: Viewer = { kind: 'anonymous', subscriberId: null, email: null }

/** Whether a subscriber holds a live (`active`) Premium subscription right now. */
export async function isPremium(db: Db, subscriberId: number): Promise<boolean> {
  const row = await db
    .select({ id: memberSubscriptions.id })
    .from(memberSubscriptions)
    .where(and(eq(memberSubscriptions.subscriberId, subscriberId), eq(memberSubscriptions.status, 'active')))
    .get()
  return Boolean(row)
}

/** The reader behind a session cookie, or `ANONYMOUS`. Never throws. */
export async function viewerFromCookie(
  env: Env,
  db: Db,
  cookieValue: string | undefined | null,
  now = new Date(),
): Promise<Viewer> {
  const secret = env.MEMBER_SESSION_SECRET
  if (!secret || !cookieValue) return ANONYMOUS
  const token = await unseal(secret, cookieValue)
  if (!token) return ANONYMOUS

  const row = await db
    .select({
      sessionId: memberSessions.id,
      lastSeenAt: memberSessions.lastSeenAt,
      subscriberId: subscribers.id,
      email: subscribers.email,
    })
    .from(memberSessions)
    .innerJoin(subscribers, eq(subscribers.id, memberSessions.subscriberId))
    .where(
      and(
        eq(memberSessions.tokenHash, await sha256(token)),
        isNull(memberSessions.revokedAt),
        gt(memberSessions.expiresAt, now),
      ),
    )
    .get()
  if (!row) return ANONYMOUS

  if (now.getTime() - row.lastSeenAt.getTime() > DAY) {
    await db.update(memberSessions).set({ lastSeenAt: now }).where(eq(memberSessions.id, row.sessionId))
  }

  const premium = await isPremium(db, row.subscriberId)
  return { kind: premium ? 'premium' : 'member', subscriberId: row.subscriberId, email: row.email }
}

/** Revoke the session behind a cookie. Idempotent; an unknown cookie is a no-op. */
export async function signOut(env: Env, db: Db, cookieValue: string | undefined | null): Promise<void> {
  const secret = env.MEMBER_SESSION_SECRET
  if (!secret) return
  const token = await unseal(secret, cookieValue)
  if (!token) return
  await db
    .update(memberSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(memberSessions.tokenHash, await sha256(token)), isNull(memberSessions.revokedAt)))
}

// ───────────────────────────────────────────────── the admin's view

export interface MemberRow {
  subscriberId: number
  email: string
  name: string | null
  status: string
  lastSeenAt: Date | null
  premium: {
    status: 'active' | 'past_due' | 'canceled'
    interval: 'month' | 'year'
    amountCents: number
    currency: string
    since: Date
    cancelAtPeriodEnd: boolean
    postId: number | null
    postSubject: string | null
    postSlug: string | null
  } | null
}

/** Ids per `inArray`, under D1's 100-parameter cap. */
const ID_CHUNK = 90

/**
 * Everyone who has signed in or paid, newest activity first, with their Premium
 * state and the post that converted them. Bounded: this is a screen, not an export.
 */
export async function listMembers(db: Db, limit = 200): Promise<MemberRow[]> {
  const signedIn = db.select({ id: memberSessions.subscriberId }).from(memberSessions)
  const paid = db.select({ id: memberSubscriptions.subscriberId }).from(memberSubscriptions)
  const people = await db
    .select({ id: subscribers.id, email: subscribers.email, name: subscribers.name, status: subscribers.status })
    .from(subscribers)
    .where(or(inArray(subscribers.id, signedIn), inArray(subscribers.id, paid)))
    .orderBy(desc(subscribers.id))
    .limit(limit)
    .all()
  if (!people.length) return []
  // D1 binds at most 100 parameters and `limit` defaults to 200 people, so the
  // two lookups below go in chunks. A person's rows all land in one chunk.
  const chunks: number[][] = []
  for (let i = 0; i < people.length; i += ID_CHUNK) chunks.push(people.slice(i, i + ID_CHUNK).map((p) => p.id))

  const sessions = (
    await Promise.all(
      chunks.map((ids) =>
        db
          .select({ subscriberId: memberSessions.subscriberId, lastSeenAt: memberSessions.lastSeenAt })
          .from(memberSessions)
          .where(inArray(memberSessions.subscriberId, ids))
          .all(),
      ),
    )
  ).flat()
  const seen = new Map<number, Date>()
  for (const s of sessions) {
    const prev = seen.get(s.subscriberId)
    if (!prev || s.lastSeenAt > prev) seen.set(s.subscriberId, s.lastSeenAt)
  }

  const subs = (
    await Promise.all(
      chunks.map((ids) =>
        db
          .select({
            id: memberSubscriptions.id,
            subscriberId: memberSubscriptions.subscriberId,
            status: memberSubscriptions.status,
            interval: memberSubscriptions.interval,
            amountCents: memberSubscriptions.amountCents,
            currency: memberSubscriptions.currency,
            createdAt: memberSubscriptions.createdAt,
            cancelAtPeriodEnd: memberSubscriptions.cancelAtPeriodEnd,
            postId: memberSubscriptions.convertedFromPostId,
            postSubject: broadcasts.subject,
            postSlug: broadcasts.slug,
          })
          .from(memberSubscriptions)
          .leftJoin(broadcasts, eq(broadcasts.id, memberSubscriptions.convertedFromPostId))
          .where(inArray(memberSubscriptions.subscriberId, ids))
          .orderBy(desc(memberSubscriptions.id))
          .all(),
      ),
    )
  ).flat()
  // The newest row per person: a live one if they have one, else their last.
  const latest = new Map<number, (typeof subs)[number]>()
  for (const s of subs) {
    const cur = latest.get(s.subscriberId)
    if (!cur || (cur.status === 'canceled' && s.status !== 'canceled')) latest.set(s.subscriberId, s)
  }

  return people.map((p) => {
    const s = latest.get(p.id)
    return {
      subscriberId: p.id,
      email: p.email,
      name: p.name,
      status: p.status,
      lastSeenAt: seen.get(p.id) ?? null,
      premium: s
        ? {
            status: s.status,
            interval: s.interval,
            amountCents: s.amountCents,
            currency: s.currency,
            since: s.createdAt,
            cancelAtPeriodEnd: s.cancelAtPeriodEnd,
            postId: s.postId,
            postSubject: s.postSubject,
            postSlug: s.postSlug,
          }
        : null,
    }
  })
}
