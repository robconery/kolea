// gap.md — "Importers from other tools": connect Kit, Ghost, Mailchimp or Drip
// with an API key and bring the list and its past mail over, resumable in the
// background.
// Kōlea SPEC 19.2 (Kit), 19.3 (Ghost), 19.4 (Mailchimp, Drip), 19.5 (1.6, 1.8,
// 1.9 for every importer). Here: SPEC 1.2, ARCHITECTURE invariants 3, 5, 6.
//
// Every run below is driven the way production drives it: started through
// `worker.fetch` (POST /imports), then advanced one page per `worker.scheduled`
// minutely tick. The four APIs are faked at the HTTP edge (`Env.IMPORT_HTTP`),
// so the real adapters and the real writer run, and nothing leaves the process.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { htmlToMarkdown } from '../../src/core/importers/html.ts'
import { nextImportStatus } from '../../src/core/importers/runs.ts'
import {
  type ImportRun,
  broadcasts,
  importRuns,
  messages,
  sequenceEnrollments,
  sequences,
  subscriberTags,
  subscribers,
  suppressions,
  tags,
} from '../../src/db/schema.ts'
import { aBroadcast, aPerson, aSequence, aTag } from '../support/factories.ts'
import { type FakeData, fakeImportApis } from '../support/fake-import-apis.ts'
import { type World, createWorld } from '../support/world.ts'

// ─────────────────────────────────────────────────────────── fixtures

const KIT_KEY = 'kit-secret-key-0001'

function kitData(): FakeData {
  return {
    kit: {
      key: KIT_KEY,
      tags: [
        { id: 1, name: 'customer' },
        { id: 2, name: 'ruby' },
        { id: 3, name: 'Imported May 5th, 2026 at 12:07 PM' },
      ],
      subscribers: [
        { email_address: 'Ada@Example.test', first_name: 'Ada', state: 'active', created_at: '2024-02-27 22:32:19 UTC', fields: { company: 'Analytical' } },
        { email_address: 'grace@example.test', first_name: 'Grace', state: 'cancelled', created_at: '2024-03-01T00:00:00Z' },
        { email_address: 'linus@example.test', state: 'bounced', created_at: '2024-03-01T00:00:00Z' },
        { email_address: 'kept@example.test', first_name: 'Kept', state: 'active', created_at: '2024-03-01T00:00:00Z' },
        { email_address: 'blocked@example.test', state: 'active', created_at: '2024-03-01T00:00:00Z' },
        { email_address: 'weird@example.test', state: 'mystery', created_at: '2024-03-01T00:00:00Z' },
        { email_address: 'not-an-email', state: 'active' },
      ],
      taggings: { 1: ['ada@example.test', 'kept@example.test'], 2: ['ada@example.test'], 3: ['ada@example.test'] },
      broadcasts: [
        {
          id: 101,
          subject: 'Hello from Kit',
          content: '<style>p{color:red}</style><p>Hi <strong>there</strong>, <a href="https://example.test/x">read</a>.</p>',
          preview_text: 'A hello',
          created_at: '2025-01-01T09:00:00Z',
          send_at: '2025-01-02T10:00:00Z',
          stats: { status: 'completed', recipients: 100, emails_opened: 40, click_rate: 0.05, unsubscribes: 2 },
        },
        { id: 102, subject: 'Still a draft', content: '<p>wip</p>', created_at: '2025-02-01T09:00:00Z', send_at: null, stats: { status: 'draft' } },
      ],
      sequences: [
        {
          id: 201,
          name: 'Kit Welcome',
          created_at: '2024-01-01T00:00:00Z',
          emails: [
            { subject: 'One', content: '<p>First</p>', delay_value: 0, delay_unit: 'days', position: 0 },
            { subject: 'Two', content: '<p>Second</p>', delay_value: 36, delay_unit: 'hours', position: 1 },
          ],
        },
      ],
    },
  }
}

async function runOf(w: World, id = 1): Promise<ImportRun> {
  return (await w.db.select().from(importRuns).where(eq(importRuns.id, id)).get())!
}

/** Tick until the run stops, the way the minutely cron would. */
async function tickUntilDone(w: World, id = 1, limit = 40): Promise<number> {
  let ticks = 0
  while (ticks < limit) {
    const run = await runOf(w, id)
    if (!['queued', 'running'].includes(run.status)) break
    await w.tick()
    ticks++
  }
  return ticks
}

