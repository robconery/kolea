// STORY-002 — Import a list without undoing anybody's choice
// SPEC 1.2, 1.3
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { type ImportReport, importCsv, upsertSubscriber } from '../../src/core/subscribers.ts'
import { subscriberTags, subscribers, tags } from '../../src/db/schema.ts'
import { createWorld, type World } from '../support/world.ts'

const header = 'email,name,tags'

describe('Feature: importing a list of people', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: importing two people nobody has seen before', () => {
    let world: World
    let report: ImportReport

    beforeAll(async () => {
      world = createWorld()
      report = await importCsv(
        world.db,
        [header, 'ada@example.test,Ada Lovelace,', 'grace@example.test,Grace Hopper,'].join('\n'),
      )
    })

    it('creates both of them', () => {
      expect(report.created).toBe(2)
    })

    it('updates nobody', () => {
      expect(report.updated).toBe(0)
    })

    it('rejects nothing', () => {
      expect(report.invalid).toBe(0)
    })

    it('counts the rows it read', () => {
      expect(report.rows).toBe(2)
    })

    it('puts both on the list', async () => {
      const n = (await world.db.select({ n: count() }).from(subscribers).get())?.n
      expect(n).toBe(2)
    })
  })

  describe('Scenario: importing somebody who is already on the list', () => {
    let world: World
    let report: ImportReport
    let people: number
    let name: string | null | undefined

    beforeAll(async () => {
      world = createWorld()
      await upsertSubscriber(world.db, { email: 'ada@example.test' })
      report = await importCsv(world.db, [header, 'Ada@example.test,Ada Lovelace,'].join('\n'))
      people = (await world.db.select({ n: count() }).from(subscribers).get())?.n ?? 0
      name = (await world.db.select().from(subscribers).get())?.name
    })

    it('reports an update', () => {
      expect(report.updated).toBe(1)
    })

    it('creates nobody', () => {
      expect(report.created).toBe(0)
    })

    it('does not duplicate the address', () => {
      expect(people).toBe(1)
    })

    it('applies the name from the file', () => {
      expect(name).toBe('Ada Lovelace')
    })
  })

  describe('Scenario: importing rows that carry tags', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      await importCsv(world.db, [header, 'ada@example.test,Ada,ruby;customer'].join('\n'))
    })

    it('creates both named tags', async () => {
      const n = (await world.db.select({ n: count() }).from(tags).get())?.n
      expect(n).toBe(2)
    })

    it('attaches them to the imported person', async () => {
      const n = (await world.db.select({ n: count() }).from(subscriberTags).get())?.n
      expect(n).toBe(2)
    })
  })

  describe('Scenario: importing through the console', () => {
    // The deployed entry point (bdd-specs rule 7). The import screen posts a
    // textarea of CSV; everything below it is the same `core/` call.
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      response = await world.post('/subscribers/import', {
        csv: [header, 'ada@example.test,Ada,'].join('\n'),
      })
    })

    it('sends the operator back to the list', () => {
      expect(response.status).toBe(302)
    })

    it('reports the import in the flash message', () => {
      expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('1 created')
    })

    it('imports the person', async () => {
      const n = (await world.db.select({ n: count() }).from(subscribers).get())?.n
      expect(n).toBe(1)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: an import that contains somebody who unsubscribed', () => {
    // ⭐ Invariant 3. This is the single most damaging thing an import can do,
    // and the reason `importCsv` may never be "optimized" into a bulk upsert.
    let world: World
    let status: string | undefined

    beforeAll(async () => {
      world = createWorld()
      const { id } = await upsertSubscriber(world.db, { email: 'gone@example.test' })
      await world.db
        .update(subscribers)
        .set({ status: 'unsubscribed' })
        .where(eq(subscribers.id, id!))

      await importCsv(world.db, [header, 'gone@example.test,Somebody Who Left,'].join('\n'))
      status = (await world.db.select().from(subscribers).get())?.status
    })

    it('leaves them unsubscribed', () => {
      expect(status).toBe('unsubscribed')
    })
  })

  describe('Scenario: a malformed row in the middle of the file', () => {
    let world: World
    let report: ImportReport

    beforeAll(async () => {
      world = createWorld()
      report = await importCsv(
        world.db,
        [header, 'ada@example.test,Ada,', ',No Address Here,', 'grace@example.test,Grace,'].join(
          '\n',
        ),
      )
    })

    it('counts the bad row as invalid', () => {
      expect(report.invalid).toBe(1)
    })

    it('does not abort — the rows after it still import', () => {
      expect(report.created).toBe(2)
    })

    it('counts every row it looked at', () => {
      expect(report.rows).toBe(3)
    })
  })

  describe('Scenario: a row whose address is not an address', () => {
    let world: World
    let report: ImportReport

    beforeAll(async () => {
      world = createWorld()
      report = await importCsv(world.db, [header, 'nope,Nobody,'].join('\n'))
    })

    it('counts it as invalid', () => {
      expect(report.invalid).toBe(1)
    })

    it('creates nobody', () => {
      expect(report.created).toBe(0)
    })
  })

  describe('Scenario: a file with no email column', () => {
    let world: World
    let report: ImportReport

    beforeAll(async () => {
      world = createWorld()
      report = await importCsv(world.db, ['name,tags', 'Ada,ruby'].join('\n'))
    })

    it('imports nothing rather than guessing which column is the address', () => {
      expect(report.created).toBe(0)
    })

    it('reads no rows at all', () => {
      expect(report.rows).toBe(0)
    })
  })

  describe('Scenario: an empty file', () => {
    let world: World
    let report: ImportReport

    beforeAll(async () => {
      world = createWorld()
      report = await importCsv(world.db, '')
    })

    it('reports an empty import rather than failing', () => {
      expect(report.rows).toBe(0)
    })
  })
})
