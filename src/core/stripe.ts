import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { syncRuns } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { type SaleResult, recordSale } from './sales.ts'
import {
  type StripeCharge,
  type StripeList,
  requireStripeKey,
  stripeGet,
} from './stripe-client.ts'

/**
 * Stripe → campaign attribution, as a nightly reconcile.
 *
 * ⭐ This is the *safety net*, not the primary path. `core/stripe-webhook.ts`
 * books a sale within seconds of the charge; this walks the same charges again
 * on a schedule and catches whatever the webhook missed — a delivery Stripe gave
 * up retrying, an outage, a secret rotated at the wrong moment. Both paths key
 * sales on the Stripe charge id and `recordSale` is idempotent on it, so the two
 * converge instead of double-counting.
 *
 * Nothing here decides how a sale is attributed — `recordSale` already resolves the campaign from
 * the buyer's last attribution touch, dedupes on the charge id, and flips an
 * existing sale on a refund. This file's whole job is turning charges into the
 * shape `recordSale` already takes.
 */

/**
 * Pages per run. Each page is 100 charges and each charge costs a handful of D1
 * queries through `recordSale`, so ten pages sits inside the 1,000-query
 * per-invocation cap. Anything beyond that is picked up by the next run, which
 * resumes from the cursor.
 */
const MAX_PAGES = 10

/** How far back a run with no previous cursor reaches. */
const COLD_START_DAYS = 30

/**
 * The buyer's address, in the order Stripe is most likely to have it right.
 *
 * A charge with no address anywhere is reported as unattributed rather than
 * guessed at — crediting revenue to the wrong person is worse than not
 * crediting it.
 */
export async function emailFor(env: Env, charge: StripeCharge): Promise<string | null> {
  const direct = charge.billing_details?.email ?? charge.receipt_email
  if (direct) return direct

  if (charge.customer) {
    try {
      const customer = await stripeGet<{ email: string | null }>(
        env,
        `/customers/${charge.customer}`,
        {},
      )
      return customer.email
    } catch {
      return null
    }
  }
  return null
}

export interface SyncOptions {
  /** Epoch seconds. Defaults to the last run's cursor, else 30 days back. */
  since?: number
  /** Epoch seconds, exclusive upper bound. Defaults to now. */
  until?: number
  /** Read Stripe and report, write nothing. */
  dryRun?: boolean
  trigger?: 'cron' | 'mcp' | 'preview'
}

export interface SyncSummary {
  runId: number | null
  dryRun: boolean
  from: number
  to: number
  chargesSeen: number
  salesRecorded: number
  refundsApplied: number
  duplicates: number
  unattributed: number
  notes: string[]
  cursor: number | null
  pagesExhausted: boolean
  /** Only populated on a dry run — what would have happened, charge by charge. */
  wouldRecord?: {
    chargeId: string
    email: string | null
    amount: number
    currency: string
    campaignHint: string | null
    refunded: boolean
  }[]
}

export async function lastCursor(db: Db): Promise<number | null> {
  const row = await db
    .select({ cursor: syncRuns.cursor })
    .from(syncRuns)
    .where(eq(syncRuns.kind, 'stripe'))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1)
    .get()
  return row?.cursor ?? null
}

/**
 * Pull charges from Stripe and post them as sales.
 *
 * Resumable and safe to re-run: `recordSale` is idempotent on the Stripe charge
 * id, so a doubled cron tick records nothing twice. The cursor only advances on
 * a real run — a dry run must never move it, or the next real run skips
 * everything it previewed.
 */
