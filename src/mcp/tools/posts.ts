import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { getPostTagBySlug, listTopics, setPostTags, tagsForPost, tagsForPosts, updateTopic } from '../../core/post-tags.ts'
import {
  getPostBySlug,
  listPosts,
  postPath,
  postStatus,
  publishPost,
  setPostFeatured,
  unpublishPost,
  updatePostMeta,
} from '../../core/posts.ts'
import { listMembers } from '../../core/members.ts'
import { ACCESS_LEVELS } from '../../core/member-access.ts'
import { renderPostHtml } from '../../core/render-web.ts'
import { type Ctx, defineTool, fail, failed, ok } from '../kit.ts'

/**
 * The public site's tools.
 *
 * Publishing is per-post and explicit here too: there is no `post_publish_all`,
 * because the archive imported from Kit is hundreds of `sent` broadcasts and an
 * agent should not be able to put all of them on the web in one call.
 */
export function registerPosts(server: McpServer, ctx: Ctx): void {
  const origin = () => (ctx.env.SITE_URL ?? '').replace(/\/$/, '')
  const offline = () =>
    fail('No public site is configured (SITE_URL is unset), so there is nowhere to publish to.')

  defineTool(
    server,
    ctx,
    'post_list',
    {
      description:
        'Posts on the public site, newest first. A post is a broadcast with a publish date — the same piece that went to the list. Optional `q` searches subject and body text.',
      inputSchema: z.object({
        q: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ q, limit, offset }) => {
      const { posts, hasMore } = await listPosts(ctx.db, { q, limit, offset })
      const tags = await tagsForPosts(
        ctx.db,
        posts.map((p) => p.id),
      )
      return ok({
        hasMore,
        posts: posts.map((p) => ({
          id: p.id,
          subject: p.subject,
          slug: p.slug,
          tags: (tags.get(p.id) ?? []).map((t) => t.name),
          url: `${origin()}${postPath(p.slug, tags.get(p.id)?.[0]?.slug)}`,
          excerpt: p.excerpt,
          featureImage: p.featureImage,
          publishedAt: p.publishedAt,
          accessLevel: p.accessLevel,
        })),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'post_get',
    {
      description: 'One published post by slug, with its body rendered as the web page HTML.',
      inputSchema: z.object({ slug: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ slug }) => {
      const post = await getPostBySlug(ctx.db, slug)
      if (!post) return fail('No published post with that slug.')
      const tags = await tagsForPost(ctx.db, post.id)
      return ok({
        id: post.id,
        subject: post.subject,
        slug: post.slug,
        tags: tags.map((t) => t.name),
        url: `${origin()}${postPath(post.slug, tags[0]?.slug)}`,
        excerpt: post.excerpt,
        featureImage: post.featureImage,
        publishedAt: post.publishedAt,
        accessLevel: post.accessLevel,
        html: renderPostHtml({ json: post.bodyJson, md: post.bodyMd }),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'post_publish',
    {
      description:
        'Put one broadcast on the public site. Sends nothing and changes nothing about the send — it sets a publish date, a slug and the card metadata. Re-running on a live post updates the metadata and keeps the original publish date. Omit slug/excerpt/featureImage to derive them from the subject and body. `tags` are post topics (never subscriber tags): the first is the primary topic and the first URL segment, so ["AI"] publishes at /ai/<slug>. Omit to leave the current topics alone; pass [] to clear them. `featured: true` puts it in the front page\'s "Start here" (newest first). `accessLevel` sets who can read it on the web: "public" (anyone), "members" (signed-in readers) or "premium" (paying members); omit to keep the current level. Gated posts show everyone else a teaser built from the hand-written excerpt only, and the level never changes who the mail goes to.',
      inputSchema: z.object({
        broadcastId: z.number().int(),
        slug: z.string().optional(),
        excerpt: z.string().optional(),
        featureImage: z.string().optional(),
        tags: z.array(z.string()).optional(),
        featured: z.boolean().optional(),
        accessLevel: z.enum(ACCESS_LEVELS).optional(),
      }),
    },
    async ({ broadcastId, slug, excerpt, featureImage, tags, featured, accessLevel }) => {
      if (!ctx.env.SITE_URL) return offline()
      const before = await postStatus(ctx.db, broadcastId)
      if (!before) return fail('No such broadcast.')

      const post = await publishPost(ctx.db, broadcastId, { slug, excerpt, featureImage, accessLevel })
      const topics = tags ? await setPostTags(ctx.db, broadcastId, tags) : await tagsForPost(ctx.db, broadcastId)
      if (featured !== undefined) await setPostFeatured(ctx.db, broadcastId, featured)
      return ok({
        published: true,
        alreadyLive: Boolean(before.publishedAt),
        tags: topics.map((t) => t.name),
        url: `${origin()}${postPath(post.slug, topics[0]?.slug)}`,
        slug: post.slug,
        excerpt: post.excerpt,
        publishedAt: post.publishedAt,
        accessLevel: post.accessLevel,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'post_update',
    {
      description:
        "Change a post's publishing fields WITHOUT changing whether it is live: slug, excerpt, featureImage, tags (post topics, never subscriber tags; the first is the primary topic and the first URL segment) and featured. Works on a published post or on a broadcast that is not up yet. Only the fields you pass change; pass \"\" to clear excerpt or featureImage, [] to clear tags. A changed slug or primary topic changes the URL, and the old one keeps redirecting. Sends nothing. To put a post on the site, use post_publish.",
      inputSchema: z.object({
        broadcastId: z.number().int(),
        slug: z.string().min(1).optional(),
        excerpt: z.string().optional(),
        featureImage: z.string().optional(),
        tags: z.array(z.string()).optional(),
        featured: z.boolean().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ broadcastId, slug, excerpt, featureImage, tags, featured }) => {
      const before = await postStatus(ctx.db, broadcastId)
      if (!before) return fail('No such broadcast.')

      await updatePostMeta(ctx.db, broadcastId, { slug, excerpt, featureImage })
      const topics = tags ? await setPostTags(ctx.db, broadcastId, tags) : await tagsForPost(ctx.db, broadcastId)
      if (featured !== undefined) await setPostFeatured(ctx.db, broadcastId, featured)

      const after = (await postStatus(ctx.db, broadcastId))!
      return ok({
        updated: true,
        published: Boolean(after.publishedAt),
        slug: after.slug,
        tags: topics.map((t) => t.name),
        url: after.publishedAt && after.slug ? `${origin()}${postPath(after.slug, topics[0]?.slug)}` : null,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'member_list',
    {
      description:
        'Readers who have signed in on the public site or paid for Premium, newest first: their newsletter status (a separate fact from membership), Premium status (active, past_due, canceled) with price and interval, and the post whose call to action converted them. Read-only; Premium state is written only by the Stripe webhook.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const members = await listMembers(ctx.db, limit ?? 50)
      return ok({ members })
    },
  )

  defineTool(
    server,
    ctx,
    'post_unpublish',
    {
      description:
        'Take a post off the public site. The slug is kept, so re-publishing restores the same URL. The broadcast and its send history are untouched.',
      inputSchema: z.object({ broadcastId: z.number().int() }),
    },
    async ({ broadcastId }) => {
      const before = await postStatus(ctx.db, broadcastId)
      if (!before) return fail('No such broadcast.')
      if (!before.publishedAt) return fail('That broadcast is not published.')

      await unpublishPost(ctx.db, broadcastId)
      return ok({ published: false, slug: before.slug, subject: before.subject })
    },
  )

  defineTool(
    server,
    ctx,
    'topic_list',
    {
      description:
        "The public site's topics (post tags — never subscriber tags), by name: slug (the URL segment, which never changes), description, whether it has a shelf on the front page, and how many posts carry it (`published` live, `tagged` in all). A topic shows on the site only once it has a published post.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok(
        (await listTopics(ctx.db)).map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          description: t.description,
          showOnHome: t.showOnHome,
          published: t.published,
          tagged: t.tagged,
          url: t.published ? `${origin()}/${t.slug}` : null,
        })),
      ),
  )

  defineTool(
    server,
    ctx,
    'topic_update',
    {
      description:
        "Edit a topic, found by slug (or id): its display name, its description (shown on the topic's archive page and as its meta description; \"\" clears it), and show_on_home (a shelf of its newest posts on the front page). The slug never changes, so no URL breaks. Topics are created by tagging posts (post_publish / post_update). Sends nothing.",
      inputSchema: z.object({
        slug: z.string().optional(),
        id: z.number().int().optional(),
        name: z.string().min(1).max(80).optional(),
        description: z.string().max(500).optional(),
        show_on_home: z.boolean().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ slug, id, name, description, show_on_home }) => {
      const topicId = id ?? (slug ? (await getPostTagBySlug(ctx.db, slug))?.id : undefined)
      if (!topicId) return fail('No such topic.', 'List them with topic_list.')
      const r = await updateTopic(ctx.db, topicId, { name, description, showOnHome: show_on_home })
      if (!r.ok) return failed(r)
      return ok({
        id: r.topic.id,
        slug: r.topic.slug,
        name: r.topic.name,
        description: r.topic.description,
        showOnHome: r.topic.showOnHome,
      })
    },
  )
}
