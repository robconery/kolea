// Buying from the store — offer pages on the public site that open a Stripe
// Checkout, with the converting post recorded.
//
// Store checkout, for paid offers. The offer page: Buy is a same-origin POST
// that writes the checkout row first, the converting post comes from `from`,
// and one IP gets 20 Checkouts an hour. The signed `checkout.session.completed`
// books the sale through the one sales door, keyed on the charge, and is
// matched to its row by token AND session id (no charge yet → 500 so Stripe
// redelivers). The return page only reads. Not part of the store: Stripe
// Connect, platform fees, per-buyer file grants, reader sign-in.
//
// ⚠️ The only fake is Stripe's HTTP API, swapped in on `globalThis.fetch` for
// api.stripe.com alone. Routes, core, the webhook's signature check and D1 are
// the production code, driven through `worker.fetch` on both hosts.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { createKind } from '../../src/core/conversions.ts'
import { publishPost } from '../../src/core/posts.ts'
import { CHECKOUTS_PER_IP_PER_HOUR } from '../../src/core/store.ts'
import { upsertPrice, upsertProduct } from '../../src/core/stripe-catalog.ts'
import {
  type StoreCheckout,
  conversions,
  sales,
  storeCheckouts,
  storeOffers,
} from '../../src/db/schema.ts'
import { aBroadcast } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const SITE = 'https://site.example.test'
const WEBHOOK_SECRET = 'whsec_test_store'

// ───────────────────────────────────────────── the fake Stripe

interface FakeStripe {
  sessionBodies: URLSearchParams[]
  calls: string[]
  restore(): void
}

/** Answers api.stripe.com; everything else goes to the real fetch. */
function fakeStripe(opts: { charge?: string | null } = {}): FakeStripe {
  const real = globalThis.fetch
  const sessionBodies: URLSearchParams[] = []
  const calls: string[] = []
  const charge = opts.charge === undefined ? 'ch_store_1' : opts.charge
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.host !== 'api.stripe.com') return real(input, init)
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    if (url.pathname === '/v1/checkout/sessions' && init?.method === 'POST') {
      sessionBodies.push(new URLSearchParams(String(init.body)))
      const n = sessionBodies.length
      return Response.json({ id: `cs_test_${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}` })
    }
    if (url.pathname.startsWith('/v1/payment_intents/')) {
      return Response.json({ id: 'pi_store_1', latest_charge: charge })
    }
    if (url.pathname.endsWith('/line_items')) {
      return Response.json({
        has_more: false,
        data: [
          {
            id: 'li_1',
            description: 'The Course',
            quantity: 1,
            amount_total: 4900,
            price: { id: 'price_once', product: 'prod_course', recurring: null },
          },
        ],
      })
    }
    return new Response('not faked', { status: 404 })
  }) as typeof fetch
  return { sessionBodies, calls, restore: () => (globalThis.fetch = real) }
}

// ───────────────────────────────────────────── helpers

function storeWorld(): World {
  return createWorld({
    SITE_URL: SITE,
    SITE_TITLE: 'Field Notes',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  })
}

/** The catalog a sync would have mirrored: one product, a one-off and a yearly price. */
async function seedCatalog(w: World): Promise<void> {
  await upsertProduct(w.db, {
    id: 'prod_course',
    name: 'The Course',
    description: 'Everything I know about databases.',
    active: true,
    default_price: 'price_once',
    metadata: { sku: 'the-course' },
  })
  await upsertPrice(w.db, {
    id: 'price_once',
    product: 'prod_course',
    nickname: null,
    unit_amount: 4900,
    currency: 'usd',
    active: true,
    recurring: null,
  })
  await upsertPrice(w.db, {
    id: 'price_yearly',
    product: 'prod_course',
    nickname: 'yearly',
    unit_amount: 9900,
    currency: 'usd',
    active: true,
    recurring: { interval: 'year', interval_count: 1 },
  })
}

async function putOnSale(w: World, priceId = 'price_once', slug = ''): Promise<Response> {
  return w.post('/store/for-sale', { product_id: 'prod_course', price_id: priceId, slug })
}

async function aPublishedPost(w: World, subject: string): Promise<number> {
  const id = await aBroadcast(w, { subject, body: 'Go buy the course.' })
  await publishPost(w.db, id)
  return id
}

