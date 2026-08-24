import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { saleItems, stripePrices, stripeProducts, stripeEvents } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { type SaleResult, recordSale } from './sales.ts'
import { upsertPrice, upsertProduct } from './stripe-catalog.ts'
import {
  type StripeCharge,
  type StripeCheckoutSession,
  type StripeInvoice,
  type StripeLineItem,
  type StripeList,
  type StripePaymentIntent,
  type StripePriceObject,
  type StripeProductObject,
  idOf,
  lineItemAmount,
  lineItemIds,
  stripeGet,
  subscriptionOf,
} from './stripe-client.ts'
import { emailFor } from './stripe.ts'

/**
 * Stripe webhooks — the live path for money.
 *
 * ⭐ The invariant that makes this safe to run alongside the nightly reconcile
 * in `core/stripe.ts`: **a sale's `external_id` is always the Stripe charge id**,
 * whichever event we learned about it from. `recordSale` is idempotent on that
 * id, so the webhook and the reconcile converge on one row instead of booking
 * the same money twice. Any handler that cannot resolve a charge id has to think
 * hard before inventing a different key — see `chargeIdFor`.
 *
 * Nothing here sends mail. A webhook records what happened; deciding to mail
 * somebody about it is a separate, deliberate act (CLAUDE.md).
 */

/** Stripe's own default. Older than this and a replayed body is refused. */
const TOLERANCE_SECONDS = 300

export interface StripeEventEnvelope {
  id: string
  type: string
  created: number
  data: { object: Record<string, unknown> }
}

// ───────────────────────────────────────────────── signature

/**
 * Verify `Stripe-Signature` against the raw request body.
 *
 * The body must be the exact bytes Stripe sent — parse it *after* this, never
 * before, or the re-serialized JSON will not match the signature.
 *
 * Header shape: `t=<unix>,v1=<hex>,v0=<hex>`, possibly several `v1` entries
 * during a secret rotation, and the signed payload is `${t}.${body}`.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!header) return { ok: false, reason: 'missing Stripe-Signature header' }

  let timestamp: string | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2)
    if (key === 't') timestamp = value ?? null
    // Only v1. v0 is a test-mode-only scheme and accepting it would let a
    // weaker signature through on a live endpoint.
    else if (key === 'v1' && value) signatures.push(value)
  }

  if (!timestamp || !signatures.length) return { ok: false, reason: 'malformed Stripe-Signature' }

  const sent = Number(timestamp)
  if (!Number.isFinite(sent)) return { ok: false, reason: 'malformed timestamp' }
  if (Math.abs(nowSeconds - sent) > TOLERANCE_SECONDS) {
    // Without this, a body-and-signature pair captured once stays valid forever.
    return { ok: false, reason: `timestamp outside ${TOLERANCE_SECONDS}s tolerance` }
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  )
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')

  if (!signatures.some((sig) => timingSafeEqual(sig, expected))) {
    return { ok: false, reason: 'no signature matched' }
  }
  return { ok: true }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ───────────────────────────────────────────────── dispatch

export interface HandledEvent {
  eventId: string
  type: string
  status: 'processed' | 'ignored' | 'duplicate' | 'failed'
  note: string
  saleId?: number
}

/**
 * Record the event, then act on it.
 *
 * The `stripe_events` insert comes first and is the idempotency guard: Stripe
 * delivers at-least-once and retries a failing endpoint for three days, so a
 * redelivery has to be recognised *before* it can reach `recordSale`. A
 * conflicting insert means we have seen this `evt_…` already and there is
 * nothing to do.
 */
