// STORY-010 — Write a broadcast, send it, and know it went
// SPEC 3.1, 3.4–3.7, 5.5
// gap.md "Where kolea-pro changed a rule": a broadcast resolves its audience
// once, at send (kolea-pro SPEC 9.4, 9.5).
import { beforeAll, describe, expect, it } from 'bun:test'
import { and, count, eq } from 'drizzle-orm'
import {
  type BroadcastStats,
  broadcastStats,
  cancelBroadcast,
  deleteBroadcast,
  getBroadcast,
  sendBroadcastNow,
  startBroadcast,
  updateBroadcast,
} from '../../src/core/broadcasts.ts'
import type { DevOutboxItem } from '../../src/db/schema.ts'
import type { Subscriber } from '../../src/db/schema.ts'
import { broadcasts, messages, subscribers, suppressions } from '../../src/db/schema.ts'
import type { SendJob } from '../../src/types.ts'
import worker from '../../src/worker.tsx'
import { aBroadcast, aPerson, tag } from '../support/factories.ts'
import { createWorld, sendBatchOf, type World } from '../support/world.ts'

/** A send queue that accepts work and never delivers it, so a send stays in flight. */
function holdingQueue(): Queue<SendJob> {
  return { send: async () => {}, sendBatch: async () => {} } as unknown as Queue<SendJob>
}

