import { and, desc, eq, isNotNull, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { broadcasts } from '../db/schema.ts'
import { slugify } from './ids.ts'
import { excerptFrom, firstImageFrom, postPlainText } from './render-web.ts'

/**
 * Publishing — the public site's half of a broadcast.
 *
 * A post is a broadcast with `published_at` set. That is the whole model: the
 * piece is written once, mailed to the list, and then (separately, deliberately)
 * put on the web. Nothing here touches the send lifecycle — `status`,
 * `scheduled_at`, `cursor_subscriber_id` and the segment are never written by
 * this module, so publishing an in-flight broadcast cannot disturb the send and
 * unpublishing one cannot un-send it.
 *
 * Publishing is always one post at a time and always explicit. There is no
 * "publish everything" here on purpose: the archive imported from Kit is
 * hundreds of `sent` broadcasts, and a bulk publish would put years of mail on a
 * public URL in one keystroke.
 */

export interface PostMeta {
  /** Omit to derive from the subject. */
  slug?: string | null
  /** Omit to derive from the body. */
  excerpt?: string | null
  featureImage?: string | null
}

/** Where a featured image came from, and who is owed the credit. */
export interface FeatureImage {
  url: string
  /** Photographer's name — set for Unsplash, null for an upload. */
  credit?: string | null
  creditUrl?: string | null
}

export interface Post {
  id: number
  subject: string
  slug: string
  excerpt: string | null
  featureImage: string | null
  featureImageCredit: string | null
  featureImageCreditUrl: string | null
  publishedAt: Date
  bodyJson: (typeof broadcasts.$inferSelect)['bodyJson']
  bodyMd: string
}

/** Only these columns leave the module — a post is a *page*, not a broadcast. */
const postColumns = {
  id: broadcasts.id,
  subject: broadcasts.subject,
  slug: broadcasts.slug,
  excerpt: broadcasts.excerpt,
  featureImage: broadcasts.featureImage,
  featureImageCredit: broadcasts.featureImageCredit,
  featureImageCreditUrl: broadcasts.featureImageCreditUrl,
  publishedAt: broadcasts.publishedAt,
  bodyJson: broadcasts.bodyJson,
  bodyMd: broadcasts.bodyMd,
}

/** `published_at is not null` is the only thing that makes a row public. */
const isPublished = isNotNull(broadcasts.publishedAt)

/**
 * Put a broadcast on the web. Idempotent: re-publishing an already-published
 * post refreshes its metadata and keeps its original `published_at`, so a typo
 * fix doesn't jump the post back to the top of the archive.
 */
export async function publishPost(db: Db, id: number, meta: PostMeta = {}): Promise<Post> {
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) throw new Error(`no broadcast ${id}`)

  const body = { json: b.bodyJson, md: b.bodyMd }
  const text = postPlainText(body)

  // The slug is sticky once assigned. Re-deriving it from the subject on every
  // save would break every link anyone has ever shared the moment a title is
  // tidied up.
  const slug = await uniqueSlug(db, id, meta.slug ?? b.slug ?? b.subject)

  const excerpt = (meta.excerpt ?? b.excerpt ?? excerptFrom(text)) || null
  // Derived only as a last resort, and a derived image carries no credit — it is
  // already one of the operator's own images, embedded in their own post.
  const featureImage = meta.featureImage ?? b.featureImage ?? firstImageFrom(body)
  const credited = featureImage === b.featureImage

  await db
    .update(broadcasts)
    .set({
      slug,
      excerpt,
      featureImage,
      featureImageCredit: credited ? b.featureImageCredit : null,
      featureImageCreditUrl: credited ? b.featureImageCreditUrl : null,
      searchText: text,
      // Sent mail dates the post: the day it landed in inboxes is the day it was
      // published, whatever day the web page happened to be switched on.
      publishedAt: b.publishedAt ?? b.sentAt ?? new Date(),
    })
    .where(eq(broadcasts.id, id))

  const row = await db.select(postColumns).from(broadcasts).where(eq(broadcasts.id, id)).get()
  return row as Post
}

/**
 * Take a post off the web. The slug, excerpt and image stay on the row — putting
 * it back must restore the same URL, not mint a new one.
 */
export async function unpublishPost(db: Db, id: number): Promise<void> {
  await db.update(broadcasts).set({ publishedAt: null }).where(eq(broadcasts.id, id))
}

/** Edit the card and the URL without changing whether the post is live. */
export async function updatePostMeta(db: Db, id: number, meta: PostMeta): Promise<void> {
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) throw new Error(`no broadcast ${id}`)

  const patch: Partial<typeof broadcasts.$inferInsert> = {}
  if (meta.slug !== undefined) patch.slug = await uniqueSlug(db, id, meta.slug ?? b.subject)
  if (meta.excerpt !== undefined) patch.excerpt = meta.excerpt || null
  if (meta.featureImage !== undefined) patch.featureImage = meta.featureImage || null
  if (Object.keys(patch).length === 0) return

  await db.update(broadcasts).set(patch).where(eq(broadcasts.id, id))
}

