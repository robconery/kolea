import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { events, messages, subscribers } from '../db/schema.ts'
import type { ProviderEvent } from '../providers/types.ts'
import { touchFromMessage } from './campaigns.ts'
import { suppressAddress } from './consent.ts'
import { applyTagRules } from './tagging.ts'

export async function recordEvent(
  db: Db,
  messageId: number,
  type: ProviderEvent['type'],
  meta: Record<string, unknown> = {},
  dedupeKey?: string,
): Promise<void> {
  const inserted = await db
    .insert(events)
    .values({ messageId, type, occurredAt: new Date(), meta, dedupeKey: dedupeKey ?? null })
    .onConflictDoNothing()
    .returning({ id: events.id })

  // A replayed webhook loses the race on `dedupe_key` and inserts nothing — the
  // rules already ran the first time round.
  if (inserted.length === 0) return

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
  }

  if (ev.type === 'complaint') {
    await suppressAddress(db, msg.toEmail, 'complaint')
    await db
      .update(subscribers)
      .set({ status: 'complained' })
      .where(eq(subscribers.id, msg.subscriberId))
  }
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
