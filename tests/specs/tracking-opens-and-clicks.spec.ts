// STORY-014 — See what happened to a mailing, without trusting a log file
// SPEC 5.1, 5.3, 5.4, 5.5
//
// The rule that shapes every scenario here: recording must never be able to
// break the reader's experience. A tracking failure that swallowed a click
// would turn a broken datapoint into a broken link in mail already delivered,
// which cannot be fixed afterwards.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { type BroadcastStats, broadcastStats, startBroadcast } from '../../src/core/broadcasts.ts'
import type { Message } from '../../src/db/schema.ts'
import { events, messages } from '../../src/db/schema.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

/** One person, one sent broadcast, one message to point events at. */
async function oneSentMessage(world: World) {
  await aPerson(world, { email: 'reader@example.test' })
  const broadcastId = await aBroadcast(world, { subject: 'This week' })
  await startBroadcast(world.env, world.db, broadcastId)
  const message = (await world.db.select().from(messages).get())!
  return { broadcastId, message }
}

describe('Feature: tracking what a mailing did', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the open pixel is fetched', () => {
    // The deployed entry point (bdd-specs rule 7): a real GET on a public route.
    let world: World
    let message: Message
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const sent = await oneSentMessage(world)
      message = sent.message
      response = await world.fetch(`/t/open/${message.id}.gif`)
    })

    it('answers the mail client', () => {
      expect(response.status).toBe(200)
    })

    it('answers with an image', () => {
      expect(response.headers.get('content-type')).toBe('image/gif')
    })

    it('tells caches not to keep it, so a second open is a second open', () => {
      expect(response.headers.get('cache-control')).toContain('no-store')
    })

    it('records the open against the message', async () => {
      const row = await world.db.select().from(events).where(eq(events.type, 'open')).get()
      expect(row?.messageId).toBe(message.id)
    })
  })

  describe('Scenario: a tracked link is clicked', () => {
    let world: World
    let response: Response
    let recorded: typeof events.$inferSelect | undefined

    beforeAll(async () => {
      world = createWorld()
      const sent = await oneSentMessage(world)
      response = await world.fetch(
        `/t/click/${sent.message.id}?u=${encodeURIComponent('https://example.com/post')}`,
        { redirect: 'manual' },
      )
      recorded = await world.db.select().from(events).where(eq(events.type, 'click')).get()
    })

    it('redirects the reader', () => {
      expect(response.status).toBe(302)
    })

    it('redirects them to where they were going', () => {
      expect(response.headers.get('location')).toBe('https://example.com/post')
    })

    it('records the click', () => {
      expect(recorded).toBeDefined()
    })

    it('records which link it was', () => {
      expect(recorded?.meta).toMatchObject({ url: 'https://example.com/post' })
    })
  })

  describe('Scenario: rolling the events up per broadcast', () => {
    let world: World
    let stats: BroadcastStats

    beforeAll(async () => {
      world = createWorld()
      const sent = await oneSentMessage(world)
      await world.fetch(`/t/open/${sent.message.id}.gif`)
      await world.fetch(
        `/t/click/${sent.message.id}?u=${encodeURIComponent('https://example.com')}`,
        { redirect: 'manual' },
      )
      stats = await broadcastStats(world.db, sent.broadcastId)
    })

    it('counts the recipient', () => {
      expect(stats.recipients).toBe(1)
    })

    it('counts the open', () => {
      expect(stats.opened).toBe(1)
    })

    it('counts the click', () => {
      expect(stats.clicked).toBe(1)
    })

    it('counts no bounce', () => {
      expect(stats.bounced).toBe(0)
    })
  })

  describe('Scenario: the same reader opens the mail twice', () => {
    let world: World
    let stats: BroadcastStats

    beforeAll(async () => {
      world = createWorld()
      const sent = await oneSentMessage(world)
      await world.fetch(`/t/open/${sent.message.id}.gif`)
      await world.fetch(`/t/open/${sent.message.id}.gif`)
      stats = await broadcastStats(world.db, sent.broadcastId)
    })

    it('records both opens as events', async () => {
      const n =
        (await world.db.select({ n: count() }).from(events).where(eq(events.type, 'open')).get())?.n
      expect(n).toBe(2)
    })

    it('counts the message once in the stats — opens are per reader, not per pixel', () => {
      expect(stats.opened).toBe(1)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a click on mail whose message row is long gone', () => {
    // ⭐ SPEC 5.4. Mail lives for years; rows get deleted. The redirect must
    // survive the datapoint being unrecordable.
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      response = await world.fetch(
        `/t/click/999999?u=${encodeURIComponent('https://example.com/post')}`,
        { redirect: 'manual' },
      )
    })

    it('still redirects', () => {
      expect(response.status).toBe(302)
    })

    it('still redirects to the right place', () => {
      expect(response.headers.get('location')).toBe('https://example.com/post')
    })

    it('records nothing, because there was nothing to record it against', async () => {
      const n = (await world.db.select({ n: count() }).from(events).get())?.n
      expect(n).toBe(0)
    })
  })

  describe('Scenario: a pixel for a message that no longer exists', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      response = await world.fetch('/t/open/999999.gif')
    })

    it('still returns the image', () => {
      expect(response.status).toBe(200)
    })
  })

  describe('Scenario: a click URL with nowhere to go', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const sent = await oneSentMessage(world)
      response = await world.fetch(`/t/click/${sent.message.id}`, { redirect: 'manual' })
    })

    it('is not found, rather than redirecting somewhere arbitrary', () => {
      expect(response.status).toBe(404)
    })
  })

  describe('Scenario: a broadcast that has sent nothing at all', () => {
    let world: World
    let stats: BroadcastStats

    beforeAll(async () => {
      world = createWorld()
      const id = await aBroadcast(world)
      stats = await broadcastStats(world.db, id)
    })

    it('reports no recipients rather than failing', () => {
      expect(stats.recipients).toBe(0)
    })

    it('reports the numbers as live, not as carried-over import totals', () => {
      expect(stats.source).toBe('live')
    })
  })
})
