// Going Premium: a paid membership on the operator's own Stripe
//
// Members and Premium (the Premium half).
// The rules: one Premium level, with a monthly and a yearly price; Checkout,
// with access ONLY from the signed webhook, and find-or-create the buyer
// without touching consent; a premium_checkouts row first, the converting
// post, session must match the row, no second Checkout for a live member,
// "paid twice"; the return page grants nothing; subscription events go through
// the transition table, stale events change nothing, canceled is final; what a
// subscription records; premium = an `active` row; plus "a sale for each paid
// invoice" under the existing recordSale rules.
//
// The only fake is the payment port (`PREMIUM_BILLING=fake`). Webhooks are
// signed with a test secret and go through the real `/webhooks/stripe` path,
// its signature check and its `stripe_events` dedupe.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { unsubscribeBroadcasts } from '../../src/core/consent.ts'
import { fakeBilling } from '../../src/core/premium-billing.ts'
import { publishPost } from '../../src/core/posts.ts'
import type { StripeSubscriptionObject } from '../../src/core/stripe-client.ts'
import {
  memberSubscriptions,
  premiumCheckouts,
  sales,
  stripeEvents,
  stripePrices,
  stripeProducts,
  subscribers,
} from '../../src/db/schema.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const SITE = 'https://site.example.test'
const WHSEC = 'whsec_test_premium'
const PREMIUM_LINE = 'Here is the part only paying readers get.'

function premiumWorld(): World {
  return createWorld({
    SITE_URL: SITE,
    SITE_TITLE: 'Field Notes',
    MEMBER_SESSION_SECRET: 'test-member-secret-0123456789abcdef',
    PREMIUM_BILLING: 'fake',
    STRIPE_WEBHOOK_SECRET: WHSEC,
  })
}