const person = async (w: World, email: string) =>
  await w.db.select().from(subscribers).where(eq(subscribers.email, email)).get()

const suppressionOf = async (w: World, email: string) =>
  (await w.db.select().from(suppressions).where(eq(suppressions.email, email)).get())?.reason ?? null

describe('Feature: bringing a list over from another tool', () => {
  // ───────────────────────────────────────────── happy path: Kit, end to end

  describe('Scenario: an operator connects Kit and the cron brings everything over', () => {
    let world: World
    let startStatus: number
    let screen: string
    let run: ImportRun
    let welcome: number
    let byTag: number
    let blockedReason: string | null
    let report: string

    beforeAll(async () => {
      const fake = fakeImportApis(kitData())
      world = createWorld({ IMPORT_HTTP: fake.fetcher })

      // Somebody who already left the newsletter here, before any of this.
      await aPerson(world, { email: 'kept@example.test', triggerSubscribeSequences: false })
      await world.db.update(subscribers).set({ status: 'unsubscribed' }).where(eq(subscribers.email, 'kept@example.test'))
      // An address suppressed here that Kit still thinks is active.
      await world.db.insert(suppressions).values({ email: 'blocked@example.test', reason: 'manual', createdAt: new Date() })
      // ⭐ Live automation an import must never trip: a welcome series and a
      // series started by the very tag Kit is about to hand over.
      welcome = (await aSequence(world, { trigger: 'subscribe', steps: [{ subject: 'Welcome!' }] })).id
      const customer = await aTag(world, 'customer')
      byTag = (await aSequence(world, { trigger: 'tag_added', triggerTagId: customer, steps: [{ subject: 'Thanks!' }] })).id

      startStatus = (await world.post('/imports', { source: 'kit', api_key: KIT_KEY })).status
      screen = await (await world.fetch('/imports')).text()
      await tickUntilDone(world)
      run = await runOf(world)
      blockedReason = await suppressionOf(world, 'blocked@example.test')
      report = await (await world.fetch('/imports/1')).text()
    })

    it('shows the results on the run page', () => {
      expect(report).toContain('sequences arrived off')
    })

    it('accepts the key and queues the run', () => {
      expect(startStatus).toBe(302)
    })

    it('never shows the key back on the imports screen', () => {
      expect(screen.includes(KIT_KEY)).toBe(false)
    })

    it('finishes the run', () => {
      expect(run.status).toBe('completed')
    })

    it('drops the key the moment the run ends', () => {
      expect(run.credentials).toBeNull()
    })

    it('brings over somebody Kit has as active, as active', async () => {
      expect((await person(world, 'ada@example.test'))?.status).toBe('active')
    })

    it("keeps Kit's custom fields as attributes", async () => {
      expect((await person(world, 'ada@example.test'))?.attributes).toEqual({ company: 'Analytical' })
    })

    it('records where a person came from', async () => {
      expect((await person(world, 'ada@example.test'))?.source).toBe('kit-import')
    })

    it('⭐ brings a Kit unsubscribe over as unsubscribed', async () => {
      expect((await person(world, 'grace@example.test'))?.status).toBe('unsubscribed')
    })

    it('⭐ and suppresses them from everything, because a Kit unsubscribe stops every mail', async () => {
      expect(await suppressionOf(world, 'grace@example.test')).toBe('unsubscribed_all')
    })

    it('brings a Kit bounce over as bounced', async () => {
      expect((await person(world, 'linus@example.test'))?.status).toBe('bounced')
    })

    it('suppresses a Kit bounce as a hard bounce', async () => {
      expect(await suppressionOf(world, 'linus@example.test')).toBe('hard_bounce')
    })

    it('⭐ never returns somebody unsubscribed here to active, whatever Kit says', async () => {
      expect((await person(world, 'kept@example.test'))?.status).toBe('unsubscribed')
    })

    it('⭐ does not add an address suppressed here', async () => {
      expect(await person(world, 'blocked@example.test')).toBeUndefined()
    })

    it('⭐ leaves the local suppression as it was', () => {
      expect(blockedReason).toBe('manual')
    })

    it('imports nobody whose Kit state it cannot read', async () => {
      expect(await person(world, 'weird@example.test')).toBeUndefined()
    })

    it('counts the address that cannot be stored as invalid', () => {
      expect(run.invalid).toBe(1)
    })

    it('counts the new people, broadcast and sequence as created', () => {
      expect(run.created).toBe(5)
    })

    it('puts the Kit tags on the people Kit tagged', async () => {
      const ada = (await person(world, 'ada@example.test'))!
      const n = (await world.db.select({ n: count() }).from(subscriberTags).where(eq(subscriberTags.subscriberId, ada.id)).get())?.n
      expect(n).toBe(2)
    })

    it("drops Kit's own \"Imported <date>\" bookkeeping tag", async () => {
      const found = await world.db.select().from(tags).where(eq(tags.slug, 'imported-may-5th-2026-at-12-07-pm')).get()
      expect(found).toBeUndefined()
    })

    it('⭐ enrolls nobody in the live welcome series', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceEnrollments).where(eq(sequenceEnrollments.sequenceId, welcome)).get())?.n
      expect(n).toBe(0)
    })

    it('⭐ enrolls nobody in the series the imported tag would start', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceEnrollments).where(eq(sequenceEnrollments.sequenceId, byTag)).get())?.n
      expect(n).toBe(0)
    })

    it('⭐ queues no mail at all', async () => {
      const n = (await world.db.select({ n: count() }).from(messages).get())?.n
      expect(n).toBe(0)
    })

    it('⭐ leaves the outbox empty', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('⭐ brings the completed broadcast over as sent', async () => {
      const b = await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, '101')).get()
      expect(b?.status).toBe('sent')
    })

    it('⭐ with its send time set', async () => {
      const b = await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, '101')).get()
      expect(b?.sentAt?.toISOString()).toBe('2025-01-02T10:00:00.000Z')
    })

    it('⭐ and not published to the web', async () => {
      const b = await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, '101')).get()
      expect(b?.publishedAt).toBeNull()
    })

    it("keeps Kit's send totals in the imported columns", async () => {
      const b = await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, '101')).get()
      expect([b?.importedRecipients, b?.importedOpened, b?.importedClicked, b?.importedUnsubscribed, b?.importedFrom]).toEqual([
        100, 40, 5, 2, 'kit',
      ])
    })

    it('turns the mail HTML into readable Markdown', async () => {
      const b = await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, '101')).get()
      expect(b?.bodyMd).toBe('Hi **there**, [read](https://example.test/x).')
    })

    it('leaves a broadcast that never went out behind', async () => {
      const b = await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, '102')).get()
      expect(b).toBeUndefined()
    })

    it('⭐ brings the sequence over switched off', async () => {
      const s = await world.db.select().from(sequences).where(eq(sequences.importedSourceId, '201')).get()
      expect(s?.isActive).toBe(false)
    })

    it('with a manual start, never a guessed trigger', async () => {
      const s = await world.db.select().from(sequences).where(eq(sequences.importedSourceId, '201')).get()
      expect(s?.trigger).toBe('manual')
    })

    it('says so in the report', () => {
      expect(run.notes.some((n) => n.key === 'sequences_off')).toBe(true)
    })
  })

  // ───────────────────────────────────────────── resuming

  describe('Scenario: the second tick picks up exactly where the first left off', () => {
    let afterFirst: ImportRun
    let afterSecond: ImportRun
    let secondTickRequests: string[]

    beforeAll(async () => {
      const fake = fakeImportApis(kitData())
      const world = createWorld({ IMPORT_HTTP: fake.fetcher })
      await world.post('/imports', { source: 'kit', api_key: KIT_KEY })
      await world.tick()
      afterFirst = await runOf(world)
      const before = fake.requests.length
      await world.tick()
      secondTickRequests = fake.requests.slice(before)
      afterSecond = await runOf(world)
    })

    it('is running after the first tick', () => {
      expect(afterFirst.status).toBe('running')
    })

    it('stores the cursor Kit handed back after the first page', () => {
      expect([afterFirst.phase, afterFirst.cursor]).toEqual(['tags', '2'])
    })

    it('asks Kit for the next page from that cursor on the second tick', () => {
      expect(secondTickRequests).toContain('api.kit.com/v4/tags?per_page=1000&after=2')
    })

    it('moves on to the next phase once the last page is read', () => {
      expect([afterSecond.phase, afterSecond.cursor, afterSecond.phasesDone]).toEqual(['subscribers', null, 1])
    })
  })

  describe('Scenario: the same Kit import is run a second time', () => {
    let world: World
    beforeAll(async () => {
      world = createWorld({ IMPORT_HTTP: fakeImportApis(kitData()).fetcher })
      await world.post('/imports', { source: 'kit', api_key: KIT_KEY })
      await tickUntilDone(world, 1)
      await world.post('/imports', { source: 'kit', api_key: KIT_KEY })
      await tickUntilDone(world, 2)
    })

    it('copies no broadcast twice', async () => {
      const n = (await world.db.select({ n: count() }).from(broadcasts).where(eq(broadcasts.importedFrom, 'kit')).get())?.n
      expect(n).toBe(1)
    })

    it('copies no sequence twice', async () => {
      const n = (await world.db.select({ n: count() }).from(sequences).where(eq(sequences.importedFrom, 'kit')).get())?.n
      expect(n).toBe(1)
    })

    it('creates nobody the second time', async () => {
      expect((await runOf(world, 2)).created).toBe(0)
    })
  })

  // ───────────────────────────────────────────── the other three tools

  describe('Scenario: an operator connects Ghost', () => {
    let world: World
    let run: ImportRun

    beforeAll(async () => {
      const adminKey = `${'a'.repeat(24)}:${'0123456789abcdef'.repeat(4)}`
      const fake = fakeImportApis({
        ghost: {
          origin: 'https://writer.example.test',
          adminKey,
          members: [
            { email: 'reader@example.test', name: 'Reader', status: 'paid', subscribed: true, labels: [{ name: 'VIP' }], created_at: '2024-01-01T00:00:00.000Z' },
            { email: 'quiet@example.test', status: 'free', subscribed: false, created_at: '2024-01-01T00:00:00.000Z' },
            { email: 'spam@example.test', status: 'free', subscribed: true, email_suppression: { suppressed: true, info: { reason: 'spam' } } },
            { email: 'unknown@example.test', status: 'free' },
          ],
          posts: [
            {
              id: 'p1',
              title: 'Hello world',
              slug: 'hello-world',
              status: 'published',
              html: '<h2>Hi</h2><p>Post body</p>',
              published_at: '2025-03-01T08:00:00.000Z',
              created_at: '2025-02-28T08:00:00.000Z',
              email: { email_count: 50, opened_count: 20, submitted_at: '2025-03-01T08:05:00.000Z' },
            },
            { id: 'p2', title: 'Unfinished', slug: 'unfinished', status: 'draft', created_at: '2025-04-01T08:00:00.000Z' },
          ],
        },
      })
      world = createWorld({ IMPORT_HTTP: fake.fetcher })
      await world.post('/imports', { source: 'ghost', url: 'https://writer.example.test/', admin_key: adminKey })
      await tickUntilDone(world)
      run = await runOf(world)
    })

    it('finishes the run', () => {
      expect(run.status).toBe('completed')
    })

    it('brings a subscribed member over as active', async () => {
      expect((await person(world, 'reader@example.test'))?.status).toBe('active')
    })

    it('turns Ghost labels into tags', async () => {
      expect(await world.db.select().from(tags).where(eq(tags.slug, 'vip')).get()).toBeDefined()
    })

    it('brings a member who turned the newsletter off over as unsubscribed', async () => {
      expect((await person(world, 'quiet@example.test'))?.status).toBe('unsubscribed')
    })

    it("⭐ without suppressing them: Ghost's toggle is the newsletter only", async () => {
      expect(await suppressionOf(world, 'quiet@example.test')).toBeNull()
    })

    it('brings a spam complaint over as complained, suppressed', async () => {
      expect(await suppressionOf(world, 'spam@example.test')).toBe('complaint')
    })

    it('imports nobody who never made a newsletter choice', async () => {
      expect(await person(world, 'unknown@example.test')).toBeUndefined()
    })

    it('⭐ brings a published post over as a sent broadcast, unpublished', async () => {
      const b = await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, 'p1')).get()
      expect([b?.status, b?.publishedAt]).toEqual(['sent', null])
    })

    it('keeps the slug so the URL survives a later publish', async () => {
      const b = await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, 'p1')).get()
      expect(b?.slug).toBe('hello-world')
    })

    it("keeps Ghost's newsletter numbers", async () => {
      const b = await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, 'p1')).get()
      expect([b?.importedRecipients, b?.importedOpened]).toEqual([50, 20])
    })

    it('leaves the draft behind', async () => {
      expect(await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, 'p2')).get()).toBeUndefined()
    })

    it('⭐ queues no mail', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: an operator connects Mailchimp', () => {
    let world: World
    let run: ImportRun

    beforeAll(async () => {
      const key = 'abcdef0123456789-us21'
      world = createWorld({
        IMPORT_HTTP: fakeImportApis({
          mailchimp: {
            key,
            listId: 'L1',
            members: [
              { email_address: 'sub@example.test', status: 'subscribed', merge_fields: { FNAME: 'Sam', LNAME: 'Sub' }, tags: [{ name: 'Fans' }] },
              { email_address: 'gone@example.test', status: 'unsubscribed' },
              { email_address: 'clean@example.test', status: 'cleaned' },
              { email_address: 'txn@example.test', status: 'transactional' },
            ],
            campaigns: [
              {
                id: 'c1',
                settings: { subject_line: 'Spring news' },
                send_time: '2025-04-01T12:00:00+00:00',
                emails_sent: 10,
                report_summary: { unique_opens: 4, subscriber_clicks: 1 },
                html: '<p>Spring</p>',
              },
            ],
          },
        }).fetcher,
      })
      await world.post('/imports', { source: 'mailchimp', api_key: key, list_id: 'L1' })
      await tickUntilDone(world)
      run = await runOf(world)
    })

    it('finishes the run', () => {
      expect(run.status).toBe('completed')
    })

    it('joins first and last name', async () => {
      expect((await person(world, 'sub@example.test'))?.name).toBe('Sam Sub')
    })

    it('suppresses an audience unsubscribe from everything', async () => {
      expect(await suppressionOf(world, 'gone@example.test')).toBe('unsubscribed_all')
    })

    it('brings a cleaned address over as bounced', async () => {
      expect((await person(world, 'clean@example.test'))?.status).toBe('bounced')
    })

    it('imports no transactional-only contact', async () => {
      expect(await person(world, 'txn@example.test')).toBeUndefined()
    })

    it('brings the sent campaign over with its numbers', async () => {
      const b = await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, 'c1')).get()
      expect([b?.status, b?.importedRecipients, b?.importedOpened, b?.importedClicked]).toEqual(['sent', 10, 4, 1])
    })
  })

  describe('Scenario: an operator connects Drip', () => {
    let world: World
    let run: ImportRun

    beforeAll(async () => {
      world = createWorld({
        IMPORT_HTTP: fakeImportApis({
          drip: {
            token: 'drip-token',
            accountId: '9999',
            tags: ['Lead'],
            subscribers: [
              { email: 'lead@example.test', status: 'active', first_name: 'Lee', tags: ['Lead'] },
              { email: 'left@example.test', status: 'unsubscribed' },
            ],
            broadcasts: [{ id: 'd1', subject: 'Drip news', html_body: '<p>News</p>', send_at: '2025-05-01T00:00:00Z' }],
          },
        }).fetcher,
      })
      await world.post('/imports', { source: 'drip', api_key: 'drip-token', account_id: '9999' })
      await tickUntilDone(world)
      run = await runOf(world)
    })

    it('finishes the run', () => {
      expect(run.status).toBe('completed')
    })

    it('brings an active subscriber over as active', async () => {
      expect((await person(world, 'lead@example.test'))?.status).toBe('active')
    })

    it('suppresses a Drip unsubscribe from everything', async () => {
      expect(await suppressionOf(world, 'left@example.test')).toBe('unsubscribed_all')
    })

    it('brings the sent broadcast over with no invented numbers', async () => {
      const b = await world.db.select().from(broadcasts).where(eq(broadcasts.importedSourceId, 'd1')).get()
      expect([b?.status, b?.importedRecipients]).toEqual(['sent', null])
    })
  })

  // ───────────────────────────────────────────── stopping, failing, waiting

  describe('Scenario: the operator cancels a run part way through', () => {
    let run: ImportRun
    let requestsAfterCancel: number
    let cancelStatus: number

    beforeAll(async () => {
      const fake = fakeImportApis(kitData())
      const world = createWorld({ IMPORT_HTTP: fake.fetcher })
      await world.post('/imports', { source: 'kit', api_key: KIT_KEY })
      await world.tick()
      cancelStatus = (await world.post('/imports/1/cancel', {})).status
      const before = fake.requests.length
      await world.tick()
      await world.tick()
      requestsAfterCancel = fake.requests.length - before
      run = await runOf(world)
    })

    it('accepts the cancel', () => {
      expect(cancelStatus).toBe(302)
    })

    it('marks the run cancelled', () => {
      expect(run.status).toBe('cancelled')
    })

    it('drops the key', () => {
      expect(run.credentials).toBeNull()
    })

    it('reads nothing more from Kit', () => {
      expect(requestsAfterCancel).toBe(0)
    })
  })

  describe('Scenario: the key is wrong', () => {
    let location: string | null
    let runs: number

    beforeAll(async () => {
      const world = createWorld({ IMPORT_HTTP: fakeImportApis(kitData()).fetcher })
      location = (await world.post('/imports', { source: 'kit', api_key: 'not-the-key' })).headers.get('location')
      runs = (await world.db.select({ n: count() }).from(importRuns).get())?.n ?? 0
    })

    it('says Kit refused it', () => {
      expect(decodeURIComponent(location ?? '')).toContain('Kit refused the key')
    })

    it('queues nothing', () => {
      expect(runs).toBe(0)
    })
  })

  describe('Scenario: Kit is down for a minute, then revokes the key', () => {
    let afterOutage: ImportRun
    let afterRevoke: ImportRun

    beforeAll(async () => {
      const fake = fakeImportApis(kitData())
      const world = createWorld({ IMPORT_HTTP: fake.fetcher })
      await world.post('/imports', { source: 'kit', api_key: KIT_KEY })
      fake.failWith(503)
      await world.tick()
      afterOutage = await runOf(world)
      fake.failWith(401)
      await world.tick()
      afterRevoke = await runOf(world)
    })

    it('keeps the run alive through an outage', () => {
      expect(afterOutage.status).toBe('queued')
    })

    it('counts the failed page', () => {
      expect(afterOutage.failures).toBe(1)
    })

    it('fails the run for good when the key is refused', () => {
      expect(afterRevoke.status).toBe('failed')
    })

    it('says why', () => {
      expect(afterRevoke.lastError).toContain('refused the key')
    })

    it('drops the key of a failed run too', () => {
      expect(afterRevoke.credentials).toBeNull()
    })
  })

  describe('Scenario: a broadcast is going out in the same minute', () => {
    let pages: number

    beforeAll(async () => {
      const world = createWorld({ IMPORT_HTTP: fakeImportApis(kitData()).fetcher })
      const id = await aBroadcast(world)
      await world.db.update(broadcasts).set({ status: 'sending', startedAt: new Date() }).where(eq(broadcasts.id, id))
      await world.post('/imports', { source: 'kit', api_key: KIT_KEY })
      await world.tick()
      pages = (await runOf(world)).pages
    })

    it('lets the send have the minute and reads no import page', () => {
      expect(pages).toBe(0)
    })
  })

  describe('Scenario: a second import while one is still running', () => {
    let location: string | null
    beforeAll(async () => {
      const world = createWorld({ IMPORT_HTTP: fakeImportApis(kitData()).fetcher })
      await world.post('/imports', { source: 'kit', api_key: KIT_KEY })
      location = (await world.post('/imports', { source: 'kit', api_key: KIT_KEY })).headers.get('location')
    })

    it('is refused: one at a time', () => {
      expect(decodeURIComponent(location ?? '')).toContain('is still running')
    })
  })

  describe('Scenario: a Ghost URL that points somewhere private', () => {
    let location: string | null
    beforeAll(async () => {
      const world = createWorld()
      location = (
        await world.post('/imports', { source: 'ghost', url: 'http://169.254.169.254', admin_key: `${'a'.repeat(24)}:${'b'.repeat(64)}` })
      ).headers.get('location')
    })

    it('is refused before any request is made', () => {
      expect(decodeURIComponent(location ?? '')).toContain('public https://')
    })
  })

  // ───────────────────────────────────────────── the pieces underneath

  describe('Scenario: a finished run is asked to move again', () => {
    it('never leaves completed', () => {
      expect(nextImportStatus('completed', 'page')).toBeNull()
    })

    it('never leaves cancelled', () => {
      expect(nextImportStatus('cancelled', 'finish')).toBeNull()
    })
  })

  describe('Scenario: another tool hands over HTML that spells a tag', () => {
    it('cannot open a tag in the stored Markdown', () => {
      expect(htmlToMarkdown('<p>&lt;script&gt;alert(1)&lt;/script&gt;<script>x()</script></p>').includes('<')).toBe(false)
    })

    it('never keeps a javascript: link', () => {
      expect(htmlToMarkdown('<a href="javascript:alert(1)">click</a>')).toBe('click')
    })
  })
})
