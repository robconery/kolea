import { and, asc, count, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { broadcastPostTags, broadcasts, postTags, type PostTag } from '../db/schema.ts'
import { slugify } from './ids.ts'

/**
 * Tags on posts — the public site's topics.
 *
 * ⚠️ Not subscriber tags (`core/subscribers.ts`). Those put people into segments
 * and sequences; these only organise pages. Nothing in this module may import
 * from, or write to, the subscriber tag tables.
 *
 * The URL rule is opinionated on purpose, and there is no routes file to argue
 * with it: a post's first tag is its **primary tag**, and the primary tag is
 * the first URL segment. Tag a post `AI` and it lives at `/ai/<slug>`; untagged,
 * it lives at `/<slug>`. `/ai` is the tag's archive.
 */

/**
 * Tag slugs that would shadow a fixed route on the public site. A tag named
 * "Author" gets `author-tag`, so `/author/rob` keeps meaning the author page.
 */
export const RESERVED_TAG_SLUGS = new Set([
  'about',
  'assets',
  'author',
  'd',
  'f',
  'favicon.ico',
  'favicon.png',
  'feed.xml',
  'logo.png',
  'logo_200.png',
  'media',
  'p',
  'page',
  'robots.txt',
  'rss',
  'search',
  'sitemap.xml',
  'subscribe',
  'tag',
  'writing',
])

export function tagSlug(name: string): string {
  const base = slugify(name)
  if (!base) return ''
  return RESERVED_TAG_SLUGS.has(base) ? `${base}-tag` : base
}

/** Trimmed, inner whitespace collapsed: the form a topic name is stored in. */
function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

/**
 * Case- and spacing-insensitive: "AI", "ai" and " Ai " are one tag.
 *
 * Matched by slug first, then by name: a topic renamed on the Topics screen
 * keeps its slug (it is a URL), so "Machine learning" may live at `/ai`, and
 * tagging a post "Machine learning" must find that topic rather than mint a
 * second one at `/machine-learning`.
 */
export async function findOrCreatePostTag(db: Db, name: string): Promise<PostTag | null> {
  const clean = cleanName(name)
  const slug = tagSlug(clean)
  if (!slug) return null
  const existing =
    (await db.select().from(postTags).where(eq(postTags.slug, slug)).get()) ??
    (await db
      .select()
      .from(postTags)
      .where(sql`lower(${postTags.name}) = ${clean.toLowerCase()}`)
      .get())
  if (existing) return existing
  return db.insert(postTags).values({ slug, name: clean, createdAt: new Date() }).returning().get()
}

/**
 * Replace a post's tags. Order matters: the first is the primary tag, and
 * therefore the URL. Duplicates collapse to their first position.
 *
 * Changing the primary tag changes the canonical URL. The old one keeps
 * working — the site redirects any `/<tag>/<slug>` and bare `/<slug>` to
 * wherever the post lives now — so a link in sent mail never dies.
 */
export async function setPostTags(db: Db, broadcastId: number, names: string[]): Promise<PostTag[]> {
  const tags: PostTag[] = []
  for (const name of names) {
    const tag = await findOrCreatePostTag(db, name)
    if (tag && !tags.some((t) => t.id === tag.id)) tags.push(tag)
  }
  await db.delete(broadcastPostTags).where(eq(broadcastPostTags.broadcastId, broadcastId))
  if (tags.length) {
    await db
      .insert(broadcastPostTags)
      .values(tags.map((t, position) => ({ broadcastId, postTagId: t.id, position })))
  }
  return tags
}

/** Every tag on each of these posts, in order. One query for a whole listing. */
export async function tagsForPosts(db: Db, broadcastIds: number[]): Promise<Map<number, PostTag[]>> {
  const out = new Map<number, PostTag[]>()
  // D1 binds at most 100 parameters per statement, and the sitemap asks for
  // every published post at once.
  for (let i = 0; i < broadcastIds.length; i += 90) {
    const chunk = broadcastIds.slice(i, i + 90)
    const rows = await db
      .select({ broadcastId: broadcastPostTags.broadcastId, tag: postTags })
      .from(broadcastPostTags)
      .innerJoin(postTags, eq(postTags.id, broadcastPostTags.postTagId))
      .where(inArray(broadcastPostTags.broadcastId, chunk))
      .orderBy(asc(broadcastPostTags.broadcastId), asc(broadcastPostTags.position))
      .all()
    for (const r of rows) {
      const bucket = out.get(r.broadcastId) ?? []
      bucket.push(r.tag)
      out.set(r.broadcastId, bucket)
    }
  }
  return out
}

export async function tagsForPost(db: Db, broadcastId: number): Promise<PostTag[]> {
  return (await tagsForPosts(db, [broadcastId])).get(broadcastId) ?? []
}

export async function getPostTagBySlug(db: Db, slug: string): Promise<PostTag | null> {
  return (await db.select().from(postTags).where(eq(postTags.slug, slug)).get()) ?? null
}

export interface TagWithCount extends PostTag {
  posts: number
}

/** Tags that have at least one *published* post, busiest first. */
export async function listPublicTags(db: Db, limit = 100): Promise<TagWithCount[]> {
  const n = count(broadcastPostTags.broadcastId)
  const rows = await db
    .select({ tag: postTags, posts: n })
    .from(postTags)
    .innerJoin(broadcastPostTags, eq(broadcastPostTags.postTagId, postTags.id))
    .innerJoin(broadcasts, eq(broadcasts.id, broadcastPostTags.broadcastId))
    .where(isNotNull(broadcasts.publishedAt))
    .groupBy(postTags.id)
    .orderBy(desc(n), asc(postTags.name))
    .limit(limit)
    .all()
  return rows.map((r) => ({ ...r.tag, posts: r.posts }))
}

/** Every post tag, by name. Counts are `listTopics`. */
export async function listAllPostTags(db: Db): Promise<PostTag[]> {
  return db.select().from(postTags).orderBy(asc(postTags.name)).all()
}

/** Count published posts under one tag. */
export async function countTagPosts(db: Db, tagId: number): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(broadcastPostTags)
    .innerJoin(broadcasts, eq(broadcasts.id, broadcastPostTags.broadcastId))
    .where(and(eq(broadcastPostTags.postTagId, tagId), isNotNull(broadcasts.publishedAt)))
    .get()
  return row?.n ?? 0
}

