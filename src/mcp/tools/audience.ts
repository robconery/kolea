import type { McpServer } from '@modelcontextprotocol/server'
import { and, desc, eq, like, or } from 'drizzle-orm'
import * as z from 'zod/v4'
import {
  type ActivityType,
  activityCounts,
  activityFeed,
  activityForSubscriber,
  growthByDay,
} from '../../core/activity.ts'
import { campaignsForSubscriber, touchesFor } from '../../core/campaigns.ts'
import { preferencesFor } from '../../core/consent.ts'
import { normalizeEmail } from '../../core/ids.ts'
import { salesForSubscriber } from '../../core/sales.ts'
import { addTags, importCsv, removeTag, upsertSubscriber } from '../../core/subscribers.ts'
import {
  events,
  messages,
  sequenceEnrollments,
  sequences,
  subscriberTags,
  subscribers,
  tags,
} from '../../db/schema.ts'
import { type Ctx, clampLimit, defineTool, fail, money, ok } from '../kit.ts'

const STATUSES = ['pending', 'active', 'unsubscribed', 'bounced', 'complained'] as const

const ACTIVITY_TYPES = [
  'subscribed',
  'pending_added',
  'promoted',
  'imported',
  'form_submitted',
  'unsubscribed',
  'resubscribed',
  'unsubscribed_all',
  'suppressed',
  'unsuppressed',
  'bounced',
  'complained',
  'sequence_enrolled',
  'sequence_advanced',
  'sequence_completed',
  'sequence_cancelled',
  'sequence_opted_out',
  'sequence_rejoined',
  'tagged',
  'untagged',
  'touched',
  'purchased',
  'refunded',
] as const satisfies readonly ActivityType[]


/** Tag rows for one person. Two queries, not one per tag. */
async function tagsOf(ctx: Ctx, subscriberId: number) {
  return await ctx.db
    .select({ id: tags.id, name: tags.name, slug: tags.slug })
    .from(subscriberTags)
    .innerJoin(tags, eq(tags.id, subscriberTags.tagId))
    .where(eq(subscriberTags.subscriberId, subscriberId))
    .all()
}

async function findByEmailOrId(ctx: Ctx, ref: { id?: number; email?: string }) {
  if (ref.id) {
    return (await ctx.db.select().from(subscribers).where(eq(subscribers.id, ref.id)).get()) ?? null
  }
  if (ref.email) {
    const email = normalizeEmail(ref.email)
    return (
      (await ctx.db.select().from(subscribers).where(eq(subscribers.email, email)).get()) ?? null
    )
  }
  return null
}

