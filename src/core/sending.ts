import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { broadcasts, messages, sequenceSteps, sequences, subscribers } from '../db/schema.ts'
import { ConsoleProvider } from '../providers/console.ts'
import { ResendProvider } from '../providers/resend.ts'
import type { EmailProvider, OutgoingEmail } from '../providers/types.ts'
import type { Env, SendJob } from '../types.ts'
import {
  type ConsentSnapshot,
  type Scope,
  canReceiveBroadcastIn,
  canReceiveSequenceIn,
  canReceiveTransactionalIn,
  loadConsentSnapshot,
} from './consent.ts'
import { downloadUrl, grantDownload, grantsForMessages } from './downloads.ts'
import { normalizeEmail } from './ids.ts'
import { postUrl } from './posts.ts'
import { BROADCAST_SCOPE_LABEL, type EmailBody, renderEmail } from './render.ts'

/**
 * ⭐ Where a preview goes. Never a form field, never a subscriber the operator
 * picked from a list — one address, from config, so a "preview" can't quietly
 * become a send to somebody else. `PREVIEW_EMAIL` overrides it; the from-address
 * is the sane default, because that mailbox is already yours by definition.
 */
export function previewAddress(env: Env): string {
  return normalizeEmail(env.PREVIEW_EMAIL || env.FROM_EMAIL)
}

export type PreviewTarget =
  | { kind: 'broadcast'; broadcastId: number; subject: string }
  | { kind: 'sequence'; stepId: number; sequenceId: number; subject: string }
  /**
   * A form's delivery mail. It carries its body inline rather than an id,
   * because the operator is previewing the draft in front of them — and a real
   * grant is minted for the preview recipient, so the download link in the copy
   * that arrives is a working one.
   */
  | { kind: 'form'; formId: number; subject: string; body: EmailBody; hasFile: boolean }

export type PreviewResult = { ok: true; messageId: number; to: string } | { ok: false; reason: string }

/**
 * ⭐ One real copy of one draft, to one address — the operator's own.
 *
 * It is a genuine send down the genuine path (same renderer, same provider,
 * same message row), because a preview that took a shortcut would be testing
 * the shortcut. The safety comes from the recipient, not from the mechanism:
 * `to` is `previewAddress(env)` at every call site, the consent rules still
 * apply to it, and the subject is prefixed so the copy is never mistaken for
 * the real thing landing in somebody's inbox.
 */
export async function sendPreview(
  env: Env,
  db: Db,
  target: PreviewTarget,
  to: string,
): Promise<PreviewResult> {
  const email = normalizeEmail(to)
  const sub = await db.select().from(subscribers).where(eq(subscribers.email, email)).get()
  if (!sub) {
    return { ok: false, reason: `${email} is not a subscriber, so there is nobody to send to.` }
  }

  const snapshot = await loadConsentSnapshot(
    db,
    [sub.email],
    [sub.id],
    target.kind === 'sequence' ? [target.sequenceId] : [],
  )
  const block =
    target.kind === 'sequence'
      ? canReceiveSequenceIn(snapshot, sub, target.sequenceId)
      : target.kind === 'form'
        ? canReceiveTransactionalIn(snapshot, sub.email)
        : canReceiveBroadcastIn(snapshot, sub)
  if (block.blocked) return { ok: false, reason: `${email} cannot receive this: ${block.reason}` }

  // Mint the real grant, so the preview tests the download too and not just the
  // wording. Idempotent — previewing twice reuses the same link.
  if (target.kind === 'form' && target.hasFile) {
    await grantDownload(db, target.formId, sub.id)
  }

  const inserted = await db
    .insert(messages)
    .values({
      subscriberId: sub.id,
      kind: target.kind,
      broadcastId: target.kind === 'broadcast' ? target.broadcastId : null,
      sequenceStepId: target.kind === 'sequence' ? target.stepId : null,
      formId: target.kind === 'form' ? target.formId : null,
      toEmail: sub.email,
      subject: `[preview] ${target.subject}`,
      bodyJson: target.kind === 'form' ? (target.body.json ?? null) : null,
      bodyMd: target.kind === 'form' ? target.body.md : null,
      status: 'queued',
      // Distinct per attempt, so previewing again after an edit really re-sends.
      idempotencyKey: `preview:${target.kind}:${previewSourceId(target)}:${sub.id}:${Date.now()}`,
      createdAt: new Date(),
    })
    .returning({ id: messages.id })

  const messageId = inserted[0]!.id
  await dispatch(env, db, [messageId])
  return { ok: true, messageId, to: sub.email }
}

