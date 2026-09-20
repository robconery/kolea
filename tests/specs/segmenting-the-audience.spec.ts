// STORY-004 — Send to a slice of the list, not all of it
// SPEC 1.6
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { countSegment, describeRule, resolveSegment } from '../../src/core/segments.ts'
import { subscribers } from '../../src/db/schema.ts'
import { aPerson, tag } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

/** Three people: one customer, one reader, one who left the newsletter. */
async function anAudience(world: World) {
  const customer = await aPerson(world, { email: 'customer@example.test' })
  await tag(world, customer, 'customer')
  const reader = await aPerson(world, { email: 'reader@example.test' })
  const departed = await aPerson(world, { email: 'departed@example.test' })
  await world.db
    .update(subscribers)
    .set({ status: 'unsubscribed' })
    .where(eq(subscribers.id, departed.id))
  return { customer, reader, departed }
}

describe('Feature: resolving who a mailing is for', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the empty rule, over a mixed list', () => {
    let world: World
    let resolved: { id: number; email: string }[]
    let counted: number

    beforeAll(async () => {
      world = createWorld()
      await anAudience(world)
      resolved = await resolveSegment(world.db, {})
      counted = await countSegment(world.db, {})
    })

    it('returns everybody active', () => {
      expect(resolved).toHaveLength(2)
    })

    it('leaves out the person who unsubscribed', () => {
      expect(resolved.map((r) => r.email)).not.toContain('departed@example.test')
    })

    it('counts the same number it would send to', () => {
      // One WHERE builder, two callers — the shown count cannot drift from the
      // actual audience (`core/segments.ts`).
      expect(counted).toBe(resolved.length)
    })

    it('describes itself in English', () => {
      expect(describeRule({}, [])).toBe('Everyone active')
    })
  })

  describe('Scenario: including a tag', () => {
    let world: World
    let resolved: { email: string }[]

    beforeAll(async () => {
      world = createWorld()
      const { customer } = await anAudience(world)
      const tagId = (await tag(world, customer, 'customer'))
      resolved = await resolveSegment(world.db, { includeTagIds: [tagId] })
    })

    it('returns only the tagged person', () => {
      expect(resolved).toHaveLength(1)
    })

    it('and it is the right one', () => {
      expect(resolved[0]?.email).toBe('customer@example.test')
    })
  })

  describe('Scenario: excluding a tag', () => {
    let world: World
    let resolved: { email: string }[]

    beforeAll(async () => {
      world = createWorld()
      const { customer } = await anAudience(world)
      const tagId = await tag(world, customer, 'customer')
      resolved = await resolveSegment(world.db, { excludeTagIds: [tagId] })
    })

    it('leaves the tagged person out', () => {
      expect(resolved.map((r) => r.email)).not.toContain('customer@example.test')
    })

    it('keeps everybody else who is active', () => {
      expect(resolved).toHaveLength(1)
    })
  })

  describe('Scenario: requiring every tag rather than any', () => {
    let world: World
    let any: unknown[]
    let all: unknown[]

    beforeAll(async () => {
      world = createWorld()
      const both = await aPerson(world, { email: 'both@example.test' })
      const one = await aPerson(world, { email: 'one@example.test' })
      const ruby = await tag(world, both, 'ruby')
      const customer = await tag(world, both, 'customer')
      await tag(world, one, 'ruby')

      any = await resolveSegment(world.db, { includeTagIds: [ruby, customer], match: 'any' })
      all = await resolveSegment(world.db, { includeTagIds: [ruby, customer], match: 'all' })
    })

    it('match=any returns anybody carrying either tag', () => {
      expect(any).toHaveLength(2)
    })

    it('match=all returns only the person carrying both', () => {
      expect(all).toHaveLength(1)
    })
  })

  describe('Scenario: paging a big audience with a cursor', () => {
    // How a broadcast materializes recipients without blowing D1's query cap.
    let world: World
    let firstPage: { id: number }[]
    let secondPage: { id: number }[]

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'a@example.test' })
      await aPerson(world, { email: 'b@example.test' })
      await aPerson(world, { email: 'c@example.test' })

      firstPage = await resolveSegment(world.db, {}, 0, 2)
      secondPage = await resolveSegment(world.db, {}, firstPage[firstPage.length - 1]!.id, 2)
    })

    it('fills the first page to the limit', () => {
      expect(firstPage).toHaveLength(2)
    })

    it('returns the remainder on the second', () => {
      expect(secondPage).toHaveLength(1)
    })

    it('never repeats a person across pages', () => {
      expect(secondPage[0]!.id).toBeGreaterThan(firstPage[1]!.id)
    })
  })

  describe('Scenario: describing a rule for the audience label', () => {
    let world: World
    let description: string

    beforeAll(async () => {
      world = createWorld()
      description = describeRule({ includeTagIds: [1], excludeTagIds: [2] }, [
        { id: 1, name: 'customer' },
        { id: 2, name: 'churned' },
      ])
    })

    it('names both halves of the rule in plain English', () => {
      expect(description).toBe('Active, tagged customer, not tagged churned')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a rule naming a tag nobody carries', () => {
    let world: World
    let resolved: unknown[]

    beforeAll(async () => {
      world = createWorld()
      await anAudience(world)
      resolved = await resolveSegment(world.db, { includeTagIds: [9999] })
    })

    it('resolves to nobody rather than to everybody', () => {
      expect(resolved).toHaveLength(0)
    })
  })

  describe('Scenario: a list where nobody is active', () => {
    let world: World
    let counted: number

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world)
      await world.db
        .update(subscribers)
        .set({ status: 'bounced' })
        .where(eq(subscribers.id, person.id))
      counted = await countSegment(world.db, {})
    })

    it('counts nobody', () => {
      expect(counted).toBe(0)
    })
  })
})