/**
 * A free slug derived from `desired`, never colliding with another broadcast's.
 *
 * Uniqueness is checked against every row, published or not — a taken-down post
 * keeps its slug so the URL means the same thing if it ever goes back up.
 */
export async function uniqueSlug(db: Db, id: number, desired: string): Promise<string> {
  const base = slugify(desired) || `post-${id}`

  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    const clash = await db
      .select({ id: broadcasts.id })
      .from(broadcasts)
      .where(and(eq(broadcasts.slug, candidate), ne(broadcasts.id, id)))
      .get()
    if (!clash) return candidate
  }

  // Fifty posts with the same title is not a naming problem any more.
  return `${base}-${id}`
}

/**
 * Set (or replace) the featured image. Independent of publishing: the image can
 * be chosen while the piece is still a draft, and changing it later never
 * touches the publish date.
 *
 * Credit is written in the same statement as the URL, so the two can never
 * disagree — an Unsplash photo with somebody else's name under it would be worse
 * than no credit at all.
 */
export async function setFeatureImage(db: Db, id: number, image: FeatureImage): Promise<void> {
  await db
    .update(broadcasts)
    .set({
      featureImage: image.url,
      featureImageCredit: image.credit ?? null,
      featureImageCreditUrl: image.creditUrl ?? null,
    })
    .where(eq(broadcasts.id, id))
}

export async function clearFeatureImage(db: Db, id: number): Promise<void> {
  await db
    .update(broadcasts)
    .set({ featureImage: null, featureImageCredit: null, featureImageCreditUrl: null })
    .where(eq(broadcasts.id, id))
}

export interface PostQuery {
  /** Free-text search over subject and body. */
  q?: string
  limit?: number
  offset?: number
}

export interface PostPage {
  posts: Post[]
  /** One more row existed past `limit` — the index page's "older posts" link. */
  hasMore: boolean
}

export async function listPosts(db: Db, query: PostQuery = {}): Promise<PostPage> {
  const limit = Math.min(Math.max(query.limit ?? 12, 1), 50)
  const offset = Math.max(query.offset ?? 0, 0)
  const q = (query.q ?? '').trim()

  // `LIKE '%q%'` over a stored plain-text column, not FTS5. At this corpus size
  // it is one indexless scan of a few hundred short rows, which D1 does in
  // single-digit milliseconds — and it costs one query out of the 1,000 an
  // invocation gets. Revisit at a few thousand posts, with an FTS5 virtual table
  // in a custom migration.
  const search = q
    ? or(
        sql`lower(${broadcasts.subject}) like ${`%${q.toLowerCase()}%`}`,
        sql`lower(${broadcasts.searchText}) like ${`%${q.toLowerCase()}%`}`,
      )
    : undefined

  const rows = await db
    .select(postColumns)
    .from(broadcasts)
    .where(search ? and(isPublished, search) : isPublished)
    .orderBy(desc(broadcasts.publishedAt))
    // One extra row answers "is there a next page?" without a second count query.
    .limit(limit + 1)
    .offset(offset)
    .all()

  return { posts: rows.slice(0, limit) as Post[], hasMore: rows.length > limit }
}

export async function getPostBySlug(db: Db, slug: string): Promise<Post | null> {
  const row = await db
    .select(postColumns)
    .from(broadcasts)
    .where(and(eq(broadcasts.slug, slug), isPublished))
    .get()
  return (row as Post | undefined) ?? null
}

/** Newest first, for the feed and the sitemap. Capped — a feed is not an archive. */
export async function recentPosts(db: Db, limit = 20): Promise<Post[]> {
  const { posts } = await listPosts(db, { limit })
  return posts
}

/** Everything published, oldest first — the sitemap's list. */
export async function allPostSlugs(db: Db): Promise<{ slug: string; publishedAt: Date }[]> {
  const rows = await db
    .select({ slug: broadcasts.slug, publishedAt: broadcasts.publishedAt })
    .from(broadcasts)
    .where(isPublished)
    .orderBy(desc(broadcasts.publishedAt))
    .limit(1000)
    .all()
  return rows as { slug: string; publishedAt: Date }[]
}

/** The publishing state of one broadcast, for the admin screen. */
export async function postStatus(db: Db, id: number) {
  const row = await db
    .select({
      slug: broadcasts.slug,
      excerpt: broadcasts.excerpt,
      featureImage: broadcasts.featureImage,
      featureImageCredit: broadcasts.featureImageCredit,
      featureImageCreditUrl: broadcasts.featureImageCreditUrl,
      publishedAt: broadcasts.publishedAt,
      subject: broadcasts.subject,
    })
    .from(broadcasts)
    .where(eq(broadcasts.id, id))
    .get()
  return row ?? null
}
