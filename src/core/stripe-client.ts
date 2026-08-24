import type { Env } from '../types.ts'

/**
 * The bit of Stripe's REST API this Worker actually speaks.
 *
 * Plain `fetch`, not the SDK: the SDK is large, it assumes Node, and everything
 * here is list-and-retrieve. Keeping it in one file means the version pin, the
 * auth header and the error shape are decided once — three callers reading
 * charges, products and webhooks should not each invent their own.
 */

const API = 'https://api.stripe.com/v1'

/**
 * Pinned deliberately. Stripe changes response shapes between versions, and a
 * Worker that silently follows the account's default version is a Worker whose
 * parsing breaks on a day nobody deployed anything.
 */
export const STRIPE_API_VERSION = '2025-08-27.basil'

export interface StripeList<T> {
  data: T[]
  has_more: boolean
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`Stripe ${status} on ${path}: ${body.slice(0, 300)}`)
    this.name = 'StripeError'
  }
}

export function requireStripeKey(env: Env): string {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured on this Worker')
  }
  return env.STRIPE_SECRET_KEY
}

/**
 * One GET against the Stripe API.
 *
 * `params` values that are `undefined` are dropped rather than serialized as the
 * string "undefined", which Stripe would take literally. Arrays are expanded into
 * the repeated-key form Stripe expects for `expand[]`.
 */
export async function stripeGet<T>(
  env: Env,
  path: string,
  params: Record<string, string | number | string[] | undefined> = {},
): Promise<T> {
  const url = new URL(`${API}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(`${key}[]`, item)
    } else {
      url.searchParams.set(key, String(value))
    }
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${requireStripeKey(env)}`,
      'Stripe-Version': STRIPE_API_VERSION,
    },
  })

  if (!res.ok) throw new StripeError(res.status, path, await res.text())
  return (await res.json()) as T
}

/**
 * Walk a paginated list endpoint, newest first, up to `maxPages`.
 *
 * The page cap is not politeness — every row a caller turns into database work
 * spends from D1's 1,000-query-per-invocation budget, so an unbounded walk is a
 * Worker that dies partway through with no record of where it got to. Callers
 * are expected to notice `pagesExhausted` and resume.
 */
export async function stripePages<T extends { id: string }>(
  env: Env,
  path: string,
  params: Record<string, string | number | string[] | undefined>,
  maxPages: number,
  onPage: (items: T[]) => Promise<void>,
): Promise<{ pages: number; pagesExhausted: boolean }> {
  let startingAfter: string | undefined
  let pages = 0

  for (; pages < maxPages; pages++) {
    const list = await stripeGet<StripeList<T>>(env, path, {
      limit: 100,
      ...params,
      starting_after: startingAfter,
    })
    if (!list.data.length) return { pages, pagesExhausted: false }

    await onPage(list.data)

    if (!list.has_more) return { pages: pages + 1, pagesExhausted: false }
    startingAfter = list.data[list.data.length - 1]!.id
  }

  return { pages, pagesExhausted: true }
}

// ───────────────────────────────────────────────── shared object shapes

/** Only the fields we read. Stripe sends far more; ignoring it is the point. */
export interface StripeCharge {
  id: string
  amount: number
  currency: string
  created: number
  refunded: boolean
  amount_refunded: number
  status: string
  paid: boolean
  description: string | null
  receipt_email: string | null
  customer: string | null
  invoice?: string | null
  payment_intent?: string | null
  billing_details?: { email: string | null; name: string | null }
  metadata?: Record<string, string>
}

export interface StripeProductObject {
  id: string
  object?: string
  name: string
  description: string | null
  active: boolean
  default_price?: string | { id: string } | null
  metadata?: Record<string, string>
  updated?: number
  deleted?: boolean
}

export interface StripePriceObject {
  id: string
  object?: string
  product: string | { id: string }
  nickname: string | null
  unit_amount: number | null
  currency: string
  active: boolean
  recurring?: { interval: string; interval_count: number } | null
  metadata?: Record<string, string>
  deleted?: boolean
}

