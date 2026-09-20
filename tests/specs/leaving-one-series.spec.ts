// STORY-005 — Leave one series and stay on everything else
// SPEC 2.3, 2.4, 2.9, 6.7
//
// ⭐ This is the file to read first. Every other consent rule in Kōlea exists to
// protect the behaviour specified here: a narrow "no" stays narrow. On the ESP
// this replaces, one unsubscribe click ends everything, forever — so if this
// Feature ever goes red, the product has stopped being the product.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { leaveSequence, rejoinSequence } from '../../src/core/consent.ts'
import { enroll, type EnrollOutcome, tickSequences } from '../../src/core/sequences.ts'
import type { DevOutboxItem, Subscriber } from '../../src/db/schema.ts'
import { sequenceOptouts, suppressions } from '../../src/db/schema.ts'
import { aBroadcast, aPerson, aSequence, enrollmentOf, makeDue, reload } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

describe('Feature: a reader leaves one series', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: leaving the one series, while enrolled in another', () => {
    let world: World
    let reader: Subscriber
    let onboarding: { id: number }
    let course: { id: number }
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test', name: 'A Reader' })
      onboarding = await aSequence(world, { name: 'Onboarding' })
      course = await aSequence(world, { name: 'The course' })
      await enroll(world.db, onboarding.id, reader.id)
      await enroll(world.db, course.id, reader.id)

      await leaveSequence(world.db, reader.id, onboarding.id)
      after = await reload(world, reader)
    })

    it('records the opt-out against that one series', async () => {
      const row = await world.db
        .select()
        .from(sequenceOptouts)
        .where(eq(sequenceOptouts.sequenceId, onboarding.id))
        .get()
      expect(row?.subscriberId).toBe(reader.id)
    })

    it('cancels that enrollment', async () => {
      expect((await enrollmentOf(world, reader, onboarding.id))?.status).toBe('cancelled')
    })

    it('stops that enrollment from being claimed again', async () => {
      expect((await enrollmentOf(world, reader, onboarding.id))?.nextRunAt).toBeNull()
    })

    it('leaves the reader active', () => {
      expect(after.status).toBe('active')
    })

    it('writes no global suppression', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(0)
    })

    it('does not stamp an unsubscribe date', () => {
      expect(after.unsubscribedAt).toBeNull()
    })

    it('leaves the other series running', async () => {
      expect((await enrollmentOf(world, reader, course.id))?.status).toBe('active')
    })

    it('opts them out of nothing else', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceOptouts).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: the newsletter after leaving a series', () => {
    let world: World
    let reader: Subscriber
    let delivered: DevOutboxItem[]

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test' })
      const onboarding = await aSequence(world, { name: 'Onboarding' })
      await enroll(world.db, onboarding.id, reader.id)
      await leaveSequence(world.db, reader.id, onboarding.id)

      const broadcast = await aBroadcast(world, { subject: 'This week' })
      await startBroadcast(world.env, world.db, broadcast)
      delivered = await world.outbox()
    })

    it('still reaches them', () => {
      expect(delivered.map((m) => m.toEmail)).toContain('reader@example.test')
    })

    it('with the broadcast they were meant to get', () => {
      expect(delivered[0]?.subject).toBe('This week')
    })
  })

  describe('Scenario: the series they left, when the tick comes round', () => {
    let world: World
    let reader: Subscriber
    let stayed: Subscriber
    let delivered: DevOutboxItem[]

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'left@example.test' })
      stayed = await aPerson(world, { email: 'stayed@example.test' })
      const onboarding = await aSequence(world, {
        name: 'Onboarding',
        steps: [{ subject: 'Welcome aboard' }],
      })
      await enroll(world.db, onboarding.id, reader.id)
      await enroll(world.db, onboarding.id, stayed.id)
      await leaveSequence(world.db, reader.id, onboarding.id)

      await makeDue(world, reader, onboarding.id)
      await makeDue(world, stayed, onboarding.id)
      await tickSequences(world.env, world.db)
      delivered = await world.outbox()
    })

    it('sends them nothing', () => {
      expect(delivered.map((m) => m.toEmail)).not.toContain('left@example.test')
    })

    it('still sends to everybody who stayed', () => {
      expect(delivered.map((m) => m.toEmail)).toContain('stayed@example.test')
    })
  })

  describe('Scenario: changing their mind and rejoining', () => {
    // SPEC 2.9 — leaving is reversible, by the reader, without asking anyone.
    let world: World
    let reader: Subscriber
    let series: { id: number }
    let rejoinOutcome: EnrollOutcome

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world)
      series = await aSequence(world)
      await enroll(world.db, series.id, reader.id)
      await leaveSequence(world.db, reader.id, series.id)

      await rejoinSequence(world.db, reader.id, series.id)
      // The old enrollment stays cancelled; re-entry is a fresh decision, and
      // 6.3 means it is refused. What rejoining restores is *eligibility*.
      rejoinOutcome = await enroll(world.db, series.id, reader.id)
    })

    it('removes the opt-out', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceOptouts).get())?.n
      expect(n).toBe(0)
    })

    it('no longer refuses them for having opted out', () => {
      expect(rejoinOutcome).not.toBe('opted_out')
    })
  })

  describe('Scenario: leaving through the preference center', () => {
    // The deployed entry point (bdd-specs rule 7): a real form POST to the real
    // public route, with no session and no JavaScript.
    let world: World
    let reader: Subscriber
    let response: Response
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test' })
      const series = await aSequence(world, { name: 'Onboarding' })
      await enroll(world.db, series.id, reader.id)

      response = await world.post(`/p/${reader.unsubToken}`, {
        action: `leave:${series.id}`,
        scope: `sequence:${series.id}`,
        m: '',
      })
      after = await reload(world, reader)
    })

    it('redirects back to the page (POST-redirect-GET)', () => {
      expect(response.status).toBe(303)
    })

    it('says what happened, in the URL it lands on', () => {
      expect(response.headers.get('location')).toContain('done=left')
    })

    it('records the opt-out', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceOptouts).get())?.n
      expect(n).toBe(1)
    })

    it('leaves the reader on the newsletter', () => {
      expect(after.status).toBe('active')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: leaving a sequence that does not exist', () => {
    // The preference center is public and takes this id from a form, so a stale
    // or hand-edited value has to be a no-op rather than a 500.
    let world: World
    let result: boolean

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world)
      result = await leaveSequence(world.db, reader.id, 9999)
    })

    it('reports that nothing was done', () => {
      expect(result).toBe(false)
    })

    it('writes no opt-out row', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceOptouts).get())?.n
      expect(n).toBe(0)
    })
  })

  describe('Scenario: leaving the same series twice', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world)
      const series = await aSequence(world)
      await enroll(world.db, series.id, reader.id)
      await leaveSequence(world.db, reader.id, series.id)
      await leaveSequence(world.db, reader.id, series.id)
    })

    it('still holds exactly one opt-out', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceOptouts).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: something tries to enroll a reader who opted out', () => {
    // Leaving is a standing preference, not a one-time skip: no trigger, chain
    // or exit may undo it. Only the reader can, from the preference center.
    let world: World
    let outcome: EnrollOutcome

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world)
      const series = await aSequence(world)
      await enroll(world.db, series.id, reader.id)
      await leaveSequence(world.db, reader.id, series.id)
      outcome = await enroll(world.db, series.id, reader.id)
    })

    it('refuses, and says why', () => {
      expect(outcome).toBe('opted_out')
    })
  })
})
