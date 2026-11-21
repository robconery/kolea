import type { Hono } from 'hono'
import * as z from 'zod/v4'
import { createForm, deleteForm, formTagIds, formTagList, getForm, getFormBySlug, listForms, updateForm } from '../../core/forms.ts'
import { ACCESS_LEVELS } from '../../core/member-access.ts'
import { statsOverview } from '../../core/overview.ts'
import { getPostTagBySlug, listTopics, setPostTags, tagsForPost, tagsForPosts, updateTopic } from '../../core/post-tags.ts'
import {
  getPostById,
  listPosts,
  postPath,
  postStatus,
  publishPost,
  setPostFeatured,
  unpublishPost,
  updatePostMeta,
} from '../../core/posts.ts'
import { getSale, listSales, revenueTotals } from '../../core/sales.ts'
import { ProfileLink, WhatIDoItem, readProfile } from '../../core/site-profile.ts'
import { applySiteUpdate, getSiteSettings } from '../../core/site-settings.ts'
import { listTags } from '../../core/tagging.ts'
import type { Form } from '../../db/schema.ts'
import type { Env } from '../../types.ts'
import { type V1, data, endpoint, notFound, pageOf, pageQuery, paged, paging, problem, refused } from './kit.ts'

/**
 * Forms, posts, topics, the site profile, sales and stats (Kōlea SPEC 14, 15,
 * 16, 17, 20.1). Money is integer cents with its currency, never a float.
 *
 * Forms never expose the download's storage key or its share token: the share
 * token is the one URL that hands the file to anybody.
 */

const nullableId = z.number().int().positive().nullable()
const tagIds = z.array(z.number().int().positive()).max(100)

const formView = (env: Env, f: Form, tags: { id: number; name: string }[]) => ({
  id: f.id,
  slug: f.slug,
  name: f.name,
  endpoint: `${env.PUBLIC_URL}/f/${f.slug}`,
  tags,
  sequenceId: f.sequenceId,
  campaignId: f.campaignId,
  redirectUrl: f.redirectUrl,
  successMessage: f.successMessage,
  doubleOptIn: f.doubleOptIn,
  isActive: f.isActive,
  reply: { active: Boolean(f.deliverySubject?.trim()), subject: f.deliverySubject || null },
  file: f.downloadKey ? { filename: f.downloadFilename, bytes: f.downloadBytes } : null,
  submitCount: f.submitCount,
  lastSubmittedAt: f.lastSubmittedAt,
  createdAt: f.createdAt,
})