export function registerAudience(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'subscriber_search',
    {
      description:
        'Find subscribers by email/name substring, status, or tag. Returns id, email, name, status, tags.',
      inputSchema: z.object({
        query: z.string().optional().describe('Substring matched against email and name'),
        status: z.enum(STATUSES).optional(),
        tag_id: z.number().int().optional().describe('Only people carrying this tag'),
        limit: z.number().int().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, status, tag_id, limit }) => {
      const n = clampLimit(limit)
      const filters = []
      if (query) {
        const pattern = `%${query.toLowerCase()}%`
        filters.push(or(like(subscribers.email, pattern), like(subscribers.name, pattern)))
      }
      if (status) filters.push(eq(subscribers.status, status))

      const base = ctx.db
        .select({
          id: subscribers.id,
          email: subscribers.email,
          name: subscribers.name,
          status: subscribers.status,
          source: subscribers.source,
          createdAt: subscribers.createdAt,
        })
        .from(subscribers)

      const rows = tag_id
        ? await base
            .innerJoin(subscriberTags, eq(subscriberTags.subscriberId, subscribers.id))
            .where(and(eq(subscriberTags.tagId, tag_id), ...filters))
            .orderBy(desc(subscribers.createdAt))
            .limit(n)
            .all()
        : await base
            .where(filters.length ? and(...filters) : undefined)
            .orderBy(desc(subscribers.createdAt))
            .limit(n)
            .all()

      return ok({ count: rows.length, limit: n, subscribers: rows })
    },
  )

  defineTool(
    server,
    ctx,
    'subscriber_get',
    {
      description: 'One subscriber with their tags, consent state, and sequence enrollments.',
      inputSchema: z.object({
        id: z.number().int().optional(),
        email: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const sub = await findByEmailOrId(ctx, args)
      if (!sub) return fail('No such subscriber.', 'Try subscriber_search to find the right id.')

      const enrollments = await ctx.db
        .select({
          sequenceId: sequences.id,
          sequence: sequences.name,
          status: sequenceEnrollments.status,
          nextRunAt: sequenceEnrollments.nextRunAt,
        })
        .from(sequenceEnrollments)
        .innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequenceId))
        .where(eq(sequenceEnrollments.subscriberId, sub.id))
        .all()

      return ok({
        ...sub,
        tags: await tagsOf(ctx, sub.id),
        enrollments,
        preferences: await preferencesFor(ctx.db, sub.id),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'subscriber_timeline',
    {
      description:
        'Everything known about one person in a single call: attribution touches, campaigns, messages with their events, and purchases. Use this before answering any "why did X happen to this person" question.',
      inputSchema: z.object({
        id: z.number().int().optional(),
        email: z.string().optional(),
        limit: z.number().int().optional().describe('Max messages to include (default 25)'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const sub = await findByEmailOrId(ctx, args)
      if (!sub) return fail('No such subscriber.', 'Try subscriber_search to find the right id.')

      const n = clampLimit(args.limit, 25, 100)
      const msgs = await ctx.db
        .select({
          id: messages.id,
          kind: messages.kind,
          subject: messages.subject,
          status: messages.status,
          suppressedReason: messages.suppressedReason,
          sentAt: messages.sentAt,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.subscriberId, sub.id))
        .orderBy(desc(messages.createdAt))
        .limit(n)
        .all()

      // One events query for the whole page, then grouped in memory — a query
      // per message would burn the D1 budget on a chatty subscriber.
      const evs = msgs.length
        ? await ctx.db
            .select({
              messageId: events.messageId,
              type: events.type,
              occurredAt: events.occurredAt,
              meta: events.meta,
            })
            .from(events)
            .where(
              or(...msgs.map((m) => eq(events.messageId, m.id))),
            )
            .orderBy(desc(events.occurredAt))
            .all()
        : []

      const purchases = await salesForSubscriber(ctx.db, sub.id)

      // The story, in order: how they arrived, what they were tagged, how far
      // into each sequence they got, what they bought. `messages` below is the
      // mail; this is the person. Imported rows are included here — on one
      // person's page, history is exactly what you came for.
      const activity = await activityForSubscriber(ctx.db, sub.id)

      return ok({
        subscriber: { id: sub.id, email: sub.email, name: sub.name, status: sub.status },
        tags: await tagsOf(ctx, sub.id),
        activity: activity.map((a) => ({
          type: a.type,
          occurredAt: a.occurredAt,
          via: a.source,
          campaign: a.campaignName,
          sequence: a.sequenceName,
          ...a.meta,
        })),
        touches: await touchesFor(ctx.db, sub.id),
        campaigns: await campaignsForSubscriber(ctx.db, sub.id),
        purchases: purchases.map(({ sale, campaignName }) => ({
          id: sale.id,
          product: sale.product,
          amount: money(sale.amountCents, sale.currency),
          status: sale.status,
          campaign: campaignName,
          externalId: sale.externalId,
          occurredAt: sale.occurredAt,
        })),
        messages: msgs.map((m) => ({
          ...m,
          events: evs.filter((e) => e.messageId === m.id).map(({ messageId, ...e }) => e),
        })),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'subscriber_upsert',
    {
      description:
        'Create or update a subscriber by email. Never resurrects someone who unsubscribed. Creating a person fires subscribe-triggered sequences unless you turn that off.',
      inputSchema: z.object({
        email: z.string(),
        name: z.string().nullable().optional(),
        source: z.string().nullable().optional(),
        tag_ids: z.array(z.number().int()).optional(),
        trigger_sequences: z
          .boolean()
          .optional()
          .describe('Default true. False for receipts and other non-signups.'),
      }),
    },
    async ({ email, name, source, tag_ids, trigger_sequences }) => {
      const result = await upsertSubscriber(ctx.db, {
        email,
        name: name ?? null,
        source: source ?? 'mcp',
        tagIds: tag_ids,
        triggerSubscribeSequences: trigger_sequences,
      })
      if (result.outcome === 'invalid') return fail(`"${email}" is not a valid address.`)
      return ok(result)
    },
  )

  defineTool(
    server,
    ctx,
    'subscriber_import_csv',
    {
      description:
        'Bulk import from CSV text with an `email` column (optional `name`, `tags`). Returns a per-row report.',
      inputSchema: z.object({
        csv: z.string().describe('Raw CSV including the header row'),
      }),
    },
    async ({ csv }) => ok(await importCsv(ctx.db, csv)),
  )

  defineTool(
    server,
    ctx,
    'subscriber_add_tags',
    {
      description:
        'Tag a subscriber. Idempotent. A newly added tag can start a tag_added sequence — that chain is intended, so check sequence triggers before bulk-tagging.',
      inputSchema: z.object({
        subscriber_id: z.number().int(),
        tag_ids: z.array(z.number().int()).min(1),
      }),
    },
    async ({ subscriber_id, tag_ids }) => {
      const added = await addTags(ctx.db, subscriber_id, tag_ids)
      return ok({ added, note: added ? 'Any tag_added sequences have been triggered.' : 'No change.' })
    },
  )

  defineTool(
    server,
    ctx,
    'subscriber_remove_tag',
    {
      description: 'Remove one tag from a subscriber. Does not un-enroll them from anything.',
      inputSchema: z.object({
        subscriber_id: z.number().int(),
        tag_id: z.number().int(),
      }),
    },
    async ({ subscriber_id, tag_id }) => {
      await removeTag(ctx.db, subscriber_id, tag_id)
      return ok({ removed: true })
    },
  )

  defineTool(
    server,
    ctx,
    'subscriber_delete',
    {
      description:
        'Permanently delete a subscriber and everything cascading from them — messages, events, enrollments, attribution touches, and sales. For a GDPR erasure. To stop mailing someone, use suppression_add instead; it keeps the history.',
      inputSchema: z.object({
        id: z.number().int(),
        confirm_email: z
          .string()
          .describe('Must match the stored address exactly — proof the right row was chosen'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ id, confirm_email }) => {
      const sub = await ctx.db.select().from(subscribers).where(eq(subscribers.id, id)).get()
      if (!sub) return fail('No such subscriber.')
      if (normalizeEmail(confirm_email) !== sub.email) {
        return fail(
          `confirm_email does not match subscriber #${id}.`,
          'Read the address with subscriber_get and pass it back exactly.',
        )
      }

      const purchases = await salesForSubscriber(ctx.db, id)
      await ctx.db.delete(subscribers).where(eq(subscribers.id, id))

      return ok({
        deleted: true,
        email: sub.email,
        warning: purchases.length
          ? `${purchases.length} sale(s) were deleted with them — revenue reports will change.`
          : undefined,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'activity_list',
    {
      description:
        'The activity feed: signups, form submissions, tags, sequence progress, consent changes and purchases, newest first. This is the story of the list — use it for "what has been happening", "why is the list shrinking", or "what is working". Backfilled history is excluded unless you ask for it.',
      inputSchema: z.object({
        types: z.array(z.enum(ACTIVITY_TYPES)).optional().describe('Filter to these activity types'),
        sequence_id: z.number().int().optional(),
        campaign_id: z.number().int().optional(),
        subscriber_id: z.number().int().optional(),
        days: z.number().int().optional().describe('Look back this many days'),
        include_imported: z
          .boolean()
          .optional()
          .describe('Include backfilled history. Default false — it is not activity.'),
        limit: z.number().int().optional().describe('Default 100, max 500'),
        before_id: z.number().int().optional().describe('Keyset page: rows older than this id'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const rows = await activityFeed(ctx.db, {
        types: args.types ? [...args.types] : undefined,
        sequenceId: args.sequence_id,
        campaignId: args.campaign_id,
        subscriberId: args.subscriber_id,
        since: args.days ? Date.now() - args.days * 24 * 60 * 60 * 1000 : undefined,
        includeImported: args.include_imported,
        limit: clampLimit(args.limit, 100, 500),
        beforeId: args.before_id,
      })

      return ok({
        count: rows.length,
        // The id to pass as `before_id` for the next page. Null when this is the end.
        nextBeforeId: rows.length ? (rows[rows.length - 1]?.id ?? null) : null,
        activity: rows.map((r) => ({
          id: r.id,
          type: r.type,
          occurredAt: r.occurredAt,
          via: r.source,
          subscriber: { id: r.subscriberId, email: r.email, name: r.name },
          campaign: r.campaignName,
          sequence: r.sequenceName,
          ...r.meta,
        })),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'list_health',
    {
      description:
        'Net list growth per day plus a breakdown of what the list has been doing. Answers "is the list growing" honestly: joins minus departures, with backfilled history excluded so an import never reads as a good day.',
      inputSchema: z.object({
        days: z.number().int().optional().describe('Window in days. Default 90.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => {
      const window = clampLimit(days, 90, 365)
      const daily = await growthByDay(ctx.db, window)
      const counts = await activityCounts(ctx.db, window)

      return ok({
        windowDays: window,
        joined: daily.reduce((n, d) => n + d.joined, 0),
        left: daily.reduce((n, d) => n + d.left, 0),
        net: daily.reduce((n, d) => n + d.net, 0),
        daily,
        byType: counts,
      })
    },
  )
}
