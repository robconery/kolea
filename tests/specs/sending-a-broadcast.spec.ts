// STORY-010 — Write a broadcast, send it, and know it went
// SPEC 3.1, 3.4–3.7, 5.5
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
import { broadcasts, messages, suppressions } from '../../src/db/schema.ts'
import { aBroadcast, aPerson, tag } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

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

    it('leaves the broadcast mid-flight until a later pass closes it', () => {
      // SPEC 3.7 says a broadcast becomes `sent` once no `queued` messages
      // remain — and it does, but on the *next* pass. `dispatchBroadcastPage`
      // writes `sent` only when it resolves an empty page, so the run that
      // materialized the last recipient cannot also close the send. In
      // production the minutely cron is that next pass. See the scenario below.
      expect(after.status).toBe('sending')
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

  describe('Scenario: somebody joins while the send is still in flight', () => {
    // ⚠️ KNOWN DIVERGENCE FROM SPEC 3.5, recorded here rather than hidden.
    //
    // Recipients are materialized page by page behind a cursor over
    // `subscribers.id` (that is what keeps a 25k send inside D1's
    // query-per-invocation budget). A person who joins mid-send gets a higher
    // id than the cursor, so the next page picks them up and mails them a
    // broadcast that was dispatched before they existed.
    //
    // At 13.7k subscribers a send spans several minutely ticks, so the window
    // is real, not theoretical. It is not obviously wrong — arguably a newcomer
    // *should* get today's newsletter — but SPEC says otherwise, and the two
    // need reconciling. Raise it before changing either.
    let world: World
    let mailed: string[]

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'early@example.test' })
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id) // leaves it `sending`

      await aPerson(world, { email: 'latecomer@example.test' })
      await sendBroadcastNow(world.env, world.db, id)
      mailed = (await world.outbox()).map((m) => m.toEmail)
    })

    it('mails them too, today', () => {
      expect(mailed).toContain('latecomer@example.test')
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
      response = await world.post(`/broadcasts/${id}/send`, {})
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