export function siteRoutes(r: Hono<V1>): void {
  const origin = (env: Env) => (env.SITE_URL ?? '').replace(/\/$/, '')

  // ───────────────────────────────────────────── forms

  endpoint(
    r,
    { method: 'get', path: '/forms', tag: 'forms', summary: 'Signup forms, by name. Each posts to its endpoint from any HTML form.', query: z.object(pageQuery) },
    async ({ c, db, env, query }) => {
      const p = paging(query)
      const page = pageOf(await listForms(db), p)
      const out = []
      for (const { form } of page) out.push(formView(env, form, await formTagList(db, form.id)))
      return paged(c, out, p, true)
    },
  )

  endpoint(
    r,
    { method: 'get', path: '/forms/:id', tag: 'forms', summary: 'One form with the tags it applies.' },
    async ({ c, db, env, id }) => {
      const f = await getForm(db, id)
      return f ? data(c, formView(env, f, await formTagList(db, id))) : notFound(c, 'form')
    },
  )

  const formFields = {
    name: z.string().trim().min(1).max(200),
    slug: z.string().trim().min(1).max(80).optional(),
    tag_ids: tagIds.optional(),
    sequence_id: nullableId.optional(),
    campaign_id: nullableId.optional(),
    redirect_url: z.url({ protocol: /^https?$/ }).max(2000).nullable().optional(),
    success_message: z.string().max(1000).optional(),
    double_opt_in: z.boolean().optional(),
    is_active: z.boolean().optional(),
  }

  /** Tag ids that exist, or the first one that does not. */
  const missingTag = async (db: Parameters<typeof listTags>[0], ids: number[] | undefined) => {
    if (!ids?.length) return null
    const known = new Set((await listTags(db)).map((t) => t.id))
    return ids.find((id) => !known.has(id)) ?? null
  }

  endpoint(
    r,
    {
      method: 'post',
      path: '/forms',
      tag: 'forms',
      status: 201,
      summary:
        'Create a signup form. double_opt_in defaults to true: a submit creates a pending person and sends one confirmation; tags, sequence and reply wait for the click.',
      body: z.object(formFields),
    },
    async ({ c, db, env, body }) => {
      const missing = await missingTag(db, body.tag_ids)
      if (missing !== null) return problem(c, 422, 'invalid', `No tag #${missing}.`, 'tag_ids')
      if (body.slug && (await getFormBySlug(db, body.slug))) {
        return problem(c, 409, 'conflict', `A form already uses the slug "${body.slug}".`, 'slug')
      }
      const id = await createForm(db, {
        name: body.name,
        ...(body.slug ? { slug: body.slug } : {}),
        tagIds: body.tag_ids ?? [],
        sequenceId: body.sequence_id ?? null,
        campaignId: body.campaign_id ?? null,
        redirectUrl: body.redirect_url ?? null,
        ...(body.success_message ? { successMessage: body.success_message } : {}),
        doubleOptIn: body.double_opt_in ?? true,
        ...(body.is_active === undefined ? {} : { isActive: body.is_active }),
      })
      return data(c, formView(env, (await getForm(db, id))!, await formTagList(db, id)), 201)
    },
  )

  endpoint(
    r,
    {
      method: 'patch',
      path: '/forms/:id',
      tag: 'forms',
      summary: 'Change a form. Only the fields given change; leaving double_opt_in out never switches confirmation off.',
      body: z.object({ ...formFields, name: formFields.name.optional() }),
    },
    async ({ c, db, env, id, body }) => {
      const f = await getForm(db, id)
      if (!f) return notFound(c, 'form')
      const missing = await missingTag(db, body.tag_ids)
      if (missing !== null) return problem(c, 422, 'invalid', `No tag #${missing}.`, 'tag_ids')
      if (body.slug && body.slug !== f.slug && (await getFormBySlug(db, body.slug))) {
        return problem(c, 409, 'conflict', `A form already uses the slug "${body.slug}".`, 'slug')
      }
      // `updateForm` writes the whole shape, so what was not given is read
      // back from the form: a PATCH changes only what it names.
      await updateForm(db, id, {
        name: body.name ?? f.name,
        slug: body.slug ?? f.slug,
        tagIds: body.tag_ids ?? (await formTagIds(db, id)),
        sequenceId: body.sequence_id !== undefined ? body.sequence_id : f.sequenceId,
        campaignId: body.campaign_id !== undefined ? body.campaign_id : f.campaignId,
        redirectUrl: body.redirect_url !== undefined ? body.redirect_url : f.redirectUrl,
        successMessage: body.success_message ?? f.successMessage,
        isActive: body.is_active ?? f.isActive,
        ...(body.double_opt_in === undefined ? {} : { doubleOptIn: body.double_opt_in }),
      })
      return data(c, formView(env, (await getForm(db, id))!, await formTagList(db, id)))
    },
  )

  endpoint(
    r,
    { method: 'delete', path: '/forms/:id', tag: 'forms', summary: 'Delete a form. Anything still posting to its endpoint starts failing.' },
    async ({ c, db, id }) => {
      const f = await getForm(db, id)
      if (!f) return notFound(c, 'form')
      await deleteForm(db, id)
      return data(c, { id, deleted: true, wasSubmitted: f.submitCount })
    },
  )

  // ───────────────────────────────────────────── posts

  endpoint(
    r,
    {
      method: 'get',
      path: '/posts',
      tag: 'posts',
      summary: 'Published posts, newest first. A post is a broadcast with a publish date; q searches subject and body.',
      query: z.object({ q: z.string().max(200).optional(), ...pageQuery }),
    },
    async ({ c, db, env, query }) => {
      const p = paging(query)
      const perPage = Math.min(p.perPage, 100)
      const { posts, hasMore } = await listPosts(db, { q: query.q, limit: perPage, offset: (p.page - 1) * perPage })
      const tags = await tagsForPosts(
        db,
        posts.map((x) => x.id),
      )
      return c.json({
        data: posts.map((x) => ({
          id: x.id,
          subject: x.subject,
          slug: x.slug,
          topics: (tags.get(x.id) ?? []).map((t) => t.name),
          url: `${origin(env)}${postPath(x.slug, tags.get(x.id)?.[0]?.slug)}`,
          excerpt: x.excerpt,
          featureImage: x.featureImage,
          featured: x.featured,
          accessLevel: x.accessLevel,
          publishedAt: x.publishedAt,
        })),
        page: p.page,
        per_page: perPage,
        has_more: hasMore,
      })
    },
  )

  endpoint(
    r,
    { method: 'get', path: '/posts/:id', tag: 'posts', summary: 'One published post by its broadcast id, with its markdown body.' },
    async ({ c, db, env, id }) => {
      const x = await getPostById(db, id)
      if (!x) return problem(c, 404, 'not_found', 'No published post with that id.')
      const tags = await tagsForPost(db, id)
      return data(c, {
        id: x.id,
        subject: x.subject,
        slug: x.slug,
        topics: tags.map((t) => t.name),
        url: `${origin(env)}${postPath(x.slug, tags[0]?.slug)}`,
        excerpt: x.excerpt,
        featureImage: x.featureImage,
        featured: x.featured,
        accessLevel: x.accessLevel,
        publishedAt: x.publishedAt,
        body_md: x.bodyMd,
      })
    },
  )

  const postMeta = {
    slug: z.string().trim().min(1).max(120).optional(),
    excerpt: z.string().max(1000).optional(),
    feature_image: z.string().max(2000).optional(),
    topics: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    featured: z.boolean().optional(),
  }

  /** The publishing fields after a change, as the API shows them. */
  const postState = async (db: Parameters<typeof postStatus>[0], env: Env, id: number) => {
    const after = (await postStatus(db, id))!
    const topics = await tagsForPost(db, id)
    return {
      id,
      published: Boolean(after.publishedAt),
      slug: after.slug,
      topics: topics.map((t) => t.name),
      url: after.publishedAt && after.slug ? `${origin(env)}${postPath(after.slug, topics[0]?.slug)}` : null,
      publishedAt: after.publishedAt,
    }
  }

  endpoint(
    r,
    {
      method: 'post',
      path: '/posts/:id/publish',
      tag: 'posts',
      summary:
        'Put one broadcast on the public site. Sends nothing. Re-publishing a live post updates its metadata and keeps the original date. topics are post topics, never subscriber tags; the first is the URL’s first segment.',
      body: z.object({ ...postMeta, access_level: z.enum(ACCESS_LEVELS).optional() }),
    },
    async ({ c, db, env, id, body }) => {
      if (!env.SITE_URL) return problem(c, 409, 'conflict', 'No public site is configured (SITE_URL is unset).')
      if (!(await postStatus(db, id))) return notFound(c, 'broadcast')
      await publishPost(db, id, {
        slug: body.slug,
        excerpt: body.excerpt,
        featureImage: body.feature_image,
        accessLevel: body.access_level,
      })
      if (body.topics) await setPostTags(db, id, body.topics)
      if (body.featured !== undefined) await setPostFeatured(db, id, body.featured)
      return data(c, await postState(db, env, id))
    },
  )

  endpoint(
    r,
    {
      method: 'patch',
      path: '/posts/:id',
      tag: 'posts',
      summary:
        'Change a post’s slug, excerpt, feature image, topics or featured flag without changing whether it is live. A changed URL keeps redirecting. Sends nothing.',
      body: z.object(postMeta),
    },
    async ({ c, db, env, id, body }) => {
      if (!(await postStatus(db, id))) return notFound(c, 'broadcast')
      await updatePostMeta(db, id, { slug: body.slug, excerpt: body.excerpt, featureImage: body.feature_image })
      if (body.topics) await setPostTags(db, id, body.topics)
      if (body.featured !== undefined) await setPostFeatured(db, id, body.featured)
      return data(c, await postState(db, env, id))
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/posts/:id/unpublish',
      tag: 'posts',
      summary: 'Take a post off the site. The slug is kept, so publishing again restores the URL.',
    },
    async ({ c, db, env, id }) => {
      const before = await postStatus(db, id)
      if (!before) return notFound(c, 'broadcast')
      if (!before.publishedAt) return problem(c, 409, 'conflict', 'That broadcast is not published.')
      await unpublishPost(db, id)
      return data(c, await postState(db, env, id))
    },
  )

  // ───────────────────────────────────────────── topics

  endpoint(
    r,
    { method: 'get', path: '/topics', tag: 'topics', summary: 'The site’s topics (post tags), with how many posts carry each.', query: z.object(pageQuery) },
    async ({ c, db, env, query }) => {
      const p = paging(query)
      return paged(
        c,
        pageOf(await listTopics(db), p).map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          description: t.description,
          showOnHome: t.showOnHome,
          published: t.published,
          tagged: t.tagged,
          url: t.published ? `${origin(env)}/${t.slug}` : null,
        })),
        p,
        true,
      )
    },
  )

  endpoint(
    r,
    {
      method: 'patch',
      path: '/topics/:slug',
      tag: 'topics',
      summary: 'Edit a topic’s name, description or front-page shelf. The slug never changes.',
      body: z.object({
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().max(500).optional(),
        show_on_home: z.boolean().optional(),
      }),
    },
    async ({ c, db, param, body }) => {
      const topic = await getPostTagBySlug(db, param('slug'))
      if (!topic) return problem(c, 404, 'not_found', 'No topic with that slug.')
      const result = await updateTopic(db, topic.id, {
        name: body.name,
        description: body.description,
        showOnHome: body.show_on_home,
      })
      if (!result.ok) return refused(c, { reason: result.reason, field: 'name' }, 409)
      const t = result.topic
      return data(c, { id: t.id, slug: t.slug, name: t.name, description: t.description, showOnHome: t.showOnHome })
    },
  )

  // ───────────────────────────────────────────── site

  const siteView = async (db: Parameters<typeof getSiteSettings>[0]) => {
    const s = await getSiteSettings(db)
    return {
      title: s?.title ?? null,
      tagline: s?.tagline ?? null,
      logoUrl: s?.logoUrl ?? null,
      authorName: s?.authorName ?? null,
      authorPhotoUrl: s?.authorPhotoUrl ?? null,
      shortBio: s?.shortBio ?? null,
      longBioMarkdown: s?.longBioMd ?? null,
      profile: readProfile(s?.profile),
    }
  }

  endpoint(r, { method: 'get', path: '/site', tag: 'site', summary: 'The public site’s settings and front-page profile.' }, async ({ c, db }) =>
    data(c, await siteView(db)),
  )

  endpoint(
    r,
    {
      method: 'patch',
      path: '/site',
      tag: 'site',
      summary:
        'Change the site’s settings. Only the fields given change; "" clears a text field. social merges by key; what_i_do and links replace their list. Sends nothing.',
      body: z.object({
        title: z.string().max(120).optional(),
        tagline: z.string().max(200).optional(),
        logoUrl: z.string().max(500).optional(),
        authorName: z.string().max(120).optional(),
        authorPhotoUrl: z.string().max(500).optional(),
        shortBio: z.string().max(1200).optional(),
        longBioMarkdown: z.string().max(20000).optional(),
        social: z.record(z.string().max(30), z.string().max(500)).optional(),
        lede: z.string().max(600).optional(),
        what_i_do: z.array(WhatIDoItem).max(6).optional(),
        links: z.array(ProfileLink).max(8).optional(),
      }),
    },
    async ({ c, db, body }) => {
      const result = await applySiteUpdate(db, body)
      if (!result.ok) return problem(c, 422, 'invalid', result.reason, result.field)
      return data(c, await siteView(db))
    },
  )

  // ───────────────────────────────────────────── sales and stats

  endpoint(
    r,
    { method: 'get', path: '/sales', tag: 'sales', summary: 'Sales, newest first, with buyer and the campaign credited. Amounts in integer cents.', query: z.object(pageQuery) },
    async ({ c, db, query }) => {
      const p = paging(query)
      const rows = await listSales(db, p.fetch, p.offset)
      return paged(
        c,
        rows.map(({ sale, email, subscriberName, campaignName }) => ({
          id: sale.id,
          subscriberId: sale.subscriberId,
          email,
          name: subscriberName,
          product: sale.product,
          amountCents: sale.amountCents,
          currency: sale.currency,
          status: sale.status,
          campaignId: sale.campaignId,
          campaign: campaignName,
          externalId: sale.externalId,
          occurredAt: sale.occurredAt,
        })),
        p,
      )
    },
  )

  endpoint(
    r,
    { method: 'get', path: '/sales/:id', tag: 'sales', summary: 'One sale with its line items and metadata.' },
    async ({ c, db, id }) => {
      const found = await getSale(db, id)
      if (!found) return notFound(c, 'sale')
      const { sale, email, subscriberName, campaignName, items } = found
      return data(c, {
        id: sale.id,
        subscriberId: sale.subscriberId,
        email,
        name: subscriberName,
        product: sale.product,
        amountCents: sale.amountCents,
        currency: sale.currency,
        status: sale.status,
        campaignId: sale.campaignId,
        campaign: campaignName,
        externalId: sale.externalId,
        occurredAt: sale.occurredAt,
        items: items.map((i) => ({
          description: i.description,
          quantity: i.quantity,
          amountCents: i.amountCents,
          stripeProductId: i.stripeProductId,
          stripePriceId: i.stripePriceId,
        })),
        meta: sale.meta,
      })
    },
  )

  endpoint(
    r,
    {
      method: 'get',
      path: '/stats',
      tag: 'stats',
      summary: 'The mailer at a glance over a window: list by status, sends, engagement, revenue, live sequences.',
      query: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }),
    },
    async ({ c, db, query }) => data(c, await statsOverview(db, query.days ?? 30)),
  )

  endpoint(
    r,
    {
      method: 'get',
      path: '/stats/revenue',
      tag: 'stats',
      summary: 'Net revenue by currency, in integer cents, optionally since a date.',
      query: z.object({ since: z.iso.date().optional() }),
    },
    async ({ c, db, query }) => data(c, await revenueTotals(db, query.since ? Date.parse(query.since) : undefined)),
  )
}
