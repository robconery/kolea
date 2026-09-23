// Nothing reaches the list without a deliberate, informed second click.
//
// Written after a partial post went to ~6,000 people from one misplaced click
// on "Send now", which also mailed whatever was last saved rather than what
// was on screen.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { reviseSentBroadcast, startBroadcast } from '../../src/core/broadcasts.ts'
import { drainQueued } from '../../src/core/sending.ts'
import { broadcasts, devOutbox, messages } from '../../src/db/schema.ts'
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

describe('Feature: cancelling really stops a send', () => {
  describe('Scenario: mail still queued when the send is cancelled', () => {
    let w: World
    let id: number
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      // No SEND_QUEUE binding sends inline, so queue rows by hand the way a
      // cancelled mid-send leaves them: queued, broadcast cancelled.
      w = createWorld()
      await aPerson(w)
      await aPerson(w)
      id = await aBroadcast(w, { subject: 'Stopped' })
      await startBroadcast(w.env, w.db, id)
      await w.db.update(messages).set({ status: 'queued' }).where(eq(messages.broadcastId, id))
      await w.db.update(broadcasts).set({ status: 'cancelled' }).where(eq(broadcasts.id, id))
      result = await reviseSentBroadcast(w.db, id, { subject: 'Fixed', bodyJson: null, bodyMd: 'Fixed body.' })
      await drainQueued(w.env, w.db)
    })

    it('still lets the operator correct it', () => {
      expect(result.ok).toBe(true)
    })

    it('⭐ never sends the rest', async () => {
      const rows = await w.db.select().from(messages).where(eq(messages.broadcastId, id)).all()
      expect(rows.every((r) => r.status === 'failed')).toBe(true)
    })
  })
})

describe('Feature: resuming a cancelled send', () => {
  describe('Scenario: a send cancelled partway, resumed', () => {
    let w: World
    let id: number
    let res: Response
    const count = async (email: string) => (await w.outbox()).filter((m) => m.toEmail === email).length

    beforeAll(async () => {
      w = createWorld()
      await aPerson(w, { email: 'already@example.test' })
      await aPerson(w, { email: 'stranded@example.test' })
      id = await aBroadcast(w, { subject: 'Resumable' })
      await startBroadcast(w.env, w.db, id)
      // What a cancel mid-send leaves behind: one row the provider never took…
      const stranded = await w.db.select().from(messages).where(eq(messages.toEmail, 'stranded@example.test')).get()
      await w.db.update(messages).set({ status: 'failed', error: 'broadcast cancelled', providerMessageId: null }).where(eq(messages.id, stranded!.id))
      await w.db.delete(devOutbox).where(eq(devOutbox.toEmail, 'stranded@example.test'))
      await w.db.update(broadcasts).set({ status: 'cancelled' }).where(eq(broadcasts.id, id))
      // …and people past the cursor the send never reached.
      await aPerson(w, { email: 'later@example.test' })
      res = await w.post(`/broadcasts/${id}/resume`, { confirm: 'resume' })
      await w.settle()
      // The minutely cron closes a send out once nothing is left, as always.
      await w.tick()
    })

    it('⭐ does not mail anyone who already had it', async () => {
      expect(await count('already@example.test')).toBe(1)
    })

    it('mails the one the provider never took', async () => {
      expect(await count('stranded@example.test')).toBe(1)
    })

    it('mails the people it never reached', async () => {
      expect(await count('later@example.test')).toBe(1)
    })

    it('finishes as sent', async () => {
      expect(await statusOf(w, id)).toBe('sent')
    })

    it('says so', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('nobody gets it twice')
    })
  })

  describe('Scenario: resuming without the confirmation screen', () => {
    let w: World
    let id: number

    beforeAll(async () => {
      w = createWorld()
      await aPerson(w)
      id = await aBroadcast(w)
      await w.db.update(broadcasts).set({ status: 'cancelled' }).where(eq(broadcasts.id, id))
      await w.post(`/broadcasts/${id}/resume`, {})
    })

    it('⭐ sends nothing', async () => {
      expect(await w.outbox()).toHaveLength(0)
    })

    it('stays cancelled', async () => {
      expect(await statusOf(w, id)).toBe('cancelled')
    })
  })

  describe('Scenario: the resume screen', () => {
    let html: string

    beforeAll(async () => {
      const w = createWorld()
      await aPerson(w)
      const id = await aBroadcast(w, { subject: 'Half' })
      await startBroadcast(w.env, w.db, id)
      await w.db.update(broadcasts).set({ status: 'cancelled' }).where(eq(broadcasts.id, id))
      await aPerson(w)
      await aPerson(w)
      html = await (await w.fetch(`/broadcasts/${id}/resume`)).text()
    })

    it('says how many already have it', () => {
      expect(html).toContain('<strong>1</strong> already got it')
    })

    it('says how many more will get it', () => {
      expect(html).toContain('about <strong>2 more people</strong>')
    })
  })
})
