import { and, count, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import type { DocNode, SegmentRule } from '../db/schema.ts'
import { broadcasts, events, messages } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { canReceiveBroadcastIn, loadConsentSnapshot } from './consent.ts'
import { resolveSegment } from './segments.ts'
import { dispatch } from './sending.ts'

// ─────────────────────────────────────────────────── authoring

export interface BroadcastInput {
  subject: string
  bodyJson?: DocNode | null
  bodyMd: string
  /** Always stored inline — see the `segment` column comment in the schema. */
  segment?: SegmentRule
  /** Provenance only: which saved segment the rule was copied from. */
  segmentId?: number | null
  campaignId?: number | null
}

export async function listBroadcasts(db: Db, limit = 50) {
  return await db
    .select()
    .from(broadcasts)
    .orderBy(desc(broadcasts.createdAt))
    .limit(limit)
    .all()
}

export async function getBroadcast(db: Db, id: number) {
  return (await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()) ?? null
}

export async function createBroadcast(db: Db, input: BroadcastInput): Promise<number> {
  const inserted = await db
    .insert(broadcasts)
    .values({
      subject: input.subject,
      bodyJson: input.bodyJson ?? null,
      bodyMd: input.bodyMd,
      segment: input.segment ?? {},
      segmentId: input.segmentId ?? null,
      campaignId: input.campaignId ?? null,
      status: 'draft',
      createdAt: new Date(),
    })
    .returning({ id: broadcasts.id })

  return inserted[0]!.id
}

/**
 * Edit a draft. Refuses anything else: rewriting a broadcast that has already
 * gone out would silently change what the archive says was sent.
 */
export async function updateBroadcast(
  db: Db,
  id: number,
  patch: Partial<BroadcastInput>,
): Promise<{ ok: boolean; reason?: string }> {
  const b = await getBroadcast(db, id)
  if (!b) return { ok: false, reason: 'no such broadcast' }
  if (b.status !== 'draft') return { ok: false, reason: `broadcast is ${b.status}, not a draft` }

  await db
    .update(broadcasts)
    .set({
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.bodyJson !== undefined ? { bodyJson: patch.bodyJson } : {}),
      ...(patch.bodyMd !== undefined ? { bodyMd: patch.bodyMd } : {}),
      ...(patch.segment !== undefined ? { segment: patch.segment } : {}),
      ...(patch.segmentId !== undefined ? { segmentId: patch.segmentId } : {}),
      ...(patch.campaignId !== undefined ? { campaignId: patch.campaignId } : {}),
    })
    .where(eq(broadcasts.id, id))

  return { ok: true }
}

export async function deleteBroadcast(
  db: Db,
  id: number,
): Promise<{ ok: boolean; reason?: string }> {
  const b = await getBroadcast(db, id)
  if (!b) return { ok: false, reason: 'no such broadcast' }
  if (b.status === 'sending') return { ok: false, reason: 'broadcast is mid-send' }

  await db.delete(broadcasts).where(eq(broadcasts.id, id))
  return { ok: true }
}

/**
 * Park a draft until a future time. The cron tick picks it up (see `worker.tsx`),
 * so scheduling is just a status plus a timestamp — nothing is held in memory.
 */
export async function scheduleBroadcast(
  db: Db,
  id: number,
  at: Date,
): Promise<{ ok: boolean; reason?: string }> {
  const b = await getBroadcast(db, id)
  if (!b) return { ok: false, reason: 'no such broadcast' }
  if (b.status !== 'draft') return { ok: false, reason: `broadcast is ${b.status}, not a draft` }
  if (at.getTime() <= Date.now()) return { ok: false, reason: 'scheduled time is in the past' }

  await db
    .update(broadcasts)
    .set({ status: 'scheduled', scheduledAt: at })
    .where(eq(broadcasts.id, id))
  return { ok: true }
}

/**
 * Stop a send. A `scheduled` broadcast is cancelled cleanly; a `sending` one
 * stops materializing new recipients but cannot recall mail already handed to
 * the provider — the return value says how many that was, because a cancel that
 * quietly half-worked is worse than one that admits it.
 */
export async function cancelBroadcast(
  db: Db,
  id: number,
): Promise<{ ok: boolean; reason?: string; alreadySent?: number }> {
  const b = await getBroadcast(db, id)
  if (!b) return { ok: false, reason: 'no such broadcast' }
  if (b.status !== 'scheduled' && b.status !== 'sending') {
    return { ok: false, reason: `broadcast is ${b.status} — nothing to cancel` }
  }

  const sent = await db
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.broadcastId, id), eq(messages.status, 'sent')))
    .get()

  await db.update(broadcasts).set({ status: 'cancelled' }).where(eq(broadcasts.id, id))
  return { ok: true, alreadySent: sent?.n ?? 0 }
}

/**
 * Rows materialized per page.
 *
 * Costs ~1 query per 10 rows (the insert chunking below) plus a handful for the
 * segment and the consent snapshot, so a page lands near 220 D1 queries — well
 * inside the 1,000-per-invocation cap, with room for several pages per run.
 */
const PAGE = 2000
/** D1 allows 100 bound parameters per query; `messages` binds 9 per row. */
const INSERT_CHUNK = 10
/**
 * Pages driven per invocation. Four pages ≈ 900 queries, which fits the cap with
 * headroom; anything still outstanding is picked up by the next cron tick.
 */
