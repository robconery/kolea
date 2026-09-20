// STORY-001 — One address, one person
// SPEC 1.1, 1.4
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { upsertSubscriber, type UpsertOutcome } from '../../src/core/subscribers.ts'
import { subscribers } from '../../src/db/schema.ts'
import { createWorld, type World } from '../support/world.ts'

describe('Feature: an address means exactly one person', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: adding an address with stray case and whitespace', () => {
    let world: World
    let stored: typeof subscribers.$inferSelect | undefined

    beforeAll(async () => {
      world = createWorld()
      await upsertSubscriber(world.db, { email: '  Ada@Example.COM  ', name: 'Ada Lovelace' })
      stored = await world.db.select().from(subscribers).get()
    })

    it('stores the address lowercased and trimmed', () => {
      expect(stored?.email).toBe('ada@example.com')
    })

    it('keeps the name as given', () => {
      expect(stored?.name).toBe('Ada Lovelace')
    })

    it('makes them active', () => {
      expect(stored?.status).toBe('active')
    })

    it('mints an unsubscribe token', () => {
      expect(stored?.unsubToken).toBeTruthy()
    })
  })

  describe('Scenario: adding the same address again in a different case', () => {
    let world: World
    let secondOutcome: UpsertOutcome
    let people: number

    beforeAll(async () => {
      world = createWorld()
      await upsertSubscriber(world.db, { email: 'ada@example.com' })
      secondOutcome = (await upsertSubscriber(world.db, {
        email: 'ADA@EXAMPLE.COM',
        name: 'Ada Lovelace',
      })).outcome
      people = (await world.db.select({ n: count() }).from(subscribers).get())?.n ?? 0
    })

    it('reports the second add as an update', () => {
      expect(secondOutcome).toBe('updated')
    })

    it('leaves exactly one subscriber on the list', () => {
      expect(people).toBe(1)
    })

    it('applies the name from the second add', async () => {
      const row = await world.db.select().from(subscribers).get()
      expect(row?.name).toBe('Ada Lovelace')
    })
  })

  describe('Scenario: recording somebody who has not asked for mail', () => {
    let world: World
    let stored: typeof subscribers.$inferSelect | undefined

    beforeAll(async () => {
      world = createWorld()
      // A buyer, a receipt recipient: on file, not on the list. `pending` is
      // invisible to broadcasts and reachable by transactional mail.
      await upsertSubscriber(world.db, { email: 'buyer@example.test', status: 'pending' })
      stored = await world.db.select().from(subscribers).get()
    })

    it('stores them as pending', () => {
      expect(stored?.status).toBe('pending')
    })
  })

  describe('Scenario: a buyer later joins the list properly', () => {
    let world: World
    let outcome: UpsertOutcome
    let status: string | undefined

    beforeAll(async () => {
      world = createWorld()
      await upsertSubscriber(world.db, { email: 'buyer@example.test', status: 'pending' })
      outcome = (await upsertSubscriber(world.db, {
        email: 'buyer@example.test',
        status: 'active',
      })).outcome
      status = (await world.db.select().from(subscribers).get())?.status
    })

    it('reports the promotion distinctly from an ordinary update', () => {
      expect(outcome).toBe('promoted')
    })

    it('makes them active', () => {
      expect(status).toBe('active')
    })
  })

  describe('Scenario: signing up through the public endpoint', () => {
    // The deployed entry point (bdd-specs rule 7): `POST /subscribe` is one of
    // the four public routes in SPEC 8.2, and it is what a website form posts to.
    let world: World
    let response: Response
    let stored: typeof subscribers.$inferSelect | undefined

    beforeAll(async () => {
      world = createWorld()
      response = await world.post('/subscribe', {
        email: 'Grace@Example.com',
        name: 'Grace Hopper',
      })
      stored = await world.db.select().from(subscribers).get()
    })

    it('accepts the signup', () => {
      expect(response.status).toBe(200)
    })

    it('creates the subscriber', () => {
      expect(stored?.email).toBe('grace@example.com')
    })

    it('records where they came from', () => {
      expect(stored?.source).toBe('signup')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: rejecting an address that is not one', () => {
    let world: World
    let outcome: UpsertOutcome
    let people: number

    beforeAll(async () => {
      world = createWorld()
      outcome = (await upsertSubscriber(world.db, { email: 'not-an-address' })).outcome
      people = (await world.db.select({ n: count() }).from(subscribers).get())?.n ?? 0
    })

    it('reports it as invalid', () => {
      expect(outcome).toBe('invalid')
    })

    it('writes nobody to the list', () => {
      expect(people).toBe(0)
    })
  })

  describe('Scenario: rejecting a signup with a malformed address', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      response = await world.post('/subscribe', { email: 'nope' })
    })

    it('answers 400', () => {
      expect(response.status).toBe(400)
    })
  })

  describe('Scenario: an unsubscribed person is never walked back to active', () => {
    // SPEC 1.2 / invariant 3. `unsubscribed` only ever moves one way, and only
    // the person themselves can move it — never an import, a sync or a re-add.
    let world: World
    let status: string | undefined

    beforeAll(async () => {
      world = createWorld()
      const { id } = await upsertSubscriber(world.db, { email: 'gone@example.test' })
      await world.db
        .update(subscribers)
        .set({ status: 'unsubscribed' })
        .where(eq(subscribers.id, id!))

      await upsertSubscriber(world.db, { email: 'gone@example.test', status: 'active' })
      status = (await world.db.select().from(subscribers).get())?.status
    })

    it('leaves them unsubscribed', () => {
      expect(status).toBe('unsubscribed')
    })
  })
})