export async function handleStripeEvent(
  env: Env,
  db: Db,
  event: StripeEventEnvelope,
): Promise<HandledEvent> {
  const object = event.data.object as Record<string, unknown> & { id?: string }
  const objectId = typeof object.id === 'string' ? object.id : null

  const claimed = await db
    .insert(stripeEvents)
    .values({
      id: event.id,
      type: event.type,
      status: 'received',
      objectId,
      receivedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: stripeEvents.id })

  if (!claimed.length) {
    // Seen before — but *why* decides what happens next. A previous attempt that
    // threw left a `failed` row and returned a 500, which is precisely what asks
    // Stripe to redeliver; treating that redelivery as a duplicate would make the
    // retry we requested permanently useless and lose the order. Anything else
    // genuinely is a duplicate and must not touch money twice.
    const previous = await db
      .select({ status: stripeEvents.status })
      .from(stripeEvents)
      .where(eq(stripeEvents.id, event.id))
      .get()

    if (previous?.status !== 'failed') {
      return {
        eventId: event.id,
        type: event.type,
        status: 'duplicate',
        note: `already handled (${previous?.status ?? 'unknown'})`,
      }
    }

    await db
      .update(stripeEvents)
      .set({ status: 'received', note: 'retrying after an earlier failure', processedAt: null })
      .where(eq(stripeEvents.id, event.id))
  }

  try {
    const outcome = await dispatch(env, db, event, object)
    await db
      .update(stripeEvents)
      .set({
        status: outcome.status === 'processed' ? 'processed' : 'ignored',
        note: outcome.note,
        saleId: outcome.saleId ?? null,
        processedAt: new Date(),
      })
      .where(eq(stripeEvents.id, event.id))
    return { eventId: event.id, type: event.type, ...outcome }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db
      .update(stripeEvents)
      .set({ status: 'failed', note: message.slice(0, 500), processedAt: new Date() })
      .where(eq(stripeEvents.id, event.id))
    throw err
  }
}

type Outcome = { status: 'processed' | 'ignored'; note: string; saleId?: number }

async function dispatch(
  env: Env,
  db: Db,
  event: StripeEventEnvelope,
  object: Record<string, unknown>,
): Promise<Outcome> {
  switch (event.type) {
    case 'charge.succeeded':
      return await onCharge(env, db, object as unknown as StripeCharge, false)

    // The object on this event is the Charge, with `amount_refunded` filled in.
    // `charge.refund.updated` carries a Refund instead and is deliberately not
    // handled here — it would need a different parser, and the charge event
    // already tells us everything the sale row cares about.
    case 'charge.refunded':
      return await onCharge(env, db, object as unknown as StripeCharge, true)

    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return await onCheckoutSession(env, db, object as unknown as StripeCheckoutSession)

    case 'invoice.paid':
      return await onInvoicePaid(env, db, object as unknown as StripeInvoice)

    case 'product.created':
    case 'product.updated':
      await upsertProduct(db, object as unknown as StripeProductObject)
      return { status: 'processed', note: 'catalog: product upserted' }

    case 'product.deleted':
      await db
        .update(stripeProducts)
        .set({ active: false, syncedAt: new Date() })
        .where(eq(stripeProducts.id, String(object.id)))
      // Deliberately not a delete: people who bought it still own it, and their
      // download link has to keep resolving.
      return { status: 'processed', note: 'catalog: product marked inactive' }

    case 'price.created':
    case 'price.updated': {
      const ok = await upsertPrice(db, object as unknown as StripePriceObject)
      return ok
        ? { status: 'processed', note: 'catalog: price upserted' }
        : { status: 'ignored', note: 'price names an unsynced product; next catalog sync fixes it' }
    }

    case 'price.deleted':
      await db
        .update(stripePrices)
        .set({ active: false, syncedAt: new Date() })
        .where(eq(stripePrices.id, String(object.id)))
      return { status: 'processed', note: 'catalog: price marked inactive' }

    default:
      // Subscribed-to-but-unhandled is a normal outcome, and it is a row, so a
      // discarded event stays distinguishable from a lost one.
      return { status: 'ignored', note: 'no handler for this event type' }
  }
}

// ───────────────────────────────────────────────── money handlers

/**
 * The money spine. Same grain as the nightly reconcile, deliberately — this and
 * `syncStripe` post identical `external_id`s for the same charge.
 */
