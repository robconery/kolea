// gap.md "Sales history import" — upload a CSV of past sales so revenue covers
// the time before Stripe was connected.
// Kōlea SPEC 16.6 (history import into sales, no attribution), 16.3 (a buyer
// with no subscriber row is `pending` and fires no subscribe trigger), 1.8
// (an import starts no automation), 1.15 (nothing is dropped silently).
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { createCampaign, recordTouch } from '../../src/core/campaigns.ts'
import { type SaleImportReport, importSales, parseAmountCents } from '../../src/core/sale-import.ts'
import { unsubscribeBroadcasts } from '../../src/core/consent.ts'
import { createWebhookEndpoint } from '../../src/core/webhooks.ts'
import { sales, sequenceEnrollments, subscribers, webhookDeliveries } from '../../src/db/schema.ts'
import { aPerson, aSequence } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const HEADER = 'email,amount,currency,date,product,external_id,campaign'

const FILE = [
  HEADER,
  'reader@example.test,49.00,USD,2021-03-04,Handbook,gumroad-1,',
  'stranger@example.test,0.29,usd,2020-01-02,Sticker,,',
  'stranger@example.test,0.29,usd,2020-01-02,Sticker,,',
  'launch@example.test,"1,299.00",usd,2022-11-25,Bundle,shop-9,bf-2022',
].join('\n')

async function upload(world: World, csv: string): Promise<Response> {
  const form = new FormData()
  form.append('file', new File([csv], 'sales.csv', { type: 'text/csv' }))
  return await world.fetch('/sales/import', { method: 'POST', body: form })
}

const saleCount = async (world: World) =>
  (await world.db.select({ n: count() }).from(sales).get())?.n ?? 0

