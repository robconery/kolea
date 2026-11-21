import type { Hono } from 'hono'
import * as z from 'zod/v4'
import {
  broadcastStats,
  cancelBroadcast,
  createBroadcast,
  deleteBroadcast,
  getBroadcast,
  listBroadcasts,
  resumeBroadcast,
  resumeOutlook,
  reviseSentBroadcast,
  scheduleBroadcast,
  updateBroadcast,
} from '../../core/broadcasts.ts'
import { mdToDoc } from '../../core/md-to-doc.ts'
import { countSegment, getSegment, type SegmentRule } from '../../core/segments.ts'
import {
  activateSequenceWithToken,
  preflightBroadcast,
  preflightSequence,
  sendBroadcastWithToken,
} from '../../core/send-preflight.ts'
import {
  createSequence,
  deleteSequence,
  getSequence,
  listSequences,
  sequenceFlow,
  sequenceStats,
  setSequenceActive,
  stepsFor,
  updateSequence,
} from '../../core/sequences.ts'
import {
  createTxTemplate,
  deleteTxTemplate,
  getTxTemplateBySlug,
  listTxTemplates,
  templateAsks,
  txTemplateUsage,
  updateTxTemplate,
} from '../../core/transactional.ts'
import type { Broadcast, Sequence, TransactionalTemplate } from '../../db/schema.ts'
import {
  type V1,
  data,
  endpoint,
  notFound,
  pageOf,
  pageQuery,
  paged,
  paging,
  problem,
  refused,
} from './kit.ts'

/**
 * Broadcasts, sequences and transactional templates.
 *
 * ⭐ The irreversible acts keep the guard they have everywhere else: a
 * broadcast is sent, and a sequence taken live, only with a preflight token
 * from the matching preflight endpoint — single-use, ten minutes, bound to the
 * content (`core/send-preflight.ts`, the same functions MCP calls). A
 * `confirm: true` flag is not accepted instead. The agent send switch applies
 * too (checked in `index.ts`): MCP authenticates with the same admin keys, so a
 * switch only MCP read would be bypassed through here. Resuming a cancelled send asks for `confirm: "resume"`, the same
 * confirmation the console and MCP ask for.
 */

const subject = z.string().trim().min(1).max(500)
const markdown = z.string().min(1).max(200_000)
const nullableId = z.number().int().positive().nullable()

const broadcastView = (b: Broadcast) => ({
  id: b.id,
  subject: b.subject,
  status: b.status,
  body_md: b.bodyMd,
  segment: b.segment ?? {},
  segmentId: b.segmentId,
  campaignId: b.campaignId,
  scheduledAt: b.scheduledAt,
  startedAt: b.startedAt,
  sentAt: b.sentAt,
  slug: b.slug,
  publishedAt: b.publishedAt,
  createdAt: b.createdAt,
})

const sequenceView = (s: Sequence) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  trigger: s.trigger,
  triggerTagId: s.triggerTagId,
  campaignId: s.campaignId,
  nextSequenceId: s.nextSequenceId,
  isActive: s.isActive,
  createdAt: s.createdAt,
})

const templateView = (t: TransactionalTemplate) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  subject: t.subject,
  body_md: t.bodyMd,
  hasRichBody: Boolean(t.bodyJson),
  variables: templateAsks(t),
  isActive: t.isActive,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt ?? t.createdAt,
})

