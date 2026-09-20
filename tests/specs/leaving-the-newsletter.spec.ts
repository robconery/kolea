// STORY-006 — Leave the newsletter and keep the series I signed up for
// SPEC 2.5, 6.7
//
// The mirror image of STORY-005, and the asymmetry is deliberate:
// `subscribers.status = 'unsubscribed'` is BROADCAST-scoped. Somebody who muted
// the newsletter still gets the course they paid for. Do not "fix" this by
// having sequence eligibility consult `status` — see `canReceiveSequenceIn`.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { resubscribeBroadcasts, unsubscribeBroadcasts } from '../../src/core/consent.ts'
import { enroll, tickSequences } from '../../src/core/sequences.ts'
import type { DevOutboxItem, Subscriber } from '../../src/db/schema.ts'
import { messages, sequenceOptouts, suppressions } from '../../src/db/schema.ts'
import { aBroadcast, aPerson, aSequence, enrollmentOf, makeDue, reload } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

describe('Feature: a reader leaves the newsletter', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: unsubscribing from broadcasts while enrolled in a series', () => {
    let world: World
    let reader: Subscriber
    let series: { id: number }
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test' })
      series = await aSequence(world, { name: 'The course' })
      await enroll(world.db, series.id, reader.id)

      await unsubscribeBroadcasts(world.db, reader.id)
      after = await reload(world, reader)
    })

    it('marks them unsubscribed', () => {
      expect(after.status).toBe('unsubscribed')
    })

    it('records when they left', () => {
      expect(after.unsubscribedAt).not.toBeNull()
    })

    it('writes no global suppression', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(0)
    })

    it('writes no sequence opt-out', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceOptouts).get())?.n
      expect(n).toBe(0)
    })

    it('leaves their series enrollment active', async () => {
      expect((await enrollmentOf(world, reader, series.id))?.status).toBe('active')
    })
  })

  describe('Scenario: the series carries on afterwards', () => {
    // ⭐ The asymmetry, asserted on the wire rather than in the database.
    let world: World
    let reader: Subscriber
    let delivered: DevOutboxItem[]

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test' })
      const series = await aSequence(world, {
        name: 'The course',
        steps: [{ subject: 'Lesson one' }],
      })
      await enroll(world.db, series.id, reader.id)
      await unsubscribeBroadcasts(world.db, reader.id)

      await makeDue(world, reader, series.id)
      await tickSequences(world.env, world.db)
      delivered = await world.outbox()
    })

    it('sends them the step', () => {
      expect(delivered.map((m) => m.toEmail)).toContain('reader@example.test')
    })

    it('and it is the lesson, not a broadcast', () => {
      expect(delivered[0]?.subject).toBe('Lesson one')
    })
  })

  describe('Scenario: a broadcast dispatched afterwards', () => {
    let world: World
    let reader: Subscriber
    let stayed: Subscriber
    let delivered: DevOutboxItem[]

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'left@example.test' })
      stayed = await aPerson(world, { email: 'stayed@example.test' })
      await unsubscribeBroadcasts(world.db, reader.id)

      const broadcast = await aBroadcast(world, { subject: 'This week' })
      await startBroadcast(world.env, world.db, broadcast)
      delivered = await world.outbox()
    })

    it('does not reach them', () => {
      expect(delivered.map((m) => m.toEmail)).not.toContain('left@example.test')
    })

    it('still reaches everybody else', () => {
      expect(delivered.map((m) => m.toEmail)).toContain('stayed@example.test')
    })

    it('does not even materialize a message for them', async () => {
      // They are outside the segment (SPEC 1.6), so there is nothing to
      // suppress — the suppressed-message row is for people the segment picked
      // up and consent then stopped. See `suppression.spec.ts`.
      const n = (await world.db.select({ n: count() }).from(messages).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: coming back to the newsletter', () => {
    let world: World
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world)
      await unsubscribeBroadcasts(world.db, reader.id)
      await resubscribeBroadcasts(world.db, reader.id)
      after = await reload(world, reader)
    })

    it('makes them active again', () => {
      expect(after.status).toBe('active')
    })

    it('clears the unsubscribe date', () => {
      expect(after.unsubscribedAt).toBeNull()
    })
  })

  describe('Scenario: unsubscribing through the preference center', () => {
    // The deployed entry point (bdd-specs rule 7).
    let world: World
    let reader: Subscriber
    let response: Response
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world)
      response = await world.post(`/p/${reader.unsubToken}`, {
        action: 'unsub_broadcast',
        scope: 'broadcast',
        m: '',
      })
      after = await reload(world, reader)
    })

    it('redirects back to the page', () => {
      expect(response.status).toBe(303)
    })

    it('unsubscribes them from broadcasts', () => {
      expect(after.status).toBe('unsubscribed')
    })

    it('writes no suppression — this is the narrow scope', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(0)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: an action the page does not recognize', () => {
    let world: World
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world)
      await world.post(`/p/${reader.unsubToken}`, { action: 'nonsense', scope: '', m: '' })
      after = await reload(world, reader)
    })

    it('changes nothing', () => {
      expect(after.status).toBe('active')
    })
  })
})
