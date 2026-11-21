import { type SQL, and, count, desc, eq, gte, lt, max, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { messages, syncRuns } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { providerReadiness } from './sending.ts'

const HOUR_MS = 60 * 60 * 1000

export interface HealthReport {
  d1Reachable: boolean
  provider: { name: string; live: boolean; problem: string | null }
  queueBound: boolean
  /** Waiting to send right now. */
  queued: number
  /** Queued for over an hour: the queue retries for minutes, so these are stuck, not waiting. */
  stuckOverAnHour: number
  /** Given up on: dead-lettered, refused by the provider, or a cancelled broadcast's leftovers. */
  failed: number
  failedLast24h: number
  /** The newest provider hand-off. Proof the send path ran, not just that the cron did. */
  lastSentAt: Date | null
  /** The nightly cron's newest Stripe run (it writes a `sync_runs` row every night it runs). */
  lastNightlyRun: { kind: string; status: string; startedAt: Date } | null
  problems: string[]
}

/**
 * Is mail moving? A cheap, read-only answer — a handful of indexed counts — so
 * an agent or a person can ask it as often as they like.
 *
 * Every figure is a row in D1 rather than a log line (invariant 7): the minutely
 * tick writes nothing of its own, so the evidence it ran is mail that went out.
 * If D1 itself does not answer, that is the whole report.
 */
export async function healthReport(env: Env, db: Db): Promise<HealthReport> {
  const provider = providerReadiness(env)
  const queueBound = Boolean(env.SEND_QUEUE)

  try {
    await db.run(sql`select 1`)
  } catch (err) {
    return {
      d1Reachable: false,
      provider,
      queueBound,
      queued: 0,
      stuckOverAnHour: 0,
      failed: 0,
      failedLast24h: 0,
      lastSentAt: null,
      lastNightlyRun: null,
      problems: [`D1 did not answer: ${err instanceof Error ? err.message : String(err)}`],
    }
  }

  const now = Date.now()
  const n = async (where: SQL | undefined) =>
    (await db.select({ n: count() }).from(messages).where(where).get())?.n ?? 0

  const queued = await n(eq(messages.status, 'queued'))
  const stuckOverAnHour = await n(
    and(eq(messages.status, 'queued'), lt(messages.createdAt, new Date(now - HOUR_MS))),
  )
  const failed = await n(eq(messages.status, 'failed'))
  const failedLast24h = await n(
    and(eq(messages.status, 'failed'), gte(messages.createdAt, new Date(now - 24 * HOUR_MS))),
  )
  const last = await db.select({ at: max(messages.sentAt) }).from(messages).get()
  const run = await db
    .select({ kind: syncRuns.kind, status: syncRuns.status, startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(eq(syncRuns.trigger, 'cron'))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1)
    .get()

  const problems: string[] = []
  if (provider.problem) problems.push(provider.problem)
  if (stuckOverAnHour > 0) {
    problems.push(
      `${stuckOverAnHour} message(s) have been queued for over an hour — check the provider and the queue consumer.`,
    )
  }
  if (failedLast24h > 0) problems.push(`${failedLast24h} message(s) failed in the last 24 hours.`)

  return {
    d1Reachable: true,
    provider,
    queueBound,
    queued,
    stuckOverAnHour,
    failed,
    failedLast24h,
    lastSentAt: last?.at ? new Date(last.at) : null,
    lastNightlyRun: run ?? null,
    problems,
  }
}
