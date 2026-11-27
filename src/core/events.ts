import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { events, messages, subscribers } from '../db/schema.ts'
import { OUTCOME_UNKNOWN, type ProviderEvent } from '../providers/types.ts'
import { logActivity } from './activity.ts'
import { touchFromMessage } from './campaigns.ts'
import { leaveBroadcasts, suppressAddress } from './consent.ts'
import { classifyOpen } from './machine-opens.ts'
import { applyTagRules } from './tagging.ts'
import { emitWebhook, subscriberPayload } from './webhooks.ts'

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
  // sequence it would start. The row above is the whole of what a prefetch is
  // allowed to do.
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
  const msg = await findEventMessage(db, ev)
  if (!msg) return

  if (ev.type === 'unsubscribe') {
    await applyProviderUnsubscribe(db, msg, ev)
    return
  }

  await recordEvent(db, msg.id, ev.type, ev.meta ?? {}, ev.dedupeKey)

  if (ev.type === 'failed' || (ev.type === 'bounce' && !ev.hardBounce && ev.permanent)) {
    await markRefused(db, msg.id, ev)
  }

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

type MessageRow = typeof messages.$inferSelect

/**
 * The message a provider event is about.
 *
 * By our own id first, when the provider echoed it back (`ev.messageId`, from
 * the tag the adapter put on the mail): a primary-key read, the cheapest there
 * is, and the one that still works for mail whose provider id was never
 * written. Then by the provider's id, which is indexed too.
 *
 * ⭐ The echoed id is a hint, never an authority. A webhook body is the
 * provider's word only when its signature checked out, and a numeric id is easy
 * to guess, so the row it names is used only if it is unmistakably the same
 * mail: its provider id matches the event's, or the provider was asked for it
 * and its answer was never recorded (`provider_called_at` set, no provider id).
 * Anything else falls through to the provider-id lookup, exactly as before.
 *
 * In the second case the event is the record that never landed: it proves the
 * provider took the mail. So the row is completed from it: it gets the
 * provider's id, and a row still `queued`, or marked failed as `outcome
 * unknown`, becomes `sent`. This only ever moves a row towards "sent", never
 * sends anything, and it is what lets an unrecorded send settle itself instead
 * of waiting for the operator.
 */
async function findEventMessage(db: Db, ev: ProviderEvent): Promise<MessageRow | undefined> {
  if (ev.messageId) {
    const tagged = await db.select().from(messages).where(eq(messages.id, ev.messageId)).get()
    if (tagged?.providerMessageId === ev.providerMessageId) return tagged
    if (tagged && tagged.providerMessageId === null && tagged.providerCalledAt !== null) {
      return await adoptUnrecordedSend(db, tagged, ev)
    }
  }
  return await db
    .select()
    .from(messages)
    .where(eq(messages.providerMessageId, ev.providerMessageId))
    .get()
}

/** Write onto the row what its lost record would have said. See `findEventMessage`. */
async function adoptUnrecordedSend(db: Db, msg: MessageRow, ev: ProviderEvent): Promise<MessageRow> {
  const settles = msg.status === 'queued' || (msg.status === 'failed' && (msg.error ?? '').startsWith(OUTCOME_UNKNOWN))
  const updated = await db
    .update(messages)
    .set({
      providerMessageId: ev.providerMessageId,
      ...(settles
        ? { status: 'sent' as const, sentAt: msg.providerCalledAt ?? ev.occurredAt, error: null, claimedAt: null }
        : {}),
    })
    .where(and(eq(messages.id, msg.id), isNull(messages.providerMessageId)))
    .returning()
  return updated[0] ?? msg
}

/**
 * ⭐ The provider took the mail, then refused it for good (a `rejected`, or a
 * permanent failure that is not a dead mailbox). Left `sent`, it would be mail
 * silently dropped: nothing would ever show it did not arrive.
 *
 * It becomes `failed` with the provider's reason, which puts it on the
 * Undelivered screen under "check before sending" (it has a provider id, so no
 * bulk resend ever claims it: the provider refused it, and sending it again
 * blind is only worth doing once whatever refused it is fixed). No consent
 * changes. Guarded on `sent`, so a replay, or a late event about mail already
 * sent again, changes nothing.
 */
async function markRefused(db: Db, messageId: number, ev: ProviderEvent): Promise<void> {
  const meta = ev.meta ?? {}
  const why = [meta.reason, meta.message].filter((v) => typeof v === 'string' && v).join(': ')
  await db
    .update(messages)
    .set({ status: 'failed', error: `refused by the provider after accepting it${why ? ` (${why})` : ''}`.slice(0, 500) })
    .where(and(eq(messages.id, messageId), eq(messages.status, 'sent')))
}

/**
 * The provider says the reader asked it to stop (Mailgun's own unsubscribe list).
 *
 * ⭐ Broadcast scope, and nothing wider. Only the reader's own "unsubscribe
 * from everything", a hard bounce or a complaint may write a suppression
 * (invariant 2), and a provider-side unsubscribe is none of those: it most
 * often comes from a List-Unsubscribe on a newsletter. So it is exactly what
 * the preference center's newsletter unsubscribe does: `unsubscribed`, no
 * suppression, sequences untouched.
 *
 * Nothing is silently dropped by not going wider: if the provider then refuses
 * a sequence step or a receipt to that address, that refusal arrives as a
 * permanent failure, the message is marked `failed`, and it shows on the
 * Undelivered screen (`markRefused`).
 *
 * Like the preference centre's unsubscribe, it skips tag rules and attribution
 * (`recordEvent`): it is a consent change, not engagement. The event row is the
 * countable mark, and its dedupe key makes a replay change nothing. Only
 * `active` and `pending` move (`leaveBroadcasts`); a person already
 * unsubscribed, bounced or complained is left as they are.
 */
async function applyProviderUnsubscribe(
  db: Db,
  msg: typeof messages.$inferSelect,
  ev: ProviderEvent,
): Promise<void> {
  const inserted = await db
    .insert(events)
    .values({
      messageId: msg.id,
      type: 'unsubscribe',
      occurredAt: ev.occurredAt,
      meta: { ...(ev.meta ?? {}), action: 'broadcast' },
      dedupeKey: ev.dedupeKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: events.id })
  if (inserted.length === 0) return

  await leaveBroadcasts(db, msg.subscriberId)
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
  // Same key, same reason: a replayed provider webhook reaches a receiver once.
  await emitWebhook(
    db,
    type,
    async () => {
      const subscriber = await subscriberPayload(db, subscriberId)
      if (!subscriber) return null
      return type === 'bounced' ? { subscriber, bounce: 'hard' } : { subscriber }
    },
    { dedupeKey: `${type}:${subscriberId}` },
  )
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