function sitePost(w: World, path: string, form: Record<string, string>, cookie?: string) {
  return w.fetch(`${SITE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: SITE,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(form),
    redirect: 'manual',
  })
}

function siteGet(w: World, path: string, cookie?: string) {
  return w.fetch(`${SITE}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
}

async function signInAs(w: World, email: string): Promise<string> {
  await sitePost(w, '/members/sign-in', { email })
  const mail = (await w.outbox()).filter((m) => m.toEmail === email).at(-1)
  const token = /members\/verify\?token=([a-z0-9]+)/.exec(mail?.html ?? '')?.[1] ?? ''
  const res = await sitePost(w, '/members/verify', { token })
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

// ───────────────────────────────────────────── Stripe, signed

let eventCounter = 0

async function sign(body: string, secret = WHSEC): Promise<string> {
  const t = Math.floor(Date.now() / 1000)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${t},v1=${hex}`
}

async function webhook(
  w: World,
  type: string,
  object: Record<string, unknown>,
  opts: { id?: string; created?: number; secret?: string } = {},
): Promise<Response> {
  const body = JSON.stringify({
    id: opts.id ?? `evt_${++eventCounter}`,
    type,
    created: opts.created ?? Math.floor(Date.now() / 1000),
    data: { object },
  })
  return await w.fetch('/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': await sign(body, opts.secret) },
    body,
  })
}

function aSubscription(id: string, status = 'active'): StripeSubscriptionObject {
  return {
    id,
    status,
    customer: `cus_${id}`,
    cancel_at_period_end: false,
    items: {
      has_more: false,
      data: [
        {
          id: `si_${id}`,
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
          price: { id: 'price_month', unit_amount: 900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } },
        },
      ],
    },
  }
}

function completedSession(sessionId: string, token: string, subscriptionId: string, email: string) {
  return {
    id: sessionId,
    object: 'checkout.session',
    mode: 'subscription',
    payment_status: 'paid',
    status: 'complete',
    customer: `cus_${subscriptionId}`,
    customer_details: { email, name: null },
    subscription: subscriptionId,
    payment_intent: null,
    amount_total: 900,
    currency: 'usd',
    created: Math.floor(Date.now() / 1000),
    metadata: { kolea_checkout: token },
  }
}

function paidInvoice(id: string, subscriptionId: string, email: string, charge: string) {
  return {
    id,
    customer: `cus_${subscriptionId}`,
    customer_email: email,
    amount_paid: 900,
    currency: 'usd',
    created: Math.floor(Date.now() / 1000),
    status: 'paid',
    billing_reason: 'subscription_cycle',
    parent: { subscription_details: { subscription: subscriptionId } },
    payments: {
      has_more: false,
      data: [{ id: `inpay_${id}`, status: 'paid', amount_paid: 900, payment: { type: 'charge', charge } }],
    },
    lines: {
      has_more: false,
      data: [
        {
          id: `il_${id}`,
          description: 'Premium (monthly)',
          quantity: 1,
          amount: 900,
          pricing: { price_details: { price: 'price_month', product: 'prod_premium' } },
          period: { start: 0, end: 0 },
        },
      ],
    },
  }
}

/** A site selling Premium, with one Premium post. Prices picked on the admin screen. */
async function sellingPremium(w: World): Promise<{ postId: number; saved: Response }> {
  const now = new Date()
  await w.db.insert(stripeProducts).values({ id: 'prod_premium', name: 'Premium', syncedAt: now })
  await w.db.insert(stripePrices).values([
    { id: 'price_month', productId: 'prod_premium', unitAmount: 900, currency: 'usd', interval: 'month', syncedAt: now },
    { id: 'price_year', productId: 'prod_premium', unitAmount: 9000, currency: 'usd', interval: 'year', syncedAt: now },
  ])
  const saved = await w.post('/members/prices', { monthly: 'price_month', yearly: 'price_year' })
  const postId = await aBroadcast(w, { subject: 'The deep dive', body: `Open with a hook.\n\n${PREMIUM_LINE}` })
  await publishPost(w.db, postId, { slug: 'deep-dive', excerpt: 'Everything I know.', accessLevel: 'premium' })
  return { postId, saved }
}

/** Press Upgrade on the post, then have Stripe report the completed Checkout. */
async function goPremium(w: World, email: string, subscriptionId: string, cookie?: string) {
  const res = await sitePost(w, '/premium/checkout', { interval: 'month', from: 'deep-dive' }, cookie)
  const checkout = fakeBilling.checkouts.at(-1)!
  fakeBilling.subscriptions.set(subscriptionId, aSubscription(subscriptionId))
  const hook = await webhook(w, 'checkout.session.completed', completedSession(checkout.id, checkout.checkoutToken, subscriptionId, email))
  return { res, checkout, hook }
}

describe('Feature: going Premium', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: an unsubscribed member upgrades from a Premium post', () => {
    let w: World
    let postId: number
    let saved: Response
    let before: string
    let upgrade: Response
    let checkout: (typeof fakeBilling.checkouts)[number]
    let hook: Response
    let sub: typeof memberSubscriptions.$inferSelect | undefined
    let row: typeof premiumCheckouts.$inferSelect | undefined
    let status: string | undefined
    let after: string
    let returnPage: string
    let admin: string

    beforeAll(async () => {
      w = premiumWorld()
      fakeBilling.reset()
      ;({ postId, saved } = await sellingPremium(w))
      const ada = await aPerson(w, { email: 'ada@example.test' })
      await unsubscribeBroadcasts(w.db, ada.id)
      const cookie = await signInAs(w, 'ada@example.test')
      before = await (await siteGet(w, '/deep-dive', cookie)).text()
      ;({ res: upgrade, checkout, hook } = await goPremium(w, 'ada@example.test', 'sub_ada', cookie))
      sub = await w.db.select().from(memberSubscriptions).get()
      row = await w.db.select().from(premiumCheckouts).get()
      status = (await w.db.select().from(subscribers).where(eq(subscribers.id, ada.id)).get())?.status
      after = await (await siteGet(w, '/deep-dive', cookie)).text()
      returnPage = await (await siteGet(w, `/premium/return?c=${checkout.checkoutToken}`, cookie)).text()
      admin = await (await w.fetch('/members')).text()
    })

    it('saves the prices from the synced catalog', () => {
      expect(saved.headers.get('location')).toContain('Premium%20prices%20saved')
    })

    it('shows a free member the teaser', () => {
      expect(before).not.toContain(PREMIUM_LINE)
    })

    it('offers them Premium, naming the post', () => {
      expect(before).toContain('/premium?from=deep-dive')
    })

    it('sends Upgrade to Stripe Checkout', () => {
      expect(upgrade.headers.get('location')).toBe(checkout.url)
    })

    it('asks Stripe for the monthly price', () => {
      expect(checkout.priceId).toBe('price_month')
    })

    it('pre-fills the signed-in member’s address', () => {
      expect(checkout.customerEmail).toBe('ada@example.test')
    })

    it('records the post that converted them on the checkout', () => {
      expect(row?.convertedFromPostId).toBe(postId)
    })

    it('puts the post on the session metadata too', () => {
      expect(checkout.postId).toBe(postId)
    })

    it('accepts the signed webhook', () => {
      expect(hook.status).toBe(200)
    })

    it('makes them Premium', () => {
      expect(sub?.status).toBe('active')
    })

    it('records the interval', () => {
      expect(sub?.interval).toBe('month')
    })

    it('records the amount in cents', () => {
      expect(sub?.amountCents).toBe(900)
    })

    it('records the post that converted them on the subscription', () => {
      expect(sub?.convertedFromPostId).toBe(postId)
    })

    it('closes the checkout', () => {
      expect(row?.status).toBe('completed')
    })

    it('⭐ leaves them unsubscribed from the newsletter', () => {
      expect(status).toBe('unsubscribed')
    })

    it('opens the Premium post to them', () => {
      expect(after).toContain(PREMIUM_LINE)
    })

    it('tells them on the return page', () => {
      expect(returnPage).toContain('You’re Premium')
    })

    it('shows the operator the post that converted them', () => {
      expect(admin).toContain('The deep dive')
    })
  })

  describe('Scenario: each paid invoice is a sale', () => {
    let w: World
    let sale: typeof sales.$inferSelect | undefined
    let replay: { status?: string }

    beforeAll(async () => {
      w = premiumWorld()
      fakeBilling.reset()
      await sellingPremium(w)
      await aPerson(w, { email: 'ada@example.test' })
      const cookie = await signInAs(w, 'ada@example.test')
      await goPremium(w, 'ada@example.test', 'sub_ada', cookie)
      await webhook(w, 'invoice.paid', paidInvoice('in_1', 'sub_ada', 'ada@example.test', 'ch_1'), { id: 'evt_invoice_1' })
      replay = (await (
        await webhook(w, 'invoice.paid', paidInvoice('in_1', 'sub_ada', 'ada@example.test', 'ch_1'), { id: 'evt_invoice_1' })
      ).json()) as { status?: string }
      sale = await w.db.select().from(sales).get()
    })

    it('records the sale', () => {
      expect(sale?.amountCents).toBe(900)
    })

    it('keys it on the charge, like every other Stripe sale', () => {
      expect(sale?.externalId).toBe('ch_1')
    })

    it('marks it as a Premium payment', () => {
      expect(typeof sale?.meta.premiumSubscriptionId).toBe('number')
    })

    it('⭐ books a redelivered event once', () => {
      expect(replay.status).toBe('duplicate')
    })
  })

  describe('Scenario: a payment fails, recovers, and the subscription ends', () => {
    let w: World
    let cookie: string
    let pastDue: string | undefined
    let pastDueRead: string
    let staleIgnored: string | undefined
    let recovered: string | undefined
    let canceled: string | undefined
    let afterCancel: string | undefined
    let canceledRead: string

    const statusNow = async () => (await w.db.select().from(memberSubscriptions).get())?.status

    beforeAll(async () => {
      w = premiumWorld()
      fakeBilling.reset()
      await sellingPremium(w)
      await aPerson(w, { email: 'ada@example.test' })
      cookie = await signInAs(w, 'ada@example.test')
      await goPremium(w, 'ada@example.test', 'sub_ada', cookie)
      const t = Math.floor(Date.now() / 1000)

      await webhook(w, 'customer.subscription.updated', aSubscription('sub_ada', 'past_due') as never, { created: t + 10 })
      pastDue = await statusNow()
      pastDueRead = await (await siteGet(w, '/deep-dive', cookie)).text()

      // Stripe does not promise order: an older "active" must change nothing.
      await webhook(w, 'customer.subscription.updated', aSubscription('sub_ada', 'active') as never, { created: t + 5 })
      staleIgnored = await statusNow()

      await webhook(w, 'invoice.paid', paidInvoice('in_2', 'sub_ada', 'ada@example.test', 'ch_2'), { created: t + 20 })
      recovered = await statusNow()

      await webhook(w, 'customer.subscription.deleted', aSubscription('sub_ada', 'canceled') as never, { created: t + 30 })
      canceled = await statusNow()

      await webhook(w, 'customer.subscription.updated', aSubscription('sub_ada', 'active') as never, { created: t + 40 })
      afterCancel = await statusNow()
      canceledRead = await (await siteGet(w, '/deep-dive', cookie)).text()
    })

    it('moves to past due when Stripe says so', () => {
      expect(pastDue).toBe('past_due')
    })

    it('⭐ closes Premium posts while past due', () => {
      expect(pastDueRead).not.toContain(PREMIUM_LINE)
    })

    it('⭐ ignores an event older than the last one applied', () => {
      expect(staleIgnored).toBe('past_due')
    })

    it('recovers when an invoice is paid', () => {
      expect(recovered).toBe('active')
    })

    it('cancels when the subscription is deleted', () => {
      expect(canceled).toBe('canceled')
    })

    it('⭐ never revives a canceled subscription', () => {
      expect(afterCancel).toBe('canceled')
    })

    it('closes Premium posts once canceled', () => {
      expect(canceledRead).not.toContain(PREMIUM_LINE)
    })
  })

  describe('Scenario: a reader the list has never seen pays, signed out', () => {
    let w: World
    let bea: typeof subscribers.$inferSelect | undefined
    let mailed: number
    let checkoutEmail: string | null | undefined

    beforeAll(async () => {
      w = premiumWorld()
      fakeBilling.reset()
      await sellingPremium(w)
      const { checkout } = await goPremium(w, 'bea@example.test', 'sub_bea')
      checkoutEmail = checkout.customerEmail
      bea = await w.db.select().from(subscribers).where(eq(subscribers.email, 'bea@example.test')).get()
      mailed = (await w.outbox()).length
    })

    it('lets Stripe ask for the address', () => {
      expect(checkoutEmail ?? null).toBeNull()
    })

    it('creates them as a subscriber', () => {
      expect(bea?.email).toBe('bea@example.test')
    })

    it('⭐ creates them pending: paying is not joining the newsletter', () => {
      expect(bea?.status).toBe('pending')
    })

    it('⭐ mails them nothing', () => {
      expect(mailed).toBe(0)
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: somebody completes a second Checkout while already Premium', () => {
    let live: number
    let second: typeof premiumCheckouts.$inferSelect | undefined
    let admin: string

    beforeAll(async () => {
      const w = premiumWorld()
      fakeBilling.reset()
      await sellingPremium(w)
      await goPremium(w, 'ada@example.test', 'sub_one')
      await goPremium(w, 'ada@example.test', 'sub_two')
      live = (await w.db.select().from(memberSubscriptions).all()).length
      second = (await w.db.select().from(premiumCheckouts).all()).at(-1)
      admin = await (await w.fetch('/members')).text()
    })

    it('⭐ records one live subscription', () => {
      expect(live).toBe(1)
    })

    it('marks the second checkout as paid twice', () => {
      expect(second?.status).toBe('duplicate')
    })

    it('keeps the second Stripe subscription for a refund', () => {
      expect(second?.stripeSubscriptionId).toBe('sub_two')
    })

    it('lists it for the operator', () => {
      expect(admin).toContain('sub_two')
    })
  })

  describe('Scenario: a Premium member presses Upgrade again', () => {
    let page: string
    let started: number

    beforeAll(async () => {
      const w = premiumWorld()
      fakeBilling.reset()
      await sellingPremium(w)
      await aPerson(w, { email: 'ada@example.test' })
      const cookie = await signInAs(w, 'ada@example.test')
      await goPremium(w, 'ada@example.test', 'sub_ada', cookie)
      page = await (await sitePost(w, '/premium/checkout', { interval: 'year' }, cookie)).text()
      started = fakeBilling.checkouts.length
    })

    it('is told they already have it', () => {
      expect(page).toContain('You already have Premium')
    })

    it('⭐ starts no second Checkout', () => {
      expect(started).toBe(1)
    })
  })

  describe('Scenario: a webhook names a checkout with the wrong session', () => {
    let subs: number
    let event: typeof stripeEvents.$inferSelect | undefined

    beforeAll(async () => {
      const w = premiumWorld()
      fakeBilling.reset()
      await sellingPremium(w)
      await sitePost(w, '/premium/checkout', { interval: 'month' })
      const checkout = fakeBilling.checkouts.at(-1)!
      fakeBilling.subscriptions.set('sub_x', aSubscription('sub_x'))
      await webhook(w, 'checkout.session.completed', completedSession('cs_someone_else', checkout.checkoutToken, 'sub_x', 'x@example.test'), {
        id: 'evt_wrong_session',
      })
      subs = (await w.db.select().from(memberSubscriptions).all()).length
      event = await w.db.select().from(stripeEvents).where(eq(stripeEvents.id, 'evt_wrong_session')).get()
    })

    it('⭐ grants nothing', () => {
      expect(subs).toBe(0)
    })

    it('records the event as ignored', () => {
      expect(event?.status).toBe('ignored')
    })
  })

  describe('Scenario: an unsigned webhook claims a completed Checkout', () => {
    let res: Response
    let subs: number

    beforeAll(async () => {
      const w = premiumWorld()
      fakeBilling.reset()
      await sellingPremium(w)
      await sitePost(w, '/premium/checkout', { interval: 'month' })
      const checkout = fakeBilling.checkouts.at(-1)!
      fakeBilling.subscriptions.set('sub_x', aSubscription('sub_x'))
      res = await webhook(w, 'checkout.session.completed', completedSession(checkout.id, checkout.checkoutToken, 'sub_x', 'x@example.test'), {
        secret: 'whsec_not_ours',
      })
      subs = (await w.db.select().from(memberSubscriptions).all()).length
    })

    it('is rejected', () => {
      expect(res.status).toBe(401)
    })

    it('⭐ grants nothing', () => {
      expect(subs).toBe(0)
    })
  })

  describe('Scenario: the return page before the webhook lands', () => {
    let res: Response

    beforeAll(async () => {
      const w = premiumWorld()
      fakeBilling.reset()
      await sellingPremium(w)
      await sitePost(w, '/premium/checkout', { interval: 'month' })
      res = await siteGet(w, `/premium/return?c=${fakeBilling.checkouts.at(-1)!.checkoutToken}`)
    })

    it('⭐ grants nothing and reloads itself to check again', () => {
      expect(res.headers.get('refresh')).toContain('n=1')
    })
  })

  describe('Scenario: a price that does not bill monthly is picked as the monthly price', () => {
    let location: string | null

    beforeAll(async () => {
      const w = premiumWorld()
      await sellingPremium(w)
      location = (await w.post('/members/prices', { monthly: 'price_year', yearly: '' })).headers.get('location')
    })

    it('is refused', () => {
      expect(location).toContain('kind=warn')
    })
  })
})
