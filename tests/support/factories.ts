/**
 * Arrange-phase helpers.
 *
 * Every one of these goes through a production `core/` function wherever a
 * production function exists — `upsertSubscriber`, `createSequence`, `addStep`,
 * `setSequenceActive`. A factory that reached for raw SQL would let a spec set
 * up a state the application itself cannot produce, and specs that pass against
 * impossible states are how a suite starts lying.
 *
 * The two exceptions both write time, not state:
 *
 * - `makeDue()` pulls `next_run_at` into the past. The app has exactly this,
 *   as "Fast-forward the clock" (`web/seed.tsx`) — delays are in whole days, so
 *   there is no other way to exercise step two before tomorrow.
 * - `backdate()` moves an enrollment's `enrolled_at`, for the "don't mail
 *   historical finishers" spec.
 */
import { and, eq } from 'drizzle-orm'
import { createBroadcast } from '../../src/core/broadcasts.ts'
import {
  addStep,
  createSequence,
  type SequenceTrigger,
  setSequenceActive,
} from '../../src/core/sequences.ts'
import { addTags, findOrCreateTag, upsertSubscriber } from '../../src/core/subscribers.ts'
import type { DocNode, SegmentRule, Subscriber } from '../../src/db/schema.ts'
import { sequenceEnrollments, subscribers } from '../../src/db/schema.ts'
import type { World } from './world.ts'

export interface PersonInput {
  email?: string
  name?: string | null
  status?: 'pending' | 'active'
  /** Tag names. Created if they do not exist yet. */
  tags?: string[]
  /** Default true, exactly as in production — joining fires the welcome series. */
  triggerSubscribeSequences?: boolean
}

let personCounter = 0

/** Somebody on the list, created the way a signup creates them. */
export async function aPerson(w: World, input: PersonInput = {}): Promise<Subscriber> {
  const email = input.email ?? `person-${++personCounter}@example.test`

  const tagIds: number[] = []
  for (const name of input.tags ?? []) tagIds.push(await findOrCreateTag(w.db, name))

  const { id, outcome } = await upsertSubscriber(w.db, {
    email,
    name: input.name ?? null,
    status: input.status,
    tagIds,
    triggerSubscribeSequences: input.triggerSubscribeSequences,
  })
  if (outcome === 'invalid' || id === undefined) {
    throw new Error(`Factory could not create ${email}: ${outcome}`)
  }

  return (await w.db.select().from(subscribers).where(eq(subscribers.id, id)).get())!
}

/** A tag, by name. Idempotent. */
export async function aTag(w: World, name: string): Promise<number> {
  return await findOrCreateTag(w.db, name)
}

/** Put a tag on somebody — the same call the console and the rule engine make. */
export async function tag(w: World, person: Subscriber, name: string): Promise<number> {
  const tagId = await findOrCreateTag(w.db, name)
  await addTags(w.db, person.id, [tagId])
  return tagId
}

export interface StepInput {
  subject: string
  body?: string
  bodyJson?: DocNode | null
  /** Whole days after the previous step. The first step defaults to 0. */
  delayDays?: number
}

export interface SequenceInput {
  name?: string
  trigger?: SequenceTrigger
  triggerTagId?: number | null
  nextSequenceId?: number | null
  steps?: StepInput[]
  /** Sequences are created paused; pass false to leave one that way. */
  active?: boolean
}

export interface BuiltSequence {
  id: number
  stepIds: number[]
}

let sequenceCounter = 0

/**
 * A sequence with its steps, activated by default.
 *
 * Activation goes through `setSequenceActive`, so a sequence this factory
 * returns as active has satisfied every rule the console would have enforced:
 * it has steps, it has a trigger tag if it needs one, and no template
 * placeholder is left in any body.
 */
export async function aSequence(w: World, input: SequenceInput = {}): Promise<BuiltSequence> {
  const name = input.name ?? `Series ${++sequenceCounter}`
  const id = await createSequence(w.db, {
    name,
    trigger: input.trigger ?? 'manual',
    triggerTagId: input.triggerTagId ?? null,
    nextSequenceId: input.nextSequenceId ?? null,
  })

  const steps = input.steps ?? [{ subject: `${name}: first` }]
  const stepIds: number[] = []
  for (const step of steps) {
    const added = await addStep(w.db, id, {
      subject: step.subject,
      bodyMd: step.body ?? `Hello {{first_name}}, this is ${step.subject}.`,
      bodyJson: step.bodyJson ?? null,
      delayDays: step.delayDays,
    })
    if (!added.ok || added.stepId === undefined) {
      throw new Error(`Factory could not add a step to ${name}: ${added.reason}`)
    }
    stepIds.push(added.stepId)
  }

  if (input.active !== false) {
    const live = await setSequenceActive(w.db, id, true)
    if (!live.ok) throw new Error(`Factory could not activate ${name}: ${live.reason}`)
  }

  return { id, stepIds }
}

export interface BroadcastInput {
  subject?: string
  body?: string
  segment?: SegmentRule
}

let broadcastCounter = 0

export async function aBroadcast(w: World, input: BroadcastInput = {}): Promise<number> {
  return await createBroadcast(w.db, {
    subject: input.subject ?? `Broadcast ${++broadcastCounter}`,
    bodyMd: input.body ?? 'Hello {{first_name}}, here is the news.\n\nRob',
    segment: input.segment ?? {},
  })
}

/**
 * Bring an enrollment's next step forward so a tick will claim it.
 *
 * The app's own "Fast-forward the clock" does exactly this, for exactly this
 * reason. Scoped to one person and one sequence so a spec can advance one
 * enrollment and leave another parked in the future.
 */
export async function makeDue(
  w: World,
  person: Subscriber,
  sequenceId: number,
  at: Date = new Date(Date.now() - 1000),
): Promise<void> {
  await w.db
    .update(sequenceEnrollments)
    .set({ nextRunAt: at })
    .where(
      and(
        eq(sequenceEnrollments.subscriberId, person.id),
        eq(sequenceEnrollments.sequenceId, sequenceId),
      ),
    )
}

/** Move when somebody joined a sequence, for "what about people from before?" specs. */
export async function backdate(
  w: World,
  person: Subscriber,
  sequenceId: number,
  when: Date,
): Promise<void> {
  await w.db
    .update(sequenceEnrollments)
    .set({ enrolledAt: when })
    .where(
      and(
        eq(sequenceEnrollments.subscriberId, person.id),
        eq(sequenceEnrollments.sequenceId, sequenceId),
      ),
    )
}

/** The enrollment row for a person in a sequence, or null. */
export async function enrollmentOf(w: World, person: Subscriber, sequenceId: number) {
  return (
    (await w.db
      .select()
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.subscriberId, person.id),
          eq(sequenceEnrollments.sequenceId, sequenceId),
        ),
      )
      .get()) ?? null
  )
}

/** Re-read a subscriber, because half these specs are about a field changing. */
export async function reload(w: World, person: Subscriber): Promise<Subscriber> {
  return (await w.db.select().from(subscribers).where(eq(subscribers.id, person.id)).get())!
}