function previewSourceId(target: PreviewTarget): number {
  if (target.kind === 'broadcast') return target.broadcastId
  if (target.kind === 'sequence') return target.stepId
  return target.formId
}

/** D1 caps bound parameters at 100 per query. */
const PARAM_CHUNK = 100

function providerFor(env: Env, db: Db): EmailProvider {
  if (env.EMAIL_PROVIDER === 'resend') {
    if (!env.RESEND_API_KEY) throw new Error('EMAIL_PROVIDER=resend but RESEND_API_KEY is unset')
    return new ResendProvider(env.RESEND_API_KEY)
  }
  return new ConsoleProvider(db)
}

/**
 * Hand work to the queue, or run it inline if no queue binding exists.
 *
 * The fallback is not a nicety: it keeps `wrangler dev` working on machines
 * where Queues aren't provisioned, so the app is always runnable locally.
 */
export async function dispatch(env: Env, db: Db, messageIds: number[]): Promise<void> {
  if (env.SEND_QUEUE) {
    for (let i = 0; i < messageIds.length; i += 100) {
      const chunk = messageIds.slice(i, i + 100)
      await env.SEND_QUEUE.sendBatch(chunk.map((messageId) => ({ body: { messageId } as SendJob })))
    }
    return
  }
  await sendMessages(env, db, messageIds)
}

/**
 * Send every still-queued message synchronously.
 *
 * Used by seeding and tests, where "the queue will get to it eventually" makes
 * results nondeterministic. Safe alongside the queue: `sendMessages` skips
 * anything no longer `queued`.
 */
export async function drainQueued(env: Env, db: Db, limit = 500): Promise<number> {
  const pending = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.status, 'queued'))
    .limit(limit)
    .all()
  await sendMessages(
    env,
    db,
    pending.map((m) => m.id),
  )
  return pending.length
}

export type SendOutcome =
  | { status: 'sent' }
  | { status: 'suppressed'; reason: string }
  | { status: 'failed'; error: string; retryable: boolean }
  | { status: 'skipped' }

/**
 * Send exactly one materialized message.
 *
 * Idempotent by design: a message that is not `queued` is skipped, so queue
 * redelivery after a crash can never double-send (SPEC 3.8).
 */
export async function sendMessage(env: Env, db: Db, messageId: number): Promise<SendOutcome> {
  const outcomes = await sendMessages(env, db, [messageId])
  return outcomes.get(messageId) ?? { status: 'skipped' }
}

type MessageRow = typeof messages.$inferSelect
type SubscriberRow = typeof subscribers.$inferSelect

/** Load rows whose ids are in `ids`, respecting D1's bound-parameter cap. */
async function loadByIds<T>(
  ids: number[],
  fetchChunk: (chunk: number[]) => Promise<T[]>,
): Promise<T[]> {
  const unique = [...new Set(ids)]
  const out: T[] = []
  for (let i = 0; i < unique.length; i += PARAM_CHUNK) {
    out.push(...(await fetchChunk(unique.slice(i, i + PARAM_CHUNK))))
  }
  return out
}

/**
 * Send a set of materialized messages as one batch.
 *
 * Identical rules to sending them one at a time — including the deliberate
 * last-moment consent check — but every lookup is hoisted out of the per-message
 * loop and the provider receives the whole set in one request. A queue batch of
 * 100 costs roughly 100 D1 queries and a single provider call, where the
 * one-at-a-time path cost 500 queries and 100 calls.
 *
 * Idempotent: anything not `queued` is skipped, so queue redelivery after a
 * crash can never double-send (SPEC 3.8).
 */
