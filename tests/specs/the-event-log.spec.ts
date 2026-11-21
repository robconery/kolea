// gap.md "Event log" — a Logs page of everything that happened, in plain words,
// kept 90 days, searchable by type and text, paged, and searchable over MCP
// (`log_search`, `log_types`).
// Ported from Kōlea SPEC 4.7 (the log of what happened) and 20.3 (log_search /
// log_types), and `Kolea.EventLog` (90-day retention, cursor paging, categories).
//
// The log is a read model over the tables the facts already live in
// (`core/event-log.ts`), so these scenarios make things happen the normal way —
// a signup, a sequence, a real broadcast through the cron — and then read the
// log, rather than writing log rows by hand.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createApiKey } from '../../src/core/api-keys.ts'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { leaveSequence } from '../../src/core/consent.ts'
import { type LogPage, searchLog } from '../../src/core/event-log.ts'
import { enroll } from '../../src/core/sequences.ts'
import { activities, broadcasts } from '../../src/db/schema.ts'
import { aBroadcast, aPerson, aSequence } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const MCP_SECRET = 'log-spec-secret'

/** A world where Ana joined, started and left Onboarding, and "Launch" went to 3 people. */
async function aBusyWeek(): Promise<World> {
  const world = createWorld({ MCP_PATH_SECRET: MCP_SECRET })
  const ana = await aPerson(world, { email: 'ana@example.test', name: 'Ana' })
  await aPerson(world, { email: 'ben@example.test', name: 'Ben' })
  await aPerson(world, { email: 'cy@example.test' })
  const onboarding = await aSequence(world, { name: 'Onboarding' })
  await enroll(world.db, onboarding.id, ana.id)
  await leaveSequence(world.db, ana.id, onboarding.id)

  const launch = await aBroadcast(world, { subject: 'Launch' })
  await startBroadcast(world.env, world.db, launch)
  for (let i = 0; i < 5; i++) {
    const b = await world.db.select().from(broadcasts).where(eq(broadcasts.id, launch)).get()
    if (b?.status === 'sent') break
    await world.tick()
  }
  return world
}

function ok(result: Awaited<ReturnType<typeof searchLog>>): LogPage {
  if (!result.ok) throw new Error(result.reason)
  return result.page
}

