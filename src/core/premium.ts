import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  type MemberSubscription,
  broadcasts,
  memberSubscriptions,
  premiumCheckouts,
  premiumSettings,
  stripePrices,
  subscribers,
} from '../db/schema.ts'
import type { Env } from '../types.ts'
import { isValidEmail, normalizeEmail, randomToken } from './ids.ts'
import { REQUESTS_PER_IP_PER_HOUR, type Viewer, requestsFromIpSince } from './members.ts'
import { billingConfigured, billingFor } from './premium-billing.ts'
import { type Observation, entitles, observe, statusFromStripe } from './premium-lifecycle.ts'
import { type StripeCheckoutSession, type StripeSubscriptionObject, idOf } from './stripe-client.ts'
import { upsertSubscriber } from './subscribers.ts'

/**
 * ⭐ Premium: the one paid membership level, billed on the operator's own
 * Stripe as a monthly or a yearly subscription.
 *
 * Access comes ONLY from the signature-verified webhook. The Checkout return
 * page grants nothing; it reads what the webhook wrote. Every Checkout is a
 * `premium_checkouts` row before Stripe hears of it, and the webhook applies
 * what that row says, so a session naming an unknown checkout, or a different
 * Stripe session than the row's, grants nothing.
 *
 * Paying is not consent: a buyer the list has never seen is created `pending`
 * (invisible to broadcasts, no welcome sequence), and an existing subscriber's
 * status is never touched — an unsubscribed reader who pays stays unsubscribed
 * from the newsletter.
 *
 * Money is booked by the ordinary webhook path: every paid invoice is a `sales`
 * row under `recordSale`'s rules. This module only keeps the membership state.
 */

export type Interval = 'month' | 'year'

export interface PremiumPrice {
  priceId: string
  amountCents: number | null
  currency: string
}

// ───────────────────────────────────────────────── settings

export async function getPremiumSettings(db: Db) {
  return (await db.select().from(premiumSettings).where(eq(premiumSettings.id, 1)).get()) ?? null
}

/** The prices on sale, with their amounts from the synced catalog. */
export async function premiumPrices(db: Db): Promise<Partial<Record<Interval, PremiumPrice>>> {
  const s = await getPremiumSettings(db)
  const out: Partial<Record<Interval, PremiumPrice>> = {}
  const wanted = [
    ['month', s?.monthlyPriceId],
    ['year', s?.yearlyPriceId],
  ] as const
  for (const [interval, priceId] of wanted) {
    if (!priceId) continue
    const p = await db.select().from(stripePrices).where(eq(stripePrices.id, priceId)).get()
    out[interval] = { priceId, amountCents: p?.unitAmount ?? null, currency: p?.currency ?? 'usd' }
  }
  return out
}

/** Recurring prices in the synced catalog a plan could use. */
export async function premiumPriceOptions(db: Db, interval: Interval) {
  return await db
    .select({
      id: stripePrices.id,
      nickname: stripePrices.nickname,
      unitAmount: stripePrices.unitAmount,
      currency: stripePrices.currency,
      productId: stripePrices.productId,
    })
    .from(stripePrices)
    .where(and(eq(stripePrices.interval, interval), eq(stripePrices.active, true), eq(stripePrices.intervalCount, 1)))
    .all()
}

export type SaveSettingsResult = { ok: true } | { ok: false; reason: string }

/**
 * Pick the monthly and yearly prices. Each must be an active, synced Stripe
 * price billed every one month (or year); empty takes that plan off sale.
 * Existing subscriptions are untouched — Stripe keeps billing them.
 */
export async function savePremiumSettings(
  db: Db,
  input: { monthlyPriceId: string | null; yearlyPriceId: string | null },
): Promise<SaveSettingsResult> {
  for (const [interval, id] of [
    ['month', input.monthlyPriceId],
    ['year', input.yearlyPriceId],
  ] as const) {
    if (!id) continue
    const p = await db.select().from(stripePrices).where(eq(stripePrices.id, id)).get()
    if (!p) return { ok: false, reason: `${id} is not in the synced Stripe catalog. Sync the catalog first.` }
    if (!p.active) return { ok: false, reason: `${id} is archived in Stripe.` }
    if (p.interval !== interval || p.intervalCount !== 1) {
      return { ok: false, reason: `${id} does not bill every ${interval}.` }
    }
  }
  const values = {
    monthlyPriceId: input.monthlyPriceId || null,
    yearlyPriceId: input.yearlyPriceId || null,
    updatedAt: new Date(),
  }
  await db
    .insert(premiumSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: premiumSettings.id, set: values })
  return { ok: true }
}