const MAX_PAGES = 4

/**
 * Materialize one page of `messages` rows for a broadcast and dispatch them.
 * Returns whether more recipients remain.
 *
 * Recipients are written up front (not resolved lazily at send time) so a send
 * is resumable and auditable after a crash — and the unique idempotency key makes
 * re-running this harmless (SPEC 3.6).
 */
export async function dispatchBroadcastPage(
  env: Env,
  db: Db,
  broadcastId: number,
): Promise<{ materialized: number; done: boolean }> {
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, broadcastId)).get()
  if (!b || (b.status !== 'scheduled' && b.status !== 'sending')) {
    return { materialized: 0, done: true }
  }

  if (b.status === 'scheduled') {
    await db
      .update(broadcasts)
      .set({ status: 'sending', startedAt: new Date() })
      .where(eq(broadcasts.id, broadcastId))
  }

  const candidates = await resolveSegment(db, b.segment ?? {}, b.cursorSubscriberId, PAGE)

  if (candidates.length === 0) {
    const remaining = await db
      .select({ n: count() })
      .from(messages)
      .where(and(eq(messages.broadcastId, broadcastId), eq(messages.status, 'queued')))
      .get()
    if ((remaining?.n ?? 0) === 0) {
      await db
        .update(broadcasts)
        .set({ status: 'sent', sentAt: new Date() })
        .where(eq(broadcasts.id, broadcastId))
    }
    return { materialized: 0, done: true }
  }

  // One snapshot for the whole page. Asking per recipient cost one query each,
  // which is what capped a page at 400 people and the whole send at 400/minute.
  const snapshot = await loadConsentSnapshot(
    db,
    candidates.map((c) => c.email),
  )

  const now = new Date()
  const rows = candidates.map((c) => {
    const block = canReceiveBroadcastIn(snapshot, c)
    return {
      subscriberId: c.id,
      kind: 'broadcast' as const,
      broadcastId,
      toEmail: c.email,
      subject: b.subject,
      status: block.blocked ? ('suppressed' as const) : ('queued' as const),
      suppressedReason: block.blocked ? block.reason : null,
      idempotencyKey: `broadcast:${broadcastId}:${c.id}`,
      createdAt: now,
    }
  })

  const created: number[] = []
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const inserted = await db
      .insert(messages)
      .values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoNothing()
      .returning({ id: messages.id, status: messages.status })
    created.push(...inserted.filter((r) => r.status === 'queued').map((r) => r.id))
  }

  const lastId = candidates[candidates.length - 1]!.id
  await db
    .update(broadcasts)
    .set({ cursorSubscriberId: lastId })
    .where(eq(broadcasts.id, broadcastId))

  await dispatch(env, db, created)

  return { materialized: created.length, done: candidates.length < PAGE }
}

/**
 * Promote a broadcast out of `draft` and send it.
 *
 * The single entry point for "send this thing" — `sendBroadcastNow` deliberately
 * ignores drafts, so callers that skip this step silently send nothing.
 */
export async function startBroadcast(env: Env, db: Db, broadcastId: number): Promise<number> {
  await db
    .update(broadcasts)
    .set({ status: 'scheduled', scheduledAt: new Date() })
    .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.status, 'draft')))
  return await sendBroadcastNow(env, db, broadcastId)
}

/**
 * Drive a broadcast forward. Safe to call repeatedly. Ignores drafts.
 *
 * Bounded, not exhaustive: it materializes up to `maxPages` and returns. Looping
 * until the list ran dry is what pushed a large send past D1's per-invocation
 * query cap and 500'd the operator mid-click. Whatever is left over is picked up
 * by the next cron tick, which is a minute away at most.
 */
export async function sendBroadcastNow(
  env: Env,
  db: Db,
  broadcastId: number,
  maxPages = MAX_PAGES,
): Promise<number> {
  let total = 0
  for (let page = 0; page < maxPages; page++) {
    const { materialized, done } = await dispatchBroadcastPage(env, db, broadcastId)
    total += materialized
    if (done) break
  }
  return total
}

export interface BroadcastStats {
  recipients: number
  sent: number
  suppressed: number
  failed: number
  delivered: number
  opened: number
  clicked: number
  bounced: number
  complained: number
}

export async function broadcastStats(db: Db, broadcastId: number): Promise<BroadcastStats> {
  const byStatus = await db
    .select({ status: messages.status, n: count() })
    .from(messages)
    .where(eq(messages.broadcastId, broadcastId))
    .groupBy(messages.status)
    .all()

  const byEvent = await db
    .select({ type: events.type, n: sql<number>`count(distinct ${events.messageId})` })
    .from(events)
    .innerJoin(messages, eq(events.messageId, messages.id))
    .where(eq(messages.broadcastId, broadcastId))
    .groupBy(events.type)
    .all()

  const s = (k: string) => byStatus.find((r) => r.status === k)?.n ?? 0
  const e = (k: string) => Number(byEvent.find((r) => r.type === k)?.n ?? 0)

  return {
    recipients: byStatus.reduce((a, r) => a + r.n, 0),
    sent: s('sent'),
    suppressed: s('suppressed'),
    failed: s('failed'),
    delivered: e('delivered'),
    opened: e('open'),
    clicked: e('click'),
    bounced: e('bounce'),
    complained: e('complaint'),
  }
}