export async function sendMessages(
  env: Env,
  db: Db,
  messageIds: number[],
): Promise<Map<number, SendOutcome>> {
  const outcomes = new Map<number, SendOutcome>()
  const ids = [...new Set(messageIds)]
  if (ids.length === 0) return outcomes
  for (const id of ids) outcomes.set(id, { status: 'skipped' })

  const msgs = await loadByIds(ids, (chunk) =>
    db.select().from(messages).where(inArray(messages.id, chunk)).all(),
  )
  const queued = msgs.filter((m) => m.status === 'queued')
  if (queued.length === 0) return outcomes

  // ── everything this batch touches, fetched once

  const subs = await loadByIds(
    queued.map((m) => m.subscriberId),
    (chunk) => db.select().from(subscribers).where(inArray(subscribers.id, chunk)).all(),
  )
  const subById = new Map(subs.map((s) => [s.id, s]))

  const bcasts = await loadByIds(
    queued.flatMap((m) => (m.kind === 'broadcast' && m.broadcastId ? [m.broadcastId] : [])),
    (chunk) => db.select().from(broadcasts).where(inArray(broadcasts.id, chunk)).all(),
  )
  const bcastById = new Map(bcasts.map((b) => [b.id, b]))

  const steps = await loadByIds(
    queued.flatMap((m) => (m.kind === 'sequence' && m.sequenceStepId ? [m.sequenceStepId] : [])),
    (chunk) => db.select().from(sequenceSteps).where(inArray(sequenceSteps.id, chunk)).all(),
  )
  const stepById = new Map(steps.map((s) => [s.id, s]))

  const seqs = await loadByIds(
    steps.map((s) => s.sequenceId),
    (chunk) => db.select().from(sequences).where(inArray(sequences.id, chunk)).all(),
  )
  const seqById = new Map(seqs.map((s) => [s.id, s]))

  // Lead-magnet links are per person, so the body can't carry them — the grant
  // token is looked up here and merged in as `{{link}}` at render time.
  const grants = await grantsForMessages(
    db,
    queued.flatMap((m) =>
      m.kind === 'form' && m.formId ? [{ formId: m.formId, subscriberId: m.subscriberId }] : [],
    ),
  )

  const snapshot = await loadConsentSnapshot(
    db,
    queued.map((m) => m.toEmail),
    queued.map((m) => m.subscriberId),
    seqs.map((s) => s.id),
  )

  // ── decide, render, collect

  const pending: { message: MessageRow; email: OutgoingEmail }[] = []

  for (const msg of queued) {
    const sub = subById.get(msg.subscriberId)
    if (!sub) {
      outcomes.set(msg.id, await markSuppressed(db, msg.id, 'no_subscriber'))
      continue
    }

    const resolved = resolveSource(msg, bcastById, stepById, seqById, env.SITE_URL)
    if ('missing' in resolved) {
      outcomes.set(msg.id, await markSuppressed(db, msg.id, resolved.missing))
      continue
    }

    const block = eligibility(snapshot, msg, sub, resolved.scope)
    if (block.blocked) {
      outcomes.set(msg.id, await markSuppressed(db, msg.id, block.reason))
      continue
    }

    // Transactional mail carries no unsubscribe footer and no tracking — it isn't
    // marketing, and offering to unsubscribe from a receipt is nonsense.
    //
    // A form's delivery mail is not in that category: the person just joined the
    // list, so it carries the ordinary newsletter footer. Only the *eligibility*
    // rule is transactional — see `eligibility()`.
    const isMarketing = msg.kind !== 'transactional'

    const grantToken =
      msg.kind === 'form' && msg.formId ? grants.get(`${msg.formId}:${msg.subscriberId}`) : undefined

    // Two sources, and they never overlap. `msg.extras` was frozen onto the row
    // when the message was queued (purchase mail); `{{link}}` is looked up live
    // because a grant token never expires and the lookup is already batched.
    const extras =
      msg.extras || grantToken
        ? {
            ...(msg.extras ?? {}),
            ...(grantToken ? { link: downloadUrl(env.PUBLIC_URL, grantToken) } : {}),
          }
        : undefined

    const rendered = renderEmail(resolved.body, {
      publicUrl: env.PUBLIC_URL,
      messageId: msg.id,
      unsubToken: sub.unsubToken,
      scope: resolved.scope,
      scopeLabel: resolved.scopeLabel,
      subject: msg.subject,
      postUrl: resolved.postUrl,
      subscriber: { email: sub.email, name: sub.name },
      trackOpens: isMarketing,
      trackClicks: isMarketing,
      showFooter: isMarketing,
      // Values this one reader's copy needs and the authored body cannot carry —
      // their download URL, the offer they just bought, their Discord invite.
      extras,
    })

    pending.push({
      message: msg,
      email: {
        ref: msg.id,
        to: sub.email,
        fromEmail: env.FROM_EMAIL,
        fromName: env.FROM_NAME,
        subject: msg.subject,
        html: rendered.html,
        text: rendered.text,
        listUnsubscribeUrl: rendered.oneClickUnsubscribeUrl,
      },
    })
  }

  if (pending.length === 0) return outcomes

  // ── one provider request for the lot

  const provider = providerFor(env, db)
  const results = await provider.sendBatch(pending.map((p) => p.email))

  for (const [i, { message }] of pending.entries()) {
    const result = results[i]
    if (!result) {
      // Shouldn't happen — the port promises one result per input — but a silent
      // `sent` here would be a lost email, so treat it as retryable.
      outcomes.set(message.id, { status: 'failed', error: 'no provider result', retryable: true })
      continue
    }

    if (result.ok) {
      await db
        .update(messages)
        .set({
          status: 'sent',
          provider: provider.name,
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          error: null,
        })
        .where(eq(messages.id, message.id))
      outcomes.set(message.id, { status: 'sent' })
      continue
    }

    await db
      .update(messages)
      .set({ status: result.retryable ? 'queued' : 'failed', error: result.error })
      .where(eq(messages.id, message.id))
    outcomes.set(message.id, {
      status: 'failed',
      error: result.error,
      retryable: result.retryable,
    })
  }

  return outcomes
}

