// STORY-003 — Tag people, and untag them, without losing them
// SPEC 1.5
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { addTags, findOrCreateTag, removeTag } from '../../src/core/subscribers.ts'
import { activities, subscriberTags, subscribers, tags } from '../../src/db/schema.ts'
import type { Subscriber } from '../../src/db/schema.ts'
import { aPerson, aTag } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

describe('Feature: tagging the people on the list', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: putting a tag on somebody', () => {
    let world: World
    let person: Subscriber
    let added: number

    beforeAll(async () => {
      world = createWorld()
      person = await aPerson(world, { email: 'ada@example.test' })
      const tagId = await aTag(world, 'customer')
      added = await addTags(world.db, person.id, [tagId])
    })

    it('reports one tag added', () => {
      expect(added).toBe(1)
    })

    it('records the pairing', async () => {
      const n = (await world.db.select({ n: count() }).from(subscriberTags).get())?.n
      expect(n).toBe(1)
    })

    it('leaves a line in the person’s story', async () => {
      const row = await world.db
        .select()
        .from(activities)
        .where(eq(activities.type, 'tagged'))
        .get()
      expect(row?.subscriberId).toBe(person.id)
    })
  })

  describe('Scenario: adding a tag somebody already carries', () => {
    // Idempotence is load-bearing: `tag_added` sequences fire from here, so a
    // re-applied tag that counted as new would re-enroll people.
    let world: World
    let secondAdd: number

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world)
      const tagId = await aTag(world, 'customer')
      await addTags(world.db, person.id, [tagId])
      secondAdd = await addTags(world.db, person.id, [tagId])
    })

    it('reports nothing added', () => {
      expect(secondAdd).toBe(0)
    })

    it('still holds a single pairing', async () => {
      const n = (await world.db.select({ n: count() }).from(subscriberTags).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: naming the same tag twice', () => {
    let world: World
    let first: number
    let second: number

    beforeAll(async () => {
      world = createWorld()
      first = await findOrCreateTag(world.db, 'Customer')
      // Slugged, so the casing a second caller happens to use is not a new tag.
      second = await findOrCreateTag(world.db, 'customer')
    })

    it('returns the same tag', () => {
      expect(second).toBe(first)
    })

    it('creates only one', async () => {
      const n = (await world.db.select({ n: count() }).from(tags).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: taking a tag off somebody', () => {
    let world: World
    let person: Subscriber

    beforeAll(async () => {
      world = createWorld()
      person = await aPerson(world)
      const tagId = await aTag(world, 'customer')
      await addTags(world.db, person.id, [tagId])
      await removeTag(world.db, person.id, tagId)
    })

    it('removes the pairing', async () => {
      const n = (await world.db.select({ n: count() }).from(subscriberTags).get())?.n
      expect(n).toBe(0)
    })

    it('keeps the subscriber', async () => {
      const row = await world.db
        .select()
        .from(subscribers)
        .where(eq(subscribers.id, person.id))
        .get()
      expect(row).toBeDefined()
    })

    it('keeps the tag itself, for everybody else', async () => {
      const n = (await world.db.select({ n: count() }).from(tags).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: tagging somebody from their page in the console', () => {
    // The deployed entry point (bdd-specs rule 7).
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world)
      response = await world.post(`/subscribers/${person.id}/tags`, { tag: 'ruby' })
    })

    it('accepts the form', () => {
      expect(response.status).toBe(302)
    })

    it('creates and attaches the tag', async () => {
      const n = (await world.db.select({ n: count() }).from(subscriberTags).get())?.n
      expect(n).toBe(1)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: removing a tag the person never had', () => {
    let world: World
    let untagged: number

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world)
      const tagId = await aTag(world, 'customer')
      await removeTag(world.db, person.id, tagId)
      untagged =
        (await world.db
          .select({ n: count() })
          .from(activities)
          .where(eq(activities.type, 'untagged'))
          .get())?.n ?? 0
    })

    it('records nothing — a feed full of no-ops is a feed nobody reads', () => {
      expect(untagged).toBe(0)
    })
  })
})
