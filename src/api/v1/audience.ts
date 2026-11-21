import type { Hono } from 'hono'
import * as z from 'zod/v4'
import { leaveBroadcasts } from '../../core/consent.ts'
import { listFields } from '../../core/fields.ts'
import { normalizeEmail } from '../../core/ids.ts'
import {
  countSegment,
  createSegment,
  deleteSegment,
  describeRule,
  getSegment,
  listSegments,
  ruleFromInput,
  updateSegment,
} from '../../core/segments.ts'
import {
  SUBSCRIBER_STATUSES,
  findSubscriber,
  searchSubscribers,
  subscriberDetail,
} from '../../core/subscriber-reads.ts'
import { addTags, eraseSubscriber, findOrCreateTag, removeTag, upsertWithFields } from '../../core/subscribers.ts'
import { deleteTag, listTags, renameTag, tagCounts, tagDependents } from '../../core/tagging.ts'
import type { Db } from '../../db/index.ts'
import { type V1, data, endpoint, notFound, pageOf, pageQuery, paged, paging, problem, refused } from './kit.ts'

/**
 * Subscribers, tags and segments (Kōlea SPEC 7, 8, 20.1). Ids are Big Mailer's
 * integer ids; Kōlea's tokens do not exist here.
 *
 * ⭐ Consent follows the scopes exactly: `POST /subscribers/:id/unsubscribe` is
 * the newsletter (broadcasts) only — sequences carry on and no suppression is
 * written — the same `leaveBroadcasts` the MCP tool and the preference center
 * call. There is no endpoint that puts someone who left back on the list.
 */