/** Resolve a message's body and consent scope from the pre-loaded sources. */
function resolveSource(
  msg: MessageRow,
  bcastById: Map<number, typeof broadcasts.$inferSelect>,
  stepById: Map<number, typeof sequenceSteps.$inferSelect>,
  seqById: Map<number, typeof sequences.$inferSelect>,
  siteUrl: string | undefined,
): { body: EmailBody; scope: Scope; scopeLabel: string; postUrl?: string | null } | { missing: string } {
  if (msg.kind === 'broadcast' && msg.broadcastId) {
    const b = bcastById.get(msg.broadcastId)
    if (!b) return { missing: 'no_broadcast' }
    return {
      body: { json: b.bodyJson, md: b.bodyMd },
      scope: { kind: 'broadcast' },
      scopeLabel: BROADCAST_SCOPE_LABEL,
      // Only when it is actually live. A published_at in the future is not a
      // thing here, but an *unpublished* broadcast with a slug is — it was taken
      // down — and linking to it would 404 in every inbox that kept the mail.
      postUrl: b.publishedAt ? postUrl(siteUrl, b.slug) : null,
    }
  }

  if (msg.kind === 'sequence' && msg.sequenceStepId) {
    const step = stepById.get(msg.sequenceStepId)
    if (!step) return { missing: 'no_step' }
    const seq = seqById.get(step.sequenceId)
    if (!seq) return { missing: 'no_sequence' }
    return {
      body: { json: step.bodyJson, md: step.bodyMd },
      scope: { kind: 'sequence', sequenceId: seq.id },
      scopeLabel: seq.name,
    }
  }

  // Form delivery and transactional mail both carry their own body: it was
  // snapshotted onto the message when it was queued, so editing the form's
  // template afterwards can't rewrite what already went out (invariant 9).
  if (msg.kind === 'form') {
    return {
      body: { json: msg.bodyJson, md: msg.bodyMd ?? '' },
      scope: { kind: 'broadcast' },
      scopeLabel: BROADCAST_SCOPE_LABEL,
    }
  }

  return {
    body: { json: msg.bodyJson, md: msg.bodyMd ?? '' },
    scope: { kind: 'broadcast' },
    scopeLabel: 'account notifications',
  }
}

/**
 * ⭐ Consent is checked here, immediately before the provider call — the last
 * possible moment, so a mid-broadcast opt-out is honoured. Reading it from a
 * snapshot rather than the database doesn't change that: the snapshot is loaded
 * inside this same batch, well after the recipient rows were materialized.
 */
function eligibility(
  snapshot: ConsentSnapshot,
  msg: MessageRow,
  sub: SubscriberRow,
  scope: Scope,
) {
  if (msg.kind === 'broadcast') return canReceiveBroadcastIn(snapshot, sub)
  if (msg.kind === 'sequence' && scope.kind === 'sequence') {
    return canReceiveSequenceIn(snapshot, sub, scope.sequenceId)
  }
  // `form` lands here with `transactional`, deliberately. Handing over the file
  // somebody just asked for is fulfillment, not marketing: an unsubscribed
  // reader still gets their download, and only a dead address or a spam
  // complaint stops it (ARCHITECTURE → Consent).
  return canReceiveTransactionalIn(snapshot, sub.email)
}

async function markSuppressed(db: Db, messageId: number, reason: string): Promise<SendOutcome> {
  await db
    .update(messages)
    .set({ status: 'suppressed', suppressedReason: reason })
    .where(eq(messages.id, messageId))
  return { status: 'suppressed', reason }
}
