// gap.md "Sequence send-time window" — a due step waits for the operator's hours
// Kōlea SPEC 12.1.2 (and Kōlea's Sequences.Rules.window_open?) · Big Mailer SPEC 6.3, 6.5
//
// A sequence can keep its mail to set hours, read in the operator's one time
// zone. A step that comes due outside the window is never skipped and never
// sent early: the enrollment's next run moves to the window's next opening and
// the tick that runs then sends it. Every scenario drives `worker.scheduled`
// with the cron's own `scheduledTime` as the clock, in 2031 so a step made due
// "now" is always due by then.
import { beforeAll, describe, expect, it } from 'bun:test'
import { enroll, updateSequence } from '../../src/core/sequences.ts'
import { getTimeZone, setTimeZone } from '../../src/core/site-settings.ts'
import type { Subscriber } from '../../src/db/schema.ts'
import { aPerson, aSequence, enrollmentOf, makeDue } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const at = (iso: string) => new Date(iso)

interface Setup {
  world: World
  person: Subscriber
  seqId: number
}

/** One live single-step sequence with one person due on it, a window and a zone. */
async function dueOn(window: { start: number; end: number } | null, zone = 'Pacific/Honolulu'): Promise<Setup> {
  const world = createWorld()
  await setTimeZone(world.db, zone)
  const { id } = await aSequence(world, { steps: [{ subject: 'Hello, in hours' }] })
  if (window) {
    const r = await updateSequence(world.db, id, { sendWindow: window })
    if (!r.ok) throw new Error(r.reason)
  }
  const person = await aPerson(world, { email: 'reader@example.test' })
  await enroll(world.db, id, person.id)
  await makeDue(world, person, id)
  return { world, person, seqId: id }
}

const H = (h: number, m = 0) => h * 60 + m