/**
 * A line item, in either of the two shapes Stripe uses.
 *
 * Checkout sessions return the shared LineItem object, which carries an
 * expanded `price`. Invoices return their own line item, where that was
 * replaced by `pricing.price_details` — the flat `price` and `product` fields
 * do not exist there at all in this API version. One type covering both, and a
 * normalizer that reads whichever is present, is cheaper than two near-identical
 * parsers that will drift.
 */
export interface StripeLineItem {
  id: string
  description: string | null
  quantity: number | null
  /** Checkout line items. */
  amount_total?: number
  /** Invoice line items. */
  amount?: number
  /** Checkout line items only. `recurring` is what tells a subscription from a
      one-off without having to trust the synced catalog. */
  price?: {
    id: string
    product: string | { id: string }
    recurring?: { interval: string; interval_count: number } | null
  } | null
  /** Invoice line items only. */
  pricing?: { price_details?: { price?: string; product?: string } | null } | null
  /**
   * The span this line bills for, epoch seconds. Invoice lines carry no `price`
   * object in this API version, so the period is the only interval signal on the
   * payload itself — a renewal covering a year is a yearly subscription whether
   * or not the price catalog has been synced.
   */
  period?: { start: number; end: number } | null
}

/** The price and product a line item refers to, whichever shape it arrived in. */
export function lineItemIds(item: StripeLineItem): {
  priceId: string | null
  productId: string | null
} {
  const details = item.pricing?.price_details
  if (details?.price || details?.product) {
    return { priceId: details.price ?? null, productId: details.product ?? null }
  }
  return { priceId: item.price?.id ?? null, productId: idOf(item.price?.product) }
}

/** Checkout line items report `amount_total`; invoice line items report `amount`. */
export function lineItemAmount(item: StripeLineItem): number {
  return item.amount_total ?? item.amount ?? 0
}

export interface StripeCheckoutSession {
  id: string
  customer: string | null
  customer_details?: { email: string | null; name: string | null } | null
  customer_email?: string | null
  payment_intent: string | null
  invoice?: string | null
  subscription?: string | null
  amount_total: number | null
  currency: string | null
  created: number
  /** 'payment' | 'subscription' | 'setup'. */
  mode: string
  /** 'paid' | 'unpaid' | 'no_payment_required'. */
  payment_status: string
  status?: string
  metadata?: Record<string, string>
}

export interface StripePaymentIntent {
  id: string
  latest_charge: string | { id: string } | null
  amount_received?: number
  currency?: string
  status?: string
}

/**
 * ⚠️ This API version has **no** `invoice.charge` and no `invoice.payment_intent`.
 * Both were removed. The payment now hangs off `payments.data[].payment`, and the
 * subscription off `parent.subscription_details.subscription`. Reaching for the
 * old flat fields silently yields `undefined`, which is how a subscription
 * renewal quietly stops being recorded.
 */
export interface StripeInvoice {
  id: string
  customer: string | null
  customer_email: string | null
  customer_name?: string | null
  amount_paid: number
  currency: string
  created: number
  status: string
  billing_reason?: string | null
  number?: string | null
  parent?: {
    subscription_details?: { subscription?: string | { id: string } | null } | null
  } | null
  payments?: StripeList<{
    id: string
    status: string
    amount_paid: number | null
    payment?: {
      type: string
      payment_intent?: string | { id: string } | null
      charge?: string | { id: string } | null
    } | null
  }>
  lines?: StripeList<StripeLineItem>
  metadata?: Record<string, string>
}

/** `default_price`, `price.product` and friends arrive either expanded or as a bare id. */
export function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

/** The subscription a renewal invoice belongs to, or null for a one-off invoice. */
export function subscriptionOf(invoice: StripeInvoice): string | null {
  return idOf(invoice.parent?.subscription_details?.subscription)
}
