import type { McpServer } from '@modelcontextprotocol/server'
import { and, desc, eq } from 'drizzle-orm'
import * as z from 'zod/v4'
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
import { devOutbox, events, messages, sequences, subscribers, suppressions } from '../../db/schema.ts'
import { type Ctx, clampLimit, defineTool, fail, ok } from '../kit.ts'

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
        kind: z.enum(['broadcast', 'sequence', 'transactional']).optional(),
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
        'Lift a suppression. Only do this on an explicit request from the person themselves — a hard bounce or a spam complaint is not something to clear because a send failed.',
      inputSchema: z.object({ email: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ email }) => {
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
}
