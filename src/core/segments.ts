import { type SQL, and, asc, count, eq, gt, gte, inArray, lte, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  type SegmentRule,
  type Tag,
  broadcasts,
  segments,
  subscriberTags,
  subscribers,
} from '../db/schema.ts'
import { slugify } from './ids.ts'

export type { SegmentRule }

/** Rows resolved per invocation. Keeps us clear of D1's per-invocation query cap. */
const PAGE = 400

/**
 * Build the WHERE clauses for a rule.
 *
 * Shared by `resolveSegment` and `countSegment` so the number shown next to a
 * broadcast can never drift from the people it actually sends to.
 */
function ruleFilters(db: Db, rule: SegmentRule): SQL[] {
  const filters: SQL[] = [eq(subscribers.status, 'active')]

  const include = rule.includeTagIds ?? []
  if (include.length) {
    const tagged = db
      .select({ id: subscriberTags.subscriberId })
      .from(subscriberTags)
      .where(inArray(subscriberTags.tagId, include))

    if (rule.match === 'all' && include.length > 1) {
      // Must carry every tag, not just one of them.
      filters.push(
        inArray(
          subscribers.id,
          tagged
            .groupBy(subscriberTags.subscriberId)
            .having(sql`count(distinct ${subscriberTags.tagId}) = ${include.length}`),
        ),
      )
    } else {
      filters.push(inArray(subscribers.id, tagged))
    }
  }

  if (rule.excludeTagIds?.length) {
    const excluded = db
      .select({ id: subscriberTags.subscriberId })
      .from(subscriberTags)
      .where(inArray(subscriberTags.tagId, rule.excludeTagIds))
    filters.push(notInArray(subscribers.id, excluded))
  }

  if (rule.joinedAfter) filters.push(gte(subscribers.createdAt, new Date(rule.joinedAfter)))
  if (rule.joinedBefore) filters.push(lte(subscribers.createdAt, new Date(rule.joinedBefore)))

  return filters
}

/**
 * Resolve a rule to eligible broadcast recipients, after `afterId`.
 *
 * Broadcast eligibility only — sequence eligibility is a different question with
 * a different answer (see `consent.ts`).
 */
export async function resolveSegment(
  db: Db,
  rule: SegmentRule,
  afterId = 0,
  limit = PAGE,
): Promise<{ id: number; email: string; status: string }[]> {
  return await db
    .select({ id: subscribers.id, email: subscribers.email, status: subscribers.status })
    .from(subscribers)
    .where(and(...ruleFilters(db, rule), gt(subscribers.id, afterId)))
    .orderBy(asc(subscribers.id))
    .limit(limit)
    .all()
}

export async function countSegment(db: Db, rule: SegmentRule): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(subscribers)
    .where(and(...ruleFilters(db, rule)))
    .get()
  return row?.n ?? 0
}

// ───────────────────────────────────────────────── saved segments

export async function listSegments(db: Db) {
  return await db.select().from(segments).orderBy(asc(segments.name)).all()
}

export async function getSegment(db: Db, id: number) {
  return await db.select().from(segments).where(eq(segments.id, id)).get()
}

export async function createSegment(db: Db, name: string, rule: SegmentRule): Promise<number> {
  const inserted = await db
    .insert(segments)
    .values({ slug: await uniqueSlug(db, name), name, rule, createdAt: new Date() })
    .returning({ id: segments.id })
  return inserted[0]!.id
}

export async function updateSegment(
  db: Db,
  id: number,
  name: string,
  rule: SegmentRule,
): Promise<void> {
  await db.update(segments).set({ name, rule }).where(eq(segments.id, id))
}

export async function deleteSegment(db: Db, id: number): Promise<void> {
  await db.delete(segments).where(eq(segments.id, id))
}

/** Slugs are unique; a second "Customers" becomes `customers-2` rather than failing. */
async function uniqueSlug(db: Db, name: string): Promise<string> {
  const base = slugify(name) || 'segment'
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    const clash = await db.select({ id: segments.id }).from(segments).where(eq(segments.slug, slug)).get()
    if (!clash) return slug
  }
  return `${base}-${Date.now()}`
}

/** Point a rule's tag references at a different tag. Null when nothing changed. */
export function swapTagInRule(
  rule: SegmentRule,
  fromTagId: number,
  intoTagId: number,
): SegmentRule | null {
  const swap = (ids?: number[]) =>
    ids?.length ? [...new Set(ids.map((id) => (id === fromTagId ? intoTagId : id)))] : ids

  const next: SegmentRule = {
    ...rule,
    includeTagIds: swap(rule.includeTagIds),
    excludeTagIds: swap(rule.excludeTagIds),
  }
  return JSON.stringify(next) === JSON.stringify(rule) ? null : next
}

/**
 * Rewrite tag references after a merge, so merging `Customer` into `customers`
 * doesn't quietly leave segments pointing at a tag that no longer exists.
 */
export async function retagSegments(db: Db, fromTagId: number, intoTagId: number): Promise<number> {
  const all = await db.select().from(segments).all()
  let touched = 0

  for (const s of all) {
    const next = swapTagInRule(s.rule, fromTagId, intoTagId)
    if (!next) continue
    await db.update(segments).set({ rule: next }).where(eq(segments.id, s.id))
    touched++
  }
  return touched
}

/**
 * Same repointing for broadcasts that haven't gone out yet.
 *
 * Drafts only — a sent broadcast's stored rule is a record of who it went to,
 * and rewriting that would be falsifying history.
 */
export async function retagDraftBroadcasts(
  db: Db,
  fromTagId: number,
  intoTagId: number,
): Promise<number> {
  const drafts = await db
    .select({ id: broadcasts.id, segment: broadcasts.segment })
    .from(broadcasts)
    .where(eq(broadcasts.status, 'draft'))
    .all()
  let touched = 0

  for (const b of drafts) {
    const next = swapTagInRule(b.segment ?? {}, fromTagId, intoTagId)
    if (!next) continue
    await db.update(broadcasts).set({ segment: next }).where(eq(broadcasts.id, b.id))
    touched++
  }
  return touched
}

/** Plain-English rule summary for tables and audience labels. */
export function describeRule(rule: SegmentRule, tags: Pick<Tag, 'id' | 'name'>[]): string {
  const name = (id: number) => tags.find((t) => t.id === id)?.name ?? `tag ${id}`
  const parts: string[] = []

  if (rule.includeTagIds?.length) {
    const joiner = rule.match === 'all' ? ' and ' : ' or '
    parts.push(`tagged ${rule.includeTagIds.map(name).join(joiner)}`)
  }
  if (rule.excludeTagIds?.length) {
    parts.push(`not tagged ${rule.excludeTagIds.map(name).join(' or ')}`)
  }
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { dateStyle: 'medium' })
  if (rule.joinedAfter) parts.push(`joined after ${day(rule.joinedAfter)}`)
  if (rule.joinedBefore) parts.push(`joined before ${day(rule.joinedBefore)}`)

  return parts.length === 0 ? 'Everyone active' : `Active, ${parts.join(', ')}`
}
