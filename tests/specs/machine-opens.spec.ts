// Machine-open detection: prefetch opens are flagged and left out of reader counts
// SPEC 5.1, 5.4
//
// Apple Mail Privacy Protection fetches every pixel whether or not anybody reads
// the mail, and corporate scanners do the same. A hit like that is still written
// — "how much of my open rate is Apple?" is a fair question — but flagged
// `machine`, left out of every reader count, and it fires no tag rule: a machine
// is not a person acting. Clicks are not judged at all.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { type BroadcastStats, broadcastStats, startBroadcast } from '../../src/core/broadcasts.ts'
import { broadcastFunnel } from '../../src/core/conversions.ts'
import { recentSignals } from '../../src/core/signal.ts'
import { createTagRule } from '../../src/core/tagging.ts'
import type { Message, Subscriber } from '../../src/db/schema.ts'
import { events, messages, subscriberTags, tags } from '../../src/db/schema.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const GMAIL_PROXY =
  'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)'
const HOUR = 60 * 60 * 1000

interface Sent {
  world: World
  broadcastId: number
  message: Message
  reader: Subscriber
}

/** One reader, one broadcast, sent `ago` ms before now. */
async function sent(ago = HOUR): Promise<Sent> {
  const world = createWorld()
  const reader = await aPerson(world, { email: 'reader@example.test' })
  const broadcastId = await aBroadcast(world, { subject: 'This week' })
  await startBroadcast(world.env, world.db, broadcastId)
  await world.db.update(messages).set({ sentAt: new Date(Date.now() - ago) })
  const message = (await world.db.select().from(messages).get())!
  return { world, broadcastId, message, reader }
}

/** The pixel, fetched the way a client would: through the deployed Worker. */
async function pixel(s: Sent, headers: Record<string, string>): Promise<Response> {
  return await s.world.fetch(`/t/open/${s.message.id}.gif`, { headers })
}

async function theOpen(s: Sent) {
  return (await s.world.db.select().from(events).where(eq(events.type, 'open')).get())!
}

async function tagsOf(s: Sent): Promise<string[]> {
  const rows = await s.world.db
    .select({ name: tags.name })
    .from(subscriberTags)
    .innerJoin(tags, eq(tags.id, subscriberTags.tagId))
    .where(eq(subscriberTags.subscriberId, s.reader.id))
    .all()
  return rows.map((r) => r.name)
}