/** Topics ticked "show on the front page" that have a published post, busiest first. */
export async function homeTopics(db: Db): Promise<TagWithCount[]> {
  const n = count(broadcastPostTags.broadcastId)
  const rows = await db
    .select({ tag: postTags, posts: n })
    .from(postTags)
    .innerJoin(broadcastPostTags, eq(broadcastPostTags.postTagId, postTags.id))
    .innerJoin(broadcasts, eq(broadcasts.id, broadcastPostTags.broadcastId))
    .where(and(eq(postTags.showOnHome, true), isNotNull(broadcasts.publishedAt)))
    .groupBy(postTags.id)
    .orderBy(desc(n), asc(postTags.name))
    .all()
  return rows.map((r) => ({ ...r.tag, posts: r.posts }))
}

/** Exactly these topics get a shelf on the front page; every other one doesn't. */
export async function setHomeTopics(db: Db, ids: number[]): Promise<void> {
  await db.update(postTags).set({ showOnHome: false }).where(eq(postTags.showOnHome, true))
  for (let i = 0; i < ids.length; i += 90) {
    await db
      .update(postTags)
      .set({ showOnHome: true })
      .where(inArray(postTags.id, ids.slice(i, i + 90)))
  }
}

// ─────────────────────────────────────────────────── managing topics

export interface Topic extends PostTag {
  /** Published posts under it. The public site only shows a topic with at least one. */
  published: number
  /** Every broadcast carrying it, published or not. */
  tagged: number
}

/**
 * Every topic with its counts, for the Topics screen and `topic_list`. Two
 * grouped queries whatever the number of topics.
 */
export async function listTopics(db: Db): Promise<Topic[]> {
  const all = await listAllPostTags(db)
  const tagged = await db
    .select({ id: broadcastPostTags.postTagId, n: count() })
    .from(broadcastPostTags)
    .groupBy(broadcastPostTags.postTagId)
    .all()
  const published = await db
    .select({ id: broadcastPostTags.postTagId, n: count() })
    .from(broadcastPostTags)
    .innerJoin(broadcasts, eq(broadcasts.id, broadcastPostTags.broadcastId))
    .where(isNotNull(broadcasts.publishedAt))
    .groupBy(broadcastPostTags.postTagId)
    .all()
  const t = new Map(tagged.map((r) => [r.id, r.n]))
  const p = new Map(published.map((r) => [r.id, r.n]))
  return all.map((tag) => ({ ...tag, published: p.get(tag.id) ?? 0, tagged: t.get(tag.id) ?? 0 }))
}

export interface TopicPatch {
  name?: string
  /** Empty clears it. Shown on the topic's archive page and as its meta description. */
  description?: string | null
  showOnHome?: boolean
}

/**
 * Edit a topic's name, description, or front-page shelf.
 *
 * The slug never changes: it is the first segment of every post URL under the
 * topic, and those URLs are in mail that has already gone out. A rename that
 * would collide with another topic — same name, or a name whose slug is
 * another topic's — is refused, because tagging a post with that name would
 * then reach the other one.
 */
export async function updateTopic(
  db: Db,
  id: number,
  patch: TopicPatch,
): Promise<{ ok: true; topic: PostTag } | { ok: false; reason: string }> {
  const topic = await db.select().from(postTags).where(eq(postTags.id, id)).get()
  if (!topic) return { ok: false, reason: 'no such topic' }

  const set: Partial<typeof postTags.$inferInsert> = {}
  if (patch.name !== undefined) {
    const name = cleanName(patch.name)
    if (!name || !tagSlug(name)) return { ok: false, reason: 'a topic needs a name' }
    if (name.length > 80) return { ok: false, reason: 'that name is longer than 80 characters' }
    const clash = await db
      .select({ name: postTags.name })
      .from(postTags)
      .where(
        and(
          ne(postTags.id, id),
          sql`(lower(${postTags.name}) = ${name.toLowerCase()} or ${postTags.slug} = ${tagSlug(name)})`,
        ),
      )
      .get()
    if (clash) return { ok: false, reason: `another topic, “${clash.name}”, already goes by that name` }
    set.name = name
  }
  if (patch.description !== undefined) {
    const d = (patch.description ?? '').trim()
    if (d.length > 500) return { ok: false, reason: 'that description is longer than 500 characters' }
    set.description = d || null
  }
  if (patch.showOnHome !== undefined) set.showOnHome = patch.showOnHome

  if (Object.keys(set).length) await db.update(postTags).set(set).where(eq(postTags.id, id))
  return { ok: true, topic: (await db.select().from(postTags).where(eq(postTags.id, id)).get())! }
}
