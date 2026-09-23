// Editing a broadcast that has already gone out
//
// A sent broadcast opens in the same composer a draft does: the subject as a
// headline, the editor on its sheet, the slop dial and the details down the
// right, with the send numbers heading the column. What must not change with
// the look is the contract: saving rewrites the page and the web copy, keeps
// the copy as mailed, and never sends anything.
import { beforeAll, describe, expect, it } from 'bun:test'
import { getBroadcast, startBroadcast } from '../../src/core/broadcasts.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

/** A broadcast mailed to one reader and closed by the minutely tick. */
async function aSentBroadcast(world: World): Promise<number> {
  await aPerson(world, { email: 'ada@example.test' })
  const id = await aBroadcast(world, { subject: 'Fridays, quietly', body: 'We ship on Thursdays now.' })
  await startBroadcast(world.env, world.db, id)
  await world.tick()
  return id
}

describe('Feature: editing a sent broadcast', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the writer opens a sent broadcast', () => {
    let page: string

    beforeAll(async () => {
      const world = createWorld()
      const id = await aSentBroadcast(world)
      page = await (await world.fetch(`/broadcasts/${id}`)).text()
    })

    it('opens in the composer frame', () => {
      expect(page).toContain('class="compose"')
    })

    it('has the slop dial in the side panel', () => {
      expect(page).toMatch(/<div[^>]*\sdata-slop-panel[\s=>]/)
    })

    it('leads with the send numbers', () => {
      expect(page).toContain('class="compose-stats"')
    })

    it('says who it went to', () => {
      expect(page).toContain('Sent to')
    })

    it('saves to the revise route, not the send route', () => {
      expect(page).toMatch(/action="\/broadcasts\/\d+\/revise"/)
    })

    it('does not autosave', () => {
      expect(page).not.toContain('data-autosave')
    })

    it('has no save-then-preview button (see previewing-a-sent-broadcast)', () => {
      expect(page).not.toContain('name="preview"')
    })
  })

  describe('Scenario: the writer corrects a sent broadcast', () => {
    let world: World
    let id: number
    let outboxBefore: number
    let location: string

    beforeAll(async () => {
      world = createWorld()
      id = await aSentBroadcast(world)
      outboxBefore = (await world.outbox()).length
      const res = await world.post(`/broadcasts/${id}/revise`, {
        subject: 'Fridays, quietly (fixed)',
        body_json: JSON.stringify({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'We ship on Wednesdays now.' }] }],
        }),
      })
      location = res.headers.get('location') ?? ''
    })

    it('saves the new subject', async () => {
      expect((await getBroadcast(world.db, id))?.subject).toBe('Fridays, quietly (fixed)')
    })

    it('keeps the subject as mailed', async () => {
      expect((await getBroadcast(world.db, id))?.originalSubject).toBe('Fridays, quietly')
    })

    it('says nothing was sent', () => {
      expect(decodeURIComponent(location)).toContain('Nothing was sent')
    })

    it('⭐ sends nothing', async () => {
      expect((await world.outbox()).length).toBe(outboxBefore)
    })
  })

  describe('Scenario: the writer looks at the copy as it was mailed', () => {
    let page: string

    beforeAll(async () => {
      const world = createWorld()
      const id = await aSentBroadcast(world)
      await world.post(`/broadcasts/${id}/revise`, { subject: 'Changed later', body: 'Changed body.' })
      page = await (await world.fetch(`/broadcasts/${id}?as=mailed`)).text()
    })

    it('shows the subject as mailed', () => {
      expect(page).toContain('Fridays, quietly')
    })

    it('shows the mailed body read-only', () => {
      expect(page).toMatch(/<div[^>]*\sdata-reader[\s=>]/)
    })

    it('has no editor to type in', () => {
      // The attribute on an element, not the selector text in the page's CSS.
      expect(page).not.toMatch(/<div[^>]*\sdata-editor[\s=>]/)
    })

    it('has no save button', () => {
      expect(page).not.toContain('Save changes')
    })

    it('still has the slop dial in the side panel', () => {
      expect(page).toMatch(/<div[^>]*\sdata-slop-panel[\s=>]/)
    })
  })
})