async function onCharge(
  env: Env,
  db: Db,
  charge: StripeCharge,
  refundEvent: boolean,
): Promise<Outcome> {
  if (!refundEvent && (!charge.paid || charge.status !== 'succeeded')) {
    return { status: 'ignored', note: `charge is ${charge.status}` }
  }

  const email = await emailFor(env, charge)
  if (!email) return { status: 'ignored', note: 'no email on the charge or its customer' }

  // A partial refund is not a refund: flipping the whole sale would erase revenue
  // that was never returned. Only a fully refunded charge changes the status.
  const fullyRefunded = charge.refunded || charge.amount_refunded >= charge.amount

  const result = await recordSale(db, {
    email,
    name: charge.billing_details?.name ?? null,
    amountCents: charge.amount,
    currency: charge.currency,
    product: charge.description,
    externalId: charge.id,
    campaignSlug: charge.metadata?.campaign ?? null,
    status: fullyRefunded ? 'refunded' : 'paid',
    occurredAt: new Date(charge.created * 1000),
    meta: {
      source: 'stripe:webhook',
      stripeCustomer: charge.customer,
      ...(charge.amount_refunded ? { amountRefunded: charge.amount_refunded } : {}),
    },
  })

  return saleOutcome(result, refundEvent ? 'refund' : 'charge')
}

/**
 * A completed checkout. This is the event that knows *what was bought*.
 *
 * The charge id is resolved through the payment intent so this lands on the same
 * row `charge.succeeded` writes — whichever arrives first creates the sale, and
 * the other is a harmless duplicate. Line items are attached either way, because
 * the duplicate branch is the common one: Stripe usually delivers the charge first.
 */
async function onCheckoutSession(
  env: Env,
  db: Db,
  session: StripeCheckoutSession,
): Promise<Outcome> {
  if (session.payment_status === 'unpaid') {
    return { status: 'ignored', note: `session payment_status is ${session.payment_status}` }
  }

  const email = session.customer_details?.email ?? session.customer_email
  if (!email) return { status: 'ignored', note: 'no email on the checkout session' }

  const chargeId = await chargeIdFor(env, session.payment_intent)
  if (!chargeId) {
    // No charge means no shared key with the reconcile. Recording under the
    // session id would create a second row for the same money the moment a
    // charge does materialize, so this waits for `charge.succeeded` instead.
    return { status: 'ignored', note: 'no charge resolved yet; charge.succeeded will book it' }
  }

  const result = await recordSale(db, {
    email,
    name: session.customer_details?.name ?? null,
    amountCents: session.amount_total ?? 0,
    currency: session.currency ?? 'usd',
    product: null,
    externalId: chargeId,
    campaignSlug: session.metadata?.campaign ?? null,
    occurredAt: new Date(session.created * 1000),
    meta: {
      source: 'stripe:webhook',
      stripeCustomer: session.customer,
      checkoutSession: session.id,
      ...(session.subscription ? { subscription: idOf(session.subscription) } : {}),
    },
  })

  if (!result.saleId) return saleOutcome(result, 'checkout')

  const items = await stripeGet<StripeList<StripeLineItem>>(
    env,
    `/checkout/sessions/${session.id}/line_items`,
    { limit: 100, expand: ['data.price'] },
  )
  const attached = await attachSaleItems(db, result.saleId, items.data)

  return {
    status: 'processed',
    saleId: result.saleId,
    note: `checkout ${result.status}, ${attached} line item(s) attached`,
  }
}

/**
 * A paid invoice — subscription renewals, and anything billed rather than charged.
 *
 * One sale row per invoice, so recurring revenue shows up month over month in
 * `revenueTotals` rather than only at signup, and a single refunded month flips
 * only its own row.
 */
async function onInvoicePaid(env: Env, db: Db, invoice: StripeInvoice): Promise<Outcome> {
  if (invoice.amount_paid <= 0) {
    // A 100%-discounted or credit-balance invoice is real, but it is not revenue,
    // and booking it as a £0 sale only adds a row to every revenue report.
    return { status: 'ignored', note: 'invoice paid nothing' }
  }

  const email = invoice.customer_email ?? (await customerEmail(env, invoice.customer))
  if (!email) return { status: 'ignored', note: 'no email on the invoice or its customer' }

  const { externalId, viaCharge } = await invoiceExternalId(env, invoice)
  const subscription = subscriptionOf(invoice)

  const result = await recordSale(db, {
    email,
    name: invoice.customer_name ?? null,
    amountCents: invoice.amount_paid,
    currency: invoice.currency,
    product: invoice.lines?.data[0]?.description ?? null,
    externalId,
    campaignSlug: invoice.metadata?.campaign ?? null,
    occurredAt: new Date(invoice.created * 1000),
    meta: {
      source: 'stripe:webhook',
      stripeCustomer: invoice.customer,
      invoice: invoice.id,
      invoiceNumber: invoice.number ?? null,
      billingReason: invoice.billing_reason ?? null,
      ...(subscription ? { subscription } : {}),
      // Says whether this row shares a key with the reconcile or not. Without it,
      // an invoice keyed on `in_…` is indistinguishable from one keyed on `ch_…`.
      keyedOn: viaCharge ? 'charge' : 'invoice',
    },
  })

  if (!result.saleId) return saleOutcome(result, 'invoice')

  const attached = await attachSaleItems(db, result.saleId, invoice.lines?.data ?? [])
  return {
    status: 'processed',
    saleId: result.saleId,
    note: `invoice ${result.status}${subscription ? ' (subscription)' : ''}, ${attached} line item(s) attached`,
  }
}

