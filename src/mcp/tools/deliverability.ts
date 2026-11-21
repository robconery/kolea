import type { McpServer } from '@modelcontextprotocol/server'
import { and, desc, eq, inArray } from 'drizzle-orm'
import * as z from 'zod/v4'
import { AGENT_SENSITIVE_OFF, agentSendAllowed, agentSendRefusal, agentSensitiveAllowed } from '../../core/agents.ts'
import {
  canReceiveBroadcastIn,
  canReceiveSequenceIn,
  canReceiveTransactionalIn,
  loadConsentSnapshot,
  preferencesFor,
  suppressAddress,
  unsuppressAddress,
} from '../../core/consent.ts'
import { normalizeEmail } from '../../core/ids.ts'
import { type ResendTarget, resendableIds, sendAgain, undeliveredMail } from '../../core/undelivered.ts'
import { devOutbox, events, messages, sequences, subscribers, suppressions } from '../../db/schema.ts'
import { type Ctx, clampLimit, defineTool, fail, failed, ok } from '../kit.ts'
import { consumePreflight, digestOf, mintPreflight } from '../preflight.ts'

const TARGET = z.object({
  kind: z
    .enum(['broadcast', 'step', 'message'])
    .describe('broadcast: every failed message of one broadcast; step: of one sequence step; message: one message'),
  id: z.number().int().describe('The broadcast id, sequence step id, or message id'),
})

/** The token binds to exactly the rows previewed: one more failure since, and it dies. */
async function undeliveredDigest(target: ResendTarget, ids: number[]): Promise<string> {
  return await digestOf(['undelivered', target.kind, target.id, ids])
}

const REASONS = ['unsubscribed_all', 'hard_bounce', 'complaint', 'manual'] as const

/**
 * `unsubscribed_all` is missing on purpose: that reason means the subscriber
 * chose it themselves from the preference center. An operator suppressing an
 * address is doing something else, and mislabelling it makes the list lie.
 */
const MANUAL_REASONS = ['hard_bounce', 'complaint', 'manual'] as const

