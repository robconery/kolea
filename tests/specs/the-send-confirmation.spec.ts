// Nothing reaches the list without a deliberate, informed second click.
//
// Written after a partial post went to ~6,000 people from one misplaced click
// on "Send now", which also mailed whatever was last saved rather than what
// was on screen.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { reviseSentBroadcast, startBroadcast } from '../../src/core/broadcasts.ts'
import { broadcasts } from '../../src/db/schema.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

async function statusOf(w: World, id: number) {
  return (await w.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get())?.status
}

describe('Feature: confirming a send', () => {
  describe('Scenario: pressing Send in the composer', () => {
    let w: World
    let id: number
    let res: Response

    beforeAll(async () => {
      w = createWorld()
      await aPerson(w)
      id = await aBroadcast(w, { subject: 'Old subject' })
      res = await w.post(`/broadcasts/${id}/edit`, { subject: 'On screen now', body: 'The words on screen.', send: '1' })
    })

    it('saves what is on screen first', async () => {
      expect((await w.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get())?.subject).toBe('On screen now')
    })

    it('goes to the confirmation screen', () => {
      expect(res.headers.get('location')).toBe(`/broadcasts/${id}/send`)
    })

    it('⭐ sends nothing', async () => {
      expect(await w.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: the confirmation screen', () => {
    let html: string

    beforeAll(async () => {
      const w = createWorld()
      await aPerson(w)
      await aPerson(w)
      const id = await aBroadcast(w, { subject: 'Big news', body: 'Too short.' })
      html = await (await w.fetch(`/broadcasts/${id}/send`)).text()
    })

    it('says who it goes to and how many', () => {
      expect(html).toContain('to <strong>2 people</strong>')
    })

    it('names the broadcast', () => {
      expect(html).toContain('Big news')
    })

    it('warns when it looks unfinished', () => {
      expect(html).toContain('Is it finished?')
    })

    it('labels the button with the count', () => {
      expect(html).toContain('Send to 2 people')
    })
  })

  describe('Scenario: confirming', () => {
    let w: World
    let id: number

    beforeAll(async () => {
      w = createWorld()
      await aPerson(w)
      id = await aBroadcast(w)
      await w.post(`/broadcasts/${id}/send`, { confirm: 'send', expected: '1' })
    })

    it('sends it', async () => {
      expect(await w.outbox()).toHaveLength(1)
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: a send that skipped the confirmation screen', () => {
    let w: World
    let id: number
    let res: Response

    beforeAll(async () => {
      w = createWorld()
      await aPerson(w)
      id = await aBroadcast(w)
      res = await w.post(`/broadcasts/${id}/send`, {})
    })

    it('⭐ sends nothing', async () => {
      expect(await w.outbox()).toHaveLength(0)
    })

    it('leaves it a draft', async () => {
      expect(await statusOf(w, id)).toBe('draft')
    })

    it('goes to the confirmation screen instead', () => {
      expect(res.headers.get('location')).toBe(`/broadcasts/${id}/send`)
    })
  })

  describe('Scenario: the audience changed after the screen was shown', () => {
    let w: World
    let id: number

    beforeAll(async () => {
      w = createWorld()
      await aPerson(w)
      id = await aBroadcast(w)
      // The screen said 1; someone joined before the click.
      await aPerson(w)
      await w.post(`/broadcasts/${id}/send`, { confirm: 'send', expected: '1' })
    })

    it('⭐ sends nothing', async () => {
      expect(await w.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: a broadcast with no subject', () => {
    let html: string

    beforeAll(async () => {
      const w = createWorld()
      await aPerson(w)
      const id = await aBroadcast(w, { subject: ' ' })
      html = await (await w.fetch(`/broadcasts/${id}/send`)).text()
    })

    it('offers no send button', () => {
      expect(html).not.toContain('Send to 1 person')
    })
  })
})

describe('Feature: correcting a cancelled send', () => {
  describe('Scenario: the send was cancelled partway', () => {
    let w: World
    let id: number
    let result: { ok: boolean; reason?: string }
    let page: string

    beforeAll(async () => {
      w = createWorld()
      await aPerson(w)
      id = await aBroadcast(w, { subject: 'Half finished' })
      await startBroadcast(w.env, w.db, id)
      await w.db.update(broadcasts).set({ status: 'cancelled' }).where(eq(broadcasts.id, id))
      page = await (await w.fetch(`/broadcasts/${id}`)).text()
      result = await reviseSentBroadcast(w.db, id, { subject: 'Finished', bodyJson: null, bodyMd: 'The whole thing.' })
    })

    it('offers Save changes', () => {
      expect(page).toContain('Save changes')
    })

    it('saves the correction', () => {
      expect(result.ok).toBe(true)
    })

    it('⭐ mails nobody again', async () => {
      expect(await w.outbox()).toHaveLength(1)
    })
  })
})
