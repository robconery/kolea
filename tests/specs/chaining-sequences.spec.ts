// STORY-016 — Send finishers straight into the next series
// SPEC 6.10–6.12
//
// ⚠️ The trap this Feature guards (ARCHITECTURE → Traps): chaining acts ONLY on
// the people who were sent a last step in *this* tick. A sweep for "completed
// but not yet in the next sequence" looks like a harmless catch-up and would
// mail every historical finisher the moment an operator links an old sequence
// to a new one. The "last month" scenario below is the one that would catch it.
import { beforeAll, describe, expect, it } from 'bun:test'
import { leaveSequence } from '../../src/core/consent.ts'
import {
  deleteStep,
  enroll,
  setExit,
  tickSequences,
  updateSequence,
} from '../../src/core/sequences.ts'
import type { Subscriber } from '../../src/db/schema.ts'
import {
  aPerson,
  aSequence,
  aTag,
  backdate,
  type BuiltSequence,
  enrollmentOf,
  makeDue,
  tag,
} from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

/** Onboarding (one step) that leads into the pitch. */
async function twoLinkedSequences(world: World, opts: { targetActive?: boolean } = {}) {
  const pitch = await aSequence(world, {
    name: 'The pitch',
    steps: [{ subject: 'Have you seen this' }],
    active: opts.targetActive !== false,
  })
  const onboarding = await aSequence(world, {
    name: 'Onboarding',
    steps: [{ subject: 'Welcome aboard' }],
    nextSequenceId: pitch.id,
  })
  return { onboarding, pitch }
}