/** Premium can be sold: a price on sale and a payment port that can start Checkout. */
export async function premiumOnSale(env: Env, db: Db): Promise<boolean> {
  if (!billingConfigured(env)) return false
  const prices = await premiumPrices(db)
  return Boolean(prices.month || prices.year)
}

// ───────────────────────────────────────────────── starting a checkout

export type StartCheckoutResult =
  | { ok: true; url: string; token: string }
  | { ok: false; reason: 'not_on_sale' | 'already_premium' | 'throttled' | 'provider_error'; detail?: string }

/**
 * Start a Stripe Checkout for `interval`. A member who already holds a live
 * subscription (active or past due) gets no second Checkout. The converting
 * post is recorded on the row and the session's metadata.
 */
export async function startPremiumCheckout(
  env: Env,
  db: Db,
  input: {
    interval: Interval
    viewer: Viewer
    fromSlug?: string | null
    ip?: string | null
    userAgent?: string | null
    origin: string
    now?: Date
  },
): Promise<StartCheckoutResult> {
  const now = input.now ?? new Date()
  if (!billingConfigured(env)) return { ok: false, reason: 'not_on_sale' }
  const price = (await premiumPrices(db))[input.interval]
  if (!price) return { ok: false, reason: 'not_on_sale' }

  if (input.viewer.subscriberId && (await liveSubscription(db, input.viewer.subscriberId))) {
    return { ok: false, reason: 'already_premium' }
  }
  if ((await requestsFromIpSince(db, input.ip ?? null, new Date(now.getTime() - 3_600_000))) >= REQUESTS_PER_IP_PER_HOUR) {
    return { ok: false, reason: 'throttled' }
  }

  const post = input.fromSlug
    ? await db
        .select({ id: broadcasts.id, slug: broadcasts.slug, publishedAt: broadcasts.publishedAt })
        .from(broadcasts)
        .where(eq(broadcasts.slug, input.fromSlug))
        .get()
    : undefined
  const postId = post?.publishedAt ? post.id : null

  const token = randomToken(40)
  const [row] = await db
    .insert(premiumCheckouts)
    .values({
      token,
      interval: input.interval,
      stripePriceId: price.priceId,
      subscriberId: input.viewer.subscriberId,
      convertedFromPostId: postId,
      ip: input.ip ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 400) : null,
      createdAt: now,
    })
    .returning({ id: premiumCheckouts.id })

  try {
    const session = await billingFor(env).createCheckout({
      priceId: price.priceId,
      successUrl: `${input.origin}/premium/return?c=${token}`,
      cancelUrl: postId && post?.slug ? `${input.origin}/${post.slug}` : `${input.origin}/premium`,
      checkoutToken: token,
      customerEmail: input.viewer.email,
      postId,
    })
    await db.update(premiumCheckouts).set({ stripeSessionId: session.id }).where(eq(premiumCheckouts.id, row!.id))
    return { ok: true, url: session.url, token }
  } catch (err) {
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300)
    await db
      .update(premiumCheckouts)
      .set({ status: 'failed', note: `could not start checkout: ${detail}` })
      .where(eq(premiumCheckouts.id, row!.id))
    return { ok: false, reason: 'provider_error', detail }
  }
}

/** A subscriber's live (non-canceled) subscription, if any. */
export async function liveSubscription(db: Db, subscriberId: number): Promise<MemberSubscription | null> {
  const row = await db
    .select()
    .from(memberSubscriptions)
    .where(
      and(
        eq(memberSubscriptions.subscriberId, subscriberId),
        inArray(memberSubscriptions.status, ['active', 'past_due']),
      ),
    )
    .get()
  return row ?? null
}

/** What the return page says. Reads only; it grants nothing. */
export async function checkoutState(db: Db, token: string): Promise<'pending' | 'completed' | 'failed' | 'expired' | 'unknown'> {
  if (!/^[a-z0-9]{20,80}$/.test(token)) return 'unknown'
  const row = await db
    .select({ status: premiumCheckouts.status })
    .from(premiumCheckouts)
    .where(eq(premiumCheckouts.token, token))
    .get()
  if (!row) return 'unknown'
  if (row.status === 'completed' || row.status === 'duplicate') return 'completed'
  if (row.status === 'failed' || row.status === 'ignored') return 'failed'
  if (row.status === 'expired') return 'expired'
  return 'pending'
}

// ───────────────────────────────────────────────── the webhook's side

export type PremiumOutcome = { status: 'processed' | 'ignored'; note: string }