export async function syncStripe(env: Env, db: Db, opts: SyncOptions = {}): Promise<SyncSummary> {
  requireStripeKey(env)

  const dryRun = opts.dryRun ?? false
  const until = opts.until ?? Math.floor(Date.now() / 1000)
  const since =
    opts.since ??
    (await lastCursor(db)) ??
    Math.floor((Date.now() - COLD_START_DAYS * 86_400_000) / 1000)

  const startedAt = new Date()
  const runId = dryRun
    ? null
    : (
        await db
          .insert(syncRuns)
          .values({
            kind: 'stripe',
            trigger: opts.trigger ?? 'mcp',
            status: 'running',
            startedAt,
          })
          .returning({ id: syncRuns.id })
      )[0]!.id

  const summary: SyncSummary = {
    runId,
    dryRun,
    from: since,
    to: until,
    chargesSeen: 0,
    salesRecorded: 0,
    refundsApplied: 0,
    duplicates: 0,
    unattributed: 0,
    notes: [],
    cursor: null,
    pagesExhausted: false,
    ...(dryRun ? { wouldRecord: [] } : {}),
  }

  try {
    let startingAfter: string | undefined
    let page = 0

    for (; page < MAX_PAGES; page++) {
      const list = await stripeGet<StripeList<StripeCharge>>(env, '/charges', {
        limit: 100,
        'created[gte]': since,
        'created[lt]': until,
        starting_after: startingAfter,
      })
      if (!list.data.length) break

      for (const charge of list.data) {
        summary.chargesSeen++
        // Stripe's list is newest first; the cursor has to end up at the newest
        // charge we actually processed, so take the max rather than the last.
        summary.cursor = Math.max(summary.cursor ?? 0, charge.created)

        if (!charge.paid || charge.status !== 'succeeded') {
          summary.notes.push(`${charge.id}: ${charge.status}, skipped`)
          continue
        }

        const email = await emailFor(env, charge)
        if (!email) {
          summary.unattributed++
          summary.notes.push(`${charge.id}: no email on the charge or its customer`)
          continue
        }

        const refunded = charge.refunded || charge.amount_refunded >= charge.amount
        const campaignSlug = charge.metadata?.campaign ?? null

        if (dryRun) {
          summary.wouldRecord!.push({
            chargeId: charge.id,
            email,
            amount: charge.amount,
            currency: charge.currency,
            campaignHint: campaignSlug,
            refunded,
          })
          continue
        }

        const result: SaleResult = await recordSale(db, {
          email,
          name: charge.billing_details?.name ?? null,
          amountCents: charge.amount,
          currency: charge.currency,
          product: charge.description,
          externalId: charge.id,
          campaignSlug,
          status: refunded ? 'refunded' : 'paid',
          occurredAt: new Date(charge.created * 1000),
          meta: { source: 'stripe', stripeCustomer: charge.customer },
        })

        switch (result.status) {
          case 'recorded':
            summary.salesRecorded++
            if (!result.campaignId) {
              summary.unattributed++
              summary.notes.push(`${charge.id}: recorded but no campaign, ${email} has no touches`)
            }
            break
          case 'refunded':
            summary.refundsApplied++
            break
          case 'duplicate':
            summary.duplicates++
            break
          default:
            summary.unattributed++
            summary.notes.push(`${charge.id}: ${result.status}`)
        }
      }

      startingAfter = list.data[list.data.length - 1]!.id
      if (!list.has_more) break
    }

    summary.pagesExhausted = page >= MAX_PAGES
    if (summary.pagesExhausted) {
      summary.notes.push(
        `Stopped after ${MAX_PAGES} pages to stay inside the D1 query budget. Run again to continue from the cursor.`,
      )
    }

    if (runId) {
      await db
        .update(syncRuns)
        .set({
          status: summary.unattributed ? 'partial' : 'ok',
          chargesSeen: summary.chargesSeen,
          salesRecorded: summary.salesRecorded,
          refundsApplied: summary.refundsApplied,
          duplicates: summary.duplicates,
          unattributed: summary.unattributed,
          // Bounded: a run over a bad week could otherwise write a note per charge.
          notes: summary.notes.slice(0, 50),
          // Only advance past charges we actually walked. A run that stopped at
          // the page cap must resume where it stopped, not where it was asked to.
          cursor: summary.cursor ?? since,
          finishedAt: new Date(),
        })
        .where(eq(syncRuns.id, runId))
    }

    return summary
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (runId) {
      await db
        .update(syncRuns)
        .set({
          status: 'failed',
          chargesSeen: summary.chargesSeen,
          salesRecorded: summary.salesRecorded,
          refundsApplied: summary.refundsApplied,
          duplicates: summary.duplicates,
          unattributed: summary.unattributed,
          notes: [...summary.notes.slice(0, 49), message],
          // A failed run does NOT advance the cursor — the charges it did not
          // reach have to be picked up next time.
          finishedAt: new Date(),
        })
        .where(eq(syncRuns.id, runId))
    }
    throw err
  }
}

export async function listSyncRuns(db: Db, limit = 20) {
  return await db
    .select()
    .from(syncRuns)
    .orderBy(desc(syncRuns.startedAt))
    .limit(limit)
    .all()
}
