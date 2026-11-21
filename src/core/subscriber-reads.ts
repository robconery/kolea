import { type SQL, and, desc, eq, inArray, like, or } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { sequenceEnrollments, sequences, subscriberTags, subscribers, tags } from '../db/schema.ts'
import { preferencesFor } from './consent.ts'
import { fieldsOf } from './fields.ts'
import { normalizeEmail } from './ids.ts'

/**
 * Reading people, for every door that lists or shows them (MCP, the REST API).
 *
 * ⭐ Nothing here ever selects `unsub_token`. That token is the reader's own
 * key to their preference center; it goes out inside their mail and nowhere
 * else. A list endpoint that returned it would let any `read` key unsubscribe
 * the whole list.
 */

export const SUBSCRIBER_STATUSES = ['pending', 'active', 'unsubscribed', 'bounced', 'complained'] as const
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number]

/** The public columns of a subscriber. Spread-safe: no token. */
const COLUMNS = {
  id: subscribers.id,
  email: subscribers.email,
  name: subscribers.name,
  status: subscribers.status,
  source: subscribers.source,
  createdAt: subscribers.createdAt,
  confirmedAt: subscribers.confirmedAt,
  unsubscribedAt: subscribers.unsubscribedAt,
}

export interface SubscriberQuery {
  /** Substring of email or name. */
  query?: string
  status?: SubscriberStatus
  tagId?: number
  limit: number
  offset?: number
}

/**
 * Newest first, one query, plus one for the page's tags. `limit` is the caller's
 * page size; ask for one more than you show to learn whether a next page exists.
 */
export async function searchSubscribers(db: Db, q: SubscriberQuery) {
  const filters: (SQL | undefined)[] = []
  if (q.query) {
    const pattern = `%${q.query.toLowerCase()}%`
    filters.push(or(like(subscribers.email, pattern), like(subscribers.name, pattern)))
  }
  if (q.status) filters.push(eq(subscribers.status, q.status))

  const base = db.select(COLUMNS).from(subscribers)
  const rows = q.tagId
    ? await base
        .innerJoin(subscriberTags, eq(subscriberTags.subscriberId, subscribers.id))
        .where(and(eq(subscriberTags.tagId, q.tagId), ...filters))
        .orderBy(desc(subscribers.createdAt), desc(subscribers.id))
        .limit(q.limit)
        .offset(q.offset ?? 0)
        .all()
    : await base
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(subscribers.createdAt), desc(subscribers.id))
        .limit(q.limit)
        .offset(q.offset ?? 0)
        .all()

  const tagRows = rows.length
    ? await db
        .select({ subscriberId: subscriberTags.subscriberId, id: tags.id, name: tags.name })
        .from(subscriberTags)
        .innerJoin(tags, eq(tags.id, subscriberTags.tagId))
        .where(
          inArray(
            subscriberTags.subscriberId,
            rows.map((r) => r.id),
          ),
        )
        .all()
    : []

  return rows.map((r) => ({
    ...r,
    tags: tagRows.filter((t) => t.subscriberId === r.id).map(({ id, name }) => ({ id, name })),
  }))
}

/** One person by id or address, or null. No token. */
export async function findSubscriber(db: Db, ref: { id?: number; email?: string }) {
  if (ref.id) return (await db.select(COLUMNS).from(subscribers).where(eq(subscribers.id, ref.id)).get()) ?? null
  if (ref.email) {
    return (
      (await db
        .select(COLUMNS)
        .from(subscribers)
        .where(eq(subscribers.email, normalizeEmail(ref.email)))
        .get()) ?? null
    )
  }
  return null
}

/**
 * One person in full: tags, custom field values (every defined field, null
 * where they have none), consent per scope, and sequence enrollments.
 */
export async function subscriberDetail(db: Db, id: number) {
  const sub = await findSubscriber(db, { id })
  if (!sub) return null
  const row = await db
    .select({ attributes: subscribers.attributes })
    .from(subscribers)
    .where(eq(subscribers.id, id))
    .get()

  const [tagList, enrollments] = await Promise.all([
    db
      .select({ id: tags.id, name: tags.name, slug: tags.slug })
      .from(subscriberTags)
      .innerJoin(tags, eq(tags.id, subscriberTags.tagId))
      .where(eq(subscriberTags.subscriberId, id))
      .all(),
    db
      .select({
        sequenceId: sequences.id,
        sequence: sequences.name,
        status: sequenceEnrollments.status,
        nextRunAt: sequenceEnrollments.nextRunAt,
      })
      .from(sequenceEnrollments)
      .innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequenceId))
      .where(eq(sequenceEnrollments.subscriberId, id))
      .all(),
  ])

  return {
    ...sub,
    tags: tagList,
    fields: await fieldsOf(db, row?.attributes),
    enrollments,
    preferences: await preferencesFor(db, id),
  }
}
