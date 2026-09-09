import { AsyncLocalStorage } from 'node:async_hooks'
import { and, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { activities, campaigns, sequences, subscribers } from '../db/schema.ts'

/**
 * ⭐ Activity — the story of the list.
 *
 * `events` answers "what happened to this mail". This answers "what happened to
 * this person": how they arrived, what they were tagged, how far into a sequence
 * they got before they stopped, and whether they ever paid for anything.
 *
 * Two rules govern everything in this file.
 *
 * **1. It never throws into its caller.** Every write is wrapped. A logging
 * failure that breaks a signup, a preference change or a send would be a far
 * worse bug than the missing row it was trying to prevent — same reasoning as
 * `applyTagRules` in `core/events.ts`.
 *
 * **2. It is written from `core/` only.** `web/`, `api/` and `mcp/` set the
 * *source* (below) and call the domain function; the domain function logs. One
 * rule, one place — the same discipline that keeps consent honest.
 */

export type ActivityType = (typeof activities.$inferInsert)['type']
export type ActivitySource = NonNullable<(typeof activities.$inferInsert)['source']>

export interface ActivityInput {
  subscriberId: number
  type: ActivityType
  occurredAt?: Date
  campaignId?: number | null
  sequenceId?: number | null
  meta?: Record<string, unknown>
  /** Makes a replayed webhook or a double-tapped link land once. */
  dedupeKey?: string | null
  /** Overrides the ambient source. Only backfills and imports should need this. */
  source?: ActivitySource
}

// ───────────────────────────────────────────────── ambient source

/**
 * How the current invocation got here.
 *
 * Threading a `source` argument through thirty domain signatures would put a
 * transport concern into every one of them, so it rides in an
 * `AsyncLocalStorage` instead — set once by the entrypoint, read at the leaf.
 *
 * ⚠️ Deliberately NOT a module-level `let`. A Worker isolate serves concurrent
 * requests, and they interleave at every `await`, so a plain global would let a
 * cron tick relabel a form submission mid-flight. That is precisely the column
 * whose whole job is to tell those two apart.
 */
const sourceStore = new AsyncLocalStorage<ActivitySource>()

/** Run `fn` with every activity inside it attributed to `source`. */
export function withActivitySource<T>(source: ActivitySource, fn: () => T): T {
  return sourceStore.run(source, fn)
}

export function currentActivitySource(): ActivitySource {
  return sourceStore.getStore() ?? 'system'
}

// ───────────────────────────────────────────────── writing

function toRow(input: ActivityInput) {
  return {
    subscriberId: input.subscriberId,
    type: input.type,
    occurredAt: input.occurredAt ?? new Date(),
    campaignId: input.campaignId ?? null,
    sequenceId: input.sequenceId ?? null,
    source: input.source ?? currentActivitySource(),
    meta: input.meta ?? {},
    dedupeKey: input.dedupeKey ?? null,
  }
}

/** Log one thing. Swallows its own failures — see rule 1 at the top of the file. */
export async function logActivity(db: Db, input: ActivityInput): Promise<void> {
  try {
    await db.insert(activities).values(toRow(input)).onConflictDoNothing()
  } catch {
    /* the log is never worth the operation it is describing */
  }
}

/**
 * Log many things in ONE query.
 *
 * ⚠️ The reason this exists. D1 allows 1,000 queries per Worker invocation, and
 * the paths that log in bulk — a 100-message queue batch, a sequence tick, a
 * CSV import — are already spending most of that budget. One insert per person
 * inside those loops is how this feature would take production down. Chunked at
 * 50 because SQLite caps bound parameters and each row binds eight.
 */
export async function logActivities(db: Db, inputs: ActivityInput[]): Promise<void> {
  if (inputs.length === 0) return
  const rows = inputs.map(toRow)
  try {
    for (let i = 0; i < rows.length; i += 50) {
      await db.insert(activities).values(rows.slice(i, i + 50)).onConflictDoNothing()
    }
  } catch {
    /* as above */
  }
}

// ───────────────────────────────────────────────── reading

export interface FeedFilter {
  types?: ActivityType[]
  subscriberId?: number
  sequenceId?: number
  campaignId?: number
  /** Epoch ms floor. */
  since?: number
  /** Backfilled rows are excluded by default — they are history, not activity. */
  includeImported?: boolean
  limit?: number
  /** Keyset pagination: return rows strictly older than this activity id. */
  beforeId?: number
}

export interface FeedRow {
  id: number
  type: ActivityType
  occurredAt: Date
  source: ActivitySource
  meta: Record<string, unknown>
  subscriberId: number
  email: string
  name: string | null
  campaignName: string | null
  sequenceName: string | null
}

function feedWhere(f: FeedFilter) {
  const clauses = [
    f.types?.length ? inArray(activities.type, f.types) : undefined,
    f.subscriberId ? eq(activities.subscriberId, f.subscriberId) : undefined,
    f.sequenceId ? eq(activities.sequenceId, f.sequenceId) : undefined,
    f.campaignId ? eq(activities.campaignId, f.campaignId) : undefined,
    f.since ? gte(activities.occurredAt, new Date(f.since)) : undefined,
    f.includeImported ? undefined : sql`${activities.source} <> 'import'`,
    f.beforeId ? lt(activities.id, f.beforeId) : undefined,
  ].filter(Boolean)
  return clauses.length ? and(...clauses) : undefined
}

/**
 * The feed. One query, joined out to the names a human needs to read it —
 * a page of "someone@example.com was enrolled in Welcome" beats a page of ids.
 */
export async function activityFeed(db: Db, filter: FeedFilter = {}): Promise<FeedRow[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  return (await db
    .select({
      id: activities.id,
      type: activities.type,
      occurredAt: activities.occurredAt,
      source: activities.source,
      meta: activities.meta,
      subscriberId: activities.subscriberId,
      email: subscribers.email,
      name: subscribers.name,
      campaignName: campaigns.name,
      sequenceName: sequences.name,
    })
    .from(activities)
    .innerJoin(subscribers, eq(subscribers.id, activities.subscriberId))
    .leftJoin(campaigns, eq(campaigns.id, activities.campaignId))
    .leftJoin(sequences, eq(sequences.id, activities.sequenceId))
    .where(feedWhere(filter))
    .orderBy(desc(activities.occurredAt), desc(activities.id))
    .limit(limit)
    .all()) as FeedRow[]
}

/** Everything about one person, oldest last. Feeds `subscriber_timeline`. */
export async function activityForSubscriber(db: Db, subscriberId: number, limit = 200) {
  return await activityFeed(db, { subscriberId, limit, includeImported: true })
}

export interface DayPoint {
  day: string
  joined: number
  left: number
  net: number
}

/**
 * List health: net growth per day.
 *
 * The one number a mailing list actually lives or dies by, and it is not
 * computable from `subscribers` alone — `unsubscribed_at` is overwritten if
 * somebody ever comes back, so the history of departures only exists here.
 *
 * `import` rows are excluded, which is the whole reason that column exists:
 * backfilling 13.7k people would otherwise show as the best day in list history.
 */
export async function growthByDay(db: Db, days = 90): Promise<DayPoint[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const rows = await db
    .select({
      day: sql<string>`date(${activities.occurredAt} / 1000, 'unixepoch')`,
      joined: sql<number>`sum(case when ${activities.type} in ('subscribed','promoted') then 1 else 0 end)`,
      left: sql<number>`sum(case when ${activities.type} in ('unsubscribed','unsubscribed_all','complained','bounced') then 1 else 0 end)`,
    })
    .from(activities)
    .where(and(gte(activities.occurredAt, since), sql`${activities.source} <> 'import'`))
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .all()

  return rows.map((r) => ({
    day: r.day,
    joined: Number(r.joined ?? 0),
    left: Number(r.left ?? 0),
    net: Number(r.joined ?? 0) - Number(r.left ?? 0),
  }))
}

export interface ExitReason {
  reason: string
  n: number
}

export interface SequenceExits {
  enrolled: number
  completed: number
  /** They chose to leave this series, and only this series. */
  optedOut: number
  /** We stopped mailing them, grouped by why. */
  cancelled: number
  cancelledBy: ExitReason[]
}

/**
 * ⭐ Why a sequence loses people — which is not the same question as *where*.
 *
 * `/analytics/sequences/:id` already answers "where" from `messages`, and does
 * it well. What it cannot answer is the difference between somebody who chose to
 * leave, somebody we stopped mailing because they bounced, and somebody who
 * bought the thing and was pulled out on purpose. All three land in
 * `sequence_enrollments.status` as the single word `cancelled`, and the reason
 * was never written down anywhere until this table.
 *
 * That distinction is the whole judgement: a series that "loses" a third of its
 * people to purchases is working perfectly.
 */
export async function sequenceExits(db: Db, sequenceId: number): Promise<SequenceExits> {
  const byType = await db
    .select({ type: activities.type, n: count() })
    .from(activities)
    .where(eq(activities.sequenceId, sequenceId))
    .groupBy(activities.type)
    .all()

  const n = (t: ActivityType) => Number(byType.find((r) => r.type === t)?.n ?? 0)

  const reasons = await db
    .select({
      reason: sql<string>`coalesce(json_extract(${activities.meta}, '$.reason'), 'unknown')`,
      n: count(),
    })
    .from(activities)
    .where(and(eq(activities.sequenceId, sequenceId), eq(activities.type, 'sequence_cancelled')))
    .groupBy(sql`1`)
    .orderBy(desc(count()))
    .all()

  return {
    enrolled: n('sequence_enrolled'),
    completed: n('sequence_completed'),
    optedOut: n('sequence_opted_out'),
    cancelled: n('sequence_cancelled'),
    cancelledBy: reasons.map((r) => ({ reason: r.reason, n: Number(r.n) })),
  }
}

/** Counts by type over a window. The "what is this list doing" summary row. */
export async function activityCounts(
  db: Db,
  days = 30,
): Promise<{ type: ActivityType; n: number }[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const rows = await db
    .select({ type: activities.type, n: count() })
    .from(activities)
    .where(and(gte(activities.occurredAt, since), sql`${activities.source} <> 'import'`))
    .groupBy(activities.type)
    .orderBy(desc(count()))
    .all()
  return rows.map((r) => ({ type: r.type, n: Number(r.n) }))
}
