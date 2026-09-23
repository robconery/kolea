// Previewing a broadcast that has already gone out
//
// The writer changes the email template and wants to see a real broadcast in a
// real inbox. A sent broadcast can therefore still be mailed to its author: one
// copy, to PREVIEW_EMAIL and nowhere else, rendered from the saved version with
// today's template. What must not happen is any change to the broadcast's
// numbers. A preview is not a recipient, and an imported (Kit-era) broadcast,
// whose totals only show while it has no message rows at all, must keep them.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { broadcastStats, startBroadcast } from '../../src/core/broadcasts.ts'
import { broadcasts, messages } from '../../src/db/schema.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const OPERATOR = 'rob@example.test'

/** Mailed to one reader and closed by the tick. The operator joins afterwards, so they weren't a recipient. */
async function aSentBroadcast(world: World): Promise<number> {
  await aPerson(world, { email: 'ada@example.test' })
  const id = await aBroadcast(world, { subject: 'Fridays, quietly', body: 'We ship on Thursdays now.' })
  await startBroadcast(world.env, world.db, id)
  await world.tick()
  await aPerson(world, { email: OPERATOR })
  return id
}

async function preview(world: World, id: number): Promise<string> {
  const res = await world.post(`/broadcasts/${id}/preview`, {})
  await world.settle()
  return decodeURIComponent(res.headers.get('location') ?? '')
}

const previewsTo = async (world: World) => (await world.outbox()).filter((m) => m.toEmail === OPERATOR)

describe('Feature: previewing a sent broadcast', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the writer opens a sent broadcast', () => {
    let page: string

    beforeAll(async () => {
      const world = createWorld()
      const id = await aSentBroadcast(world)
      page = await (await world.fetch(`/broadcasts/${id}`)).text()
    })

    it('offers a preview send', () => {
      expect(page).toMatch(/formaction="\/broadcasts\/\d+\/preview"/)
    })

    it('says where the preview goes', () => {
      expect(page).toContain(`One copy to ${OPERATOR}`)
    })

    it('⭐ does not save the editor on the way', () => {
      // `name="preview"` is the draft composer's save-then-preview button.
      expect(page).not.toContain('name="preview"')
    })
  })

  describe('Scenario: the writer sends themselves a preview of a sent broadcast', () => {
    let world: World
    let id: number
    let location: string
    let before: Awaited<ReturnType<typeof broadcastStats>>

    beforeAll(async () => {
      world = createWorld()
      id = await aSentBroadcast(world)
      before = await broadcastStats(world.db, id)
      location = await preview(world, id)
    })

    it('says the preview was sent', () => {
      expect(location).toContain(`Preview sent to ${OPERATOR}`)
    })

    it('mails exactly one copy to the operator', async () => {
      expect((await previewsTo(world)).length).toBe(1)
    })

    it('marks the subject as a preview', async () => {
      expect((await world.mailTo(OPERATOR)).subject).toBe('[preview] Fridays, quietly')
    })

    it('renders the broadcast body', async () => {
      expect((await world.mailTo(OPERATOR)).html).toContain('We ship on Thursdays now.')
    })

    it('mails nobody else', async () => {
      expect((await world.outbox()).filter((m) => m.toEmail === 'ada@example.test').length).toBe(1)
    })

    it('⭐ leaves the recipient count alone', async () => {
      expect((await broadcastStats(world.db, id)).recipients).toBe(before.recipients)
    })

    it('records the preview against the broadcast it copies, not as one of its messages', async () => {
      const row = await world.db.select().from(messages).where(eq(messages.previewBroadcastId, id)).get()
      expect(row?.broadcastId ?? null).toBeNull()
    })
  })

  describe('Scenario: the writer previews after correcting a sent broadcast', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const id = await aSentBroadcast(world)
      await world.post(`/broadcasts/${id}/revise`, { subject: 'Fridays, quietly', body: 'We ship on Wednesdays now.' })
      await preview(world, id)
    })

    it('mails the saved version', async () => {
      expect((await world.mailTo(OPERATOR)).html).toContain('We ship on Wednesdays now.')
    })
  })

  describe('Scenario: the writer previews a broadcast imported from Kit', () => {
    let world: World
    let id: number

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: OPERATOR })
      id = await aBroadcast(world, { subject: 'From the archive', body: 'An old favourite.' })
      await world.db
        .update(broadcasts)
        .set({ status: 'sent', sentAt: new Date(), importedRecipients: 13_000, importedOpened: 5_200 })
        .where(eq(broadcasts.id, id))
      await preview(world, id)
    })

    it('mails the preview', async () => {
      expect((await previewsTo(world)).length).toBe(1)
    })

    it('⭐ keeps the imported totals', async () => {
      expect((await broadcastStats(world.db, id)).recipients).toBe(13_000)
    })

    it('still reports them as imported', async () => {
      expect((await broadcastStats(world.db, id)).source).toBe('imported')
    })
  })

  describe('Scenario: the writer previews a cancelled broadcast', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const id = await aSentBroadcast(world)
      await world.db.update(broadcasts).set({ status: 'cancelled' }).where(eq(broadcasts.id, id))
      await preview(world, id)
    })

    it('still mails the preview', async () => {
      expect((await previewsTo(world)).length).toBe(1)
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: the preview route is used on a draft', () => {
    let world: World
    let location: string

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: OPERATOR })
      const id = await aBroadcast(world, { subject: 'Not yet' })
      location = await preview(world, id)
    })

    it('sends nothing', async () => {
      expect((await world.outbox()).length).toBe(0)
    })

    it('points at the composer’s own preview', () => {
      expect(location).toContain('Use "Send a preview" in the composer')
    })
  })

  describe('Scenario: the operator is not on the list', () => {
    let world: World
    let location: string

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'ada@example.test' })
      const id = await aBroadcast(world, { subject: 'Fridays, quietly' })
      await startBroadcast(world.env, world.db, id)
      await world.tick()
      location = await preview(world, id)
    })

    it('sends no preview', async () => {
      expect((await previewsTo(world)).length).toBe(0)
    })

    it('says why', () => {
      expect(location).toContain('is not a subscriber')
    })
  })

  describe('Scenario: the broadcast does not exist', () => {
    let status: number

    beforeAll(async () => {
      const world = createWorld()
      status = (await world.post('/broadcasts/9999/preview', {})).status
    })

    it('is not found', () => {
      expect(status).toBe(404)
    })
  })
})
