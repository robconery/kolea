import { and, asc, count, eq, lte } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import type { DocNode } from '../db/schema.ts'
import {
  messages,
  sequenceEnrollments,
  sequenceOptouts,
  sequenceSteps,
  sequences,
  subscribers,
} from '../db/schema.ts'
import type { Env } from '../types.ts'
import { canReceiveSequence } from './consent.ts'
import { slugify } from './ids.ts'
import { dispatch } from './sending.ts'

const TICK_LIMIT = 200
const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days, clamped to a year. Shared by the admin form and the MCP tools. */
export function normalizeDelayDays(raw: unknown, position: number): number {
  if (raw === null || raw === undefined || String(raw).trim() === '') return position <= 1 ? 0 : 1
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return position <= 1 ? 0 : 1
  return Math.min(Math.max(n, 0), 365)
}

async function firstStep(db: Db, sequenceId: number) {
  return await db
    .select()
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, sequenceId))
    .orderBy(asc(sequenceSteps.position))
    .get()
}

/**
 * Enroll a subscriber in a sequence.
 *
 * Refuses if they have previously opted out of this sequence — leaving is a
 * standing preference, not a one-time skip. Only the subscriber can undo it,
 * from the preference center.
 */
export async function enroll(
  db: Db,
  sequenceId: number,
  subscriberId: number,
): Promise<'enrolled' | 'already' | 'opted_out' | 'no_steps'> {
  const optout = await db
    .select({ subscriberId: sequenceOptouts.subscriberId })
    .from(sequenceOptouts)
    .where(
      and(eq(sequenceOptouts.subscriberId, subscriberId), eq(sequenceOptouts.sequenceId, sequenceId)),
    )
    .get()
  if (optout) return 'opted_out'

  const existing = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.sequenceId, sequenceId),
        eq(sequenceEnrollments.subscriberId, subscriberId),
      ),
    )
    .get()
  if (existing) return 'already'

  const step = await firstStep(db, sequenceId)
  if (!step) return 'no_steps'

  const now = new Date()
  await db.insert(sequenceEnrollments).values({
    sequenceId,
    subscriberId,
    nextStepId: step.id,
    status: 'active',
    nextRunAt: new Date(now.getTime() + step.delayDays * DAY_MS),
    enrolledAt: now,
  })
  return 'enrolled'
}

/** Fire `subscribe`-triggered sequences for a new subscriber. */
export async function enrollOnSubscribe(db: Db, subscriberId: number): Promise<void> {
  const active = await db
    .select({ id: sequences.id })
    .from(sequences)
    .where(and(eq(sequences.trigger, 'subscribe'), eq(sequences.isActive, true)))
    .all()
  for (const s of active) await enroll(db, s.id, subscriberId)
}

/** Fire `tag_added`-triggered sequences when a tag lands on a subscriber. */
export async function enrollOnTag(db: Db, subscriberId: number, tagId: number): Promise<void> {
  const active = await db
    .select({ id: sequences.id })
    .from(sequences)
    .where(
      and(
        eq(sequences.trigger, 'tag_added'),
        eq(sequences.isActive, true),
        eq(sequences.triggerTagId, tagId),
      ),
    )
    .all()
  for (const s of active) await enroll(db, s.id, subscriberId)
}

/**
 * Advance every enrollment whose next step is due: materialize one message,
 * dispatch it, and move the enrollment to the following step.
 *
 * Called from cron, and from the "Run sequences now" button so the whole thing
 * is playable locally without waiting on a clock.
 */
export async function tickSequences(env: Env, db: Db): Promise<number> {
  const now = new Date()

  const due = await db
    .select({
      enrollmentId: sequenceEnrollments.id,
      sequenceId: sequenceEnrollments.sequenceId,
      subscriberId: sequenceEnrollments.subscriberId,
      stepId: sequenceEnrollments.nextStepId,
    })
    .from(sequenceEnrollments)
    .innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequenceId))
    .where(
      and(
        eq(sequenceEnrollments.status, 'active'),
        eq(sequences.isActive, true),
        lte(sequenceEnrollments.nextRunAt, now),
      ),
    )
    .limit(TICK_LIMIT)
    .all()

  const toSend: number[] = []

  for (const d of due) {
    if (d.stepId === null) {
      await complete(db, d.enrollmentId)
      continue
    }

    const step = await db.select().from(sequenceSteps).where(eq(sequenceSteps.id, d.stepId)).get()
    const sub = await db.select().from(subscribers).where(eq(subscribers.id, d.subscriberId)).get()
    if (!step || !sub) {
      await complete(db, d.enrollmentId)
      continue
    }

    // ⭐ Re-check scoped consent at the moment of sending, not at enrollment.
    const block = await canReceiveSequence(db, sub, d.sequenceId)
    if (block.blocked) {
      await db
        .update(sequenceEnrollments)
        .set({ status: 'cancelled', nextRunAt: null })
        .where(eq(sequenceEnrollments.id, d.enrollmentId))
      continue
    }

    const inserted = await db
      .insert(messages)
      .values({
        subscriberId: sub.id,
        kind: 'sequence',
        sequenceStepId: step.id,
        toEmail: sub.email,
        subject: step.subject,
        status: 'queued',
        // Guarantees a step is never sent twice to the same person (SPEC 6.5).
        idempotencyKey: `seqstep:${step.id}:${sub.id}`,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id })

    if (inserted[0]) toSend.push(inserted[0].id)

    const next = await db
      .select()
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, d.sequenceId))
      .orderBy(asc(sequenceSteps.position))
      .all()
    const following = next.find((s) => s.position > step.position)

    if (following) {
      await db
        .update(sequenceEnrollments)
        .set({
          nextStepId: following.id,
          nextRunAt: new Date(now.getTime() + following.delayDays * DAY_MS),
        })
        .where(eq(sequenceEnrollments.id, d.enrollmentId))
    } else {
      await complete(db, d.enrollmentId)
    }
  }

  await dispatch(env, db, toSend)
  return toSend.length
}