describe('Feature: sending a broadcast to the list', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a newly written broadcast', () => {
    let world: World
    let broadcast: typeof broadcasts.$inferSelect

    beforeAll(async () => {
      world = createWorld()
      const id = await aBroadcast(world, { subject: 'This week in Ruby' })
      broadcast = (await getBroadcast(world.db, id))!
    })

    it('starts as a draft', () => {
      expect(broadcast.status).toBe('draft')
    })

    it('has sent to nobody yet', () => {
      expect(broadcast.sentAt).toBeNull()
    })

    it('holds the subject it was given', () => {
      expect(broadcast.subject).toBe('This week in Ruby')
    })
  })

  describe('Scenario: editing a draft', () => {
    let world: World
    let result: { ok: boolean }
    let after: typeof broadcasts.$inferSelect

    beforeAll(async () => {
      world = createWorld()
      const id = await aBroadcast(world, { subject: 'First go' })
      result = await updateBroadcast(world.db, id, { subject: 'Second thoughts' })
      after = (await getBroadcast(world.db, id))!
    })

    it('is allowed', () => {
      expect(result.ok).toBe(true)
    })

    it('saves the change', () => {
      expect(after.subject).toBe('Second thoughts')
    })
  })

  describe('Scenario: sending to everybody active', () => {
    let world: World
    let queued: number
    let delivered: DevOutboxItem[]
    let after: typeof broadcasts.$inferSelect
    let stats: BroadcastStats

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'ada@example.test', name: 'Ada Lovelace' })
      await aPerson(world, { email: 'grace@example.test', name: 'Grace Hopper' })
      await aPerson(world, { email: 'alan@example.test', name: 'Alan Turing' })

      const id = await aBroadcast(world, { subject: 'This week in Ruby' })
      queued = await startBroadcast(world.env, world.db, id)
      delivered = await world.outbox()
      after = (await getBroadcast(world.db, id))!
      stats = await broadcastStats(world.db, id)
    })

    it('queues one message per recipient', () => {
      expect(queued).toBe(3)
    })

    it('materializes a row for each of them', async () => {
      const n = (await world.db.select({ n: count() }).from(messages).get())?.n
      expect(n).toBe(3)
    })

    it('hands three separate mails to the provider', () => {
      expect(delivered).toHaveLength(3)
    })

    it('sends each of them the subject', () => {
      expect(delivered.every((m) => m.subject === 'This week in Ruby')).toBe(true)
    })

    it('personalizes each copy', () => {
      const ada = delivered.find((m) => m.toEmail === 'ada@example.test')
      expect(ada?.html).toContain('Ada')
    })

    it('closes the send in the same pass that reached the last recipient', () => {
      // SPEC 3.7: `sent` once no `queued` message remains. With nothing left in
      // a queue there is no "next tick" lag (kolea-pro 9.5).
      expect(after.status).toBe('sent')
    })

    it('reports the recipients in its stats', () => {
      expect(stats.recipients).toBe(3)
    })

    it('reports them as sent', () => {
      expect(stats.sent).toBe(3)
    })

    it('reports the stats as live, not carried over from an import', () => {
      expect(stats.source).toBe('live')
    })
  })

  describe('Scenario: sending to a tagged segment only', () => {
    let world: World
    let delivered: DevOutboxItem[]

    beforeAll(async () => {
      world = createWorld()
      const customer = await aPerson(world, { email: 'customer@example.test' })
      await aPerson(world, { email: 'everyone-else@example.test' })
      const tagId = await tag(world, customer, 'customer')

      const id = await aBroadcast(world, { segment: { includeTagIds: [tagId] } })
      await startBroadcast(world.env, world.db, id)
      delivered = await world.outbox()
    })

    it('reaches the tagged person', () => {
      expect(delivered.map((m) => m.toEmail)).toContain('customer@example.test')
    })

    it('reaches nobody else', () => {
      expect(delivered).toHaveLength(1)
    })
  })

  describe('Scenario: the cron tick closes a finished send', () => {
    let world: World
    let after: typeof broadcasts.$inferSelect

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'ada@example.test' })
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id)

      // The deployed entry point (bdd-specs rule 7): `worker.scheduled`, which
      // is what actually drives a broadcast to completion in production.
      await world.tick()
      after = (await getBroadcast(world.db, id))!
    })

    it('marks it sent once nothing is queued', () => {
      expect(after.status).toBe('sent')
    })

    it('records when it finished', () => {
      expect(after.sentAt).not.toBeNull()
    })
  })

  describe('Scenario: somebody joins after the broadcast finished', () => {
    // SPEC 3.5 — recipients are resolved once, at dispatch. Anything else is a
    // broadcast that quietly keeps sending for the rest of the week.
    let world: World

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'early@example.test' })
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id)
      await world.tick() // closes the send

      await aPerson(world, { email: 'latecomer@example.test' })
      await sendBroadcastNow(world.env, world.db, id)
    })

    it('does not mail the newcomer', async () => {
      const delivered = await world.outbox()
      expect(delivered.map((m) => m.toEmail)).not.toContain('latecomer@example.test')
    })

    it('does not even materialize a message for them', async () => {
      const n = (await world.db.select({ n: count() }).from(messages).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: mail still waiting in the queue keeps the send open', () => {
    // With a real queue the provider hasn't been called yet when the walk ends,
    // so the broadcast stays `sending` until the queue has drained and a later
    // pass (the minutely cron) finds nothing queued.
    let world: World
    let after: typeof broadcasts.$inferSelect

    beforeAll(async () => {
      world = createWorld({ SEND_QUEUE: holdingQueue() })
      await aPerson(world, { email: 'ada@example.test' })
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id)
      after = (await getBroadcast(world.db, id))!
    })

    it('is still sending', () => {
      expect(after.status).toBe('sending')
    })
  })

  describe('Scenario: somebody joins while the send is still in flight', () => {
    // ⭐ SPEC 3.5 — recipients are resolved once, at dispatch. The walk is
    // still cursored over `subscribers.id` (that is what keeps a 25k send
    // inside D1's per-invocation budget), but it stops at the highest id the
    // audience held when the send began, so a newcomer's higher id is never
    // reached however many ticks the send spans.
    let world: World
    let latecomer: Subscriber
    let bound: number | null

    beforeAll(async () => {
      world = createWorld({ SEND_QUEUE: holdingQueue() })
      await aPerson(world, { email: 'early@example.test' })
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id) // queued, so still `sending`

      latecomer = await aPerson(world, { email: 'latecomer@example.test' })
      // The deployed entry point: the minutely cron drives the send onward.
      await world.tick()
      bound = (await getBroadcast(world.db, id))!.audienceUpperId
    })

    it('does not materialize a message for them', async () => {
      const mine = await world.db
        .select({ n: count() })
        .from(messages)
        .where(eq(messages.subscriberId, latecomer.id))
        .get()
      expect(mine?.n).toBe(0)
    })

    it('froze the audience below them', () => {
      expect(bound).toBeLessThan(latecomer.id)
    })
  })

  describe('Scenario: somebody already on the list is tagged into the segment mid-send', () => {
    // The kolea-pro reading: only *who existed* is frozen. The rule is still
    // evaluated on every page beneath the bound, so a person who was already on
    // the list when the send began and picks up the segment's tag before the
    // walk reaches them gets it; someone created after the send began does not,
    // tag or no tag.
    let world: World
    let mailed: string[]

    beforeAll(async () => {
      world = createWorld()
      const first = await aPerson(world, { email: 'first@example.test' })
      const middle = await aPerson(world, { email: 'middle@example.test' })
      const last = await aPerson(world, { email: 'last@example.test' })
      const tagId = await tag(world, first, 'ruby')
      await tag(world, last, 'ruby')

      // A send part-way through its walk: frozen at dispatch with `last` as the
      // highest id in the segment, and the cursor past `first` only.
      const id = await aBroadcast(world, { segment: { includeTagIds: [tagId] } })
      await world.db
        .update(broadcasts)
        .set({
          status: 'sending',
          startedAt: new Date(),
          audienceUpperId: last.id,
          cursorSubscriberId: first.id,
        })
        .where(eq(broadcasts.id, id))

      await tag(world, middle, 'ruby')
      const newcomer = await aPerson(world, { email: 'newcomer@example.test' })
      await tag(world, newcomer, 'ruby')

      await world.tick()
      mailed = (await world.outbox()).map((m) => m.toEmail)
    })

    it('reaches the person who existed before the send and joined the segment', () => {
      expect(mailed).toContain('middle@example.test')
    })

    it('reaches the rest of the frozen audience', () => {
      expect(mailed).toContain('last@example.test')
    })

    it('⭐ does not reach the person created after the send began', () => {
      expect(mailed).not.toContain('newcomer@example.test')
    })
  })

  describe('Scenario: a send already in flight before the audience was frozen', () => {
    // A broadcast mid-send when the `audience_upper_id` column arrived has no
    // bound yet. Its next page freezes one, which is the closest thing to "at
    // dispatch" left for it.
    let world: World
    let bound: number | null
    let highest: number

    beforeAll(async () => {
      world = createWorld()
      const a = await aPerson(world, { email: 'a@example.test' })
      const b = await aPerson(world, { email: 'b@example.test' })
      highest = b.id
      const id = await aBroadcast(world)
      await world.db
        .update(broadcasts)
        .set({ status: 'sending', startedAt: new Date(), cursorSubscriberId: a.id })
        .where(eq(broadcasts.id, id))
      await world.tick()
      bound = (await getBroadcast(world.db, id))!.audienceUpperId
    })

    it('freezes the audience at its next page', () => {
      expect(bound).toBe(highest)
    })
  })

  describe('Scenario: somebody unsubscribes after the send began', () => {
    // ⭐ Freezing who the audience is never freezes their consent. A queued
    // message is checked again immediately before the provider call.
    let world: World
    let outcome: string | undefined

    beforeAll(async () => {
      world = createWorld({ SEND_QUEUE: holdingQueue() })
      const ada = await aPerson(world, { email: 'ada@example.test' })
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id)
      await world.db.update(subscribers).set({ status: 'unsubscribed' }).where(eq(subscribers.id, ada.id))

      const queued = await world.db.select().from(messages).where(eq(messages.broadcastId, id)).all()
      const { batch } = sendBatchOf(queued.map((m) => m.id))
      await worker.queue(batch, world.env)
      outcome = (await world.db.select().from(messages).where(eq(messages.broadcastId, id)).get())?.status
    })

    it('does not mail them', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('records the message as suppressed, not lost', () => {
      expect(outcome).toBe('suppressed')
    })
  })

  describe('Scenario: driving the same broadcast twice', () => {
    // SPEC 3.6 — the idempotency key is what makes a retry, a double click and
    // a cron overlap all harmless.
    let world: World

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'ada@example.test' })
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id)
      await sendBroadcastNow(world.env, world.db, id)
    })

    it('leaves one message for the recipient', async () => {
      const n = (await world.db.select({ n: count() }).from(messages).get())?.n
      expect(n).toBe(1)
    })

    it('sends them one mail', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: sending from the console', () => {
    // The deployed entry point (bdd-specs rule 7).
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'ada@example.test' })
      const id = await aBroadcast(world)
      // Through the confirmation screen's own button: it carries the audience
      // size the operator saw. See the-send-confirmation.spec.ts.
      response = await world.post(`/broadcasts/${id}/send`, { confirm: 'send', expected: '1' })
    })

    it('sends the operator back to the broadcast', () => {
      expect(response.status).toBe(302)
    })

    it('tells them how many went', () => {
      expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('Queued 1')
    })

    it('actually mailed them', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: editing a broadcast that has already gone out', () => {
    // Invariant 9 — sent history is immutable. Rewriting the body of a sent
    // broadcast would make the archive disagree with what landed in inboxes.
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world)
      const id = await aBroadcast(world, { subject: 'As mailed' })
      await startBroadcast(world.env, world.db, id)
      result = await updateBroadcast(world.db, id, { subject: 'Rewritten afterwards' })
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })

    it('says why, in terms the operator can act on', () => {
      expect(result.reason).toContain('not a draft')
    })

    it('leaves the sent subject alone', async () => {
      const row = await world.db.select().from(broadcasts).get()
      expect(row?.subject).toBe('As mailed')
    })
  })

  describe('Scenario: deleting a broadcast that is mid-send', () => {
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const id = await aBroadcast(world)
      await world.db.update(broadcasts).set({ status: 'sending' }).where(eq(broadcasts.id, id))
      result = await deleteBroadcast(world.db, id)
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })

    it('says it is mid-send', () => {
      expect(result.reason).toContain('mid-send')
    })
  })

  describe('Scenario: cancelling a draft', () => {
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const id = await aBroadcast(world)
      result = await cancelBroadcast(world.db, id)
    })

    it('is refused — there is nothing to cancel', () => {
      expect(result.ok).toBe(false)
    })
  })

  describe('Scenario: sending to an empty list', () => {
    let world: World
    let queued: number
    let after: typeof broadcasts.$inferSelect

    beforeAll(async () => {
      world = createWorld()
      const id = await aBroadcast(world)
      queued = await startBroadcast(world.env, world.db, id)
      after = (await getBroadcast(world.db, id))!
    })

    it('queues nothing', () => {
      expect(queued).toBe(0)
    })

    it('still completes rather than hanging in `sending`', () => {
      expect(after.status).toBe('sent')
    })
  })

  describe('Scenario: a broadcast whose whole segment is suppressed', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world, { email: 'gone@example.test' })
      await world.db
        .insert(suppressions)
        .values({ email: person.email, reason: 'unsubscribed_all', createdAt: new Date() })

      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id)
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('leaves the attempt on the record', async () => {
      const n =
        (await world.db
          .select({ n: count() })
          .from(messages)
          .where(and(eq(messages.status, 'suppressed')))
          .get())?.n
      expect(n).toBe(1)
    })
  })
})
