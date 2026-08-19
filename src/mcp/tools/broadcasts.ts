import type { McpServer } from '@modelcontextprotocol/server'
import { asc, eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import {
  broadcastStats,
  cancelBroadcast,
  createBroadcast,
  deleteBroadcast,
  getBroadcast,
  listBroadcasts,
  scheduleBroadcast,
  startBroadcast,
  updateBroadcast,
} from '../../core/broadcasts.ts'
import { canReceiveBroadcastIn, loadConsentSnapshot } from '../../core/consent.ts'
import { normalizeEmail } from '../../core/ids.ts'
import { mdToDoc } from '../../core/md-to-doc.ts'
import { previewHtml, renderEmail } from '../../core/render.ts'
import { countSegment, describeRule, getSegment, resolveSegment } from '../../core/segments.ts'
import { dispatch } from '../../core/sending.ts'
import type { SegmentRule } from '../../db/schema.ts'
import { messages, subscribers, tags } from '../../db/schema.ts'
import { type Ctx, clampLimit, defineTool, fail, failed, ok } from '../kit.ts'
import { SEND_DISABLED, consumePreflight, digestOf, mintPreflight, sendingAllowed } from '../preflight.ts'

/**
 * Merge tags the renderer knows. Anything else is passed through to the reader
 * verbatim, braces and all — no error, no blank. Exactly the silent failure a
 * preflight exists to surface.
 */
const KNOWN_MERGE_FIELDS = new Set(['name', 'first_name', 'email'])

/**
 * Segment pages the preflight walks. `resolveSegment` pages at 400 and each page
 * costs a handful of D1 queries, so five pages counts 2,000 people well inside
 * the 1,000-query cap. Beyond that the preflight reports what it counted.
 */
const PREFLIGHT_PAGES = 5

function unknownMergeFields(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) {
    const field = m[1]!.toLowerCase()
    if (!KNOWN_MERGE_FIELDS.has(field)) found.add(field)
  }
  return [...found]
}

