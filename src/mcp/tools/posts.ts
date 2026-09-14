import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { getPostBySlug, listPosts, postStatus, publishPost, unpublishPost } from '../../core/posts.ts'
import { renderPostHtml } from '../../core/render-web.ts'
import { type Ctx, defineTool, fail, ok } from '../kit.ts'

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
      return ok({
        hasMore,
        posts: posts.map((p) => ({
          id: p.id,
          subject: p.subject,
          slug: p.slug,
          url: `${origin()}/${p.slug}`,
          excerpt: p.excerpt,
          featureImage: p.featureImage,
          publishedAt: p.publishedAt,
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
      return ok({
        id: post.id,
        subject: post.subject,
        slug: post.slug,
        url: `${origin()}/${post.slug}`,
        excerpt: post.excerpt,
        featureImage: post.featureImage,
        publishedAt: post.publishedAt,
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
        'Put one broadcast on the public site. Sends nothing and changes nothing about the send — it sets a publish date, a slug and the card metadata. Re-running on a live post updates the metadata and keeps the original publish date. Omit slug/excerpt/featureImage to derive them from the subject and body.',
      inputSchema: z.object({
        broadcastId: z.number().int(),
        slug: z.string().optional(),
        excerpt: z.string().optional(),
        featureImage: z.string().optional(),
      }),
    },
    async ({ broadcastId, slug, excerpt, featureImage }) => {
      if (!ctx.env.SITE_URL) return offline()
      const before = await postStatus(ctx.db, broadcastId)
      if (!before) return fail('No such broadcast.')

      const post = await publishPost(ctx.db, broadcastId, { slug, excerpt, featureImage })
      return ok({
        published: true,
        alreadyLive: Boolean(before.publishedAt),
        url: `${origin()}/${post.slug}`,
        slug: post.slug,
        excerpt: post.excerpt,
        publishedAt: post.publishedAt,
      })
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
}
