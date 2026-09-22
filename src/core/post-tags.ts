import { and, asc, count, desc, eq, inArray, isNotNull } from 'drizzle-orm'
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
])

export function tagSlug(name: string): string {
  const base = slugify(name)
  if (!base) return ''
  return RESERVED_TAG_SLUGS.has(base) ? `${base}-tag` : base
}

/** Case- and spacing-insensitive: "AI", "ai" and " Ai " are one tag. */
export async function findOrCreatePostTag(db: Db, name: string): Promise<PostTag | null> {
  const clean = name.trim().replace(/\s+/g, ' ')
  const slug = tagSlug(clean)
  if (!slug) return null
  const existing = await db.select().from(postTags).where(eq(postTags.slug, slug)).get()
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

/** Every post tag, with its published-post count, for the admin. */
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