export function registerBroadcasts(server: McpServer, ctx: Ctx): void {
  /** What the preflight token is bound to. Any edit to these invalidates it. */
  const broadcastDigest = (b: { subject: string; bodyMd: string; bodyJson: unknown; segment: unknown }) =>
    digestOf([b.subject, b.bodyMd, b.bodyJson, b.segment])

  defineTool(
    server,
    ctx,
    'broadcast_list',
    {
      description: 'Recent broadcasts, newest first, with status and schedule.',
      inputSchema: z.object({
        limit: z.number().int().optional(),
        status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'cancelled']).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, status }) => {
      const rows = await listBroadcasts(ctx.db, clampLimit(limit))
      const filtered = status ? rows.filter((b) => b.status === status) : rows
      return ok(
        filtered.map((b) => ({
          id: b.id,
          subject: b.subject,
          status: b.status,
          campaignId: b.campaignId,
          scheduledAt: b.scheduledAt,
          sentAt: b.sentAt,
          createdAt: b.createdAt,
        })),
      )
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_get',
    {
      description: 'One broadcast: content, audience rule, current audience size, and stats.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const b = await getBroadcast(ctx.db, id)
      if (!b) return fail('No such broadcast.')

      const allTags = await ctx.db.select().from(tags).orderBy(asc(tags.name)).all()
      return ok({
        ...b,
        audience: describeRule(b.segment ?? {}, allTags),
        audienceSize: await countSegment(ctx.db, b.segment ?? {}),
        stats: await broadcastStats(ctx.db, id),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_create',
    {
      description:
        'Create a draft broadcast from markdown. Merge tags {{name}}, {{first_name}} and {{email}} are supported. Give it an audience with segment_id (copies that segment’s rule) or an inline rule; with neither it goes to everyone who can receive broadcasts.',
      inputSchema: z.object({
        subject: z.string().min(1),
        body_markdown: z.string().min(1),
        segment_id: z.number().int().nullable().optional(),
        rule: z
          .object({
            match: z.enum(['any', 'all']).optional(),
            include_tag_ids: z.array(z.number().int()).optional(),
            exclude_tag_ids: z.array(z.number().int()).optional(),
          })
          .optional()
          .describe('Inline audience rule. Ignored when segment_id is given.'),
        campaign_id: z.number().int().nullable().optional(),
      }),
    },
    async (args) => {
      let segment = {}
      let segmentId: number | null = null

      if (args.segment_id) {
        const seg = await getSegment(ctx.db, args.segment_id)
        if (!seg) return fail(`No segment #${args.segment_id}.`, 'List them with segment_list.')
        // Copied, not referenced — editing the segment next month must not
        // rewrite who this broadcast went to.
        segment = seg.rule ?? {}
        segmentId = seg.id
      } else if (args.rule) {
        segment = {
          ...(args.rule.match ? { match: args.rule.match } : {}),
          ...(args.rule.include_tag_ids?.length ? { includeTagIds: args.rule.include_tag_ids } : {}),
          ...(args.rule.exclude_tag_ids?.length ? { excludeTagIds: args.rule.exclude_tag_ids } : {}),
        }
      }

      const id = await createBroadcast(ctx.db, {
        subject: args.subject,
        bodyMd: args.body_markdown,
        bodyJson: mdToDoc(args.body_markdown),
        segment,
        segmentId,
        campaignId: args.campaign_id ?? null,
      })

      return ok({
        id,
        status: 'draft',
        audienceSize: await countSegment(ctx.db, segment),
        next: 'broadcast_preflight to see who it would reach, then broadcast_send.',
      })
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_update',
    {
      description:
        'Edit a draft. Refused once a broadcast is scheduled, sending or sent — rewriting it would change what the archive says went out.',
      inputSchema: z.object({
        id: z.number().int(),
        subject: z.string().min(1).optional(),
        body_markdown: z.string().min(1).optional(),
        campaign_id: z.number().int().nullable().optional(),
        segment_id: z.number().int().nullable().optional(),
      }),
    },
    async (args) => {
      let segment: SegmentRule | undefined
      if (args.segment_id) {
        const seg = await getSegment(ctx.db, args.segment_id)
        if (!seg) return fail(`No segment #${args.segment_id}.`)
        segment = seg.rule ?? {}
      }

      const result = await updateBroadcast(ctx.db, args.id, {
        ...(args.subject !== undefined ? { subject: args.subject } : {}),
        ...(args.body_markdown !== undefined
          ? { bodyMd: args.body_markdown, bodyJson: mdToDoc(args.body_markdown) }
          : {}),
        ...(args.campaign_id !== undefined ? { campaignId: args.campaign_id } : {}),
        ...(segment !== undefined ? { segment, segmentId: args.segment_id ?? null } : {}),
      })
      if (!result.ok) return failed(result)

      return ok({
        updated: true,
        note: 'Any preflight token minted before this edit is now invalid.',
      })
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_delete',
    {
      description: 'Delete a broadcast and its message rows. Refused mid-send.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const result = await deleteBroadcast(ctx.db, id)
      return result.ok ? ok({ deleted: true }) : failed(result)
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_preview',
    {
      description:
        'Render a broadcast as HTML and plain text with sample merge values. No tracking rewrites, nothing sent.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const b = await getBroadcast(ctx.db, id)
      if (!b) return fail('No such broadcast.')
      return ok({ subject: b.subject, html: previewHtml(b.bodyJson, b.bodyMd) })
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_send_test',
    {
      description:
        'Send one real copy to one address. No preflight needed — it reaches exactly one person. The recipient must already be a subscriber and must not be suppressed.',
      inputSchema: z.object({
        id: z.number().int(),
        to: z.string().describe('Address of an existing subscriber'),
      }),
    },
    async ({ id, to }) => {
      if (!sendingAllowed(ctx.env)) return fail(SEND_DISABLED)

      const b = await getBroadcast(ctx.db, id)
      if (!b) return fail('No such broadcast.')

      const email = normalizeEmail(to)
      const sub = await ctx.db.select().from(subscribers).where(eq(subscribers.email, email)).get()
      if (!sub) {
        return fail(
          `${email} is not a subscriber.`,
          'Add them with subscriber_upsert first, or pick an address from subscriber_search.',
        )
      }

      const snapshot = await loadConsentSnapshot(ctx.db, [sub.email])
      const block = canReceiveBroadcastIn(snapshot, sub)
      if (block.blocked) return fail(`${email} cannot receive broadcasts: ${block.reason}`)

      const inserted = await ctx.db
        .insert(messages)
        .values({
          subscriberId: sub.id,
          kind: 'broadcast',
          broadcastId: b.id,
          toEmail: sub.email,
          subject: `[test] ${b.subject}`,
          status: 'queued',
          // Distinct per attempt, so re-testing after an edit actually re-sends.
          idempotencyKey: `test:${b.id}:${sub.id}:${Date.now()}`,
          createdAt: new Date(),
        })
        .returning({ id: messages.id })

      const messageId = inserted[0]!.id
      ctx.executionCtx.waitUntil(dispatch(ctx.env, ctx.db, [messageId]))

      return ok({ sent: true, messageId, to: sub.email })
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_preflight',
    {
      description:
        'MANDATORY before broadcast_send. Reports exactly who would receive this broadcast, who is filtered out and why, any unresolved merge tags, and a rendered sample. Returns a single-use preflight_token that expires in 10 minutes and is invalidated by any edit. Nothing is sent.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const b = await getBroadcast(ctx.db, id)
      if (!b) return fail('No such broadcast.')
      if (b.status !== 'draft') {
        return fail(`Broadcast #${id} is ${b.status}, not a draft — there is nothing to preflight.`)
      }

      const totalCandidates = await countSegment(ctx.db, b.segment ?? {})

      // Walk the same pages the real send walks, so the numbers here are the
      // numbers that will happen. Capped: past the cap the counts become an
      // extrapolation and the response says so rather than quietly rounding.
      const blockedBy = new Map<string, number>()
      let examined = 0
      let willReceive = 0
      let first: { id: number; email: string; status: string } | undefined
      let cursor = 0

      for (let page = 0; page < PREFLIGHT_PAGES; page++) {
        const candidates = await resolveSegment(ctx.db, b.segment ?? {}, cursor)
        if (!candidates.length) break

        const snapshot = await loadConsentSnapshot(
          ctx.db,
          candidates.map((c) => c.email),
        )
        for (const c of candidates) {
          const block = canReceiveBroadcastIn(snapshot, c)
          if (block.blocked) blockedBy.set(block.reason, (blockedBy.get(block.reason) ?? 0) + 1)
          else {
            willReceive++
            first ??= c
          }
        }

        examined += candidates.length
        cursor = candidates[candidates.length - 1]!.id
      }

      const partial = examined < totalCandidates
      const sampleName = first
        ? ((
            await ctx.db
              .select({ name: subscribers.name })
              .from(subscribers)
              .where(eq(subscribers.id, first.id))
              .get()
          )?.name ?? null)
        : null

      // Rendered against a real recipient where one exists, so the sample is the
      // mail that will actually land rather than an idealized version of it.
      const sample = renderEmail(
        { json: b.bodyJson, md: b.bodyMd },
        {
          publicUrl: ctx.env.PUBLIC_URL,
          messageId: 0,
          unsubToken: 'sample-token',
          scope: { kind: 'broadcast' },
          scopeLabel: ctx.env.FROM_NAME,
          subscriber: first
            ? { email: first.email, name: sampleName }
            : { email: 'ada@example.com', name: 'Ada Lovelace' },
          trackOpens: true,
          trackClicks: true,
          showFooter: true,
        },
      )

      const unresolved = unknownMergeFields(`${b.subject} ${b.bodyMd}`)
      const allTags = await ctx.db.select().from(tags).orderBy(asc(tags.name)).all()
      const { token, expiresAt } = await mintPreflight(
        ctx.db,
        'broadcast_send',
        b.id,
        await broadcastDigest(b),
        willReceive,
      )

      const warnings: string[] = []
      if (!willReceive) warnings.push('Nobody would receive this — the audience resolves to zero.')
      if (unresolved.length) {
        warnings.push(
          `Unknown merge tags — these reach the reader literally, braces and all: ${unresolved
            .map((f) => `{{${f}}}`)
            .join(', ')}`,
        )
      }
      if (!b.campaignId) warnings.push('No campaign — clicks will not be attributed to anything.')
      if (!sendingAllowed(ctx.env)) warnings.push(SEND_DISABLED)
      if (partial) {
        warnings.push(
          `Audience is larger than the preflight walks: counted the first ${examined} of ${totalCandidates}. The rest are filtered by the same rules at send time.`,
        )
      }

      return ok({
        broadcast: { id: b.id, subject: b.subject, status: b.status, campaignId: b.campaignId },
        audience: describeRule(b.segment ?? {}, allTags),
        candidates: totalCandidates,
        examined,
        willReceive,
        countsAreComplete: !partial,
        filteredOut: Object.fromEntries(blockedBy),
        warnings,
        sampleRenderedFor: first?.email ?? '(no real recipient — sample values used)',
        sampleText: sample.text.slice(0, 2000),
        preflight_token: token,
        expiresAt,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_send',
    {
      description:
        'Send a broadcast for real. Requires a preflight_token from broadcast_preflight for this exact broadcast, unused, under 10 minutes old, and minted after the last edit. This is irreversible.',
      inputSchema: z.object({
        id: z.number().int(),
        preflight_token: z.string().describe('From broadcast_preflight'),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ id, preflight_token }) => {
      if (!sendingAllowed(ctx.env)) return fail(SEND_DISABLED)

      const b = await getBroadcast(ctx.db, id)
      if (!b) return fail('No such broadcast.')
      if (b.status !== 'draft') return fail(`Broadcast #${id} is already ${b.status}.`)

      const check = await consumePreflight(
        ctx.db,
        'broadcast_send',
        id,
        await broadcastDigest(b),
        preflight_token,
      )
      if (!check.ok) {
        return fail(
          `Refusing to send: ${check.reason}.`,
          `Call broadcast_preflight({ id: ${id} }) and pass the token it returns.`,
        )
      }

      const materialized = await startBroadcast(ctx.env, ctx.db, id)
      return ok({
        sending: true,
        expectedRecipients: check.recipientCount,
        materializedThisCall: materialized,
        note: 'Large sends continue across cron ticks. Poll broadcast_stats.',
      })
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_schedule',
    {
      description:
        'Park a draft to go out at a future time. The cron tick picks it up. No preflight token needed — broadcast_cancel can still stop it before it starts.',
      inputSchema: z.object({
        id: z.number().int(),
        at: z.string().describe('ISO 8601 timestamp, in the future'),
      }),
    },
    async ({ id, at }) => {
      if (!sendingAllowed(ctx.env)) return fail(SEND_DISABLED)

      const ms = Date.parse(at)
      if (Number.isNaN(ms)) return fail(`"${at}" is not a parseable timestamp.`)

      const result = await scheduleBroadcast(ctx.db, id, new Date(ms))
      return result.ok ? ok({ scheduled: true, at: new Date(ms) }) : failed(result)
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_cancel',
    {
      description:
        'Cancel a scheduled or in-flight broadcast. Mail already handed to the provider cannot be recalled — the response says how much that was.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const result = await cancelBroadcast(ctx.db, id)
      if (!result.ok) return failed(result)
      return ok({
        cancelled: true,
        alreadySent: result.alreadySent,
        note: result.alreadySent
          ? `${result.alreadySent} message(s) had already gone out and cannot be recalled.`
          : 'Nothing had gone out yet.',
      })
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_stats',
    {
      description: 'Recipients, sends, opens, clicks, bounces and failures for one broadcast.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const b = await getBroadcast(ctx.db, id)
      if (!b) return fail('No such broadcast.')
      return ok({ status: b.status, ...(await broadcastStats(ctx.db, id)) })
    },
  )
}