describe('Feature: one series hands its finishers to the next', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: finishing a sequence that names a next one', () => {
    let world: World
    let reader: Subscriber
    let onboarding: BuiltSequence
    let pitch: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      ;({ onboarding, pitch } = await twoLinkedSequences(world))
      reader = await aPerson(world, { email: 'reader@example.test' })
      await enroll(world.db, onboarding.id, reader.id)

      await makeDue(world, reader, onboarding.id)
      await tickSequences(world.env, world.db)
    })

    it('completes the first', async () => {
      expect((await enrollmentOf(world, reader, onboarding.id))?.status).toBe('completed')
    })

    it('enrolls them in the next, in the same tick', async () => {
      expect((await enrollmentOf(world, reader, pitch.id))?.status).toBe('active')
    })

    it('sends the last step of the first series', async () => {
      const delivered = await world.outbox()
      expect(delivered.map((m) => m.subject)).toContain('Welcome aboard')
    })

    it('does not also send the next series in the same tick', async () => {
      const delivered = await world.outbox()
      expect(delivered.map((m) => m.subject)).not.toContain('Have you seen this')
    })

    it('sends the next series on the following tick', async () => {
      await makeDue(world, reader, pitch.id)
      await tickSequences(world.env, world.db)
      const delivered = await world.outbox()
      expect(delivered.map((m) => m.subject)).toContain('Have you seen this')
    })
  })

  describe('Scenario: two people finishing at once', () => {
    let world: World
    let first: Subscriber
    let second: Subscriber
    let pitch: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      const linked = await twoLinkedSequences(world)
      pitch = linked.pitch
      first = await aPerson(world, { email: 'one@example.test' })
      second = await aPerson(world, { email: 'two@example.test' })
      await enroll(world.db, linked.onboarding.id, first.id)
      await enroll(world.db, linked.onboarding.id, second.id)

      await makeDue(world, first, linked.onboarding.id)
      await makeDue(world, second, linked.onboarding.id)
      await tickSequences(world.env, world.db)
    })

    it('chains the first', async () => {
      expect((await enrollmentOf(world, first, pitch.id))?.status).toBe('active')
    })

    it('chains the second', async () => {
      expect((await enrollmentOf(world, second, pitch.id))?.status).toBe('active')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a finisher who had already opted out of the next series', () => {
    // ⭐ Chaining is an enrollment path, so every enrollment rule still applies.
    // An opt-out is a standing preference; nothing automatic may overrule it.
    let world: World
    let reader: Subscriber
    let pitch: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      const linked = await twoLinkedSequences(world)
      pitch = linked.pitch
      reader = await aPerson(world)
      // They joined the pitch once, left it, and are now coming round again.
      await enroll(world.db, pitch.id, reader.id)
      await leaveSequence(world.db, reader.id, pitch.id)
      await enroll(world.db, linked.onboarding.id, reader.id)

      await makeDue(world, reader, linked.onboarding.id)
      await tickSequences(world.env, world.db)
    })

    it('leaves their cancelled pitch enrollment cancelled', async () => {
      expect((await enrollmentOf(world, reader, pitch.id))?.status).toBe('cancelled')
    })

    it('sends them nothing from the pitch', async () => {
      await makeDue(world, reader, pitch.id)
      await tickSequences(world.env, world.db)
      const delivered = await world.outbox()
      expect(delivered.map((m) => m.subject)).not.toContain('Have you seen this')
    })
  })

  describe('Scenario: the next sequence is paused', () => {
    let world: World
    let reader: Subscriber
    let pitch: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      const linked = await twoLinkedSequences(world, { targetActive: false })
      pitch = linked.pitch
      reader = await aPerson(world)
      await enroll(world.db, linked.onboarding.id, reader.id)

      await makeDue(world, reader, linked.onboarding.id)
      await tickSequences(world.env, world.db)
    })

    it('enrolls nobody into it', async () => {
      expect(await enrollmentOf(world, reader, pitch.id)).toBeNull()
    })
  })

  describe('Scenario: a finisher who holds one of the next sequence’s exit tags', () => {
    let world: World
    let reader: Subscriber
    let pitch: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      const linked = await twoLinkedSequences(world)
      pitch = linked.pitch
      const customer = await aTag(world, 'customer')
      await setExit(world.db, pitch.id, customer, null)

      reader = await aPerson(world)
      await tag(world, reader, 'customer')
      await enroll(world.db, linked.onboarding.id, reader.id)

      await makeDue(world, reader, linked.onboarding.id)
      await tickSequences(world.env, world.db)
    })

    it('refuses them at the door — they already bought', async () => {
      expect(await enrollmentOf(world, reader, pitch.id)).toBeNull()
    })
  })

  describe('Scenario: linking an old sequence to a new one, long after the fact', () => {
    // ⭐ The trap. Everybody who finished onboarding last month must stay where
    // they are; only this tick's finishers chain.
    let world: World
    let historical: Subscriber
    let pitch: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      const onboarding = await aSequence(world, {
        name: 'Onboarding',
        steps: [{ subject: 'Welcome aboard' }],
      })
      historical = await aPerson(world, { email: 'last-month@example.test' })
      await enroll(world.db, onboarding.id, historical.id)
      await tickSequences(world.env, world.db) // they finish, with no next sequence set
      await backdate(world, historical, onboarding.id, new Date(Date.now() - 30 * 864e5))

      // Only now does the operator wire the two together.
      pitch = await aSequence(world, { name: 'The pitch', steps: [{ subject: 'Have you seen this' }] })
      await updateSequence(world.db, onboarding.id, { nextSequenceId: pitch.id })
      await tickSequences(world.env, world.db)
    })

    it('does not enroll the historical finisher', async () => {
      expect(await enrollmentOf(world, historical, pitch.id)).toBeNull()
    })

    it('does not mail them', async () => {
      const delivered = await world.outbox()
      expect(delivered.map((m) => m.subject)).not.toContain('Have you seen this')
    })
  })

  describe('Scenario: an enrollment that ends by accident rather than by finishing', () => {
    // SPEC 6.11 — a completion caused by a deleted step is an accident of
    // editing, and an accident must not start a new series.
    let world: World
    let reader: Subscriber
    let onboarding: BuiltSequence
    let pitch: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      ;({ onboarding, pitch } = await twoLinkedSequences(world))
      reader = await aPerson(world)
      await enroll(world.db, onboarding.id, reader.id)
      await deleteStep(world.db, onboarding.stepIds[0]!)

      await makeDue(world, reader, onboarding.id)
      await tickSequences(world.env, world.db)
    })

    it('completes the stranded enrollment', async () => {
      expect((await enrollmentOf(world, reader, onboarding.id))?.status).toBe('completed')
    })

    it('chains nobody  ⭐', async () => {
      expect(await enrollmentOf(world, reader, pitch.id)).toBeNull()
    })
  })

  describe('Scenario: pointing a sequence at itself', () => {
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const series = await aSequence(world)
      result = await updateSequence(world.db, series.id, { nextSequenceId: series.id })
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })

    it('says a sequence cannot lead into itself', () => {
      expect(result.reason).toContain('cannot lead into itself')
    })
  })

  describe('Scenario: pointing a sequence at one that does not exist', () => {
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const series = await aSequence(world)
      result = await updateSequence(world.db, series.id, { nextSequenceId: 9999 })
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })
  })
})
