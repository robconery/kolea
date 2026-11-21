import type { Env } from '../types.ts'
import {
  type StripeSubscriptionObject,
  type SubscriptionCheckoutInput,
  createSubscriptionCheckoutSession,
  retrieveStripeSubscription,
} from './stripe-client.ts'

/**
 * The port Premium talks to the payment provider through: start a subscription
 * Checkout, and read a subscription back. Two calls, so the fake is small and
 * the webhook path stays the real one in tests.
 *
 * Picked by `PREMIUM_BILLING` in `Env`: unset (the production default) is the
 * real Stripe adapter; `fake` is the in-memory one below, which never touches
 * the network. Nothing but this file decides which.
 */
export interface PremiumBilling {
  readonly name: string
  createCheckout(input: SubscriptionCheckoutInput): Promise<{ id: string; url: string }>
  retrieveSubscription(id: string): Promise<StripeSubscriptionObject>
}

export function billingFor(env: Env): PremiumBilling {
  if (env.PREMIUM_BILLING === 'fake') return fakeBilling
  return {
    name: 'stripe',
    createCheckout: (input) => createSubscriptionCheckoutSession(env, input),
    retrieveSubscription: (id) => retrieveStripeSubscription(env, id),
  }
}

/** Whether Checkout can be started at all: a key that can write, or the fake. */
export function billingConfigured(env: Env): boolean {
  return env.PREMIUM_BILLING === 'fake' || Boolean(env.STRIPE_SECRET_KEY)
}

/**
 * The fake. Records every Checkout it was asked for and answers subscription
 * reads from `subscriptions`, which a test (or a local demo) fills in. Module
 * state, deliberately: the Worker is stateless, and the fake only has to live
 * as long as one test file.
 */
const fakeCheckouts: (SubscriptionCheckoutInput & { id: string; url: string })[] = []
const fakeSubscriptions = new Map<string, StripeSubscriptionObject>()

export const fakeBilling: PremiumBilling & {
  checkouts: typeof fakeCheckouts
  subscriptions: typeof fakeSubscriptions
  reset(): void
} = {
  name: 'fake',
  checkouts: fakeCheckouts,
  subscriptions: fakeSubscriptions,
  async createCheckout(input) {
    const id = `cs_fake_${fakeCheckouts.length + 1}`
    const url = `https://checkout.stripe.test/c/${id}`
    fakeCheckouts.push({ ...input, id, url })
    return { id, url }
  },
  async retrieveSubscription(id) {
    const sub = fakeSubscriptions.get(id)
    if (!sub) throw new Error(`fake billing: no subscription ${id}`)
    return sub
  },
  reset() {
    fakeCheckouts.length = 0
    fakeSubscriptions.clear()
  },
}
