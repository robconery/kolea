// Publishing when it sends — the box decides, and only the box
//
// A broadcast is a post unless the writer says otherwise, and the share buttons
// in the mail exist only when there is a post to share. The New broadcast page
// has no "publish" box, and after its first autosave it saves to the same place
// the full composer does — so a form with no box on it was read as a box left
// unchecked. Anything written in one sitting went out unpublished, with no
// share buttons, and nobody had asked for that.
import { beforeAll, describe, expect, it } from 'bun:test'
import { getBroadcast } from '../../src/core/broadcasts.ts'
import { aBroadcast } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const WRITING = { subject: 'Fridays, quietly', body: 'We ship on Thursdays now.' }

async function aDraft(world: World): Promise<number> {
  return await aBroadcast(world, WRITING)
}

describe('Feature: publishing when it sends', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a new draft', () => {
    let publishOnSend: boolean | undefined

    beforeAll(async () => {
      const world = createWorld({ SITE_URL: 'https://site.example.test' })
      const id = await aDraft(world)
      publishOnSend = (await getBroadcast(world.db, id))?.publishOnSend
    })

    it('will be published when it sends', () => {
      expect(publishOnSend).toBe(true)
    })
  })

  describe('Scenario: saving from a page that has no publish box', () => {
    // The New broadcast page, after its first autosave.
    let publishOnSend: boolean | undefined

    beforeAll(async () => {
      const world = createWorld({ SITE_URL: 'https://site.example.test' })
      const id = await aDraft(world)
      await world.post(`/broadcasts/${id}/edit`, WRITING)
      publishOnSend = (await getBroadcast(world.db, id))?.publishOnSend
    })

    it('leaves publishing on  ⭐', () => {
      expect(publishOnSend).toBe(true)
    })
  })

  describe('Scenario: saving with the box checked', () => {
    let publishOnSend: boolean | undefined

    beforeAll(async () => {
      const world = createWorld({ SITE_URL: 'https://site.example.test' })
      const id = await aDraft(world)
      await world.post(`/broadcasts/${id}/edit`, {
        ...WRITING,
        publish_on_send_shown: '1',
        publish_on_send: 'on',
      })
      publishOnSend = (await getBroadcast(world.db, id))?.publishOnSend
    })

    it('keeps publishing on', () => {
      expect(publishOnSend).toBe(true)
    })
  })

  describe('Scenario: the composer page', () => {
    let page: string

    beforeAll(async () => {
      const world = createWorld({ SITE_URL: 'https://site.example.test' })
      const id = await aDraft(world)
      page = await (await world.fetch(`/broadcasts/${id}`)).text()
    })

    it('says the box is on the page, so an unchecked one can be told apart', () => {
      expect(page).toContain('name="publish_on_send_shown"')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: saving with the box unchecked', () => {
    // A sales push, a note to one segment: the writer chose not to publish.
    let publishOnSend: boolean | undefined

    beforeAll(async () => {
      const world = createWorld({ SITE_URL: 'https://site.example.test' })
      const id = await aDraft(world)
      await world.post(`/broadcasts/${id}/edit`, { ...WRITING, publish_on_send_shown: '1' })
      publishOnSend = (await getBroadcast(world.db, id))?.publishOnSend
    })

    it('turns publishing off', () => {
      expect(publishOnSend).toBe(false)
    })
  })
})
