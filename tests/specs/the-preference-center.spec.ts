// STORY-009 — A preference center that works from an email link
// SPEC 2a.1–2a.6, 9.3
//
// Every scenario here drives the real public route. That is the point: this
// page is reached by strangers, from a link in mail sent months ago, with no
// session, no account and — on a locked-down mail client — no JavaScript. It
// has to work from the URL alone, and it has to keep working when the URL is
// stale, hand-edited, or somebody else's.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count } from 'drizzle-orm'
import { leaveSequence } from '../../src/core/consent.ts'
import { enroll } from '../../src/core/sequences.ts'
import type { Subscriber } from '../../src/db/schema.ts'
import { sequenceOptouts, suppressions } from '../../src/db/schema.ts'
import { aPerson, aSequence, enrollmentOf, reload } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

describe('Feature: a reader manages their own preferences', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: opening the page from a sequence email', () => {
    let world: World
    let reader: Subscriber
    let series: { id: number }
    let page: string
    let status: number

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test', name: 'A Reader' })
      series = await aSequence(world, { name: 'The Ruby course' })
      await aSequence(world, { name: 'The newsletter pitch' })
      await enroll(world.db, series.id, reader.id)

      const response = await world.fetch(
        `/p/${reader.unsubToken}?scope=sequence:${series.id}&m=1`,
      )
      status = response.status
      page = await response.text()
    })

    it('opens on the token alone', () => {
      expect(status).toBe(200)
    })

    it('tells the reader whose preferences these are', () => {
      expect(page).toContain('reader@example.test')
    })

    it('names the series they are in', () => {
      expect(page).toContain('The Ruby course')
    })

    it('marks the series they arrived from', () => {
      expect(page).toContain('You came here from this one')
    })

    it('offers the narrow action as the prominent one  ⭐', () => {
      expect(page).toContain('Stop just this series')
    })

    it('says plainly that leaving one thing leaves the rest alone', () => {
      // The apostrophe arrives HTML-escaped, which is the renderer doing its job.
      expect(page).toContain('Leaving one series doesn&#39;t remove you from')
    })

    it('offers the newsletter as its own separate choice', () => {
      expect(page).toContain('The newsletter')
    })

    it('keeps "unsubscribe from everything" available but apart', () => {
      expect(page).toContain('Unsubscribe from everything')
    })

    it('needs no JavaScript to do any of it', () => {
      expect(page).not.toContain('<script')
    })

    it('does not list a series the reader has nothing to do with', () => {
      expect(page).not.toContain('The newsletter pitch')
    })
  })

  describe('Scenario: leaving one series from the page', () => {
    let world: World
    let reader: Subscriber
    let series: { id: number }
    let response: Response
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world)
      series = await aSequence(world, { name: 'The Ruby course' })
      await enroll(world.db, series.id, reader.id)

      response = await world.post(`/p/${reader.unsubToken}`, {
        action: `leave:${series.id}`,
        scope: `sequence:${series.id}`,
        m: '',
      })
      after = await reload(world, reader)
    })

    it('redirects rather than rendering the POST', () => {
      expect(response.status).toBe(303)
    })

    it('carries the outcome back to the page', () => {
      expect(response.headers.get('location')).toContain('done=left')
    })

    it('keeps the scope, so the page still knows where they came from', () => {
      expect(response.headers.get('location')).toContain(`scope=sequence%3A${series.id}`)
    })

    it('cancels that enrollment', async () => {
      expect((await enrollmentOf(world, reader, series.id))?.status).toBe('cancelled')
    })

    it('leaves the reader on the newsletter', () => {
      expect(after.status).toBe('active')
    })

    it('confirms it in words the reader can check', async () => {
      const page = await (await world.fetch(`/p/${reader.unsubToken}?done=left`)).text()
      expect(page).toContain('Everything else is untouched')
    })
  })

  describe('Scenario: rejoining a series they had left', () => {
    let world: World
    let reader: Subscriber
    let series: { id: number }

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world)
      series = await aSequence(world, { name: 'The Ruby course' })
      await enroll(world.db, series.id, reader.id)
      await leaveSequence(world.db, reader.id, series.id)

      await world.post(`/p/${reader.unsubToken}`, {
        action: `rejoin:${series.id}`,
        scope: '',
        m: '',
      })
    })

    it('removes the opt-out', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceOptouts).get())?.n
      expect(n).toBe(0)
    })

    it('offers the series back on the page', async () => {
      const page = await (await world.fetch(`/p/${reader.unsubToken}`)).text()
      expect(page).toContain('Stop this')
    })
  })

  describe('Scenario: turning the newsletter off and on again', () => {
    let world: World
    let reader: Subscriber
    let afterOff: Subscriber
    let afterOn: Subscriber

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world)

      await world.post(`/p/${reader.unsubToken}`, {
        action: 'unsub_broadcast',
        scope: 'broadcast',
        m: '',
      })
      afterOff = await reload(world, reader)

      await world.post(`/p/${reader.unsubToken}`, { action: 'resub_broadcast', scope: '', m: '' })
      afterOn = await reload(world, reader)
    })

    it('turns it off', () => {
      expect(afterOff.status).toBe('unsubscribed')
    })

    it('turns it back on', () => {
      expect(afterOn.status).toBe('active')
    })

    it('never writes a suppression on the way through', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(0)
    })
  })

  describe('Scenario: a mail client’s own one-click button, on a sequence email', () => {
    // RFC 8058. The client POSTs the List-Unsubscribe-Post URL without asking,
    // so the scope baked into that URL is the entire decision the reader made.
    let world: World
    let reader: Subscriber
    let series: { id: number }
    let other: { id: number }
    let response: Response
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world)
      series = await aSequence(world, { name: 'The Ruby course' })
      other = await aSequence(world, { name: 'The course' })
      await enroll(world.db, series.id, reader.id)
      await enroll(world.db, other.id, reader.id)

      response = await world.fetch(
        `/p/${reader.unsubToken}/one-click?scope=sequence:${series.id}&m=1`,
        { method: 'POST' },
      )
      after = await reload(world, reader)
    })

    it('answers the client', () => {
      expect(response.status).toBe(303)
    })

    it('leaves that series  ⭐', async () => {
      expect((await enrollmentOf(world, reader, series.id))?.status).toBe('cancelled')
    })

    it('and only that series', async () => {
      expect((await enrollmentOf(world, reader, other.id))?.status).toBe('active')
    })

    it('leaves the reader on the newsletter', () => {
      expect(after.status).toBe('active')
    })

    it('writes no suppression', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(0)
    })
  })

  describe('Scenario: one-click on a broadcast', () => {
    let world: World
    let reader: Subscriber
    let series: { id: number }
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world)
      series = await aSequence(world)
      await enroll(world.db, series.id, reader.id)

      await world.fetch(`/p/${reader.unsubToken}/one-click?scope=broadcast&m=1`, {
        method: 'POST',
      })
      after = await reload(world, reader)
    })

    it('takes them off the newsletter', () => {
      expect(after.status).toBe('unsubscribed')
    })

    it('leaves their series running', async () => {
      expect((await enrollmentOf(world, reader, series.id))?.status).toBe('active')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a token nobody holds', () => {
    let world: World
    let status: number
    let page: string

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'reader@example.test' })
      const response = await world.fetch('/p/not-a-real-token')
      status = response.status
      page = await response.text()
    })

    it('is not found', () => {
      expect(status).toBe(404)
    })

    it('reveals no address', () => {
      expect(page).not.toContain('reader@example.test')
    })

    it('says something neutral and useful instead', () => {
      expect(page).toContain('Link not recognized')
    })
  })

  describe('Scenario: posting an action with an unknown token', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      response = await world.post('/p/not-a-real-token', { action: 'unsub_all', scope: '', m: '' })
    })

    it('is not found', () => {
      expect(response.status).toBe(404)
    })

    it('suppresses nobody', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(0)
    })
  })

  describe('Scenario: submitting the same choice twice', () => {
    // SPEC 2a.5 — a refresh, a double-tap, or a mail client prefetching the
    // link must all land on the same state with no error.
    let world: World
    let second: Response

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world)
      const series = await aSequence(world)
      await enroll(world.db, series.id, reader.id)

      const form = { action: `leave:${series.id}`, scope: '', m: '' }
      await world.post(`/p/${reader.unsubToken}`, form)
      second = await world.post(`/p/${reader.unsubToken}`, form)
    })

    it('answers the second submission the same way', () => {
      expect(second.status).toBe(303)
    })

    it('leaves exactly one opt-out behind', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceOptouts).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: a hand-edited sequence id', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world)
      response = await world.post(`/p/${reader.unsubToken}`, {
        action: 'leave:9999',
        scope: '',
        m: '',
      })
    })

    it('is a no-op, not a 500', () => {
      expect(response.status).toBe(303)
    })

    it('writes no opt-out', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceOptouts).get())?.n
      expect(n).toBe(0)
    })
  })

  describe('Scenario: a scope parameter that means nothing', () => {
    let world: World
    let status: number

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world)
      status = (await world.fetch(`/p/${reader.unsubToken}?scope=sequence:banana`)).status
    })

    it('still renders the page', () => {
      expect(status).toBe(200)
    })
  })
})