describe('Feature: importing past sales', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: uploading a file of past sales through the admin screen', () => {
    let world: World
    let res: Response
    let html: string

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'reader@example.test' })
      await createCampaign(world.db, 'bf-2022')
      // A live welcome series: if an import ever fired subscribe triggers,
      // the stranger would be mailed by the next tick.
      await aSequence(world, { trigger: 'subscribe' })
      res = await upload(world, FILE)
      html = await res.text()
      await world.tick()
    })

    it('answers the upload', () => {
      expect(res.status).toBe(200)
    })

    it('reports every line in its counts', () => {
      expect(html).toContain('4 created, 0 duplicate, 0 invalid')
    })

    it('books four sales', async () => {
      expect(await saleCount(world)).toBe(4)
    })

    it('reads "0.29" as 29 cents, not through a float', async () => {
      const row = await world.db.select().from(sales).where(eq(sales.product, 'Sticker')).get()
      expect(row?.amountCents).toBe(29)
    })

    it('reads "1,299.00" as 129900 cents', async () => {
      const row = await world.db.select().from(sales).where(eq(sales.externalId, 'shop-9')).get()
      expect(row?.amountCents).toBe(129900)
    })

    it('keeps the date the sale happened', async () => {
      const row = await world.db.select().from(sales).where(eq(sales.externalId, 'gumroad-1')).get()
      expect(row?.occurredAt.toISOString()).toBe('2021-03-04T00:00:00.000Z')
    })

    it('credits the campaign named on the line', async () => {
      const row = await world.db.select().from(sales).where(eq(sales.externalId, 'shop-9')).get()
      expect(row?.campaignId).not.toBeNull()
    })

    it('keeps a buyer who was not on the list off it, as pending', async () => {
      const sub = await world.db
        .select()
        .from(subscribers)
        .where(eq(subscribers.email, 'stranger@example.test'))
        .get()
      expect(sub?.status).toBe('pending')
    })

    it('enrolls nobody in any sequence', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceEnrollments).get())?.n
      expect(n).toBe(0)
    })

    it('sends nobody any mail', async () => {
      expect((await world.outbox()).length).toBe(0)
    })
  })

  describe('Scenario: a webhook receiver is listening when past sales are imported', () => {
    // History, not news: a receiver that fulfils on `purchased` must not
    // ship a 2021 order again.
    let deliveries: number

    beforeAll(async () => {
      const world = createWorld()
      await createWebhookEndpoint(world.db, { url: 'https://hooks.example.com/kolea', events: ['purchased'] })
      await upload(world, FILE)
      deliveries = (await world.db.select().from(webhookDeliveries).all()).length
    })

    it('⭐ emits no purchased webhook', () => {
      expect(deliveries).toBe(0)
    })
  })

  describe('Scenario: uploading the same file twice', () => {
    let world: World
    let second: SaleImportReport

    beforeAll(async () => {
      world = createWorld()
      await createCampaign(world.db, 'bf-2022')
      await importSales(world.db, FILE)
      second = await importSales(world.db, FILE)
    })

    it('creates nothing the second time', () => {
      expect(second.created).toBe(0)
    })

    it('reports every line as a duplicate', () => {
      expect(second.duplicate).toBe(4)
    })

    it('leaves four sales, not eight', async () => {
      expect(await saleCount(world)).toBe(4)
    })
  })

  describe('Scenario: a buyer whose last touch is newer than the sale', () => {
    let world: World
    let campaignId: number | null | undefined

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world, { email: 'toucher@example.test' })
      const launch = await createCampaign(world.db, 'launch-2026')
      await recordTouch(world.db, {
        subscriberId: person.id,
        campaignId: launch,
        sourceKind: 'manual',
        sourceId: null,
        occurredAt: new Date(),
      })
      await importSales(world.db, [HEADER, 'toucher@example.test,10,usd,2019-05-05,Old,old-1,'].join('\n'))
      campaignId = (await world.db.select().from(sales).get())?.campaignId
    })

    it('credits no campaign the line did not name', () => {
      expect(campaignId).toBeNull()
    })
  })

  describe('Scenario: importing a sale for somebody who unsubscribed', () => {
    let world: World
    let status: string | undefined

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world, { email: 'gone@example.test' })
      await unsubscribeBroadcasts(world.db, person.id)
      await importSales(world.db, [HEADER, 'gone@example.test,10,usd,2019-05-05,Old,old-2,'].join('\n'))
      status = (await world.db.select().from(subscribers).where(eq(subscribers.id, person.id)).get())
        ?.status
    })

    it('leaves them unsubscribed', () => {
      expect(status).toBe('unsubscribed')
    })
  })

  // ───────────────────────────────────────────── amounts

  describe('Scenario: amounts parsed as strings', () => {
    it('reads "12.3" as 1230', () => {
      expect(parseAmountCents('12.3', 'usd')).toBe(1230)
    })

    it('reads "$5" as 500', () => {
      expect(parseAmountCents('$5', 'usd')).toBe(500)
    })

    it('reads yen with no minor unit', () => {
      expect(parseAmountCents('500', 'jpy')).toBe(500)
    })

    it('refuses three decimal places', () => {
      expect(parseAmountCents('12.345', 'usd')).toBeNull()
    })

    it('refuses a negative amount', () => {
      expect(parseAmountCents('-5', 'usd')).toBeNull()
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: a file with lines that cannot be booked', () => {
    let world: World
    let report: SaleImportReport

    beforeAll(async () => {
      world = createWorld()
      report = await importSales(
        world.db,
        [
          HEADER,
          'not-an-email,10,usd,2020-01-01,,,',
          'a@example.test,ten,usd,2020-01-01,,,',
          'b@example.test,10,dollars,2020-01-01,,,',
          'c@example.test,10,usd,2999-01-01,,,',
          'd@example.test,10,usd,2020-01-01,,,no-such-campaign',
          'e@example.test,10,usd,2020-01-01,Fine,,',
        ].join('\n'),
      )
    })

    it('refuses the five bad lines', () => {
      expect(report.invalid).toBe(5)
    })

    it('still books the good one', () => {
      expect(report.created).toBe(1)
    })

    it('says why each was refused', () => {
      expect(report.lines.filter((l) => l.outcome === 'invalid' && l.reason).length).toBe(5)
    })

    it('creates no subscriber for a refused line', async () => {
      const n = (await world.db.select({ n: count() }).from(subscribers).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: a file without the required columns', () => {
    let report: SaleImportReport

    beforeAll(async () => {
      report = await importSales(createWorld().db, 'email,amount\na@example.test,10')
    })

    it('refuses the whole file and says which columns are missing', () => {
      expect(report.error).toContain('currency, date')
    })
  })

  describe('Scenario: a file longer than one upload may book', () => {
    let report: SaleImportReport

    beforeAll(async () => {
      const lines = Array.from({ length: 102 }, (_, i) => `p${i}@example.test,1,usd,2020-01-01,,x-${i},`)
      report = await importSales(createWorld().db, [HEADER, ...lines].join('\n'))
    })

    it('reports the lines past the cap as refused, not dropped', () => {
      expect(report.lines.length).toBe(102)
    })
  })
})
