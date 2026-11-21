import type { MemberSubscription } from '../db/schema.ts'

/**
 * The only way a Premium subscription changes status, as a transition table.
 * Pure.
 *
 *     active   -> past_due | canceled
 *     past_due -> active   | canceled
 *     canceled -> (final; a returning subscriber gets a new row)
 *
 * Each move stamps `status_changed_at`; `past_due` also stamps `past_due_at`
 * and `canceled` stamps `canceled_at` (with the reason). Recovering from
 * past_due keeps `past_due_at`.
 */

export type PremiumStatus = MemberSubscription['status']

const TABLE: Record<PremiumStatus, PremiumStatus[]> = {
  active: ['past_due', 'canceled'],
  past_due: ['active', 'canceled'],
  canceled: [],
}

export function canMove(from: PremiumStatus, to: PremiumStatus): boolean {
  return TABLE[from].includes(to)
}

/** Whether a row at `status` makes its subscriber premium. */
export function entitles(status: PremiumStatus): boolean {
  return status === 'active'
}

export type SubscriptionPatch = Partial<
  Pick<
    MemberSubscription,
    | 'status'
    | 'statusChangedAt'
    | 'pastDueAt'
    | 'canceledAt'
    | 'cancelReason'
    | 'currentPeriodEndAt'
    | 'cancelAtPeriodEnd'
    | 'stripeEventAt'
  >
>

/** The patch moving a row from its status to `to`, or null when the table forbids it. */
export function transition(
  row: Pick<MemberSubscription, 'status'>,
  to: PremiumStatus,
  at: Date,
  cancelReason?: string | null,
): SubscriptionPatch | null {
  if (!canMove(row.status, to)) return null
  const patch: SubscriptionPatch = { status: to, statusChangedAt: at }
  if (to === 'past_due') patch.pastDueAt = at
  if (to === 'canceled') {
    patch.canceledAt = at
    patch.cancelReason = cancelReason ? cancelReason.slice(0, 500) : null
  }
  return patch
}

/**
 * What Stripe's subscription status means here. `null` means
 * the status moves nothing — `incomplete`, `paused` and anything new Stripe
 * invents are left alone rather than guessed at.
 */
export function statusFromStripe(status: string | null | undefined): PremiumStatus | null {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active'
    case 'past_due':
    case 'unpaid':
      return 'past_due'
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled'
    default:
      return null
  }
}

/** What the provider says a subscription now is, as of `at`. */
export interface Observation {
  at: Date
  status?: PremiumStatus | null
  currentPeriodEndAt?: Date | null
  cancelAtPeriodEnd?: boolean | null
  cancelReason?: string | null
}

export type ObserveResult =
  | { kind: 'changed'; patch: SubscriptionPatch }
  | { kind: 'unchanged'; patch: SubscriptionPatch }
  | { kind: 'stale' }
  | { kind: 'refused' }

/**
 * Apply an observation: `stale` when it is older than the newest event already
 * applied (Stripe does not promise order), `refused` when the row is canceled
 * (final), otherwise the patch — `changed` when a status or billing fact moved,
 * `unchanged` when only the event time does. A status the table forbids (there
 * is none from a live row, but a future status might) is ignored, never forced.
 */
export function observe(
  row: Pick<MemberSubscription, 'status' | 'stripeEventAt' | 'currentPeriodEndAt' | 'cancelAtPeriodEnd' | 'cancelReason'>,
  obs: Observation,
): ObserveResult {
  if (row.stripeEventAt && obs.at.getTime() < row.stripeEventAt.getTime()) return { kind: 'stale' }
  if (row.status === 'canceled') return { kind: 'refused' }

  let patch: SubscriptionPatch = {}
  if (obs.status && obs.status !== row.status) {
    patch = transition(row, obs.status, obs.at, obs.cancelReason ?? row.cancelReason) ?? {}
  }
  if (
    obs.currentPeriodEndAt &&
    obs.currentPeriodEndAt.getTime() !== (row.currentPeriodEndAt?.getTime() ?? null)
  ) {
    patch.currentPeriodEndAt = obs.currentPeriodEndAt
  }
  if (typeof obs.cancelAtPeriodEnd === 'boolean' && obs.cancelAtPeriodEnd !== row.cancelAtPeriodEnd) {
    patch.cancelAtPeriodEnd = obs.cancelAtPeriodEnd
  }
  const kind = Object.keys(patch).length ? 'changed' : 'unchanged'
  return { kind, patch: { ...patch, stripeEventAt: obs.at } }
}