describe('Feature: a sequence sends only inside its window', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a step comes due at 3am in Honolulu, window 08:00–18:00', () => {
    let s: Setup
    let mailed: number
    let nextRunAt: Date | null | undefined

    beforeAll(async () => {
      s = await dueOn({ start: H(8), end: H(18) })
      await s.world.tick(at('2031-06-10T13:00:00Z')) // 03:00 HST
      mailed = (await s.world.outbox()).length
      nextRunAt = (await enrollmentOf(s.world, s.person, s.seqId))?.nextRunAt
    })

    it('⭐ sends nothing', () => {
      expect(mailed).toBe(0)
    })

    it('keeps the enrollment on the same step, still active', async () => {
      expect((await enrollmentOf(s.world, s.person, s.seqId))?.status).toBe('active')
    })

    it('moves it to 08:00 that morning, Honolulu time', () => {
      expect(nextRunAt?.toISOString()).toBe('2031-06-10T18:00:00.000Z')
    })
  })

  describe('Scenario: the window opens', () => {
    let s: Setup

    beforeAll(async () => {
      s = await dueOn({ start: H(8), end: H(18) })
      await s.world.tick(at('2031-06-10T13:00:00Z')) // 03:00 HST: held
      await s.world.tick(at('2031-06-10T18:00:00Z')) // 08:00 HST: open
    })

    it('⭐ sends the held step', async () => {
      expect((await s.world.mailTo('reader@example.test')).subject).toBe('Hello, in hours')
    })
  })

  describe('Scenario: a step comes due inside the window', () => {
    let s: Setup

    beforeAll(async () => {
      s = await dueOn({ start: H(8), end: H(18) })
      await s.world.tick(at('2031-06-10T23:30:00Z')) // 13:30 HST
    })

    it('sends it at that tick', async () => {
      expect((await s.world.outbox()).length).toBe(1)
    })
  })

  describe('Scenario: the sequence has no window', () => {
    let s: Setup

    beforeAll(async () => {
      s = await dueOn(null)
      await s.world.tick(at('2031-06-10T13:00:00Z')) // 03:00 HST
    })

    it('sends at the first tick, day or night, as it always has', async () => {
      expect((await s.world.outbox()).length).toBe(1)
    })
  })

  describe('Scenario: a window that runs past midnight, 22:00–06:00', () => {
    let s: Setup
    let nextRunAt: Date | null | undefined

    beforeAll(async () => {
      s = await dueOn({ start: H(22), end: H(6) })
      await s.world.tick(at('2031-06-10T22:00:00Z')) // 12:00 HST
      nextRunAt = (await enrollmentOf(s.world, s.person, s.seqId))?.nextRunAt
    })

    it('holds a step due at noon until 22:00 that night', () => {
      expect(nextRunAt?.toISOString()).toBe('2031-06-11T08:00:00.000Z')
    })
  })

  describe('Scenario: the night before the clocks go forward in New York', () => {
    // 2031-03-09 02:00 EST → 03:00 EDT. 09:00 the next morning is 13:00 UTC,
    // not the 14:00 UTC it was the day before.
    let nextRunAt: Date | null | undefined

    beforeAll(async () => {
      const s = await dueOn({ start: H(9), end: H(17) }, 'America/New_York')
      await s.world.tick(at('2031-03-09T03:00:00Z')) // 22:00 EST, Mar 8
      nextRunAt = (await enrollmentOf(s.world, s.person, s.seqId))?.nextRunAt
    })

    it('waits until 09:00 daylight time', () => {
      expect(nextRunAt?.toISOString()).toBe('2031-03-09T13:00:00.000Z')
    })
  })

  describe('Scenario: the night before the clocks go back in New York', () => {
    // 2031-11-02 02:00 EDT → 01:00 EST. 09:00 that morning is 14:00 UTC.
    let nextRunAt: Date | null | undefined

    beforeAll(async () => {
      const s = await dueOn({ start: H(9), end: H(17) }, 'America/New_York')
      await s.world.tick(at('2031-11-02T02:00:00Z')) // 22:00 EDT, Nov 1
      nextRunAt = (await enrollmentOf(s.world, s.person, s.seqId))?.nextRunAt
    })

    it('waits until 09:00 standard time', () => {
      expect(nextRunAt?.toISOString()).toBe('2031-11-02T14:00:00.000Z')
    })
  })

  describe('Scenario: the operator sets the window on the sequence screen', () => {
    let world: World
    let seqId: number
    let response: Response
    let page: string

    beforeAll(async () => {
      world = createWorld()
      ;({ id: seqId } = await aSequence(world))
      response = await world.post(`/sequences/${seqId}/window`, {
        start: '08:00',
        end: '18:00',
        timeZone: 'Pacific/Honolulu',
      })
      page = await (await world.fetch(`/sequences/${seqId}`)).text()
    })

    it('saves it', () => {
      expect(response.headers.get('location')).toContain('Send%20window%20saved')
    })

    it('shows it on the screen, with the zone', () => {
      expect(page).toContain('Pacific/Honolulu')
    })

    it('shows the hours', () => {
      expect(page).toContain('value="08:00"')
    })

    it('stores the time zone for the install', async () => {
      expect(await getTimeZone(world.db)).toBe('Pacific/Honolulu')
    })
  })

  describe('Scenario: the operator clears the window', () => {
    let world: World
    let seqId: number

    beforeAll(async () => {
      world = createWorld()
      ;({ id: seqId } = await aSequence(world))
      await updateSequence(world.db, seqId, { sendWindow: { start: H(8), end: H(18) } })
      await world.post(`/sequences/${seqId}/window`, { start: '', end: '', timeZone: 'UTC' })
    })

    it('leaves the sequence with no window', async () => {
      const page = await (await world.fetch(`/sequences/${seqId}`)).text()
      expect(page).toContain('the minute they come due')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a window with only a start', () => {
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      const world = createWorld()
      const { id } = await aSequence(world)
      result = await updateSequence(world.db, id, { sendWindow: { start: H(8), end: null } })
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })
  })

  describe('Scenario: a window that starts and ends at the same minute', () => {
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      const world = createWorld()
      const { id } = await aSequence(world)
      result = await updateSequence(world.db, id, { sendWindow: { start: H(9), end: H(9) } })
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })
  })

  describe('Scenario: a time zone that does not exist', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const { id } = await aSequence(world)
      response = await world.post(`/sequences/${id}/window`, {
        start: '08:00',
        end: '18:00',
        timeZone: 'Mars/Olympus_Mons',
      })
    })

    it('is refused with a warning', () => {
      expect(response.headers.get('location')).toContain('kind=warn')
    })

    it('leaves the install on UTC', async () => {
      expect(await getTimeZone(world.db)).toBe('UTC')
    })
  })

  describe('Scenario: a time that is not a time', () => {
    let response: Response

    beforeAll(async () => {
      const world = createWorld()
      const { id } = await aSequence(world)
      response = await world.post(`/sequences/${id}/window`, { start: '8am', end: '18:00', timeZone: 'UTC' })
    })

    it('is refused with a warning', () => {
      expect(response.headers.get('location')).toContain('kind=warn')
    })
  })
})