async function complete(db: Db, enrollmentId: number) {
  await db
    .update(sequenceEnrollments)
    .set({ status: 'completed', nextRunAt: null, nextStepId: null })
    .where(eq(sequenceEnrollments.id, enrollmentId))
}

export interface SequenceStats {
  steps: number
  active: number
  completed: number
  cancelled: number
  optedOut: number
}

export async function sequenceStats(db: Db, sequenceId: number): Promise<SequenceStats> {
  const steps = await db
    .select({ n: count() })
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, sequenceId))
    .get()

  const byStatus = await db
    .select({ status: sequenceEnrollments.status, n: count() })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.sequenceId, sequenceId))
    .groupBy(sequenceEnrollments.status)
    .all()

  const optedOut = await db
    .select({ n: count() })
    .from(sequenceOptouts)
    .where(eq(sequenceOptouts.sequenceId, sequenceId))
    .get()

  const s = (k: string) => byStatus.find((r) => r.status === k)?.n ?? 0

  return {
    steps: steps?.n ?? 0,
    active: s('active'),
    completed: s('completed'),
    cancelled: s('cancelled'),
    optedOut: optedOut?.n ?? 0,
  }
}

// ─────────────────────────────────────────────────── authoring

export type SequenceTrigger = 'subscribe' | 'tag_added' | 'manual'

export interface SequenceInput {
  name: string
  description?: string | null
  trigger: SequenceTrigger
  triggerTagId?: number | null
  campaignId?: number | null
}

export async function listSequences(db: Db) {
  return await db.select().from(sequences).orderBy(asc(sequences.name)).all()
}

export async function getSequence(db: Db, id: number) {
  return (await db.select().from(sequences).where(eq(sequences.id, id)).get()) ?? null
}

export async function stepsFor(db: Db, sequenceId: number) {
  return await db
    .select()
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, sequenceId))
    .orderBy(asc(sequenceSteps.position))
    .all()
}

export async function createSequence(db: Db, input: SequenceInput): Promise<number> {
  const inserted = await db
    .insert(sequences)
    .values({
      slug: slugify(input.name),
      name: input.name,
      description: input.description ?? null,
      trigger: input.trigger,
      // A trigger tag on a non-tag_added sequence would never be read again.
      triggerTagId: input.trigger === 'tag_added' ? (input.triggerTagId ?? null) : null,
      campaignId: input.campaignId ?? null,
      // Never live on creation — activation is a deliberate, preflighted act.
      isActive: false,
      createdAt: new Date(),
    })
    .returning({ id: sequences.id })

  return inserted[0]!.id
}

export async function updateSequence(
  db: Db,
  id: number,
  patch: Partial<SequenceInput>,
): Promise<{ ok: boolean; reason?: string }> {
  const s = await getSequence(db, id)
  if (!s) return { ok: false, reason: 'no such sequence' }

  const trigger = patch.trigger ?? s.trigger
  await db
    .update(sequences)
    .set({
      ...(patch.name !== undefined ? { name: patch.name, slug: slugify(patch.name) } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
      ...(patch.triggerTagId !== undefined || patch.trigger !== undefined
        ? { triggerTagId: trigger === 'tag_added' ? (patch.triggerTagId ?? s.triggerTagId) : null }
        : {}),
      ...(patch.campaignId !== undefined ? { campaignId: patch.campaignId } : {}),
    })
    .where(eq(sequences.id, id))

  return { ok: true }
}

export async function deleteSequence(
  db: Db,
  id: number,
): Promise<{ ok: boolean; reason?: string }> {
  const s = await getSequence(db, id)
  if (!s) return { ok: false, reason: 'no such sequence' }
  if (s.isActive) return { ok: false, reason: 'sequence is live — deactivate it first' }

  await db.delete(sequences).where(eq(sequences.id, id))
  return { ok: true }
}

/**
 * Flip a sequence live or paused. Activating with no steps is refused rather
 * than accepted-and-inert: a series that enrolls people and sends nothing looks
 * identical to a working one until somebody checks.
 */
export async function setSequenceActive(
  db: Db,
  id: number,
  isActive: boolean,
): Promise<{ ok: boolean; reason?: string }> {
  const s = await getSequence(db, id)
  if (!s) return { ok: false, reason: 'no such sequence' }

  if (isActive) {
    const steps = await db
      .select({ n: count() })
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, id))
      .get()
    if (!steps?.n) return { ok: false, reason: 'sequence has no steps' }
    if (s.trigger === 'tag_added' && !s.triggerTagId) {
      return { ok: false, reason: 'tag_added sequence has no trigger tag' }
    }
  }

  await db.update(sequences).set({ isActive }).where(eq(sequences.id, id))
  return { ok: true }
}

