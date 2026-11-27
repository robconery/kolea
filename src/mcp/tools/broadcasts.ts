import type { McpServer } from '@modelcontextprotocol/server'
import { asc } from 'drizzle-orm'
import * as z from 'zod/v4'
import { agentSendAllowed, agentSendRefusal } from '../../core/agents.ts'
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
import { previewHtml } from '../../core/render.ts'
import { countSegment, describeRule, getSegment } from '../../core/segments.ts'
import { sendPreview } from '../../core/sending.ts'
import type { SegmentRule } from '../../db/schema.ts'
import { tags } from '../../db/schema.ts'
import { type Ctx, clampLimit, defineTool, fail, failed, ok } from '../kit.ts'
import { consumePreflight, digestOf, mintPreflight } from '../../core/preflight.ts'
import { preflightBroadcast, sendBroadcastWithToken } from '../../core/send-preflight.ts'

export function registerBroadcasts(server: McpServer, ctx: Ctx): void {
  // What a resume will send: the current content, to whoever is left after
  // `alreadySent`. A revise, or mail going out in between, kills the token.
  const resumeDigest = (
    b: { subject: string; bodyMd: string; bodyJson: unknown; segment: unknown },
    alreadySent: number,
  ) => digestOf(['resume', b.subject, b.bodyMd, b.bodyJson, b.segment, alreadySent])

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
        'Create a draft broadcast from markdown. Merge tags {{name}}, {{first_name}}, {{email}} and every custom field key ({{plan}}) are supported, each with an optional fallback: {{plan|free}}. kolea://merge-tags lists the fields. Give it an audience with segment_id (copies that segment’s rule) or an inline rule; with neither it goes to everyone who can receive broadcasts.',
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
      if (!(await agentSendAllowed(ctx.env, ctx.db))) return fail(agentSendRefusal(ctx.env))

      const b = await getBroadcast(ctx.db, id)
      if (!b) return fail('No such broadcast.')

      // Same single-copy path the composer's "Send a preview" button uses —
      // one send route, one set of consent checks, one place to get it wrong.
      const result = await sendPreview(
        ctx.env,
        ctx.db,
        { kind: 'broadcast', broadcastId: b.id, subject: b.subject },
        to,
      )
      if (!result.ok) {
        return fail(
          result.reason,
          'Add them with subscriber_upsert first, or pick an address from subscriber_search.',
        )
      }

      return ok({ sent: true, messageId: result.messageId, to: result.to })
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
      const r = await preflightBroadcast(ctx.env, ctx.db, id)
      if (!r.ok) return fail(r.reason)
      // The agent switch is MCP's gate, so its warning is added here, not in core.
      if (!(await agentSendAllowed(ctx.env, ctx.db))) r.report.warnings.push(agentSendRefusal(ctx.env))
      return ok(r.report)
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
      if (!(await agentSendAllowed(ctx.env, ctx.db))) return fail(agentSendRefusal(ctx.env))

      const r = await sendBroadcastWithToken(ctx.env, ctx.db, id, preflight_token)
      if (!r.ok) {
        return r.code === 'preflight'
          ? fail(r.reason, `Call broadcast_preflight({ id: ${id} }) and pass the token it returns.`)
          : fail(r.reason)
      }
      return ok({
        sending: true,
        expectedRecipients: r.expectedRecipients,
        materializedThisCall: r.materialized,
        note: r.interrupted
          ? `This call stopped part-way (the database said: ${r.interrupted}). The send is under way and continues on the next cron tick; nobody gets it twice. Do not send again. Poll broadcast_stats.`
          : 'Large sends continue across cron ticks. Poll broadcast_stats.',
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
      if (!(await agentSendAllowed(ctx.env, ctx.db))) return fail(agentSendRefusal(ctx.env))

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
    'broadcast_resume_preflight',
    {
      description:
        'MANDATORY before broadcast_resume. For a CANCELLED broadcast: how many already have it, roughly how many are left, the subject and body they will get, and a single-use preflight_token (10 minutes) bound to that content. Any edit (broadcast_revise) invalidates it. Nothing is sent.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const b = await getBroadcast(ctx.db, id)
      if (!b) return fail('No such broadcast.')
      if (b.status !== 'cancelled') {
        return fail(`Broadcast #${id} is ${b.status}; only a cancelled send can be resumed.`)
      }
      const outlook = (await resumeOutlook(ctx.db, id))!
      if (outlook.remaining === 0) {
        return fail('Everyone in the audience already has it — there is nobody to resume for.')
      }
      const { token, expiresAt } = await mintPreflight(
        ctx.db,
        'broadcast_resume',
        id,
        await resumeDigest(b, outlook.alreadySent),
        outlook.remaining,
      )
      const warnings: string[] = []
      if (!(await agentSendAllowed(ctx.env, ctx.db))) warnings.push(agentSendRefusal(ctx.env))
      return ok({
        broadcast: { id: b.id, subject: b.subject, status: b.status },
        alreadySent: outlook.alreadySent,
        expectedRemaining: outlook.remaining,
        bodyText: b.bodyMd.slice(0, 2000),
        note: 'The audience was frozen when the send started: nobody who joined since is included. Nobody who already has it gets it again.',
        warnings,
        preflight_token: token,
        expiresAt,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_resume',
    {
      description:
        'Pick a CANCELLED broadcast back up where it stopped. Requires a preflight_token from broadcast_resume_preflight for this broadcast, unused, under 10 minutes old, and minted after the last edit. Nobody is mailed twice: everyone who already has a sent message for it is skipped, mail the provider already accepted is never re-sent, and the walk continues after the last person reached. The audience is the one frozen when the send started: people who joined after that are NOT included. Everyone from here on gets the current subject and body, so a correction saved with broadcast_revise is what they read (re-run the preflight after revising). This sends real mail.',
      inputSchema: z.object({
        id: z.number().int(),
        preflight_token: z.string().describe('From broadcast_resume_preflight'),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ id, preflight_token }) => {
      if (!(await agentSendAllowed(ctx.env, ctx.db))) return fail(agentSendRefusal(ctx.env))

      const b = await getBroadcast(ctx.db, id)
      if (!b) return fail('No such broadcast.')
      if (b.status !== 'cancelled') {
        return fail(`Broadcast #${id} is ${b.status}; only a cancelled send can be resumed.`)
      }
      const outlook = (await resumeOutlook(ctx.db, id))!
      // The confirmation screen offers no button at zero; neither does this.
      if (outlook.remaining === 0) {
        return fail('Everyone in the audience already has it — there is nobody to resume for.')
      }

      const check = await consumePreflight(
        ctx.db,
        'broadcast_resume',
        id,
        await resumeDigest(b, outlook.alreadySent),
        preflight_token,
      )
      if (!check.ok) {
        return fail(
          `Refusing to resume: ${check.reason}.`,
          `Call broadcast_resume_preflight({ id: ${id} }) and pass the token it returns.`,
        )
      }

      const r = await resumeBroadcast(ctx.env, ctx.db, id)
      if (!r.ok) return failed(r)
      return ok({
        resumed: true,
        alreadySent: outlook.alreadySent,
        expectedRemaining: outlook.remaining,
        requeued: r.requeued,
        materializedThisCall: r.materialized,
        note: 'Nobody who already has it gets it again. Large sends continue across cron ticks; poll broadcast_stats.',
      })
    },
  )

  defineTool(
    server,
    ctx,
    'broadcast_revise',
    {
      description:
        'Correct a broadcast that already went out (sent, or cancelled part-way): its subject and body, nothing else. NEVER sends anything to anyone — the corrected copy reaches people only through its web page, and through broadcast_resume if the send was cancelled. The as-mailed copy is kept the first time. Omit a field to keep it. For a draft, use broadcast_update.',
      inputSchema: z.object({
        id: z.number().int(),
        subject: z.string().min(1).optional(),
        body_markdown: z.string().min(1).optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ id, subject, body_markdown }) => {
      const b = await getBroadcast(ctx.db, id)
      if (!b) return fail('No such broadcast.')
      if (subject === undefined && body_markdown === undefined) {
        return fail('Nothing to change.', 'Pass subject, body_markdown, or both.')
      }

      const result = await reviseSentBroadcast(ctx.db, id, {
        subject: subject ?? b.subject,
        ...(body_markdown !== undefined
          ? { bodyMd: body_markdown, bodyJson: mdToDoc(body_markdown) }
          : { bodyMd: b.bodyMd, bodyJson: b.bodyJson }),
      })
      if (!result.ok) {
        return failed(result, b.status === 'draft' ? 'A draft is edited with broadcast_update.' : undefined)
      }
      return ok({ revised: true, sent: 0, note: 'Saved. Nothing was sent.' })
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