export function registerDeliverability(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'message_list',
    {
      description:
        'Individual sent messages, newest first. Filter by status to find failures, or by kind to separate marketing from transactional.',
      inputSchema: z.object({
        status: z.enum(['queued', 'sent', 'failed', 'suppressed']).optional(),
        kind: z.enum(['broadcast', 'sequence', 'transactional', 'form', 'confirmation']).optional(),
        broadcast_id: z.number().int().optional(),
        limit: z.number().int().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ status, kind, broadcast_id, limit }) => {
      const filters = []
      if (status) filters.push(eq(messages.status, status))
      if (kind) filters.push(eq(messages.kind, kind))
      if (broadcast_id) filters.push(eq(messages.broadcastId, broadcast_id))

      const rows = await ctx.db
        .select({
          id: messages.id,
          kind: messages.kind,
          toEmail: messages.toEmail,
          subject: messages.subject,
          status: messages.status,
          suppressedReason: messages.suppressedReason,
          error: messages.error,
          provider: messages.provider,
          sentAt: messages.sentAt,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(messages.createdAt))
        .limit(clampLimit(limit))
        .all()

      return ok(rows)
    },
  )

  defineTool(
    server,
    ctx,
    'message_get',
    {
      description: 'One message with every delivery event recorded against it.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const msg = await ctx.db.select().from(messages).where(eq(messages.id, id)).get()
      if (!msg) return fail('No such message.')

      const evs = await ctx.db
        .select({
          type: events.type,
          occurredAt: events.occurredAt,
          meta: events.meta,
        })
        .from(events)
        .where(eq(events.messageId, id))
        .orderBy(desc(events.occurredAt))
        .all()

      return ok({ ...msg, events: evs })
    },
  )

  defineTool(
    server,
    ctx,
    'consent_check',
    {
      description:
        'Would this address receive a broadcast, a given sequence, or a transactional message right now — and if not, why? The three answers differ on purpose: unsubscribing stops broadcasts only, leaving a sequence is scoped to that sequence, and a receipt goes out unless the address is dead or complained.',
      inputSchema: z.object({
        email: z.string(),
        sequence_id: z.number().int().optional().describe('Also check this specific sequence'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ email, sequence_id }) => {
      const address = normalizeEmail(email)
      const sub = await ctx.db.select().from(subscribers).where(eq(subscribers.email, address)).get()

      const snapshot = await loadConsentSnapshot(
        ctx.db,
        [address],
        sub ? [sub.id] : [],
        sequence_id ? [sequence_id] : [],
      )

      const suppression = await ctx.db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, address))
        .get()

      const answer: Record<string, unknown> = {
        email: address,
        isSubscriber: Boolean(sub),
        status: sub?.status ?? null,
        suppression: suppression ? { reason: suppression.reason, since: suppression.createdAt } : null,
        transactional: canReceiveTransactionalIn(snapshot, address),
      }

      if (sub) {
        answer.broadcast = canReceiveBroadcastIn(snapshot, sub)
        answer.preferences = await preferencesFor(ctx.db, sub.id)
        if (sequence_id) {
          const seq = await ctx.db
            .select({ name: sequences.name })
            .from(sequences)
            .where(eq(sequences.id, sequence_id))
            .get()
          answer.sequence = {
            id: sequence_id,
            name: seq?.name ?? null,
            ...canReceiveSequenceIn(snapshot, sub, sequence_id),
          }
        }
      }

      return ok(answer)
    },
  )

  defineTool(
    server,
    ctx,
    'suppression_list',
    {
      description: 'Globally suppressed addresses — the kill switch list, keyed by address not person.',
      inputSchema: z.object({
        reason: z.enum(REASONS).optional(),
        limit: z.number().int().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ reason, limit }) =>
      ok(
        await ctx.db
          .select()
          .from(suppressions)
          .where(reason ? eq(suppressions.reason, reason) : undefined)
          .orderBy(desc(suppressions.createdAt))
          .limit(clampLimit(limit))
          .all(),
      ),
  )

  defineTool(
    server,
    ctx,
    'suppression_add',
    {
      description:
        'Stop all mail to an address, forever, including transactional if the reason is hard_bounce or complaint. This is the right way to make someone stop receiving mail — it keeps their history, unlike subscriber_delete.',
      inputSchema: z.object({
        email: z.string(),
        reason: z.enum(MANUAL_REASONS).optional().describe("Defaults to 'manual'"),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ email, reason }) => {
      const address = normalizeEmail(email)
      await suppressAddress(ctx.db, address, reason ?? 'manual')
      return ok({ suppressed: address, reason: reason ?? 'manual' })
    },
  )

  defineTool(
    server,
    ctx,
    'suppression_remove',
    {
      description:
        'Lift a suppression. Only do this on an explicit request from the person themselves — a hard bounce or a spam complaint is not something to clear because a send failed. Refused unless the operator has turned on sensitive changes for agents (System > Agents & keys).',
      inputSchema: z.object({ email: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ email }) => {
      if (!(await agentSensitiveAllowed(ctx.db))) return fail(AGENT_SENSITIVE_OFF)
      const address = normalizeEmail(email)
      const existing = await ctx.db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, address))
        .get()
      if (!existing) return fail(`${address} is not suppressed.`)

      await unsuppressAddress(ctx.db, address)
      return ok({ unsuppressed: address, wasReason: existing.reason })
    },
  )

  defineTool(
    server,
    ctx,
    'outbox_list',
    {
      description:
        'Local development only: fully rendered mail the console provider captured instead of sending. Use this to check what a send would actually look like when EMAIL_PROVIDER is "console".',
      inputSchema: z.object({ limit: z.number().int().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const rows = await ctx.db
        .select({
          id: devOutbox.id,
          messageId: devOutbox.messageId,
          toEmail: devOutbox.toEmail,
          subject: devOutbox.subject,
          text: devOutbox.text,
          createdAt: devOutbox.createdAt,
        })
        .from(devOutbox)
        .orderBy(desc(devOutbox.createdAt))
        .limit(clampLimit(limit, 20, 100))
        .all()

      if (!rows.length && ctx.env.EMAIL_PROVIDER !== 'console') {
        return ok({
          outbox: [],
          note: `EMAIL_PROVIDER is "${ctx.env.EMAIL_PROVIDER}" — mail is really being sent, so nothing lands here.`,
        })
      }
      return ok(rows.map((r) => ({ ...r, text: r.text.slice(0, 1500) })))
    },
  )

  defineTool(
    server,
    ctx,
    'undelivered_list',
    {
      description:
        'Mail that should have gone and did not: messages the queue gave up on or the provider refused, grouped by broadcast, sequence step, or single message. Cancelled broadcasts, suppressed mail, and anything the provider accepted are never listed. `renderedToOutbox` counts mail the console provider rendered instead of sending; that is not offered for re-sending.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const report = await undeliveredMail(ctx.db, 20)
      return ok({ total: report.total, groups: report.groups, renderedToOutbox: report.renderedToOutbox })
    },
  )

  defineTool(
    server,
    ctx,
    'undelivered_preflight',
    {
      description:
        'Preview sending failed mail again for one target, and get the preflight_token undelivered_send_again requires. Shows how many messages, to whom, and why they failed. The token is single-use, lasts 10 minutes, and dies if the set of failed messages changes.',
      inputSchema: z.object({ target: TARGET }),
      annotations: { readOnlyHint: true },
    },
    async ({ target }) => {
      const ids = await resendableIds(ctx.db, target)
      if (ids.length === 0) return fail('Nothing to send again for that target.')

      const sample = await ctx.db
        .select({ id: messages.id, toEmail: messages.toEmail, subject: messages.subject, error: messages.error })
        .from(messages)
        .where(inArray(messages.id, ids.slice(0, 10)))
        .all()
      const { token, expiresAt } = await mintPreflight(
        ctx.db,
        'undelivered_send_again',
        target.id,
        await undeliveredDigest(target, ids),
        ids.length,
      )
      return ok({
        target,
        messages: ids.length,
        sample,
        note: 'Consent is checked again at send time; anyone who unsubscribed since is skipped. Nobody who already got it is mailed twice.',
        preflight_token: token,
        expiresAt,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'undelivered_send_again',
    {
      description:
        'Put failed mail for one target back through the normal send path. Requires a preflight_token from undelivered_preflight for the same target, minted since the last change to its failed messages. Real mail goes out.',
      inputSchema: z.object({ target: TARGET, preflight_token: z.string().describe('From undelivered_preflight') }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ target, preflight_token }) => {
      if (!(await agentSendAllowed(ctx.env, ctx.db))) return fail(agentSendRefusal(ctx.env))

      const ids = await resendableIds(ctx.db, target)
      const check = await consumePreflight(
        ctx.db,
        'undelivered_send_again',
        target.id,
        await undeliveredDigest(target, ids),
        preflight_token,
      )
      if (!check.ok) {
        return fail(
          `Refusing to send: ${check.reason}.`,
          `Call undelivered_preflight({ target: ${JSON.stringify(target)} }) and pass the token it returns.`,
        )
      }

      const result = await sendAgain(ctx.env, ctx.db, target)
      return result.ok ? ok({ requeued: result.requeued }) : failed(result)
    },
  )
}