describe('Feature: telling a reader’s open from a machine’s', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a reader opens the mail an hour after it went out', () => {
    let s: Sent
    let stats: BroadcastStats

    beforeAll(async () => {
      s = await sent()
      await pixel(s, { 'user-agent': SAFARI, 'cf-connecting-ip': '203.0.113.7' })
      stats = await broadcastStats(s.world.db, s.broadcastId)
    })

    it('records the open as a person’s', async () => {
      expect((await theOpen(s)).machine).toBe(false)
    })

    it('counts them as a reader', () => {
      expect(stats.opened).toBe(1)
    })

    it('counts no machine open', () => {
      expect(stats.machineOpened).toBe(0)
    })
  })

  describe('Scenario: Gmail’s image proxy fetches the pixel', () => {
    // Gmail and Outlook proxy images when the reader opens the mail, so the
    // fetch IS the person opening it.
    let s: Sent

    beforeAll(async () => {
      s = await sent()
      await pixel(s, { 'user-agent': GMAIL_PROXY, 'cf-connecting-ip': '66.249.84.1' })
    })

    it('counts as a person', async () => {
      expect((await theOpen(s)).machine).toBe(false)
    })
  })

  describe('Scenario: Apple Mail Privacy Protection prefetches the pixel', () => {
    let s: Sent
    let response: Response
    let stats: BroadcastStats

    beforeAll(async () => {
      s = await sent()
      response = await pixel(s, { 'user-agent': 'Mozilla/5.0', 'cf-connecting-ip': '17.58.100.4' })
      stats = await broadcastStats(s.world.db, s.broadcastId)
    })

    it('still gets its image — the pixel never breaks', () => {
      expect(response.headers.get('content-type')).toBe('image/gif')
    })

    it('is still written down', async () => {
      expect(await theOpen(s)).toBeDefined()
    })

    it('is flagged as a machine', async () => {
      expect((await theOpen(s)).machine).toBe(true)
    })

    it('says why', async () => {
      expect((await theOpen(s)).meta).toMatchObject({ machine_reason: 'apple_privacy_proxy' })
    })

    it('⭐ is left out of the reader count', () => {
      expect(stats.opened).toBe(0)
    })

    it('is reported beside it instead', () => {
      expect(stats.machineOpened).toBe(1)
    })
  })

  describe('Scenario: the machine open, read by every other screen that counts opens', () => {
    let funnelOpened: number
    let signalOpened: number | undefined

    beforeAll(async () => {
      const s = await sent()
      await pixel(s, { 'user-agent': 'Mozilla/5.0' })
      await s.world.tick() // closes the send, so it is `sent` and gets a Signal
      funnelOpened = (await broadcastFunnel(s.world.db, s.broadcastId)).opened
      signalOpened = (await recentSignals(s.world.db)).find((b) => b.id === s.broadcastId)?.opened
    })

    it('is not a reader in the broadcast funnel', () => {
      expect(funnelOpened).toBe(0)
    })

    it('is not a reader in Signal', () => {
      expect(signalOpened).toBe(0)
    })
  })

  describe('Scenario: an open rule is set, and a machine opens the mail', () => {
    // Machine events fire nothing. A prefetch that tagged people
    // "engaged" would start every sequence keyed on that tag for everyone on Apple Mail.
    let s: Sent

    beforeAll(async () => {
      s = await sent()
      await createTagRule(s.world.db, { name: 'Opened', event: 'open', tagName: 'engaged' })
      await pixel(s, { 'user-agent': 'Mozilla/5.0' })
    })

    it('⭐ fires no tag rule', async () => {
      expect(await tagsOf(s)).toEqual([])
    })
  })

  describe('Scenario: an open rule is set, and the reader opens the mail', () => {
    let s: Sent

    beforeAll(async () => {
      s = await sent()
      await createTagRule(s.world.db, { name: 'Opened', event: 'open', tagName: 'engaged' })
      await pixel(s, { 'user-agent': SAFARI })
    })

    it('fires the rule', async () => {
      expect(await tagsOf(s)).toEqual(['engaged'])
    })
  })

  describe('Scenario: a click straight after sending, from a client with no agent', () => {
    // Clicks are not judged. They move campaign credit and fire click rules,
    // and they have always been trusted.
    let s: Sent
    let stats: BroadcastStats

    beforeAll(async () => {
      s = await sent(0)
      await s.world.fetch(
        `/t/click/${s.message.id}?u=${encodeURIComponent('https://example.com/post')}`,
        { redirect: 'manual' },
      )
      stats = await broadcastStats(s.world.db, s.broadcastId)
    })

    it('counts the click', () => {
      expect(stats.clicked).toBe(1)
    })
  })

  // ───────────────────────────────────────────── the other machines

  describe('Scenario: a fetch from Apple’s network with an ordinary agent', () => {
    let s: Sent

    beforeAll(async () => {
      s = await sent()
      await pixel(s, { 'user-agent': SAFARI, 'cf-connecting-ip': '17.0.0.9' })
    })

    it('is Apple’s proxy', async () => {
      expect((await theOpen(s)).meta).toMatchObject({ machine_reason: 'apple_privacy_proxy' })
    })
  })

  describe('Scenario: a fetch with no user agent at all', () => {
    let s: Sent

    beforeAll(async () => {
      s = await sent()
      await pixel(s, {})
    })

    it('is a machine', async () => {
      expect((await theOpen(s)).meta).toMatchObject({ machine_reason: 'no_user_agent' })
    })
  })

  describe('Scenario: a corporate link scanner fetches the pixel', () => {
    let s: Sent

    beforeAll(async () => {
      s = await sent()
      await pixel(s, { 'user-agent': 'Mozilla/5.0 (compatible; Proofpoint URL Defense)' })
    })

    it('is a machine', async () => {
      expect((await theOpen(s)).meta).toMatchObject({ machine_reason: 'known_agent' })
    })
  })

  describe('Scenario: the pixel is fetched a second after the mail went out', () => {
    // Nobody opens a mail that fast. A prefetcher does.
    let s: Sent

    beforeAll(async () => {
      s = await sent(1000)
      await pixel(s, { 'user-agent': SAFARI })
    })

    it('is a machine', async () => {
      expect((await theOpen(s)).meta).toMatchObject({ machine_reason: 'too_soon' })
    })
  })
})