const name = z.string().trim().min(1).max(200)
const fieldValues = z
  .record(z.string().max(64), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
  .refine((r) => Object.keys(r).length <= 100, 'at most 100 fields')
const tagIds = z.array(z.number().int().positive()).max(100)
const tagNames = z.array(z.string().trim().min(1).max(100)).max(100)

/** Tag ids that exist, or the first one that does not. One query. */
async function checkTagIds(db: Db, ids: number[]): Promise<number | null> {
  if (!ids.length) return null
  const known = new Set((await listTags(db)).map((t) => t.id))
  return ids.find((id) => !known.has(id)) ?? null
}

/** `tag_ids` checked, plus `tags` by name (created when new), as one id list. */
async function resolveTags(
  db: Db,
  ids: number[] | undefined,
  names: string[] | undefined,
): Promise<{ ok: true; ids: number[] } | { ok: false; field: string; reason: string }> {
  const missing = await checkTagIds(db, ids ?? [])
  if (missing !== null) return { ok: false, field: 'tag_ids', reason: `No tag #${missing}.` }
  const out = [...(ids ?? [])]
  for (const n of names ?? []) out.push(await findOrCreateTag(db, n))
  return { ok: true, ids: [...new Set(out)] }
}

const RULE = z.object({
  match: z.enum(['any', 'all']).optional(),
  include_tag_ids: tagIds.optional(),
  exclude_tag_ids: tagIds.optional(),
  joined_after: z.string().max(40).optional(),
  joined_before: z.string().max(40).optional(),
  fields: z
    .array(
      z.object({
        key: z.string().max(64),
        op: z.string().max(32),
        value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
      }),
    )
    .max(20)
    .optional(),
})

export function audienceRoutes(r: Hono<V1>): void {
  // ───────────────────────────────────────────── subscribers

  endpoint(
    r,
    {
      method: 'get',
      path: '/subscribers',
      tag: 'subscribers',
      summary: 'Subscribers, newest first, filtered by search text, status or tag.',
      query: z.object({
        search: z.string().max(200).optional(),
        status: z.enum(SUBSCRIBER_STATUSES).optional(),
        tag_id: z.coerce.number().int().positive().optional(),
        ...pageQuery,
      }),
    },
    async ({ c, db, query }) => {
      const p = paging(query)
      const rows = await searchSubscribers(db, {
        query: query.search,
        status: query.status,
        tagId: query.tag_id,
        limit: p.fetch,
        offset: p.offset,
      })
      return paged(c, rows, p)
    },
  )

  endpoint(
    r,
    { method: 'get', path: '/subscribers/:id', tag: 'subscribers', summary: 'One subscriber with tags, custom fields, consent per scope and enrollments.' },
    async ({ c, db, id }) => {
      const sub = await subscriberDetail(db, id)
      return sub ? data(c, sub) : notFound(c, 'subscriber')
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/subscribers',
      tag: 'subscribers',
      status: 201,
      summary:
        'Add one subscriber, or update one by address. A new active subscriber is a signup and starts subscribe-triggered sequences; a new pending one starts nothing. Never returns anyone who left to active.',
      body: z.object({
        email: z.string().trim().min(3).max(320),
        name: name.nullable().optional(),
        status: z.enum(['active', 'pending']).optional(),
        source: z.string().trim().max(80).optional(),
        tag_ids: tagIds.optional(),
        tags: tagNames.optional(),
        fields: fieldValues.optional(),
      }),
    },
    async ({ c, db, body }) => {
      const tags = await resolveTags(db, body.tag_ids, body.tags)
      if (!tags.ok) return problem(c, 422, 'invalid', tags.reason, tags.field)

      // Kōlea's single API create behaves like a signup when the person is
      // active (SPEC 12.4: automation hears about them) and starts nothing when
      // pending. Bulk paths never come through here.
      const status = body.status ?? 'active'
      const saved = await upsertWithFields(
        db,
        {
          email: body.email,
          name: body.name ?? null,
          source: body.source ?? 'api',
          tagIds: tags.ids,
          status,
          triggerSubscribeSequences: status === 'active',
        },
        body.fields,
      )
      if (!saved.ok) return problem(c, 422, 'invalid', saved.reason, saved.field)

      const sub = await subscriberDetail(db, saved.id)
      return data(c, { outcome: saved.outcome, subscriber: sub }, saved.outcome === 'created' ? 201 : 200)
    },
  )

  endpoint(
    r,
    {
      method: 'patch',
      path: '/subscribers/:id',
      tag: 'subscribers',
      summary: 'Change a subscriber’s name or custom field values. Never changes their status.',
      body: z.object({ name: name.optional(), fields: fieldValues.optional() }),
    },
    async ({ c, db, id, body }) => {
      const sub = await findSubscriber(db, { id })
      if (!sub) return notFound(c, 'subscriber')
      // `pending` as the wanted status means "never promote": an edit is not a
      // signup, and the upsert never walks any other status anywhere.
      const saved = await upsertWithFields(
        db,
        { email: sub.email, name: body.name ?? null, status: 'pending', triggerSubscribeSequences: false },
        body.fields,
      )
      if (!saved.ok) return problem(c, 422, 'invalid', saved.reason, saved.field)
      return data(c, await subscriberDetail(db, id))
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/subscribers/:id/tags',
      tag: 'subscribers',
      summary: 'Tag a subscriber (by id, or by name — new names are created). A tag new to them can start a tag_added sequence.',
      body: z.object({ tag_ids: tagIds.optional(), tags: tagNames.optional() }),
    },
    async ({ c, db, id, body }) => {
      if (!body.tag_ids?.length && !body.tags?.length) {
        return problem(c, 422, 'invalid', 'Pass tag_ids or tags.', 'tag_ids')
      }
      if (!(await findSubscriber(db, { id }))) return notFound(c, 'subscriber')
      const tags = await resolveTags(db, body.tag_ids, body.tags)
      if (!tags.ok) return problem(c, 422, 'invalid', tags.reason, tags.field)
      const added = await addTags(db, id, tags.ids)
      return data(c, { added, subscriber: await subscriberDetail(db, id) })
    },
  )

  endpoint(
    r,
    {
      method: 'delete',
      path: '/subscribers/:id/tags/:tag_id',
      tag: 'subscribers',
      summary: 'Remove one tag from a subscriber. Un-enrolls them from nothing.',
    },
    async ({ c, db, id, param }) => {
      if (!(await findSubscriber(db, { id }))) return notFound(c, 'subscriber')
      await removeTag(db, id, Number(param('tag_id')))
      return data(c, await subscriberDetail(db, id))
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/subscribers/:id/unsubscribe',
      tag: 'subscribers',
      summary:
        'Take a person off the newsletter (broadcasts) at their request. Their sequences and receipts continue; no suppression is written. To stop all marketing, use the console’s suppression list.',
    },
    async ({ c, db, id }) => {
      const r = await leaveBroadcasts(db, id)
      if (r.outcome === 'not_found') return notFound(c, 'subscriber')
      return data(c, { id, outcome: r.outcome, status: r.status })
    },
  )

  endpoint(
    r,
    {
      method: 'delete',
      path: '/subscribers/:id',
      tag: 'subscribers',
      summary:
        'Erase a subscriber and everything cascading from them (messages, events, enrollments, sales). For erasure requests; confirm_email must repeat their address exactly.',
      query: z.object({ confirm_email: z.string().max(320) }),
    },
    async ({ c, db, id, query }) => {
      const sub = await findSubscriber(db, { id })
      if (!sub) return notFound(c, 'subscriber')
      if (normalizeEmail(query.confirm_email) !== sub.email) {
        return problem(c, 422, 'invalid', `confirm_email does not match subscriber #${id}.`, 'confirm_email')
      }
      const r = await eraseSubscriber(db, id)
      return data(c, { id, deleted: true, salesDeleted: r.salesDeleted })
    },
  )

  // ───────────────────────────────────────────── tags

  endpoint(
    r,
    { method: 'get', path: '/tags', tag: 'tags', summary: 'Every tag, by name, with how many subscribers carry it.', query: z.object(pageQuery) },
    async ({ c, db, query }) => {
      const p = paging(query)
      const [all, counts] = await Promise.all([listTags(db), tagCounts(db)])
      return paged(
        c,
        pageOf(all, p).map((t) => ({ id: t.id, name: t.name, slug: t.slug, subscribers: counts.get(t.id) ?? 0 })),
        p,
        true,
      )
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/tags',
      tag: 'tags',
      status: 201,
      summary: 'Create a tag, or return the existing one with the same slug.',
      body: z.object({ name: z.string().trim().min(1).max(100) }),
    },
    async ({ c, db, body }) => {
      const id = await findOrCreateTag(db, body.name)
      const tag = (await listTags(db)).find((t) => t.id === id)
      return data(c, tag, 201)
    },
  )

  endpoint(
    r,
    {
      method: 'patch',
      path: '/tags/:id',
      tag: 'tags',
      summary: 'Rename a tag. Every reference is by id, so nothing breaks.',
      body: z.object({ name: z.string().trim().min(1).max(100) }),
    },
    async ({ c, db, id, body }) => {
      const result = await renameTag(db, id, body.name)
      if (!result.ok) return refused(c, result)
      return data(c, (await listTags(db)).find((t) => t.id === id))
    },
  )

  endpoint(
    r,
    {
      method: 'delete',
      path: '/tags/:id',
      tag: 'tags',
      summary: 'Delete a tag. Refused (409) while a sequence or tag rule depends on it.',
    },
    async ({ c, db, id }) => {
      if (!(await listTags(db)).some((t) => t.id === id)) return notFound(c, 'tag')
      const result = await deleteTag(db, id)
      if (result.ok) return data(c, { id, deleted: true })
      const blockers = await tagDependents(db, id)
      return problem(c, 409, 'conflict', result.reason ?? `Still used by ${blockers.join(', ')}.`)
    },
  )

  // ───────────────────────────────────────────── segments

  /** A segment as the API shows it: the rule, its plain-English reading, its size now. */
  const segmentView = async (db: Db, s: { id: number; slug: string; name: string; rule: unknown }) => {
    const rule = (s.rule ?? {}) as Parameters<typeof countSegment>[1]
    return {
      id: s.id,
      slug: s.slug,
      name: s.name,
      rule,
      describes: describeRule(rule, await listTags(db), [], await listFields(db)),
      size: await countSegment(db, rule),
    }
  }

  endpoint(
    r,
    { method: 'get', path: '/segments', tag: 'segments', summary: 'Saved audience rules with their description and current size.', query: z.object(pageQuery) },
    async ({ c, db, query }) => {
      const p = paging(query)
      // Paged before counting: each segment's size is one query.
      const page = pageOf(await listSegments(db), p)
      const out = []
      for (const s of page) out.push(await segmentView(db, s))
      return paged(c, out, p, true)
    },
  )

  endpoint(
    r,
    { method: 'get', path: '/segments/:id', tag: 'segments', summary: 'One saved segment with its rule, description and size.' },
    async ({ c, db, id }) => {
      const s = await getSegment(db, id)
      return s ? data(c, await segmentView(db, s)) : notFound(c, 'segment')
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/segments',
      tag: 'segments',
      status: 201,
      summary: 'Save an audience rule under a name.',
      body: z.object({ name: z.string().trim().min(1).max(120), rule: RULE }),
    },
    async ({ c, db, body }) => {
      const parsed = await ruleFromInput(db, body.rule)
      if (!parsed.ok) return problem(c, 422, 'invalid', parsed.reason, `rule.${parsed.field ?? ''}`.replace(/\.$/, ''))
      const id = await createSegment(db, body.name, parsed.rule)
      return data(c, await segmentView(db, (await getSegment(db, id))!), 201)
    },
  )

  endpoint(
    r,
    {
      method: 'patch',
      path: '/segments/:id',
      tag: 'segments',
      summary: 'Change a saved segment. Broadcasts copied its rule when made, so none is rewritten.',
      body: z.object({ name: z.string().trim().min(1).max(120).optional(), rule: RULE.optional() }),
    },
    async ({ c, db, id, body }) => {
      const s = await getSegment(db, id)
      if (!s) return notFound(c, 'segment')
      let next = s.rule ?? {}
      if (body.rule) {
        const parsed = await ruleFromInput(db, body.rule)
        if (!parsed.ok) return problem(c, 422, 'invalid', parsed.reason, `rule.${parsed.field ?? ''}`.replace(/\.$/, ''))
        next = parsed.rule
      }
      await updateSegment(db, id, body.name ?? s.name, next)
      return data(c, await segmentView(db, (await getSegment(db, id))!))
    },
  )

  endpoint(
    r,
    { method: 'delete', path: '/segments/:id', tag: 'segments', summary: 'Delete a saved segment. Broadcasts built from it keep their own copy of the rule.' },
    async ({ c, db, id }) => {
      if (!(await getSegment(db, id))) return notFound(c, 'segment')
      await deleteSegment(db, id)
      return data(c, { id, deleted: true })
    },
  )
}
