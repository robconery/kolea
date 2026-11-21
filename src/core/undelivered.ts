import { and, count, desc, eq, inArray, isNotNull, isNull, like, max, min, ne, notLike, or, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { broadcasts, messages, sequenceSteps, sequences } from '../db/schema.ts'
import { OUTCOME_UNKNOWN } from '../providers/types.ts'
import type { Env } from '../types.ts'
import { dispatch } from './sending.ts'

/**
 * ⭐ Mail that should have gone and didn't, and the one way to send it again.
 *
 * Rule: mail is never silently dropped. If something stops a message — the
 * queue gave up on it (the DLQ marks it `failed`), or the provider refused it
 * outright — it stays on a visible list with a way to send it once whatever
 * stopped it is fixed (kolea-pro's held-mail release, ported to the one hold
 * Big Mailer has: a failure).
 *
 * What is NOT on the list, deliberately:
 *  - `failed` with `broadcast cancelled`. A cancel is the operator saying stop;
 *    `resumeBroadcast` is the way back, and it already handles exactly these.
 *  - Anything belonging to a broadcast that is cancelled now, for the same reason.
 *  - Anything the provider accepted (`provider_message_id` set). It may have
 *    been delivered; sending it again risks a duplicate, and a duplicate is the
 *    other way to break the rule.
 *  - Anything whose outcome is unknown (`error` starts `outcome unknown`): the
 *    line dropped after the request may have reached the provider, or it
 *    answered 2xx with no id. That mail may be in the reader's inbox.
 *
 * Those last two are not hidden either. They are listed apart, under "check
 * before sending" (`checkFirst`): the provider took it and then refused it
 * (a `rejected` or a permanent non-bounce failure), or nobody can tell whether
 * it went. Neither is ever claimed by a bulk send-again; each can be sent once,
 * one message at a time, after the operator has looked (`sendAgain` with
 * `checked: true`).
 *  - Mail the `console` provider rendered. It is `sent` with `provider =
 *    'console'`, so it can always be told apart, but it is not offered for
 *    release: in Big Mailer the console provider is both the dev default and
 *    the kill switch, and nothing on the row says which. Releasing it would put
 *    old test renderings onto the wire to real addresses. It is counted on the
 *    screen so it is never invisible.
 *
 * Sending again never mails anyone twice: it only ever moves a row from
 * `failed` back to `queued` (a conditional update, so two clicks claim each row
 * once), never touches a `sent` row, and the idempotency key already allows one
 * message per person per broadcast or step. Consent is checked again by
 * `sendMessages` immediately before the provider call, exactly as for any other
 * send, so someone who unsubscribed since the failure is suppressed, not mailed.
 */

/** What "send again" can be pointed at. */
export type ResendTarget =
  | { kind: 'broadcast'; id: number }
  | { kind: 'step'; id: number }
  | { kind: 'message'; id: number }

export interface UndeliveredGroup {
  target: ResendTarget
  /** What the operator recognises it by: the subject, plus the series for a step. */
  label: string
  source: 'broadcast' | 'sequence' | 'transactional' | 'form' | 'preview'
  count: number
  sampleError: string | null
  firstAt: Date | null
  lastAt: Date | null
}

export interface UndeliveredMessage {
  id: number
  kind: string
  toEmail: string
  subject: string
  error: string | null
  createdAt: Date
}

export interface UndeliveredReport {
  groups: UndeliveredGroup[]
  /** The newest individual rows, for a per-message send-again. */
  recent: UndeliveredMessage[]
  total: number
  /**
   * Failed mail that may have gone, or that the provider took and then
   * refused. Never in `groups`/`recent`/`total`, never sent in bulk: listed so
   * it is visible, each with a one-message send-again behind a confirm.
   */
  checkFirst: UndeliveredMessage[]
  checkFirstTotal: number
  /** Mail the console provider rendered to the Outbox instead of the wire. */
  renderedToOutbox: number
}

const CANCELLED = 'broadcast cancelled'

/** A preview copy. It names its step (and a broadcast preview names nothing), so
    it must not be counted as one of that step's real recipients. */
const isPreview = sql`coalesce(${messages.idempotencyKey}, '') like 'preview:%'`
const notPreview = sql`coalesce(${messages.idempotencyKey}, '') not like 'preview:%'`

const UNKNOWN_LIKE = `${OUTCOME_UNKNOWN}%`

/** A broadcast cancelled since is a stop, not a failure. Previews carry no
    `broadcast_id`, so they are never caught by this. */
const notCancelledBroadcast = () =>
  or(
    isNull(messages.broadcastId),
    sql`${messages.broadcastId} not in (select ${broadcasts.id} from ${broadcasts} where ${broadcasts.status} = 'cancelled')`,
  )

/** The one definition of "failed, and fair to send again". Every query below uses it. */
function resendable() {
  return and(
    eq(messages.status, 'failed'),
    isNull(messages.providerMessageId),
    or(isNull(messages.error), and(ne(messages.error, CANCELLED), notLike(messages.error, UNKNOWN_LIKE))),
    notCancelledBroadcast(),
  )
}

/**
 * ⭐ The one definition of "failed, but it may have gone or the provider
 * refused it after taking it". Never bulk-resent; see the header.
 */
function checkFirst() {
  return and(
    eq(messages.status, 'failed'),
    or(isNotNull(messages.providerMessageId), like(messages.error, UNKNOWN_LIKE)),
    or(isNull(messages.error), ne(messages.error, CANCELLED)),
    notCancelledBroadcast(),
  )
}

export async function undeliveredMail(db: Db, recentLimit = 100): Promise<UndeliveredReport> {
  const where = resendable()

  const byBroadcast = await db
    .select({
      id: messages.broadcastId,
      subject: broadcasts.subject,
      n: count(),
      sampleError: max(messages.error),
      firstAt: min(messages.createdAt),
      lastAt: max(messages.createdAt),
    })
    .from(messages)
    .innerJoin(broadcasts, eq(messages.broadcastId, broadcasts.id))
    .where(and(where, isNotNull(messages.broadcastId)))
    .groupBy(messages.broadcastId)
    .all()

  const byStep = await db
    .select({
      id: messages.sequenceStepId,
      subject: sequenceSteps.subject,
      sequence: sequences.name,
      position: sequenceSteps.position,
      n: count(),
      sampleError: max(messages.error),
      firstAt: min(messages.createdAt),
      lastAt: max(messages.createdAt),
    })
    .from(messages)
    .innerJoin(sequenceSteps, eq(messages.sequenceStepId, sequenceSteps.id))
    .innerJoin(sequences, eq(sequenceSteps.sequenceId, sequences.id))
    .where(and(where, eq(messages.kind, 'sequence'), notPreview))
    .groupBy(messages.sequenceStepId)
    .all()

  // Transactional, form delivery and previews: one row each, because each is
  // its own mail to its own person and nothing groups them. A broadcast or step
  // preview lands here too, never in its source's group.
  const singles = await db
    .select({
      id: messages.id,
      kind: messages.kind,
      subject: messages.subject,
      toEmail: messages.toEmail,
      error: messages.error,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(where, isNull(messages.broadcastId), or(isNull(messages.sequenceStepId), isPreview)))
    .orderBy(desc(messages.createdAt))
    .limit(recentLimit)
    .all()

  const recent = await db
    .select({
      id: messages.id,
      kind: messages.kind,
      toEmail: messages.toEmail,
      subject: messages.subject,
      error: messages.error,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(where)
    .orderBy(desc(messages.createdAt))
    .limit(recentLimit)
    .all()

  const total = (await db.select({ n: count() }).from(messages).where(where).get())?.n ?? 0
  const checkFirstRows = await db
    .select({
      id: messages.id,
      kind: messages.kind,
      toEmail: messages.toEmail,
      subject: messages.subject,
      error: messages.error,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(checkFirst())
    .orderBy(desc(messages.createdAt))
    .limit(recentLimit)
    .all()
  const checkFirstTotal = (await db.select({ n: count() }).from(messages).where(checkFirst()).get())?.n ?? 0
  const renderedToOutbox =
    (
      await db
        .select({ n: count() })
        .from(messages)
        .where(and(eq(messages.status, 'sent'), eq(messages.provider, 'console')))
        .get()
    )?.n ?? 0

  const groups: UndeliveredGroup[] = [
    ...byBroadcast.map((r) => ({
      target: { kind: 'broadcast' as const, id: r.id! },
      label: r.subject,
      source: 'broadcast' as const,
      count: r.n,
      sampleError: r.sampleError,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
    })),
    ...byStep.map((r) => ({
      target: { kind: 'step' as const, id: r.id! },
      label: `${r.sequence} · step ${r.position}: ${r.subject}`,
      source: 'sequence' as const,
      count: r.n,
      sampleError: r.sampleError,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
    })),
    ...singles.map((r) => ({
      target: { kind: 'message' as const, id: r.id },
      label: `${r.subject} → ${r.toEmail}`,
      source: r.kind === 'form' ? ('form' as const) : r.kind === 'transactional' ? ('transactional' as const) : ('preview' as const),
      count: 1,
      sampleError: r.error,
      firstAt: r.createdAt,
      lastAt: r.createdAt,
    })),
  ].sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0))

  return { groups, recent, total, checkFirst: checkFirstRows, checkFirstTotal, renderedToOutbox }
}

/**
 * The ids "send again" would claim for a target, right now.
 *
 * `checked` reaches the check-before-sending rows instead, and only for a
 * single message: the operator has looked at the provider and says this one
 * did not go. There is no bulk form of that on purpose.
 */
export async function resendableIds(
  db: Db,
  target: ResendTarget,
  opts: { checked?: boolean } = {},
): Promise<number[]> {
  if (opts.checked) {
    if (target.kind !== 'message') return []
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(checkFirst(), eq(messages.id, target.id)))
      .all()
    return rows.map((r) => r.id)
  }
  const scope =
    target.kind === 'broadcast'
      ? eq(messages.broadcastId, target.id)
      : target.kind === 'step'
        ? and(eq(messages.sequenceStepId, target.id), eq(messages.kind, 'sequence'), notPreview)
        : eq(messages.id, target.id)

  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(resendable(), scope))
    .orderBy(messages.id)
    .all()
  return rows.map((r) => r.id)
}

/** D1 allows 100 bound parameters; leave room for the status predicate. */
const CHUNK = 90

/**
 * Put failed mail back through the ordinary send path.
 *
 * Returns how many rows were claimed. Zero is a normal answer — someone else
 * already sent them again, or there was nothing to send — and never an error.
 */
export async function sendAgain(
  env: Env,
  db: Db,
  target: ResendTarget,
  opts: { checked?: boolean } = {},
): Promise<{ ok: boolean; requeued: number; reason?: string }> {
  if (opts.checked && target.kind !== 'message') {
    return { ok: false, requeued: 0, reason: 'mail that may already have gone is sent again one message at a time' }
  }
  if (target.kind === 'broadcast') {
    const b = await db.select({ status: broadcasts.status }).from(broadcasts).where(eq(broadcasts.id, target.id)).get()
    if (!b) return { ok: false, requeued: 0, reason: 'no such broadcast' }
    if (b.status === 'cancelled') {
      return { ok: false, requeued: 0, reason: 'broadcast is cancelled; resume it instead' }
    }
  }

  const ids = await resendableIds(db, target, opts)
  const claimed: number[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    // The claim: only rows still `failed` move, so a second click, or a second
    // tab, finds nothing left to claim and sends nothing.
    const moved = await db
      .update(messages)
      .set({ status: 'queued', error: null })
      .where(and(inArray(messages.id, ids.slice(i, i + CHUNK)), eq(messages.status, 'failed')))
      .returning({ id: messages.id })
    claimed.push(...moved.map((m) => m.id))
  }

  await dispatch(env, db, claimed)
  return { ok: true, requeued: claimed.length }
}
