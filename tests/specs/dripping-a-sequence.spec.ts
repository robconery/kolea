// STORY-015 — Drip a series, one step at a time
// SPEC 6.1–6.6, 6.8
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import {
  deleteStep,
  enroll,
  type EnrollOutcome,
  setSequenceActive,
  tickSequences,
} from '../../src/core/sequences.ts'
import type { DevOutboxItem, Subscriber } from '../../src/db/schema.ts'
import { messages, sequenceEnrollments } from '../../src/db/schema.ts'
import {
  aPerson,
  aSequence,
  aTag,
  type BuiltSequence,
  enrollmentOf,
  makeDue,
  tag,
} from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const THREE_STEPS = [
  { subject: 'Welcome aboard', delayDays: 0 },
  { subject: 'The part everyone skips', delayDays: 2 },
  { subject: 'One last thing', delayDays: 3 },
]

describe('Feature: a drip sequence delivers its steps', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: somebody joins the list while a welcome series is live', () => {
    let world: World
    let joiner: Subscriber
    let series: { id: number }
    let enrollment: typeof sequenceEnrollments.$inferSelect | null

    beforeAll(async () => {
      world = createWorld()
      series = await aSequence(world, { trigger: 'subscribe', steps: THREE_STEPS })
      // Created *after* the sequence went live, exactly as a real signup is.
      joiner = await aPerson(world, { email: 'joiner@example.test', name: 'A Joiner' })
      enrollment = await enrollmentOf(world, joiner, series.id)
    })

    it('enrolls them', () => {
      expect(enrollment).not.toBeNull()
    })

    it('leaves the enrollment active', () => {
      expect(enrollment?.status).toBe('active')
    })

    it('points it at the first step', () => {
      expect(enrollment?.nextStepId).not.toBeNull()
    })

    it('makes the first step due immediately — no delay on step one', () => {
      expect(enrollment!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000)
    })
  })

  describe('Scenario: the tick, with a first step due', () => {
    let world: World
    let joiner: Subscriber
    let series: { id: number }
    let sent: number
    let delivered: DevOutboxItem[]
    let enrollment: typeof sequenceEnrollments.$inferSelect | null

    beforeAll(async () => {
      world = createWorld()
      series = await aSequence(world, { trigger: 'subscribe', steps: THREE_STEPS })
      joiner = await aPerson(world, { email: 'joiner@example.test', name: 'A Joiner' })

      sent = await tickSequences(world.env, world.db)
      delivered = await world.outbox()
      enrollment = await enrollmentOf(world, joiner, series.id)
    })

    it('sends exactly one message', () => {
      expect(sent).toBe(1)
    })

    it('sends it to the enrolled person', () => {
      expect(delivered[0]?.toEmail).toBe('joiner@example.test')
    })

    it('sends the first step', () => {
      expect(delivered[0]?.subject).toBe('Welcome aboard')
    })

    it('resolves the merge tag to their first name', () => {
      // The step body is `Hello {{first_name}}, …` — "A Joiner" first-names to "A".
      expect(delivered[0]?.html).toContain('Hello A,')
    })

    it('advances the enrollment to the next step', () => {
      expect(enrollment?.nextStepId).toBe(2)
    })

    it('parks the next step two days out', () => {
      const days = (enrollment!.nextRunAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
      expect(Math.round(days)).toBe(2)
    })

    it('keeps the enrollment active', () => {
      expect(enrollment?.status).toBe('active')
    })
  })

  describe('Scenario: the tick again, immediately', () => {
    let world: World
    let second: number

    beforeAll(async () => {
      world = createWorld()
      await aSequence(world, { trigger: 'subscribe', steps: THREE_STEPS })
      await aPerson(world)
      await tickSequences(world.env, world.db)
      second = await tickSequences(world.env, world.db)
    })

    it('sends nothing — step two is not due yet', () => {
      expect(second).toBe(0)
    })

    it('leaves the reader with one mail', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: playing the whole series out', () => {
    let world: World
    let reader: Subscriber
    let series: { id: number }
    let delivered: DevOutboxItem[]
    let enrollment: typeof sequenceEnrollments.$inferSelect | null

    beforeAll(async () => {
      world = createWorld()
      series = await aSequence(world, { trigger: 'subscribe', steps: THREE_STEPS })
      reader = await aPerson(world, { email: 'reader@example.test' })

      // Three ticks, each preceded by bringing the clock forward — the same
      // thing the dashboard's "Fast-forward" button does locally.
      for (let i = 0; i < 3; i++) {
        await makeDue(world, reader, series.id)
        await tickSequences(world.env, world.db)
      }
      delivered = await world.outbox()
      enrollment = await enrollmentOf(world, reader, series.id)
    })

    it('sends every step', () => {
      expect(delivered).toHaveLength(3)
    })

    it('sends them in order', () => {
      expect(delivered.map((m) => m.subject)).toEqual(THREE_STEPS.map((s) => s.subject))
    })

    it('completes the enrollment', () => {
      expect(enrollment?.status).toBe('completed')
    })

    it('leaves nothing scheduled', () => {
      expect(enrollment?.nextRunAt).toBeNull()
    })
  })

  describe('Scenario: a tick replayed after the step already went', () => {
    // SPEC 6.5 — one step, one message, guaranteed by the `seqstep:` key.
    let world: World
    let reader: Subscriber
    let series: { id: number }

    beforeAll(async () => {
      world = createWorld()
      series = await aSequence(world, { trigger: 'subscribe', steps: THREE_STEPS })
      reader = await aPerson(world)
      await tickSequences(world.env, world.db)

      // Rewind the enrollment as though the tick had crashed after sending.
      await world.db
        .update(sequenceEnrollments)
        .set({ nextStepId: 1, nextRunAt: new Date(Date.now() - 1000) })
        .where(eq(sequenceEnrollments.subscriberId, reader.id))
      await tickSequences(world.env, world.db)
    })

    it('materializes one message for that step, not two  ⭐', async () => {
      const n = (await world.db.select({ n: count() }).from(messages).get())?.n
      expect(n).toBe(1)
    })

    it('mails them once', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: a sequence triggered by a tag', () => {
    let world: World
    let reader: Subscriber
    let series: { id: number }

    beforeAll(async () => {
      world = createWorld()
      const tagId = await aTag(world, 'bought-the-course')
      series = await aSequence(world, {
        trigger: 'tag_added',
        triggerTagId: tagId,
        steps: [{ subject: 'Thanks for buying' }],
      })
      reader = await aPerson(world, { email: 'buyer@example.test' })
      await tag(world, reader, 'bought-the-course')
    })

    it('enrolls them when the tag lands', async () => {
      expect((await enrollmentOf(world, reader, series.id))?.status).toBe('active')
    })

    it('sends them the step on the next tick', async () => {
      await tickSequences(world.env, world.db)
      expect((await world.outbox())[0]?.subject).toBe('Thanks for buying')
    })
  })

  describe('Scenario: running the tick from the cron', () => {
    // The deployed entry point (bdd-specs rule 7): `worker.scheduled`.
    let world: World

    beforeAll(async () => {
      world = createWorld()
      await aSequence(world, { trigger: 'subscribe', steps: THREE_STEPS })
      await aPerson(world, { email: 'joiner@example.test' })
      await world.tick()
    })

    it('delivers the due step', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a sequence that is not live', () => {
    let world: World
    let joiner: Subscriber
    let series: { id: number }

    beforeAll(async () => {
      world = createWorld()
      series = await aSequence(world, { trigger: 'subscribe', steps: THREE_STEPS, active: false })
      joiner = await aPerson(world)
    })

    it('enrolls nobody', async () => {
      expect(await enrollmentOf(world, joiner, series.id)).toBeNull()
    })
  })

  describe('Scenario: pausing a sequence that people are part-way through', () => {
    // SPEC 6.4 — deactivating halts pending steps, it does not merely stop new
    // enrollment. The tick joins on `sequences.is_active`.
    let world: World
    let reader: Subscriber
    let series: { id: number }

    beforeAll(async () => {
      world = createWorld()
      series = await aSequence(world, { trigger: 'subscribe', steps: THREE_STEPS })
      reader = await aPerson(world)
      await setSequenceActive(world.db, series.id, false)
      await makeDue(world, reader, series.id)
      await tickSequences(world.env, world.db)
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('leaves the enrollment where it was, for when it starts again', async () => {
      expect((await enrollmentOf(world, reader, series.id))?.status).toBe('active')
    })
  })

  describe('Scenario: enrolling somebody who is already in the sequence', () => {
    let world: World
    let outcome: EnrollOutcome

    beforeAll(async () => {
      world = createWorld()
      const series = await aSequence(world)
      const reader = await aPerson(world)
      await enroll(world.db, series.id, reader.id)
      outcome = await enroll(world.db, series.id, reader.id)
    })

    it('refuses, and says they are already in it', () => {
      expect(outcome).toBe('already')
    })
  })

  describe('Scenario: enrolling somebody who has already finished it', () => {
    // ⭐ SPEC 6.3 — a completed enrollment still counts. Otherwise re-running a
    // welcome series over the list mails everybody their welcome again.
    let world: World
    let outcome: EnrollOutcome

    beforeAll(async () => {
      world = createWorld()
      const series = await aSequence(world, { steps: [{ subject: 'Only step' }] })
      const reader = await aPerson(world)
      await enroll(world.db, series.id, reader.id)
      await tickSequences(world.env, world.db)
      outcome = await enroll(world.db, series.id, reader.id)
    })

    it('refuses', () => {
      expect(outcome).toBe('already')
    })
  })

  describe('Scenario: activating a sequence that has no steps', () => {
    // Accepted-and-inert is worse than refused: a series that enrolls people
    // and sends nothing looks exactly like a working one until somebody checks.
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const series = await aSequence(world, { steps: [], active: false })
      result = await setSequenceActive(world.db, series.id, true)
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })

    it('says the sequence has no steps', () => {
      expect(result.reason).toContain('no steps')
    })
  })

  describe('Scenario: activating a sequence with template scaffolding left in it', () => {
    // ⭐ A sequence built from a template arrives full of `[[ write this ]]`.
    // Going live with any of it would mail instructions to real people.
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const series = await aSequence(world, {
        active: false,
        steps: [{ subject: 'Welcome', body: 'Hello — [[ say what they get ]] — see you soon.' }],
      })
      result = await setSequenceActive(world.db, series.id, true)
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })

    it('says which placeholder is still there', () => {
      expect(result.reason).toContain('say what they get')
    })
  })

  describe('Scenario: a tag_added sequence with no trigger tag', () => {
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const series = await aSequence(world, { trigger: 'tag_added', active: false })
      result = await setSequenceActive(world.db, series.id, true)
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })

    it('says the trigger tag is missing', () => {
      expect(result.reason).toContain('trigger tag')
    })
  })

  describe('Scenario: an enrollment whose next step was deleted under it', () => {
    // `next_step_id` is ON DELETE SET NULL, and a null next step completes the
    // enrollment on the following tick — so nobody is left stranded mid-series.
    let world: World
    let reader: Subscriber
    let series: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      series = await aSequence(world, {
        steps: [{ subject: 'One' }, { subject: 'Two', delayDays: 1 }],
      })
      reader = await aPerson(world)
      await enroll(world.db, series.id, reader.id)
      await deleteStep(world.db, series.stepIds[0]!)

      await makeDue(world, reader, series.id)
      await tickSequences(world.env, world.db)
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('completes the enrollment rather than retrying forever', async () => {
      expect((await enrollmentOf(world, reader, series.id))?.status).toBe('completed')
    })
  })
})
