// STORY-018 — Consent always wins over configuration
// SPEC 2.1, 6.17, 6.18
//
// Every other sequence spec is about the machinery working. This one is about
// the machinery being overruled. Whatever the exits, the chain, or the trigger
// say, an opt-out, a global unsubscribe, a hard bounce or a complaint ends an
// enrollment — and the reason is recorded, because "they asked to leave" and
// "we stopped because they bounced" look identical in `status` and mean
// opposite things.
import { beforeAll, describe, expect, it } from 'bun:test'
import { desc, eq } from 'drizzle-orm'
import { leaveSequence, unsubscribeBroadcasts } from '../../src/core/consent.ts'
import { enroll, tickSequences } from '../../src/core/sequences.ts'
import type { DevOutboxItem, Subscriber } from '../../src/db/schema.ts'
import { activities, subscribers, suppressions } from '../../src/db/schema.ts'
import { aPerson, aSequence, type BuiltSequence, enrollmentOf, makeDue } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

/** One person, one live series, one step due right now. */
async function aDueEnrollment(world: World, email = 'reader@example.test') {
  const series = await aSequence(world, { name: 'The course', steps: [{ subject: 'Lesson one' }] })
  const reader = await aPerson(world, { email })
  await enroll(world.db, series.id, reader.id)
  await makeDue(world, reader, series.id)
  return { series, reader }
}

describe('Feature: consent overrules whatever the sequence is configured to do', () => {
  // ───────────────────────────────────────────── happy path
  //
  // "Happy" here means the rule holding. Every scenario is somebody NOT being
  // mailed, which is the outcome this product is for.

  describe('Scenario: the address is suppressed between enrolling and the step falling due', () => {
    // ⭐ SPEC 2.1 — consent is checked immediately before the provider call,
    // never at enqueue time. A queue can deliver minutes later; consent can
    // change in between.
    let world: World
    let reader: Subscriber
    let series: BuiltSequence
    let delivered: DevOutboxItem[]

    beforeAll(async () => {
      world = createWorld()
      ;({ series, reader } = await aDueEnrollment(world))
      await world.db
        .insert(suppressions)
        .values({ email: reader.email, reason: 'unsubscribed_all', createdAt: new Date() })

      await tickSequences(world.env, world.db)
      delivered = await world.outbox()
    })

    it('sends them nothing', () => {
      expect(delivered).toHaveLength(0)
    })

    it('cancels the enrollment rather than retrying every minute', async () => {
      expect((await enrollmentOf(world, reader, series.id))?.status).toBe('cancelled')
    })

    it('records why  ⭐', async () => {
      const row = await world.db
        .select()
        .from(activities)
        .where(eq(activities.type, 'sequence_cancelled'))
        .orderBy(desc(activities.id))
        .get()
      expect(row?.meta).toMatchObject({ reason: 'suppressed' })
    })
  })

  describe('Scenario: the subscriber hard-bounced', () => {
    let world: World
    let reader: Subscriber
    let series: BuiltSequence

    beforeAll(async () => {
      world = createWorld()
      ;({ series, reader } = await aDueEnrollment(world))
      await world.db
        .update(subscribers)
        .set({ status: 'bounced' })
        .where(eq(subscribers.id, reader.id))

      await tickSequences(world.env, world.db)
    })

    it('sends them nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('records the status as the reason', async () => {
      const row = await world.db
        .select()
        .from(activities)
        .where(eq(activities.type, 'sequence_cancelled'))
        .orderBy(desc(activities.id))
        .get()
      expect(row?.meta).toMatchObject({ reason: 'status:bounced' })
    })
  })

  describe('Scenario: the subscriber complained about a previous mail', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const { reader } = await aDueEnrollment(world)
      await world.db
        .update(subscribers)
        .set({ status: 'complained' })
        .where(eq(subscribers.id, reader.id))

      await tickSequences(world.env, world.db)
    })

    it('sends them nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: the reader opted out of this very series', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const { series, reader } = await aDueEnrollment(world)
      await leaveSequence(world.db, reader.id, series.id)

      await tickSequences(world.env, world.db)
    })

    it('sends them nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })
  })

  // ───────────────────────────────────────────── sad path
  //
  // The rule being over-applied is just as much a bug as it being skipped: an
  // unsubscribe from the newsletter is not an unsubscribe from a course.

  describe('Scenario: the reader left the newsletter but not this series', () => {
    // ⭐ The asymmetry that makes Kōlea different. `canReceiveSequenceIn`
    // deliberately does not consult `status === 'unsubscribed'`.
    let world: World
    let delivered: DevOutboxItem[]

    beforeAll(async () => {
      world = createWorld()
      const { reader } = await aDueEnrollment(world)
      await unsubscribeBroadcasts(world.db, reader.id)

      await tickSequences(world.env, world.db)
      delivered = await world.outbox()
    })

    it('still sends them the step', () => {
      expect(delivered).toHaveLength(1)
    })

    it('and it is the lesson they signed up for', () => {
      expect(delivered[0]?.subject).toBe('Lesson one')
    })
  })

  describe('Scenario: a reader who is only `pending` — on file, never joined', () => {
    // `pending` is invisible to broadcasts and reachable by sequences, which is
    // exactly the shape a buyer who never subscribed should have.
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const series = await aSequence(world, {
        name: 'Receipts',
        steps: [{ subject: 'Your download' }],
      })
      const buyer = await aPerson(world, { email: 'buyer@example.test', status: 'pending' })
      await enroll(world.db, series.id, buyer.id)
      await makeDue(world, buyer, series.id)

      await tickSequences(world.env, world.db)
    })

    it('reaches them', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })
})
