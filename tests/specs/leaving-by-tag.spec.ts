// STORY-017 — Pull somebody out of a pitch when they buy
// SPEC 6.13–6.16, 6.18
//
// ⚠️ An exit is NOT an opt-out (ARCHITECTURE → Traps). `exitSequence` cancels an
// enrollment because something happened *to* the person; `leaveSequence`
// records that the person chose to go. Confusing the two writes a consent fact
// nobody consented to — and consent facts are the one thing here that cannot be
// undone by the operator.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, desc, eq } from 'drizzle-orm'
import { enroll, type EnrollOutcome, removeExit, setExit } from '../../src/core/sequences.ts'
import type { Subscriber } from '../../src/db/schema.ts'
import { activities, sequenceOptouts, suppressions } from '../../src/db/schema.ts'
import {
  aPerson,
  aSequence,
  aTag,
  type BuiltSequence,
  enrollmentOf,
  reload,
  tag,
} from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

describe('Feature: a tag ends a series, and may start another', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the exit tag lands on somebody mid-pitch', () => {
    let world: World
    let buyer: Subscriber
    let pitch: BuiltSequence
    let onboarding: BuiltSequence
    let unrelated: BuiltSequence
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      pitch = await aSequence(world, { name: 'The pitch', steps: [{ subject: 'Buy the course' }] })
      onboarding = await aSequence(world, {
        name: 'Customer onboarding',
        steps: [{ subject: 'Getting started' }],
      })
      unrelated = await aSequence(world, { name: 'The newsletter tips' })

      const customer = await aTag(world, 'customer')
      await setExit(world.db, pitch.id, customer, onboarding.id)

      buyer = await aPerson(world, { email: 'buyer@example.test' })
      await enroll(world.db, pitch.id, buyer.id)
      await enroll(world.db, unrelated.id, buyer.id)

      await tag(world, buyer, 'customer')
      after = await reload(world, buyer)
    })

    it('cancels the pitch enrollment', async () => {
      expect((await enrollmentOf(world, buyer, pitch.id))?.status).toBe('cancelled')
    })

    it('records why it was cancelled  ⭐', async () => {
      const row = await world.db
        .select()
        .from(activities)
        .where(eq(activities.type, 'sequence_cancelled'))
        .orderBy(desc(activities.id))
        .get()
      expect(row?.meta).toMatchObject({ reason: 'exit_tag' })
    })

    it('enrolls them in the follow-on', async () => {
      expect((await enrollmentOf(world, buyer, onboarding.id))?.status).toBe('active')
    })

    it('writes no sequence opt-out — this is not them saying no  ⭐', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceOptouts).get())?.n
      expect(n).toBe(0)
    })

    it('writes no suppression', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(0)
    })

    it('does not change their status', () => {
      expect(after.status).toBe('active')
    })

    it('leaves every other series they are in alone', async () => {
      expect((await enrollmentOf(world, buyer, unrelated.id))?.status).toBe('active')
    })
  })

  describe('Scenario: an exit with no follow-on', () => {
    let world: World
    let buyer: Subscriber
    let pitch: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      pitch = await aSequence(world, { name: 'The pitch' })
      const customer = await aTag(world, 'customer')
      await setExit(world.db, pitch.id, customer, null)

      buyer = await aPerson(world)
      await enroll(world.db, pitch.id, buyer.id)
      await tag(world, buyer, 'customer')
    })

    it('still ends the series', async () => {
      expect((await enrollmentOf(world, buyer, pitch.id))?.status).toBe('cancelled')
    })
  })

  describe('Scenario: somebody who already holds the exit tag tries to join', () => {
    // ⭐ SPEC 6.14. An exit tag is a standing fact, not a one-off event:
    // somebody who bought the course last year must not be dripped the pitch
    // for it just because they joined the list today.
    let world: World
    let outcome: EnrollOutcome

    beforeAll(async () => {
      world = createWorld()
      const pitch = await aSequence(world, { name: 'The pitch' })
      const customer = await aTag(world, 'customer')
      await setExit(world.db, pitch.id, customer, null)

      const buyer = await aPerson(world)
      await tag(world, buyer, 'customer')
      outcome = await enroll(world.db, pitch.id, buyer.id)
    })

    it('is refused at the door', () => {
      expect(outcome).toBe('has_exit_tag')
    })
  })

  describe('Scenario: removing an exit again', () => {
    let world: World
    let outcome: EnrollOutcome

    beforeAll(async () => {
      world = createWorld()
      const pitch = await aSequence(world, { name: 'The pitch' })
      const customer = await aTag(world, 'customer')
      await setExit(world.db, pitch.id, customer, null)
      await removeExit(world.db, pitch.id, customer)

      const buyer = await aPerson(world)
      await tag(world, buyer, 'customer')
      outcome = await enroll(world.db, pitch.id, buyer.id)
    })

    it('lets the tagged person in again', () => {
      expect(outcome).toBe('enrolled')
    })
  })

  describe('Scenario: setting an exit from the sequence editor', () => {
    // The deployed entry point (bdd-specs rule 7).
    let world: World
    let response: Response
    let buyer: Subscriber
    let pitch: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      pitch = await aSequence(world, { name: 'The pitch' })
      const customer = await aTag(world, 'customer')

      response = await world.post(`/sequences/${pitch.id}/exits`, {
        tagId: String(customer),
        thenSequenceId: '',
      })

      buyer = await aPerson(world)
      await enroll(world.db, pitch.id, buyer.id)
      await tag(world, buyer, 'customer')
    })

    it('accepts the form', () => {
      expect(response.status).toBe(302)
    })

    it('makes the exit take effect', async () => {
      expect((await enrollmentOf(world, buyer, pitch.id))?.status).toBe('cancelled')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: the exit tag lands on somebody who was never in the series', () => {
    // SPEC 6.13 — the follow-on fires only for people actually pulled out. An
    // exit is "how people leave this series and where they go", not a second
    // tag trigger for everybody who ever gets the tag.
    let world: World
    let bystander: Subscriber
    let onboarding: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      const pitch = await aSequence(world, { name: 'The pitch' })
      onboarding = await aSequence(world, { name: 'Customer onboarding' })
      const customer = await aTag(world, 'customer')
      await setExit(world.db, pitch.id, customer, onboarding.id)

      bystander = await aPerson(world)
      await tag(world, bystander, 'customer')
    })

    it('does not enroll them in the follow-on', async () => {
      expect(await enrollmentOf(world, bystander, onboarding.id)).toBeNull()
    })
  })

  describe('Scenario: a follow-on sequence that is paused', () => {
    let world: World
    let buyer: Subscriber
    let pitch: BuiltSequence
    let onboarding: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      pitch = await aSequence(world, { name: 'The pitch' })
      onboarding = await aSequence(world, { name: 'Customer onboarding', active: false })
      const customer = await aTag(world, 'customer')
      await setExit(world.db, pitch.id, customer, onboarding.id)

      buyer = await aPerson(world)
      await enroll(world.db, pitch.id, buyer.id)
      await tag(world, buyer, 'customer')
    })

    it('still ends the pitch', async () => {
      expect((await enrollmentOf(world, buyer, pitch.id))?.status).toBe('cancelled')
    })

    it('enrolls nobody into the paused one', async () => {
      expect(await enrollmentOf(world, buyer, onboarding.id)).toBeNull()
    })
  })

  describe('Scenario: a tag that both starts and ends the same sequence', () => {
    // `enroll` refuses anybody holding an exit tag, so this pair would build a
    // sequence nobody could ever enter.
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const customer = await aTag(world, 'customer')
      const series = await aSequence(world, { trigger: 'tag_added', triggerTagId: customer })
      result = await setExit(world.db, series.id, customer, null)
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })

    it('explains the contradiction', () => {
      expect(result.reason).toContain('cannot also end it')
    })
  })

  describe('Scenario: an exit that leads back into its own sequence', () => {
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const series = await aSequence(world)
      const customer = await aTag(world, 'customer')
      result = await setExit(world.db, series.id, customer, series.id)
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })
  })

  describe('Scenario: an exit on a tag that does not exist', () => {
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const series = await aSequence(world)
      result = await setExit(world.db, series.id, 9999, null)
    })

    it('is refused rather than leaving a dangling rule', () => {
      expect(result.ok).toBe(false)
    })

    it('says which half was wrong', () => {
      expect(result.reason).toContain('no such tag')
    })
  })
})