/** The facts a Stripe subscription object carries, whichever API shape it arrived in. */
export function subscriptionFacts(sub: StripeSubscriptionObject) {
  const item = sub.items?.data[0]
  const periodEnd = item?.current_period_end ?? sub.current_period_end ?? null
  const interval = item?.price?.recurring?.interval
  return {
    status: statusFromStripe(sub.status),
    customerId: idOf(sub.customer),
    priceId: item?.price?.id ?? null,
    amountCents: item?.price?.unit_amount ?? null,
    currency: item?.price?.currency ?? null,
    interval: interval === 'month' || interval === 'year' ? (interval as Interval) : null,
    currentPeriodEndAt: periodEnd ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    cancelReason: sub.cancellation_details?.reason ?? null,
  }
}

/**
 * `checkout.session.completed` (or `async_payment_succeeded`) for a Premium
 * Checkout. Finds or creates the buyer's subscriber without touching consent,
 * then writes the subscription `active`. Idempotent: a second delivery finds
 * the checkout already closed.
 */
export async function applyPremiumCheckout(
  env: Env,
  db: Db,
  session: StripeCheckoutSession,
  at: Date,
): Promise<PremiumOutcome> {
  const token = session.metadata?.kolea_checkout ?? ''
  const checkout = await db.select().from(premiumCheckouts).where(eq(premiumCheckouts.token, token)).get()
  if (!checkout) return { status: 'ignored', note: 'premium: no checkout matches this session' }
  if (checkout.stripeSessionId && checkout.stripeSessionId !== session.id) {
    return { status: 'ignored', note: `premium: checkout #${checkout.id} belongs to another session` }
  }
  if (checkout.status === 'completed' || checkout.status === 'duplicate') {
    return { status: 'processed', note: `premium: checkout #${checkout.id} already applied` }
  }
  if (session.payment_status === 'unpaid') {
    // A delayed payment (ACH, SEPA…) completes unpaid; `async_payment_succeeded` follows.
    return { status: 'ignored', note: 'premium: session completed unpaid; waiting for the payment' }
  }

  const subscriptionId = idOf(session.subscription)
  if (!subscriptionId) return { status: 'ignored', note: 'premium: session carries no subscription' }

  const email = normalizeEmail(session.customer_details?.email ?? session.customer_email ?? '')
  if (!isValidEmail(email)) {
    await db
      .update(premiumCheckouts)
      .set({ status: 'ignored', note: 'Stripe collected no usable address', stripeSubscriptionId: subscriptionId })
      .where(eq(premiumCheckouts.id, checkout.id))
    return { status: 'ignored', note: 'premium: no usable email on the session' }
  }

  // Never fires subscribe sequences, never changes an existing row's status:
  // `pending` applies only to a brand-new row (core/subscribers.ts).
  const { id: subscriberId } = await upsertSubscriber(db, {
    email,
    name: session.customer_details?.name ?? null,
    source: 'premium',
    status: 'pending',
    triggerSubscribeSequences: false,
  })
  if (!subscriberId) return { status: 'ignored', note: 'premium: could not resolve the buyer' }

  const facts = subscriptionFacts(await billingFor(env).retrieveSubscription(subscriptionId))
  const customerId = facts.customerId ?? idOf(session.customer)

  if (await liveSubscription(db, subscriberId)) {
    // Paid twice. The second Stripe subscription is not recorded as live; the
    // checkout keeps its ids so the operator can cancel and refund it in Stripe.
    await db
      .update(premiumCheckouts)
      .set({
        status: 'duplicate',
        note: 'already held a live subscription: cancel and refund this one in Stripe',
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId,
        completedAt: at,
      })
      .where(eq(premiumCheckouts.id, checkout.id))
    return { status: 'processed', note: `premium: ${email} paid twice (checkout #${checkout.id})` }
  }

  const price = await db.select().from(stripePrices).where(eq(stripePrices.id, checkout.stripePriceId)).get()
  const status = facts.status === 'canceled' ? 'canceled' : facts.status === 'past_due' ? 'past_due' : 'active'

  await db
    .insert(memberSubscriptions)
    .values({
      subscriberId,
      checkoutId: checkout.id,
      status,
      interval: facts.interval ?? checkout.interval,
      amountCents: facts.amountCents ?? price?.unitAmount ?? session.amount_total ?? 0,
      currency: facts.currency ?? price?.currency ?? session.currency ?? 'usd',
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripePriceId: facts.priceId ?? checkout.stripePriceId,
      convertedFromPostId: checkout.convertedFromPostId,
      currentPeriodEndAt: facts.currentPeriodEndAt,
      cancelAtPeriodEnd: facts.cancelAtPeriodEnd,
      statusChangedAt: at,
      canceledAt: status === 'canceled' ? at : null,
      stripeEventAt: at,
      createdAt: at,
    })
    .onConflictDoNothing({ target: memberSubscriptions.stripeSubscriptionId })

  await db
    .update(premiumCheckouts)
    .set({
      status: 'completed',
      stripeSubscriptionId: subscriptionId,
      stripeCustomerId: customerId,
      subscriberId: checkout.subscriberId ?? subscriberId,
      completedAt: at,
    })
    .where(eq(premiumCheckouts.id, checkout.id))

  return { status: 'processed', note: `premium: ${email} subscribed (${checkout.interval}ly)` }
}

