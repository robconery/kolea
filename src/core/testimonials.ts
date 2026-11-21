import { and, count, desc, eq, gte } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { type Testimonial, subscribers, testimonials } from '../db/schema.ts'

/**
 * Testimonials.
 *
 * How one arrives: a marketing mail says `{{testimonial_link}}`, which
 * `renderEmail` turns into `/p/<unsub_token>/testimonial` for that reader. The
 * token is the proof of who they are, the same proof the preference centre
 * already rests on, so there is no address field and no confirmation mail.
 * Transactional mail resolves the tag to nothing (the ask is marketing),
 * and the public web renderer resolves it to the wall, never to a personal link.
 *
 * The person owns `may_publish`; the operator owns `status`. The wall shows only
 * what both said yes to. See the `testimonials` table for the shape.
 */

export const NAME_MAX = 80
export const BODY_MIN = 10
export const BODY_MAX = 2000
/** Submissions one subscriber may make per rolling day. */
export const DAILY_LIMIT = 3
const DAY = 24 * 60 * 60 * 1000

export type SubmitResult =
  | { ok: true; id: number }
  | { ok: false; reason: 'not_found' | 'invalid' | 'rate_limited'; message: string }

export interface SubmitInput {
  displayName: string
  body: string
  mayPublish: boolean
}

/** Collapse runs of spaces on one line; keep the writer's paragraph breaks. */
function clean(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The subscriber a personal link belongs to, or null. */
export async function subscriberForToken(db: Db, token: string) {
  if (!token || token.length > 128) return null
  return (
    (await db
      .select({ id: subscribers.id, name: subscribers.name })
      .from(subscribers)
      .where(eq(subscribers.unsubToken, token))
      .get()) ?? null
  )
}

/**
 * A reader writes a testimonial through their personal link. Arrives
 * `pending`; nothing is public until the operator approves it.
 */
export async function submitTestimonial(
  db: Db,
  token: string,
  input: SubmitInput,
  now = new Date(),
): Promise<SubmitResult> {
  const sub = await subscriberForToken(db, token)
  if (!sub) return { ok: false, reason: 'not_found', message: 'This link is no longer valid.' }

  const displayName = clean(input.displayName).replace(/\n/g, ' ')
  const body = clean(input.body)
  if (!displayName || displayName.length > NAME_MAX) {
    return { ok: false, reason: 'invalid', message: `Your name needs 1 to ${NAME_MAX} characters.` }
  }
  if (body.length < BODY_MIN || body.length > BODY_MAX) {
    return {
      ok: false,
      reason: 'invalid',
      message: `What you wrote needs ${BODY_MIN} to ${BODY_MAX} characters.`,
    }
  }

  const recent =
    (
      await db
        .select({ n: count() })
        .from(testimonials)
        .where(
          and(
            eq(testimonials.subscriberId, sub.id),
            gte(testimonials.createdAt, new Date(now.getTime() - DAY)),
          ),
        )
        .get()
    )?.n ?? 0
  if (recent >= DAILY_LIMIT) {
    return {
      ok: false,
      reason: 'rate_limited',
      message: 'Thank you, we already have what you wrote today. Try again tomorrow.',
    }
  }

  const [row] = await db
    .insert(testimonials)
    .values({
      subscriberId: sub.id,
      displayName,
      body,
      mayPublish: input.mayPublish,
      status: 'pending',
      createdAt: now,
    })
    .returning({ id: testimonials.id })
  return { ok: true, id: row!.id }
}

export type Decision = 'approve' | 'hide'

/**
 * The operator's moderation. Approving needs the writer's permission: what they
 * did not allow to be published stays off the wall whatever the operator wants.
 */
export async function decideTestimonial(
  db: Db,
  id: number,
  decision: Decision,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'no_publish_consent' }> {
  const row = await db.select().from(testimonials).where(eq(testimonials.id, id)).get()
  if (!row) return { ok: false, reason: 'not_found' }
  if (decision === 'approve' && !row.mayPublish) return { ok: false, reason: 'no_publish_consent' }
  await db
    .update(testimonials)
    .set({ status: decision === 'approve' ? 'approved' : 'hidden', decidedAt: new Date() })
    .where(eq(testimonials.id, id))
  return { ok: true }
}

export async function deleteTestimonial(db: Db, id: number): Promise<boolean> {
  const gone = await db
    .delete(testimonials)
    .where(eq(testimonials.id, id))
    .returning({ id: testimonials.id })
  return gone.length > 0
}

/** The admin inbox: everything, newest first, with who wrote it. */
export async function listTestimonials(db: Db, limit = 200) {
  return await db
    .select({ testimonial: testimonials, email: subscribers.email })
    .from(testimonials)
    .innerJoin(subscribers, eq(subscribers.id, testimonials.subscriberId))
    .orderBy(desc(testimonials.createdAt), desc(testimonials.id))
    .limit(limit)
    .all()
}

export interface WallCard {
  displayName: string
  body: string
  createdAt: Date
}

/** The public wall. Approved and allowed, and nothing a stranger may not see. */
export async function wall(db: Db, limit = 100): Promise<WallCard[]> {
  return await db
    .select({
      displayName: testimonials.displayName,
      body: testimonials.body,
      createdAt: testimonials.createdAt,
    })
    .from(testimonials)
    .where(and(eq(testimonials.status, 'approved'), eq(testimonials.mayPublish, true)))
    .orderBy(desc(testimonials.decidedAt), desc(testimonials.id))
    .limit(limit)
    .all()
}

export type { Testimonial }
