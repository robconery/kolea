// STORY-011 — Schedule a broadcast and be able to call it off
// SPEC 3.3, 3.4
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { cancelBroadcast, getBroadcast, scheduleBroadcast } from '../../src/core/broadcasts.ts'
import { broadcasts } from '../../src/db/schema.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const TOMORROW = () => new Date(Date.now() + 24 * 60 * 60 * 1000)
const YESTERDAY = () => new Date(Date.now() - 24 * 60 * 60 * 1000)

/**
 * Make a scheduled broadcast due.
 *
 * `scheduleBroadcast` refuses a time in the past, correctly — so the only
 * honest way to reach "its moment has come" is to move the clock, exactly as
 * the app's own "Fast-forward" does for sequences.
 */
async function bringForward(world: World, id: number) {
  await world.db
    .update(broadcasts)
    .set({ scheduledAt: YESTERDAY() })
    .where(eq(broadcasts.id, id))
}

describe('Feature: scheduling a broadcast for later', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: parking a draft until tomorrow', () => {
    let world: World
    let when: Date
    let after: typeof broadcasts.$inferSelect

    beforeAll(async () => {
      world = createWorld()
      const id = await aBroadcast(world)
      when = TOMORROW()
      await scheduleBroadcast(world.db, id, when)
      after = (await getBroadcast(world.db, id))!
    })

    it('marks it scheduled', () => {
      expect(after.status).toBe('scheduled')
    })

    it('records the time it is due', () => {
      expect(after.scheduledAt?.getTime()).toBe(when.getTime())
    })

    it('has not started', () => {
      expect(after.startedAt).toBeNull()
    })
  })

  describe('Scenario: the cron tick before it is due', () => {
    let world: World
    let after: typeof broadcasts.$inferSelect

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'ada@example.test' })
      const id = await aBroadcast(world)
      await scheduleBroadcast(world.db, id, TOMORROW())

      await world.tick()
      after = (await getBroadcast(world.db, id))!
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('leaves it scheduled', () => {
      expect(after.status).toBe('scheduled')
    })
  })

  describe('Scenario: the cron tick once it is due', () => {
    // The deployed entry point (bdd-specs rule 7): `worker.scheduled` is the
    // only thing that ever starts a scheduled send in production.
    let world: World
    let after: typeof broadcasts.$inferSelect

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'ada@example.test' })
      await aPerson(world, { email: 'grace@example.test' })
      const id = await aBroadcast(world, { subject: 'Tuesday post' })
      await scheduleBroadcast(world.db, id, TOMORROW())
      await bringForward(world, id)

      await world.tick()
      after = (await getBroadcast(world.db, id))!
    })

    it('mails everybody in the segment', async () => {
      expect(await world.outbox()).toHaveLength(2)
    })

    it('sends the broadcast that was scheduled', async () => {
      const delivered = await world.outbox()
      expect(delivered[0]?.subject).toBe('Tuesday post')
    })

    it('records when the send started', () => {
      expect(after.startedAt).not.toBeNull()
    })
  })

  describe('Scenario: calling it off before it goes', () => {
    let world: World
    let result: { ok: boolean; alreadySent?: number }
    let after: typeof broadcasts.$inferSelect

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world)
      const id = await aBroadcast(world)
      await scheduleBroadcast(world.db, id, TOMORROW())

      result = await cancelBroadcast(world.db, id)
      after = (await getBroadcast(world.db, id))!
    })

    it('is allowed', () => {
      expect(result.ok).toBe(true)
    })

    it('marks it cancelled', () => {
      expect(after.status).toBe('cancelled')
    })

    it('reports that nothing had gone out yet', () => {
      expect(result.alreadySent).toBe(0)
    })
  })

  describe('Scenario: the tick after a cancellation', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world)
      const id = await aBroadcast(world)
      await scheduleBroadcast(world.db, id, TOMORROW())
      await bringForward(world, id)
      await cancelBroadcast(world.db, id)

      await world.tick()
    })

    it('sends nothing, even though its moment has passed', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: scheduling for a time that has already gone', () => {
    let world: World
    let result: { ok: boolean; reason?: string }
    let after: typeof broadcasts.$inferSelect

    beforeAll(async () => {
      world = createWorld()
      const id = await aBroadcast(world)
      result = await scheduleBroadcast(world.db, id, YESTERDAY())
      after = (await getBroadcast(world.db, id))!
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })

    it('says the time is in the past', () => {
      expect(result.reason).toContain('past')
    })

    it('leaves it a draft', () => {
      expect(after.status).toBe('draft')
    })
  })

  describe('Scenario: scheduling something that has already been sent', () => {
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const id = await aBroadcast(world)
      await world.db.update(broadcasts).set({ status: 'sent' }).where(eq(broadcasts.id, id))
      result = await scheduleBroadcast(world.db, id, TOMORROW())
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })
  })

  describe('Scenario: scheduling a broadcast that does not exist', () => {
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      result = await scheduleBroadcast(world.db, 9999, TOMORROW())
    })

    it('is refused rather than throwing', () => {
      expect(result.ok).toBe(false)
    })

    it('says there is no such broadcast', () => {
      expect(result.reason).toContain('no such broadcast')
    })
  })
})