describe('Feature: the event log', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the operator reads the Logs page after a busy week', () => {
    let response: Response
    let html: string

    beforeAll(async () => {
      const world = await aBusyWeek()
      response = await world.fetch('/logs')
      html = await response.text()
    })

    it('opens', () => {
      expect(response.status).toBe(200)
    })

    it('says, in words, that Ana left the Onboarding series', () => {
      expect(html).toContain('Ana left the Onboarding series')
    })

    it('says the broadcast finished and how many it went to', () => {
      expect(html).toMatch(/Broadcast (&quot;|")Launch(&quot;|") finished: 3 sent/)
    })

    it('says when it started sending', () => {
      expect(html).toMatch(/Broadcast (&quot;|")Launch(&quot;|") started sending/)
    })

    it('says who joined', () => {
      expect(html).toContain('Ben joined the list')
    })

    it('falls back to the address for someone with no name', () => {
      expect(html).toContain('cy@example.test joined the list')
    })

    it('is in the console navigation', () => {
      expect(html).toContain('href="/logs"')
    })
  })

  describe('Scenario: narrowing the log by type', () => {
    let page: LogPage

    beforeAll(async () => {
      const world = await aBusyWeek()
      page = ok(await searchLog(world.db, { type: 'sequence.left' }))
    })

    it('finds the one departure', () => {
      expect(page.events.map((e) => e.summary)).toEqual(['Ana left the Onboarding series'])
    })
  })

  describe('Scenario: narrowing the log by category', () => {
    let page: LogPage

    beforeAll(async () => {
      const world = await aBusyWeek()
      page = ok(await searchLog(world.db, { category: 'broadcasts' }))
    })

    it('shows only broadcast lines, newest first', () => {
      expect(page.events.map((e) => e.type)).toEqual(['broadcast.finished', 'broadcast.started'])
    })
  })

  describe('Scenario: searching the log for a word', () => {
    let page: LogPage

    beforeAll(async () => {
      const world = await aBusyWeek()
      page = ok(await searchLog(world.db, { q: 'onboard', limit: 200 }))
    })

    it('finds every line about the Onboarding series and nothing else', () => {
      expect(page.events.every((e) => e.summary.includes('Onboarding'))).toBe(true)
    })

    it('finds more than one of them (enrolled, then left)', () => {
      expect(page.events.length).toBeGreaterThan(1)
    })
  })

  describe('Scenario: paging back through the log', () => {
    let first: LogPage
    let second: LogPage
    let everything: LogPage

    beforeAll(async () => {
      const world = await aBusyWeek()
      everything = ok(await searchLog(world.db, { limit: 200 }))
      first = ok(await searchLog(world.db, { limit: 3 }))
      second = ok(await searchLog(world.db, { limit: 200, cursor: first.nextCursor ?? undefined }))
    })

    it('hands back a cursor when there is more', () => {
      expect(first.nextCursor).not.toBeNull()
    })

    it('continues exactly where the first page stopped, with no line twice and none lost', () => {
      expect([...first.events, ...second.events].map((e) => e.id)).toEqual(
        everything.events.map((e) => e.id),
      )
    })

    it('has no cursor on the last page', () => {
      expect(second.nextCursor).toBeNull()
    })
  })

  describe('Scenario: something that happened more than 90 days ago', () => {
    let page: LogPage

    beforeAll(async () => {
      const world = createWorld()
      const old = await aPerson(world, { email: 'old@example.test', name: 'Olwen' })
      await world.db
        .update(activities)
        .set({ occurredAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) })
        .where(eq(activities.subscriberId, old.id))
      page = ok(await searchLog(world.db, { q: 'olwen' }))
    })

    it('has aged out of the log', () => {
      expect(page.events).toHaveLength(0)
    })
  })

  describe('Scenario: an agent searches the log over MCP', () => {
    let body: string

    beforeAll(async () => {
      const world = await aBusyWeek()
      const { token } = await createApiKey(world.db, 'agent', 'admin')
      const res = await world.fetch(`/mcp/${MCP_SECRET}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'log_search', arguments: { type: 'sequence.left' } },
        }),
      })
      body = await res.text()
    })

    it('answers with the departure', () => {
      expect(body).toContain('Ana left the Onboarding series')
    })

    it('keeps the subscriber-written text under a key that says it is untrusted', () => {
      expect(body).toContain('untrusted_text')
    })
  })

  // ───────────────────────────────────────────── text people wrote is data

  describe('Scenario: someone signs up with markup for a name', () => {
    let html: string

    beforeAll(async () => {
      const world = createWorld()
      await aPerson(world, { email: 'x@example.test', name: '<script>alert(1)</script>' })
      html = await (await world.fetch('/logs')).text()
    })

    it('shows the name as text', () => {
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; joined the list')
    })

    it('never puts it on the page as markup', () => {
      expect(html).not.toContain('<script>alert(1)</script>')
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: asking for a type the log does not have', () => {
    let result: Awaited<ReturnType<typeof searchLog>>

    beforeAll(async () => {
      const world = createWorld()
      result = await searchLog(world.db, { type: "x'); drop table activities; --" })
    })

    it('refuses with a reason rather than running it', () => {
      expect(result.ok).toBe(false)
    })
  })

  describe('Scenario: a cursor the log never handed out', () => {
    let result: Awaited<ReturnType<typeof searchLog>>

    beforeAll(async () => {
      const world = createWorld()
      result = await searchLog(world.db, { cursor: 'not-a-cursor' })
    })

    it('refuses it', () => {
      expect(result.ok).toBe(false)
    })
  })
})