export function mailRoutes(r: Hono<V1>): void {
  // ───────────────────────────────────────────── broadcasts

  endpoint(
    r,
    {
      method: 'get',
      path: '/broadcasts',
      tag: 'broadcasts',
      summary: 'Broadcasts, newest send first.',
      query: z.object(pageQuery),
    },
    async ({ c, db, query }) => {
      const p = paging(query)
      return paged(c, (await listBroadcasts(db, p.fetch, p.offset)).map(broadcastView), p)
    },
  )

  endpoint(
    r,
    { method: 'get', path: '/broadcasts/:id', tag: 'broadcasts', summary: 'One broadcast, its current audience size and its stats.' },
    async ({ c, db, id }) => {
      const b = await getBroadcast(db, id)
      if (!b) return notFound(c, 'broadcast')
      return data(c, {
        ...broadcastView(b),
        audienceSize: await countSegment(db, b.segment ?? {}),
        stats: await broadcastStats(db, id),
      })
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/broadcasts',
      tag: 'broadcasts',
      status: 201,
      summary:
        'Create a draft from markdown. The audience is a saved segment (its rule is copied) or everyone who can receive broadcasts. Sends nothing.',
      body: z.object({
        subject,
        body_markdown: markdown,
        segment_id: nullableId.optional(),
        campaign_id: nullableId.optional(),
      }),
    },
    async ({ c, db, body }) => {
      let segment: SegmentRule = {}
      if (body.segment_id) {
        const seg = await getSegment(db, body.segment_id)
        if (!seg) return problem(c, 422, 'invalid', `No segment #${body.segment_id}.`, 'segment_id')
        // Copied, not referenced: editing the segment must not rewrite who
        // this broadcast went to.
        segment = seg.rule ?? {}
      }
      const id = await createBroadcast(db, {
        subject: body.subject,
        bodyMd: body.body_markdown,
        bodyJson: mdToDoc(body.body_markdown),
        segment,
        segmentId: body.segment_id ?? null,
        campaignId: body.campaign_id ?? null,
      })
      return data(c, broadcastView((await getBroadcast(db, id))!), 201)
    },
  )

  endpoint(
    r,
    {
      method: 'patch',
      path: '/broadcasts/:id',
      tag: 'broadcasts',
      summary: 'Edit a draft. Refused once scheduled, sending or sent. Any preflight token minted before the edit dies.',
      body: z.object({
        subject: subject.optional(),
        body_markdown: markdown.optional(),
        segment_id: nullableId.optional(),
        campaign_id: nullableId.optional(),
      }),
    },
    async ({ c, db, id, body }) => {
      if (!(await getBroadcast(db, id))) return notFound(c, 'broadcast')
      let segment: SegmentRule | undefined
      if (body.segment_id) {
        const seg = await getSegment(db, body.segment_id)
        if (!seg) return problem(c, 422, 'invalid', `No segment #${body.segment_id}.`, 'segment_id')
        segment = seg.rule ?? {}
      } else if (body.segment_id === null) {
        segment = {}
      }
      const result = await updateBroadcast(db, id, {
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        ...(body.body_markdown !== undefined
          ? { bodyMd: body.body_markdown, bodyJson: mdToDoc(body.body_markdown) }
          : {}),
        ...(body.campaign_id !== undefined ? { campaignId: body.campaign_id } : {}),
        ...(segment !== undefined ? { segment, segmentId: body.segment_id ?? null } : {}),
      })
      if (!result.ok) return refused(c, result, 409)
      return data(c, broadcastView((await getBroadcast(db, id))!))
    },
  )

  endpoint(
    r,
    { method: 'delete', path: '/broadcasts/:id', tag: 'broadcasts', summary: 'Delete a broadcast and its message rows. Refused mid-send.' },
    async ({ c, db, id }) => {
      const result = await deleteBroadcast(db, id)
      return result.ok ? data(c, { id, deleted: true }) : refused(c, result, 409)
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/broadcasts/:id/preflight',
      tag: 'broadcasts',
      summary:
        'Required before sending. Who would receive the draft, who is filtered out and why, unknown merge tags, a rendered sample, and a single-use preflight_token (10 minutes, dies on any edit). Sends nothing.',
    },
    async ({ c, db, env, id }) => {
      const result = await preflightBroadcast(env, db, id)
      if (!result.ok) return result.code === 'not_found' ? notFound(c, 'broadcast') : refused(c, result, 409)
      return data(c, result.report)
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/broadcasts/:id/send',
      tag: 'broadcasts',
      status: 202,
      summary:
        'Send a draft for real. Needs the preflight_token from POST /broadcasts/{id}/preflight for this broadcast, unused, under 10 minutes old, minted after the last edit. Irreversible.',
      body: z.object({ preflight_token: z.string().min(1).max(200) }),
    },
    async ({ c, db, env, id, body }) => {
      const result = await sendBroadcastWithToken(env, db, id, body.preflight_token)
      if (!result.ok) {
        if (result.code === 'not_found') return notFound(c, 'broadcast')
        if (result.code === 'preflight') {
          return problem(c, 409, 'preflight_refused', result.reason, 'preflight_token')
        }
        return refused(c, result, 409)
      }
      return data(
        c,
        { id, sending: true, expectedRecipients: result.expectedRecipients, materialized: result.materialized },
        202,
      )
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/broadcasts/:id/schedule',
      tag: 'broadcasts',
      summary: 'Park a draft to go out at a future time. Cancel can still stop it before it starts.',
      body: z.object({ at: z.iso.datetime({ offset: true }) }),
    },
    async ({ c, db, id, body }) => {
      const at = new Date(body.at)
      const result = await scheduleBroadcast(db, id, at)
      if (!result.ok) return refused(c, { ...result, field: /past/.test(result.reason ?? '') ? 'at' : undefined })
      return data(c, broadcastView((await getBroadcast(db, id))!))
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/broadcasts/:id/cancel',
      tag: 'broadcasts',
      summary: 'Cancel a scheduled or in-flight send. Mail already handed to the provider cannot be recalled; alreadySent says how much.',
    },
    async ({ c, db, id }) => {
      const result = await cancelBroadcast(db, id)
      if (!result.ok) return refused(c, result, 409)
      return data(c, { id, cancelled: true, alreadySent: result.alreadySent ?? 0 })
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/broadcasts/:id/resume',
      tag: 'broadcasts',
      status: 202,
      summary:
        'Pick a cancelled send back up where it stopped. Nobody who already has it gets it again. Sends real mail; confirm must be exactly "resume".',
      body: z.object({ confirm: z.literal('resume') }),
    },
    async ({ c, db, env, id }) => {
      const b = await getBroadcast(db, id)
      if (!b) return notFound(c, 'broadcast')
      if (b.status !== 'cancelled') {
        return problem(c, 409, 'conflict', `Broadcast #${id} is ${b.status}; only a cancelled send can be resumed.`)
      }
      const outlook = (await resumeOutlook(db, id))!
      if (outlook.remaining === 0) {
        return problem(c, 409, 'conflict', 'Everyone in the audience already has it; there is nobody to resume for.')
      }
      const result = await resumeBroadcast(env, db, id)
      if (!result.ok) return refused(c, result, 409)
      return data(c, { id, resumed: true, alreadySent: outlook.alreadySent, expectedRemaining: outlook.remaining }, 202)
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/broadcasts/:id/revise',
      tag: 'broadcasts',
      summary:
        'Correct a broadcast that already went out: subject and body only. Never sends anything; the as-mailed copy is kept the first time.',
      body: z.object({ subject: subject.optional(), body_markdown: markdown.optional() }),
    },
    async ({ c, db, id, body }) => {
      const b = await getBroadcast(db, id)
      if (!b) return notFound(c, 'broadcast')
      if (body.subject === undefined && body.body_markdown === undefined) {
        return problem(c, 422, 'invalid', 'Pass subject, body_markdown, or both.', 'subject')
      }
      const result = await reviseSentBroadcast(db, id, {
        subject: body.subject ?? b.subject,
        ...(body.body_markdown !== undefined
          ? { bodyMd: body.body_markdown, bodyJson: mdToDoc(body.body_markdown) }
          : { bodyMd: b.bodyMd, bodyJson: b.bodyJson }),
      })
      if (!result.ok) return refused(c, result, 409)
      return data(c, broadcastView((await getBroadcast(db, id))!))
    },
  )

  endpoint(
    r,
    { method: 'get', path: '/broadcasts/:id/stats', tag: 'broadcasts', summary: 'Recipients, sends, opens, clicks, bounces and failures for one broadcast.' },
    async ({ c, db, id }) => {
      const b = await getBroadcast(db, id)
      if (!b) return notFound(c, 'broadcast')
      return data(c, { id, status: b.status, ...(await broadcastStats(db, id)) })
    },
  )

  // ───────────────────────────────────────────── sequences

  const TRIGGERS = ['subscribe', 'tag_added', 'manual'] as const

  endpoint(
    r,
    { method: 'get', path: '/sequences', tag: 'sequences', summary: 'Every sequence by name, with trigger, live state and enrollment counts.', query: z.object(pageQuery) },
    async ({ c, db, query }) => {
      const p = paging(query)
      // Paged before the stats: each sequence's counts are a few queries.
      const page = pageOf(await listSequences(db), p)
      const out = []
      for (const s of page) out.push({ ...sequenceView(s), stats: await sequenceStats(db, s.id) })
      return paged(c, out, p, true)
    },
  )

  endpoint(
    r,
    { method: 'get', path: '/sequences/:id', tag: 'sequences', summary: 'One sequence with its ordered steps, stats and flow.' },
    async ({ c, db, id }) => {
      const s = await getSequence(db, id)
      if (!s) return notFound(c, 'sequence')
      const steps = await stepsFor(db, id)
      return data(c, {
        ...sequenceView(s),
        steps: steps.map((st) => ({
          id: st.id,
          position: st.position,
          delayDays: st.delayDays,
          subject: st.subject,
          body_md: st.bodyMd,
        })),
        stats: await sequenceStats(db, id),
        flow: await sequenceFlow(db, id),
      })
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/sequences',
      tag: 'sequences',
      status: 201,
      summary: 'Create a sequence. It starts paused with no steps; steps are written in the console or over MCP.',
      body: z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().max(2000).nullable().optional(),
        trigger: z.enum(TRIGGERS),
        trigger_tag_id: nullableId.optional(),
        campaign_id: nullableId.optional(),
        next_sequence_id: nullableId.optional(),
      }),
    },
    async ({ c, db, body }) => {
      if (body.trigger === 'tag_added' && !body.trigger_tag_id) {
        return problem(c, 422, 'invalid', 'A tag_added sequence needs trigger_tag_id.', 'trigger_tag_id')
      }
      const id = await createSequence(db, {
        name: body.name,
        description: body.description ?? null,
        trigger: body.trigger,
        triggerTagId: body.trigger_tag_id ?? null,
        campaignId: body.campaign_id ?? null,
        nextSequenceId: body.next_sequence_id ?? null,
      })
      return data(c, sequenceView((await getSequence(db, id))!), 201)
    },
  )

  endpoint(
    r,
    {
      method: 'patch',
      path: '/sequences/:id',
      tag: 'sequences',
      summary: 'Change a sequence’s name, description, trigger, campaign or what follows it. Not its steps.',
      body: z.object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        trigger: z.enum(TRIGGERS).optional(),
        trigger_tag_id: nullableId.optional(),
        campaign_id: nullableId.optional(),
        next_sequence_id: nullableId.optional(),
      }),
    },
    async ({ c, db, id, body }) => {
      const result = await updateSequence(db, id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
        ...(body.trigger_tag_id !== undefined ? { triggerTagId: body.trigger_tag_id } : {}),
        ...(body.campaign_id !== undefined ? { campaignId: body.campaign_id } : {}),
        ...(body.next_sequence_id !== undefined ? { nextSequenceId: body.next_sequence_id } : {}),
      })
      if (!result.ok) return refused(c, result)
      return data(c, sequenceView((await getSequence(db, id))!))
    },
  )

  endpoint(
    r,
    { method: 'delete', path: '/sequences/:id', tag: 'sequences', summary: 'Delete a paused sequence, its steps and enrollments. Refused while it is live.' },
    async ({ c, db, id }) => {
      const result = await deleteSequence(db, id)
      return result.ok ? data(c, { id, deleted: true }) : refused(c, result, 409)
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/sequences/:id/preflight',
      tag: 'sequences',
      summary:
        'Required before activating. Every step with its delay and a sample, who it would start reaching, and a single-use preflight_token (10 minutes, dies on any step edit).',
    },
    async ({ c, db, id }) => {
      const result = await preflightSequence(db, id)
      if (!result.ok) return result.code === 'not_found' ? notFound(c, 'sequence') : refused(c, result, 409)
      return data(c, result.report)
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/sequences/:id/activate',
      tag: 'sequences',
      summary: 'Take a sequence live. Needs the preflight_token from POST /sequences/{id}/preflight, minted after the last step edit.',
      body: z.object({ preflight_token: z.string().min(1).max(200) }),
    },
    async ({ c, db, id, body }) => {
      const result = await activateSequenceWithToken(db, id, body.preflight_token)
      if (!result.ok) {
        if (result.code === 'not_found') return notFound(c, 'sequence')
        if (result.code === 'preflight') return problem(c, 409, 'preflight_refused', result.reason, 'preflight_token')
        return refused(c, result, 409)
      }
      return data(c, sequenceView((await getSequence(db, id))!))
    },
  )

  endpoint(
    r,
    {
      method: 'post',
      path: '/sequences/:id/deactivate',
      tag: 'sequences',
      summary: 'Pause a sequence. No new enrollments, no further sends; everyone keeps their place.',
    },
    async ({ c, db, id }) => {
      const result = await setSequenceActive(db, id, false)
      if (!result.ok) return refused(c, result, 409)
      return data(c, sequenceView((await getSequence(db, id))!))
    },
  )

  // ───────────────────────────────────────────── transactional templates

  endpoint(
    r,
    {
      method: 'get',
      path: '/templates',
      tag: 'templates',
      summary: 'Stored transactional templates that POST /api/send names by slug, with the {{variables}} each asks for.',
      query: z.object(pageQuery),
    },
    async ({ c, db, query }) => {
      const p = paging(query)
      return paged(c, pageOf(await listTxTemplates(db), p).map(templateView), p, true)
    },
  )

  endpoint(
    r,
    { method: 'get', path: '/templates/:slug', tag: 'templates', summary: 'One transactional template by slug, with how many messages have gone out from it.' },
    async ({ c, db, param }) => {
      const t = await getTxTemplateBySlug(db, param('slug').trim().toLowerCase())
      if (!t) return problem(c, 404, 'not_found', 'No transactional template with that slug.')
      return data(c, { ...templateView(t), sent: await txTemplateUsage(db, t.slug) })
    },
  )

  const templateBody = {
    name: z.string().trim().min(1).max(200),
    subject: z.string().trim().min(1).max(500),
    body_md: z.string().min(1).max(200_000),
    is_active: z.boolean().optional(),
  }

  endpoint(
    r,
    {
      method: 'post',
      path: '/templates',
      tag: 'templates',
      status: 201,
      summary: 'Create a transactional template. Its slug comes from the name (or slug) and never changes. Sends nothing.',
      body: z.object({ ...templateBody, slug: z.string().trim().min(1).max(80).optional() }),
    },
    async ({ c, db, body }) => {
      const result = await createTxTemplate(db, {
        name: body.name,
        subject: body.subject,
        bodyMd: body.body_md,
        bodyJson: null,
        slug: body.slug ?? null,
        isActive: body.is_active,
      })
      if (!result.ok) return refused(c, { reason: result.reason, field: /slug/i.test(result.reason) ? 'slug' : undefined }, 409)
      return data(c, templateView(result.template), 201)
    },
  )

  endpoint(
    r,
    {
      method: 'patch',
      path: '/templates/:slug',
      tag: 'templates',
      summary: 'Change a template’s name, subject, markdown body or active flag. The slug never changes.',
      body: z.object({
        name: templateBody.name.optional(),
        subject: templateBody.subject.optional(),
        body_md: templateBody.body_md.optional(),
        is_active: z.boolean().optional(),
      }),
    },
    async ({ c, db, param, body }) => {
      const t = await getTxTemplateBySlug(db, param('slug').trim().toLowerCase())
      if (!t) return problem(c, 404, 'not_found', 'No transactional template with that slug.')
      const result = await updateTxTemplate(db, t.id, {
        name: body.name,
        subject: body.subject,
        ...(body.body_md === undefined ? {} : { bodyMd: body.body_md, bodyJson: null }),
        isActive: body.is_active,
      })
      if (!result.ok) return refused(c, result)
      return data(c, templateView(result.template))
    },
  )

  endpoint(
    r,
    {
      method: 'delete',
      path: '/templates/:slug',
      tag: 'templates',
      summary: 'Delete a transactional template. confirm_slug must repeat the slug. Sent messages keep their copy.',
      query: z.object({ confirm_slug: z.string().max(80) }),
    },
    async ({ c, db, param, query }) => {
      const t = await getTxTemplateBySlug(db, param('slug').trim().toLowerCase())
      if (!t) return problem(c, 404, 'not_found', 'No transactional template with that slug.')
      if (query.confirm_slug !== t.slug) {
        return problem(c, 422, 'invalid', `confirm_slug must be exactly "${t.slug}".`, 'confirm_slug')
      }
      const sent = await txTemplateUsage(db, t.slug)
      await deleteTxTemplate(db, t.id)
      return data(c, { slug: t.slug, deleted: true, messagesKept: sent })
    },
  )
}