function site(w: World, path: string, init?: RequestInit): Promise<Response> {
  return w.fetch(`${SITE}${path}`, init)
}

function buy(w: World, slug: string, form: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return site(w, `/offers/${slug}/buy`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: SITE, ...headers },
    body: new URLSearchParams(form),
  })
}

async function signed(body: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${t},v1=${hex}`
}

/** Stripe delivering `checkout.session.completed` for a session. */
async function completed(
  w: World,
  eventId: string,
  session: { id: string; token: string | null; paymentIntent?: string },
): Promise<Response> {
  const body = JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: session.id,
        mode: 'payment',
        payment_status: 'paid',
        customer: null,
        customer_details: { email: 'buyer@example.test', name: 'Bea Buyer' },
        payment_intent: session.paymentIntent ?? 'pi_store_1',
        amount_total: 4900,
        currency: 'usd',
        created: Math.floor(Date.now() / 1000),
        metadata: session.token ? { kolea_checkout: session.token } : {},
      },
    },
  })
  return w.fetch('/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': await signed(body) },
    body,
  })
}

async function onlyCheckout(w: World): Promise<StoreCheckout> {
  const rows = await w.db.select().from(storeCheckouts).all()
  if (rows.length !== 1) throw new Error(`expected one checkout, found ${rows.length}`)
  return rows[0]!
}

// ───────────────────────────────────────────── the Feature

describe('Feature: buying from the store', () => {
  describe('Scenario: the operator puts a product on sale', () => {
    const w = storeWorld()
    let saved: Response
    let page: Response
    let pageHtml: string
    let listHtml: string

    beforeAll(async () => {
      await seedCatalog(w)
      saved = await putOnSale(w)
      page = await site(w, '/offers/the-course')
      pageHtml = await page.text()
      listHtml = await (await site(w, '/offers')).text()
    })

    it('saves the listing and returns to the For sale screen', () => {
      expect(saved.headers.get('location')).toStartWith('/store/for-sale?flash=On%20sale')
    })

    it('gives it a page at /offers/<sku>', () => {
      expect(page.status).toBe(200)
    })

    it('shows a Buy button with the price on the page', () => {
      expect(pageHtml).toContain('Buy · $49.00')
    })

    it('posts Buy to the offer, never naming a price', () => {
      expect(pageHtml).toContain('action="/offers/the-course/buy"')
    })

    it('lists it at /offers', () => {
      expect(listHtml).toContain('href="/offers/the-course"')
    })
  })

  describe('Scenario: a reader clicks through from a post and buys', () => {
    const w = storeWorld()
    let stripe: FakeStripe
    let postId: number
    let pageHtml: string
    let res: Response
    let checkout: StoreCheckout

    beforeAll(async () => {
      stripe = fakeStripe()
      await seedCatalog(w)
      await putOnSale(w)
      postId = await aPublishedPost(w, 'Why I wrote the course')
      pageHtml = await (await site(w, `/offers/the-course?from=${postId}`)).text()
      res = await buy(w, 'the-course', { from: String(postId) })
      checkout = await onlyCheckout(w)
    })
    afterAll(() => stripe.restore())

    it('carries the post into the Buy form', () => {
      expect(pageHtml).toContain(`name="from" value="${postId}"`)
    })

    it('sends the reader to Stripe with a 303', () => {
      expect(res.status).toBe(303)
    })

    it("points at Stripe's checkout URL", () => {
      expect(res.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_1')
    })

    it('opens the session in payment mode', () => {
      expect(stripe.sessionBodies[0]!.get('mode')).toBe('payment')
    })

    it('asks for the listed price', () => {
      expect(stripe.sessionBodies[0]!.get('line_items[0][price]')).toBe('price_once')
    })

    it('asks for exactly one', () => {
      expect(stripe.sessionBodies[0]!.get('line_items[0][quantity]')).toBe('1')
    })

    it("puts the checkout's token in the session metadata", () => {
      expect(stripe.sessionBodies[0]!.get('metadata[kolea_checkout]')).toBe(checkout.token)
    })

    it('returns the buyer to the read-only return page', () => {
      expect(stripe.sessionBodies[0]!.get('success_url')).toBe(`${SITE}/offers/return?token=${checkout.token}`)
    })

    it('⭐ records the converting post on the checkout row', () => {
      expect(checkout.convertedFromBroadcastId).toBe(postId)
    })

    it('records which session the row opened', () => {
      expect(checkout.stripeSessionId).toBe('cs_test_1')
    })
  })

  describe('Scenario: Stripe confirms the payment', () => {
    const w = storeWorld()
    let stripe: FakeStripe
    let postId: number
    let res: Response
    let checkout: StoreCheckout
    let returnRes: Response
    let returnHtml: string

    beforeAll(async () => {
      stripe = fakeStripe()
      await seedCatalog(w)
      await createKind(w.db, { slug: 'any_sale', label: 'Any sale', ruleType: 'any_sale', ruleValue: null, priority: 100 })
      await putOnSale(w)
      postId = await aPublishedPost(w, 'Why I wrote the course')
      await buy(w, 'the-course', { from: String(postId) })
      const started = await onlyCheckout(w)
      res = await completed(w, 'evt_store_1', { id: 'cs_test_1', token: started.token })
      await w.settle()
      checkout = await onlyCheckout(w)
      returnRes = await site(w, `/offers/return?token=${checkout.token}`)
      returnHtml = await returnRes.text()
    })
    afterAll(() => stripe.restore())

    it('answers the webhook 200', () => {
      expect(res.status).toBe(200)
    })

    it('⭐ books the sale on the charge id, through the one sales door', async () => {
      const sale = await w.db.select().from(sales).where(eq(sales.externalId, 'ch_store_1')).get()
      expect(sale?.amountCents).toBe(4900)
    })

    it('completes the checkout row', () => {
      expect(checkout.status).toBe('completed')
    })

    it('ties the checkout to the sale', async () => {
      const sale = await w.db.select().from(sales).where(eq(sales.externalId, 'ch_store_1')).get()
      expect(checkout.saleId).toBe(sale!.id)
    })

    it('fills in the buyer once the sale knows who that is', () => {
      expect(checkout.subscriberId).not.toBeNull()
    })

    it('⭐ copies the converting post onto the sale', async () => {
      const sale = await w.db.select().from(sales).where(eq(sales.externalId, 'ch_store_1')).get()
      expect(sale?.meta.convertedFromBroadcastId).toBe(postId)
    })

    it('records the conversion by the existing rules', async () => {
      const row = await w.db.select({ n: count() }).from(conversions).get()
      expect(row?.n).toBe(1)
    })

    it('⭐ sends no mail — purchase mail stays a deliberate act', async () => {
      expect((await w.outbox()).length).toBe(0)
    })

    it('shows the buyer a confirmed return page', () => {
      expect(returnHtml).toContain('is confirmed')
    })

    it('keeps the return page out of every cache', () => {
      expect(returnRes.headers.get('cache-control')).toBe('private, no-store')
    })
  })

  describe('Scenario: Stripe delivers the same event twice', () => {
    const w = storeWorld()
    let stripe: FakeStripe

    beforeAll(async () => {
      stripe = fakeStripe()
      await seedCatalog(w)
      await putOnSale(w)
      await buy(w, 'the-course')
      const started = await onlyCheckout(w)
      await completed(w, 'evt_twice', { id: 'cs_test_1', token: started.token })
      await completed(w, 'evt_twice', { id: 'cs_test_1', token: started.token })
    })
    afterAll(() => stripe.restore())

    it('books one sale', async () => {
      const row = await w.db.select({ n: count() }).from(sales).get()
      expect(row?.n).toBe(1)
    })
  })

  describe('Scenario: the buyer is back before the webhook', () => {
    const w = storeWorld()
    let stripe: FakeStripe
    let res: Response

    beforeAll(async () => {
      stripe = fakeStripe()
      await seedCatalog(w)
      await putOnSale(w)
      await buy(w, 'the-course')
      res = await site(w, `/offers/return?token=${(await onlyCheckout(w)).token}`)
    })
    afterAll(() => stripe.restore())

    it('asks the browser to reload in three seconds, without script', () => {
      expect(res.headers.get('refresh')).toStartWith('3; url=/offers/return?token=')
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: a reader tries to buy something not on sale', () => {
    const w = storeWorld()
    let stripe: FakeStripe
    let res: Response

    beforeAll(async () => {
      stripe = fakeStripe()
      await seedCatalog(w)
      res = await buy(w, 'the-course')
    })
    afterAll(() => stripe.restore())

    it('is refused as not for sale', () => {
      expect(res.status).toBe(404)
    })

    it('never asks Stripe', () => {
      expect(stripe.calls.length).toBe(0)
    })
  })

  describe('Scenario: the price is archived in Stripe after it went on sale', () => {
    const w = storeWorld()
    let page: Response

    beforeAll(async () => {
      await seedCatalog(w)
      await putOnSale(w)
      await upsertPrice(w.db, {
        id: 'price_once',
        product: 'prod_course',
        nickname: null,
        unit_amount: 4900,
        currency: 'usd',
        active: false,
        recurring: null,
      })
      page = await site(w, '/offers/the-course')
    })

    it('takes the page down by itself', () => {
      expect(page.status).toBe(404)
    })
  })

  describe('Scenario: the operator picks a recurring price', () => {
    const w = storeWorld()
    let res: Response

    beforeAll(async () => {
      await seedCatalog(w)
      res = await putOnSale(w, 'price_yearly')
    })

    it('is refused with a warning', () => {
      expect(res.headers.get('location')).toContain('kind=warn')
    })

    it('puts nothing on sale', async () => {
      const row = await w.db.select({ n: count() }).from(storeOffers).get()
      expect(row?.n).toBe(0)
    })
  })

  describe('Scenario: a Buy arrives naming a post that is not published', () => {
    const w = storeWorld()
    let stripe: FakeStripe
    let checkout: StoreCheckout

    beforeAll(async () => {
      stripe = fakeStripe()
      await seedCatalog(w)
      await putOnSale(w)
      const draft = await aBroadcast(w, { subject: 'A draft' })
      await buy(w, 'the-course', { from: String(draft) })
      checkout = await onlyCheckout(w)
    })
    afterAll(() => stripe.restore())

    it('records no converting post, and still sells', () => {
      expect(checkout.convertedFromBroadcastId).toBeNull()
    })
  })

  describe('Scenario: another site posts a Buy', () => {
    const w = storeWorld()
    let stripe: FakeStripe
    let res: Response

    beforeAll(async () => {
      stripe = fakeStripe()
      await seedCatalog(w)
      await putOnSale(w)
      res = await buy(w, 'the-course', {}, { Origin: 'https://evil.example.test' })
    })
    afterAll(() => stripe.restore())

    it('is forbidden', () => {
      expect(res.status).toBe(403)
    })
  })

  describe('Scenario: one address opens too many Checkouts in an hour', () => {
    const w = storeWorld()
    let stripe: FakeStripe
    let res: Response

    beforeAll(async () => {
      stripe = fakeStripe()
      await seedCatalog(w)
      await putOnSale(w)
      for (let i = 0; i < CHECKOUTS_PER_IP_PER_HOUR; i++) {
        await buy(w, 'the-course', {}, { 'CF-Connecting-IP': '203.0.113.9' })
      }
      res = await buy(w, 'the-course', {}, { 'CF-Connecting-IP': '203.0.113.9' })
    })
    afterAll(() => stripe.restore())

    it('says too many tries', () => {
      expect(res.status).toBe(429)
    })
  })

  describe("Scenario: a completed session carries a token from another session", () => {
    const w = storeWorld()
    let stripe: FakeStripe
    let checkout: StoreCheckout

    beforeAll(async () => {
      stripe = fakeStripe()
      await seedCatalog(w)
      await putOnSale(w)
      await buy(w, 'the-course')
      const started = await onlyCheckout(w)
      await completed(w, 'evt_forged', { id: 'cs_someone_else', token: started.token })
      checkout = await onlyCheckout(w)
    })
    afterAll(() => stripe.restore())

    it('completes nothing', () => {
      expect(checkout.status).toBe('open')
    })
  })

  describe('Scenario: Stripe reports the session paid before the charge exists', () => {
    const w = storeWorld()
    let stripe: FakeStripe
    let res: Response

    beforeAll(async () => {
      stripe = fakeStripe({ charge: null })
      await seedCatalog(w)
      await putOnSale(w)
      await buy(w, 'the-course')
      res = await completed(w, 'evt_early', { id: 'cs_test_1', token: (await onlyCheckout(w)).token })
    })
    afterAll(() => stripe.restore())

    it('answers 500 so Stripe redelivers, rather than losing the converting post', () => {
      expect(res.status).toBe(500)
    })
  })
})
