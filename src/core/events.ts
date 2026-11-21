import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { events, messages, subscribers } from '../db/schema.ts'
import type { ProviderEvent } from '../providers/types.ts'
import { logActivity } from './activity.ts'
import { touchFromMessage } from './campaigns.ts'
import { suppressAddress } from './consent.ts'
import { classifyOpen } from './machine-opens.ts'
import { applyTagRules } from './tagging.ts'

export async function recordEvent(
  db: Db,
  messageId: number,
  type: ProviderEvent['type'],
  meta: Record<string, unknown> = {},
  dedupeKey?: string,
  opts: { machine?: boolean; at?: Date } = {},
): Promise<void> {
  const machine = opts.machine ?? false
  const inserted = await db
    .insert(events)
    .values({
      messageId,
      type,
      occurredAt: opts.at ?? new Date(),
      meta,
      dedupeKey: dedupeKey ?? null,
      machine,
    })
    .onConflictDoNothing()
    .returning({ id: events.id })

  // A replayed webhook loses the race on `dedupe_key` and inserts nothing — the
  // rules already ran the first time round.
  if (inserted.length === 0) return

  // A machine is not a person acting, so it fires nothing: no tag rule, no
  // sequence it would start (Kōlea SPEC 11.2, `TagRules`). The row above is the
  // whole of what a prefetch is allowed to do.
  if (machine) return

  try {
    await applyTagRules(db, messageId, type, meta)
  } catch {
    // Auto-tagging must never break the open pixel or the click redirect. The
    // event itself is already recorded, which is the part that must not be lost.
  }

  // A click on campaign mail is a touch — that's what moves last-touch credit
  // onto the campaign when the sale lands. An open is not: it fires on image
  // proxies and preview panes, and would hand credit to whatever mailed last.
  if (type === 'click') {
    try {
      await touchFromMessage(db, messageId)
    } catch {
      /* same reasoning as above — attribution is never worth a broken redirect */
    }
  }
}

/**
 * The open pixel was fetched: judge the hit, then record it.
 *
 * A machine open (`core/machine-opens.ts`) is still written, flagged, so the
 * share of opens that are Apple's can be shown; it is left out of every reader
 * count and fires no tag rule. The timing check measures from `sent_at`, when the
 * provider took the mail, falling back to when the row was queued.
 *
 * Throws only if the message is gone, which the pixel route swallows.
 */
export async function recordOpen(
  db: Db,
  messageId: number,
  request: { userAgent: string | null | undefined; ip: string | null | undefined },
  at: Date = new Date(),
): Promise<void> {
  const msg = await db
    .select({ sentAt: messages.sentAt, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()
  if (!msg) return

  const verdict = classifyOpen({
    userAgent: request.userAgent,
    ip: request.ip,
    sentAt: msg.sentAt ?? msg.createdAt,
    at,
  })
  const meta: Record<string, unknown> = {}
  if (request.userAgent) meta.user_agent = request.userAgent.slice(0, 512)
  if (verdict.machine) meta.machine_reason = verdict.reason

  await recordEvent(db, messageId, 'open', meta, undefined, { machine: verdict.machine, at })
}

/**
 * Apply a provider event.
 *
 * Only hard bounces and complaints escalate to a global suppression — a soft
 * bounce is transient, and nothing here may act on a narrower consent scope.
 */
export async function applyProviderEvent(db: Db, ev: ProviderEvent): Promise<void> {
  const msg = await db
    .select()
    .from(messages)
    .where(eq(messages.providerMessageId, ev.providerMessageId))
    .get()
  if (!msg) return

  await recordEvent(db, msg.id, ev.type, ev.meta ?? {}, ev.dedupeKey)

  if (ev.type === 'bounce' && ev.hardBounce) {
    await suppressAddress(db, msg.toEmail, 'hard_bounce')
    await db
      .update(subscribers)
      .set({ status: 'bounced' })
      .where(eq(subscribers.id, msg.subscriberId))
    await logLeaving(db, msg.subscriberId, 'bounced', msg.id, msg.toEmail)
  }

  if (ev.type === 'complaint') {
    await suppressAddress(db, msg.toEmail, 'complaint')
    await db
      .update(subscribers)
      .set({ status: 'complained' })
      .where(eq(subscribers.id, msg.subscriberId))
    await logLeaving(db, msg.subscriberId, 'complained', msg.id, msg.toEmail)
  }
}

/**
 * The same fact, told twice on purpose.
 *
 * `events` already has the bounce against the message — that is how you cost a
 * send. This is the person leaving the list, which is how you read list health,
 * and it has to sit in the same feed as every other departure or net growth is
 * assembled from two different shapes. The message id rides along in the meta,
 * so the two are never out of touch.
 */
async function logLeaving(
  db: Db,
  subscriberId: number,
  type: 'bounced' | 'complained',
  messageId: number,
  email: string,
) {
  await logActivity(db, {
    type,
    subscriberId,
    source: 'queue',
    meta: { messageId, email },
    // Status is terminal, so this happens once no matter how many times the
    // provider replays the webhook.
    dedupeKey: `${type}:${subscriberId}`,
  })
}

/**
 * Charge an unsubscribe to the mail that caused it.
 *
 * Deliberately not routed through `recordEvent()`: that path runs tag rules and
 * campaign attribution, which are for things a *provider* told us. This is the
 * reader acting on our own preference centre, and the only thing it should do is
 * leave a countable mark.
 *
 * `messageId` arrives from a URL, so it is verified against the subscriber before
 * anything is written — otherwise anyone with a preference link could hand an
 * arbitrary broadcast a fake unsubscribe. An unattributable action is simply not
 * recorded; the consent change itself has already happened either way, and is
 * never contingent on this.
 *
 * The dedupe key makes a refresh or a double-tap idempotent (SPEC 2a.5).
 */
export async function recordUnsubscribeAttribution(
  db: Db,
  subscriberId: number,
  messageId: number | null,
  action: 'broadcast' | 'sequence' | 'all',
): Promise<void> {
  if (!messageId || !Number.isInteger(messageId)) return

  const msg = await db
    .select({ id: messages.id, subscriberId: messages.subscriberId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()
  if (!msg || msg.subscriberId !== subscriberId) return

  await db
    .insert(events)
    .values({
      messageId: msg.id,
      type: 'unsubscribe',
      occurredAt: new Date(),
      meta: { action },
      dedupeKey: `unsub:${msg.id}:${action}`,
    })
    .onConflictDoNothing()
}