/** `checkout.session.expired` / `async_payment_failed`: tell abandoned from in progress. */
export async function closePremiumCheckout(
  db: Db,
  session: StripeCheckoutSession,
  status: 'expired' | 'failed',
): Promise<PremiumOutcome> {
  const token = session.metadata?.kolea_checkout ?? ''
  const updated = await db
    .update(premiumCheckouts)
    .set({ status, note: status === 'failed' ? 'the delayed payment failed' : 'Stripe expired it unpaid' })
    .where(and(eq(premiumCheckouts.token, token), eq(premiumCheckouts.status, 'open')))
    .returning({ id: premiumCheckouts.id })
  return updated.length
    ? { status: 'processed', note: `premium: checkout #${updated[0]!.id} ${status}` }
    : { status: 'ignored', note: 'premium: no open checkout matches this session' }
}

/**
 * Apply what Stripe says a subscription now is, through the lifecycle's
 * transition table. Unknown subscriptions (not Premium, or not recorded yet —
 * the checkout event reads the subscription fresh when it lands) are ignored.
 */
export async function observeSubscription(
  db: Db,
  stripeSubscriptionId: string,
  obs: Observation,
): Promise<PremiumOutcome> {
  const row = await db
    .select()
    .from(memberSubscriptions)
    .where(eq(memberSubscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .get()
  if (!row) return { status: 'ignored', note: 'premium: not a recorded Premium subscription' }

  const result = observe(row, obs)
  if (result.kind === 'stale') return { status: 'ignored', note: 'premium: older than the last event applied' }
  if (result.kind === 'refused') return { status: 'ignored', note: 'premium: subscription is canceled (final)' }

  await db.update(memberSubscriptions).set(result.patch).where(eq(memberSubscriptions.id, row.id))
  return {
    status: 'processed',
    note:
      result.kind === 'changed' && result.patch.status
        ? `premium: ${row.status} → ${result.patch.status}`
        : 'premium: billing details updated',
  }
}

/** For the sale meta: is this Stripe subscription a Premium membership? */
export async function premiumSubscriptionId(db: Db, stripeSubscriptionId: string | null): Promise<number | null> {
  if (!stripeSubscriptionId) return null
  const row = await db
    .select({ id: memberSubscriptions.id })
    .from(memberSubscriptions)
    .where(eq(memberSubscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .get()
  return row?.id ?? null
}

// ───────────────────────────────────────────────── the admin's view

/** Checkouts that completed for somebody already premium: the operator refunds these. */
export async function paidTwice(db: Db) {
  return await db
    .select({
      id: premiumCheckouts.id,
      completedAt: premiumCheckouts.completedAt,
      stripeSubscriptionId: premiumCheckouts.stripeSubscriptionId,
      stripeCustomerId: premiumCheckouts.stripeCustomerId,
      email: subscribers.email,
    })
    .from(premiumCheckouts)
    .leftJoin(subscribers, eq(subscribers.id, premiumCheckouts.subscriberId))
    .where(eq(premiumCheckouts.status, 'duplicate'))
    .orderBy(desc(premiumCheckouts.id))
    .limit(50)
    .all()
}

/** Headline numbers for the Members screen. */
export async function premiumTotals(db: Db) {
  const rows = await db
    .select({ status: memberSubscriptions.status, interval: memberSubscriptions.interval })
    .from(memberSubscriptions)
    .all()
  return {
    active: rows.filter((r) => entitles(r.status)).length,
    pastDue: rows.filter((r) => r.status === 'past_due').length,
    canceled: rows.filter((r) => r.status === 'canceled').length,
    monthly: rows.filter((r) => entitles(r.status) && r.interval === 'month').length,
    yearly: rows.filter((r) => entitles(r.status) && r.interval === 'year').length,
  }
}

/** Which posts converted people to Premium, most first. */
export async function convertingPosts(db: Db) {
  const rows = await db
    .select({ postId: memberSubscriptions.convertedFromPostId, subject: broadcasts.subject })
    .from(memberSubscriptions)
    .innerJoin(broadcasts, eq(broadcasts.id, memberSubscriptions.convertedFromPostId))
    .all()
  const counts = new Map<number, { postId: number; subject: string; count: number }>()
  for (const r of rows) {
    if (!r.postId) continue
    const cur = counts.get(r.postId) ?? { postId: r.postId, subject: r.subject, count: 0 }
    cur.count++
    counts.set(r.postId, cur)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}