// ───────────────────────────────────────────────── helpers

/**
 * The charge behind a payment intent.
 *
 * One extra round trip per order, and worth it: it is what keeps the webhook and
 * the nightly reconcile writing the same `external_id`.
 */
async function chargeIdFor(env: Env, paymentIntentId: string | null): Promise<string | null> {
  if (!paymentIntentId) return null
  try {
    const intent = await stripeGet<StripePaymentIntent>(
      env,
      `/payment_intents/${paymentIntentId}`,
      {},
    )
    return idOf(intent.latest_charge)
  } catch {
    return null
  }
}

/**
 * What to key an invoice's sale on.
 *
 * ⚠️ This API version removed `invoice.charge` and `invoice.payment_intent`. The
 * payment hangs off `payments.data[].payment` instead, and reaching for the old
 * flat fields yields `undefined` rather than an error — which would silently key
 * every renewal on the invoice id and double-count it against the reconcile.
 *
 * Falling back to the invoice id is safe only when there is no payment intent at
 * all: no payment intent means no charge, which means `charge.succeeded` will
 * never fire for this money and there is nothing to collide with.
 */
async function invoiceExternalId(
  env: Env,
  invoice: StripeInvoice,
): Promise<{ externalId: string; viaCharge: boolean }> {
  for (const payment of invoice.payments?.data ?? []) {
    if (payment.status !== 'paid') continue

    const direct = idOf(payment.payment?.charge)
    if (direct) return { externalId: direct, viaCharge: true }

    const intentId = idOf(payment.payment?.payment_intent)
    const chargeId = await chargeIdFor(env, intentId)
    if (chargeId) return { externalId: chargeId, viaCharge: true }
  }
  return { externalId: invoice.id, viaCharge: false }
}

async function customerEmail(env: Env, customerId: string | null): Promise<string | null> {
  if (!customerId) return null
  try {
    const customer = await stripeGet<{ email: string | null }>(env, `/customers/${customerId}`, {})
    return customer.email
  } catch {
    return null
  }
}

/**
 * Write what a sale contained.
 *
 * Idempotent through the `(sale_id, stripe_price_id)` unique index, so a
 * redelivered checkout session re-attaching the same basket is a no-op rather
 * than a doubled receipt. Lines with no price — Stripe's own tax and shipping
 * rows — are skipped: they are money, not things you own.
 */
export async function attachSaleItems(
  db: Db,
  saleId: number,
  items: StripeLineItem[],
): Promise<number> {
  const now = new Date()
  let written = 0

  for (const item of items) {
    const { priceId, productId } = lineItemIds(item)
    if (!priceId && !productId) continue

    const inserted = await db
      .insert(saleItems)
      .values({
        saleId,
        stripeProductId: productId,
        stripePriceId: priceId,
        description: item.description ?? productId ?? priceId ?? 'line item',
        quantity: item.quantity ?? 1,
        amountCents: lineItemAmount(item),
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: saleItems.id })

    if (inserted.length) written++
  }

  return written
}

function saleOutcome(result: SaleResult, label: string): Outcome {
  switch (result.status) {
    case 'recorded':
      return { status: 'processed', saleId: result.saleId, note: `${label}: sale recorded` }
    case 'refunded':
      return { status: 'processed', saleId: result.saleId, note: `${label}: sale marked refunded` }
    case 'duplicate':
      return { status: 'processed', saleId: result.saleId, note: `${label}: already recorded` }
    default:
      return { status: 'ignored', note: `${label}: ${result.status}` }
  }
}
