// STORY-007 — One deliberate action to stop everything
// SPEC 2.6, 6.7, 6.17
//
// The legal escape hatch, and the only subscriber-initiated path in the whole
// codebase that may write a `suppressions` row (invariant 2). It has to work
// completely — and it has to stay a separate, deliberate choice, never the
// default action on the preference page (SPEC 2a.3).
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { unsubscribeAll } from '../../src/core/consent.ts'
import { enroll, tickSequences } from '../../src/core/sequences.ts'
import type { DevOutboxItem, Subscriber } from '../../src/db/schema.ts'
import { messages, suppressions } from '../../src/db/schema.ts'
import { aBroadcast, aPerson, aSequence, enrollmentOf, makeDue, reload } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

describe('Feature: a reader stops everything', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: unsubscribing from everything while in two series', () => {
    let world: World
    let reader: Subscriber
    let first: { id: number }
    let second: { id: number }
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test' })
      first = await aSequence(world, { name: 'Onboarding' })
      second = await aSequence(world, { name: 'The course' })
      await enroll(world.db, first.id, reader.id)
      await enroll(world.db, second.id, reader.id)

      await unsubscribeAll(world.db, reader.id, reader.email)
      after = await reload(world, reader)
    })

    it('suppresses the address', async () => {
      const row = await world.db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, 'reader@example.test'))
        .get()
      expect(row).toBeDefined()
    })

    it('records why it was suppressed', async () => {
      const row = await world.db.select().from(suppressions).get()
      expect(row?.reason).toBe('unsubscribed_all')
    })

    it('marks them unsubscribed', () => {
      expect(after.status).toBe('unsubscribed')
    })

    it('cancels the first enrollment', async () => {
      expect((await enrollmentOf(world, reader, first.id))?.status).toBe('cancelled')
    })

    it('cancels the second as well', async () => {
      expect((await enrollmentOf(world, reader, second.id))?.status).toBe('cancelled')
    })
  })

  describe('Scenario: a broadcast dispatched to a suppressed reader', () => {
    // SPEC 2.2 — blocked, and *observable*. A silently dropped send is the one
    // outcome that leaves nobody able to answer "what happened to that mail?".
    let world: World
    let reader: Subscriber
    let delivered: DevOutboxItem[]

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test' })
      // Suppressed but still `active`, which is the state a hard bounce leaves
      // behind before its status write lands — and the state that proves the
      // suppression check, not the status check, is what stopped this send.
      await world.db
        .insert(suppressions)
        .values({ email: reader.email, reason: 'unsubscribed_all', createdAt: new Date() })

      const broadcast = await aBroadcast(world)
      await startBroadcast(world.env, world.db, broadcast)
      delivered = await world.outbox()
    })

    it('sends them nothing', () => {
      expect(delivered).toHaveLength(0)
    })

    it('still records the intended send', async () => {
      const n = (await world.db.select({ n: count() }).from(messages).get())?.n
      expect(n).toBe(1)
    })

    it('marks it suppressed rather than queued', async () => {
      const row = await world.db.select().from(messages).get()
      expect(row?.status).toBe('suppressed')
    })

    it('says why', async () => {
      const row = await world.db.select().from(messages).get()
      expect(row?.suppressedReason).toBe('suppressed')
    })
  })

  describe('Scenario: the sequence tick after a global unsubscribe', () => {
    let world: World
    let delivered: DevOutboxItem[]

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world, { email: 'reader@example.test' })
      const series = await aSequence(world, { steps: [{ subject: 'Lesson one' }] })
      await enroll(world.db, series.id, reader.id)
      await makeDue(world, reader, series.id)
      await unsubscribeAll(world.db, reader.id, reader.email)

      await tickSequences(world.env, world.db)
      delivered = await world.outbox()
    })

    it('sends nothing', () => {
      expect(delivered).toHaveLength(0)
    })
  })

  describe('Scenario: choosing it from the preference center', () => {
    // The deployed entry point (bdd-specs rule 7).
    let world: World
    let reader: Subscriber
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test' })
      response = await world.post(`/p/${reader.unsubToken}`, {
        action: 'unsub_all',
        scope: '',
        m: '',
      })
    })

    it('redirects back to the page', () => {
      expect(response.status).toBe(303)
    })

    it('reports what happened', () => {
      expect(response.headers.get('location')).toContain('done=all')
    })

    it('suppresses the address', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(1)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: doing it twice', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world, { email: 'reader@example.test' })
      await unsubscribeAll(world.db, reader.id, reader.email)
      await unsubscribeAll(world.db, reader.id, reader.email)
    })

    it('holds one suppression, not two', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: a reader whose address differs in case from the suppression', () => {
    // Suppression is keyed by address, so normalization is the whole safety net.
    let world: World
    let delivered: DevOutboxItem[]

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world, { email: 'reader@example.test' })
      await unsubscribeAll(world.db, reader.id, 'READER@EXAMPLE.TEST')

      const broadcast = await aBroadcast(world)
      await startBroadcast(world.env, world.db, broadcast)
      delivered = await world.outbox()
    })

    it('still blocks the send', () => {
      expect(delivered).toHaveLength(0)
    })
  })
})