export interface StepInput {
  subject: string
  bodyJson?: DocNode | null
  bodyMd: string
  delayDays?: number
}

export async function addStep(
  db: Db,
  sequenceId: number,
  input: StepInput,
): Promise<{ ok: boolean; reason?: string; stepId?: number; position?: number }> {
  const s = await getSequence(db, sequenceId)
  if (!s) return { ok: false, reason: 'no such sequence' }

  const existing = await db
    .select({ position: sequenceSteps.position })
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, sequenceId))
    .all()
  const position = existing.reduce((max, r) => Math.max(max, r.position), 0) + 1

  const inserted = await db
    .insert(sequenceSteps)
    .values({
      sequenceId,
      position,
      delayDays: normalizeDelayDays(input.delayDays, position),
      subject: input.subject,
      bodyJson: input.bodyJson ?? null,
      bodyMd: input.bodyMd,
    })
    .returning({ id: sequenceSteps.id })

  return { ok: true, stepId: inserted[0]!.id, position }
}

export async function updateStep(
  db: Db,
  stepId: number,
  patch: Partial<StepInput>,
): Promise<{ ok: boolean; reason?: string }> {
  const step = await db.select().from(sequenceSteps).where(eq(sequenceSteps.id, stepId)).get()
  if (!step) return { ok: false, reason: 'no such step' }

  await db
    .update(sequenceSteps)
    .set({
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.bodyJson !== undefined ? { bodyJson: patch.bodyJson } : {}),
      ...(patch.bodyMd !== undefined ? { bodyMd: patch.bodyMd } : {}),
      ...(patch.delayDays !== undefined
        ? { delayDays: normalizeDelayDays(patch.delayDays, step.position) }
        : {}),
    })
    .where(eq(sequenceSteps.id, stepId))

  return { ok: true }
}

export async function deleteStep(
  db: Db,
  stepId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const step = await db.select().from(sequenceSteps).where(eq(sequenceSteps.id, stepId)).get()
  if (!step) return { ok: false, reason: 'no such step' }

  // `next_step_id` is ON DELETE SET NULL, and a null next step completes the
  // enrollment on the following tick — so no enrollment gets stranded.
  await db.delete(sequenceSteps).where(eq(sequenceSteps.id, stepId))
  return { ok: true }
}

/**
 * Rewrite step order from an explicit list of step ids.
 *
 * Positions are unique per sequence, so the obvious "update each row to its new
 * position" collides mid-way through any swap. Everything is parked in a
 * negative band first, which no real position occupies.
 */
export async function reorderSteps(
  db: Db,
  sequenceId: number,
  stepIds: number[],
): Promise<{ ok: boolean; reason?: string }> {
  const current = await stepsFor(db, sequenceId)
  if (current.length !== stepIds.length) {
    return { ok: false, reason: `sequence has ${current.length} steps, got ${stepIds.length} ids` }
  }
  const known = new Set(current.map((s) => s.id))
  if (stepIds.some((id) => !known.has(id)) || new Set(stepIds).size !== stepIds.length) {
    return { ok: false, reason: 'step ids must be exactly this sequence’s steps, each once' }
  }

  for (const [i, id] of stepIds.entries()) {
    await db
      .update(sequenceSteps)
      .set({ position: -(i + 1) })
      .where(eq(sequenceSteps.id, id))
  }
  for (const [i, id] of stepIds.entries()) {
    await db
      .update(sequenceSteps)
      .set({ position: i + 1 })
      .where(eq(sequenceSteps.id, id))
  }

  return { ok: true }
}

export async function enrollmentsFor(db: Db, sequenceId: number, limit = 50) {
  return await db
    .select({
      subscriberId: subscribers.id,
      email: subscribers.email,
      name: subscribers.name,
      status: sequenceEnrollments.status,
      nextStepId: sequenceEnrollments.nextStepId,
      nextRunAt: sequenceEnrollments.nextRunAt,
      enrolledAt: sequenceEnrollments.enrolledAt,
    })
    .from(sequenceEnrollments)
    .innerJoin(subscribers, eq(subscribers.id, sequenceEnrollments.subscriberId))
    .where(eq(sequenceEnrollments.sequenceId, sequenceId))
    .orderBy(asc(sequenceEnrollments.nextRunAt))
    .limit(limit)
    .all()
}
