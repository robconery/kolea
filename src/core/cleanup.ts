import { desc, eq, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { type ListPrune, listPrunes, subscribers, suppressions } from '../db/schema.ts'

/**
 * List clean-up (gap.md "Clean up"), ported from Kōlea's `Audience.Prune` /
 * `Audience.Pruning`: pick groups of people to prune, see the counts, download
 * a backup of exactly those people, then delete them.
 *
 * The groups split people by status, so nobody is in two:
 *
 *   `never_engaged` — active, sent at least 3 mails in the window (each more
 *                     than 7 days old, so they had time to open), and no open
 *                     or click in the last N days
 *   `unsubscribed`  — left the newsletter
 *   `bounced`       — hard-bounced or complained
 *   `unconfirmed`   — pending for more than 30 days, never confirmed
 *
 * Nobody is pruned who has bought something (a sale, a purchase, a conversion:
 * the money keeps its person) or who has mail queued (the send finishes first).
 *
 * ⭐ Deleting a person must never be a path to re-mailing them. Whoever bounced
 * or complained keeps that suppression on the address (SPEC 2.1). Whoever left
 * the newsletter keeps a `pruned` marker, which is exactly as wide as the choice
 * they made and no wider (invariant 2, `core/consent.ts`): it blocks broadcasts
 * and makes a re-import bring them back `unsubscribed`, but a sequence they
 * later join, a receipt, or a double opt-in confirmation still reaches them,
 * and signing up again themselves clears it. A pruned non-opener or
 * unconfirmed person keeps nothing: they never said no, and may sign up again.
 *
 * The SQL below names `subscribers` unaliased on purpose: the same predicate
 * runs inside a SELECT and inside a DELETE.
 */

export const PRUNE_GROUPS = ['never_engaged', 'unsubscribed', 'bounced', 'unconfirmed'] as const
export type PruneGroup = (typeof PRUNE_GROUPS)[number]

export const MIN_SENDS = 3
export const SEND_AGE_DAYS = 7
export const PENDING_DAYS = 30
export const DEFAULT_INACTIVE_DAYS = 180
/** Shorter than this and the window cannot hold three mails a week old. */
export const MIN_INACTIVE_DAYS = 30

/** People deleted per statement. Small enough that the cascade (messages, events, activities) stays quick. */
const PAGE = 200
/** Pages per invocation: 2 queries each, far under D1's 1,000. */
const PAGES_PER_RUN = 25

const DAY = 86_400_000

export function parseGroups(values: unknown[]): PruneGroup[] {
  const names = new Set(values.map(String))
  return PRUNE_GROUPS.filter((g) => names.has(g))
}

export function clampDays(raw: unknown): number {
  const n = Math.trunc(Number(raw))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INACTIVE_DAYS
  return Math.min(Math.max(n, MIN_INACTIVE_DAYS), 3650)
}

/** Which group a person of this status belongs to, for counting a delete. */
export function groupOfStatus(status: string): PruneGroup {
  if (status === 'unsubscribed') return 'unsubscribed'
  if (status === 'bounced' || status === 'complained') return 'bounced'
  if (status === 'pending') return 'unconfirmed'
  return 'never_engaged'
}

function groupCondition(group: PruneGroup, now: number, days: number): SQL {
  switch (group) {
    case 'unsubscribed':
      return sql`subscribers.status = 'unsubscribed'`
    case 'bounced':
      return sql`subscribers.status in ('bounced', 'complained')`
    case 'unconfirmed':
      return sql`(subscribers.status = 'pending' and subscribers.confirmed_at is null and subscribers.created_at < ${now - PENDING_DAYS * DAY})`
    case 'never_engaged': {
      const windowStart = now - days * DAY
      const sendCutoff = now - SEND_AGE_DAYS * DAY
      return sql`(subscribers.status = 'active'
        and (select count(*) from messages m
              where m.subscriber_id = subscribers.id and m.status = 'sent'
                and m.sent_at >= ${windowStart} and m.sent_at < ${sendCutoff}) >= ${MIN_SENDS}
        and not exists (select 1 from events e join messages m2 on m2.id = e.message_id
              where m2.subscriber_id = subscribers.id and e.type in ('open', 'click')
                and e.occurred_at >= ${windowStart}))`
    }
  }
}

/** Who may be pruned from `groups` right now, minus everyone the money or a queued send keeps. */
function prunable(groups: PruneGroup[], now: number, days: number): SQL {
  const any = sql.join(
    groups.map((g) => groupCondition(g, now, days)),
    sql` or `,
  )
  return sql`(${any})
    and not exists (select 1 from sales x where x.subscriber_id = subscribers.id)
    and not exists (select 1 from conversions x where x.subscriber_id = subscribers.id)
    and not exists (select 1 from purchases x where x.email = subscribers.email)
    and not exists (select 1 from messages q where q.subscriber_id = subscribers.id and q.status = 'queued')`
}

const inIds = (ids: number[]) => sql`subscribers.id in (select value from json_each(${JSON.stringify(ids)}))`

/** How many people each group holds right now. One query per group. */
export async function previewPrune(
  db: Db,
  days = DEFAULT_INACTIVE_DAYS,
  now = Date.now(),
): Promise<Record<PruneGroup, number>> {
  const counts = await Promise.all(
    PRUNE_GROUPS.map(async (g) => {
      const row = await db
        .select({ n: sql<number>`count(*)` })
        .from(subscribers)
        .where(prunable([g], now, days))
        .get()
      return [g, row?.n ?? 0] as const
    }),
  )
  return Object.fromEntries(counts) as Record<PruneGroup, number>
}

export type PlanResult = { ok: true; prune: ListPrune } | { ok: false; message: string }

/**
 * Snapshot the people in `groups` into a planned clean-up. Nothing is deleted;
 * the operator downloads the backup and confirms the count next.
 */
export async function planPrune(
  db: Db,
  groups: PruneGroup[],
  days = DEFAULT_INACTIVE_DAYS,
  now = Date.now(),
): Promise<PlanResult> {
  if (groups.length === 0) return { ok: false, message: 'Pick at least one group.' }
  const rows = await db
    .select({ id: subscribers.id, status: subscribers.status })
    .from(subscribers)
    .where(prunable(groups, now, days))
    .orderBy(subscribers.id)
    .all()
  if (rows.length === 0) return { ok: false, message: 'Nobody is in those groups right now.' }

  const planned: Record<string, number> = Object.fromEntries(groups.map((g) => [g, 0]))
  for (const r of rows) {
    const g = groupOfStatus(r.status)
    planned[g] = (planned[g] ?? 0) + 1
  }
  const [prune] = await db
    .insert(listPrunes)
    .values({
      groups,
      inactiveDays: days,
      subscriberIds: rows.map((r) => r.id),
      planned,
      total: rows.length,
      createdAt: new Date(now),
    })
    .returning()
  return { ok: true, prune: prune! }
}

export async function getPrune(db: Db, id: number): Promise<ListPrune | undefined> {
  return await db.select().from(listPrunes).where(eq(listPrunes.id, id)).get()
}

export async function recentPrunes(db: Db, limit = 10): Promise<ListPrune[]> {
  return await db
    .select()
    .from(listPrunes)
    .orderBy(desc(listPrunes.createdAt), desc(listPrunes.id))
    .limit(limit)
    .all()
}

const cell = (v: unknown) => {
  const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * The backup: exactly the planned people, one row each, with their tags, in a
 * shape `importCsv` reads back (`email,name,tags,status`, then the rest). It
 * honours `status` in the narrowing direction only, so an unconfirmed person
 * comes back `pending` and a leaver `unsubscribed`, never `active`. Stamps
 * `backed_up_at` so the confirm step can say a backup was taken.
 */
export async function pruneBackupCsv(db: Db, prune: ListPrune): Promise<string> {
  const rows = (
    await db.all<{
      email: string
      name: string | null
      tags: string | null
      status: string
      source: string | null
      created_at: number
      confirmed_at: number | null
      unsubscribed_at: number | null
      attributes: string
    }>(sql`select subscribers.email, subscribers.name, subscribers.status, subscribers.source,
             subscribers.created_at, subscribers.confirmed_at, subscribers.unsubscribed_at, subscribers.attributes,
             (select group_concat(t.name, ';') from subscriber_tags st join tags t on t.id = st.tag_id
               where st.subscriber_id = subscribers.id) as tags
           from subscribers where ${inIds(prune.subscriberIds)} order by subscribers.id`)
  )
  const header = 'email,name,tags,status,group,source,created_at,confirmed_at,unsubscribed_at,attributes'
  const iso = (ms: number | null) => (ms == null ? '' : new Date(ms).toISOString())
  const lines = rows.map((r) =>
    [
      r.email,
      r.name,
      r.tags,
      r.status,
      groupOfStatus(r.status),
      r.source,
      iso(r.created_at),
      iso(r.confirmed_at),
      iso(r.unsubscribed_at),
      r.attributes,
    ]
      .map(cell)
      .join(','),
  )
  await db.update(listPrunes).set({ backedUpAt: new Date() }).where(eq(listPrunes.id, prune.id))
  return `${[header, ...lines].join('\r\n')}\r\n`
}

export type RunResult =
  | { ok: true; prune: ListPrune }
  | { ok: false; message: string; prune?: ListPrune }

/**
 * Delete a planned clean-up's people, a page at a time.
 *
 * The first press must carry the count the confirm step showed, typed back:
 * deleting is explicit. Later presses (Continue) resume where the last one
 * stopped. Each page re-applies the group rules to its ids, writes the
 * suppressions the leavers keep, and deletes, in one batch so a failed page
 * leaves neither half behind.
 */
export async function runPrune(
  db: Db,
  id: number,
  opts: { confirmCount?: number; now?: number; pageSize?: number; pages?: number } = {},
): Promise<RunResult> {
  const prune = await getPrune(db, id)
  if (!prune) return { ok: false, message: 'No such clean-up.' }
  if (prune.status === 'done' || prune.status === 'cancelled') {
    return { ok: false, message: `That clean-up is already ${prune.status}.`, prune }
  }
  if (prune.status === 'planned') {
    if (opts.confirmCount !== prune.total) {
      return {
        ok: false,
        message: `Type ${prune.total} to confirm deleting ${prune.total} people.`,
        prune,
      }
    }
    await db
      .update(listPrunes)
      .set({ status: 'running', confirmedAt: new Date() })
      .where(eq(listPrunes.id, id))
  }

  const now = opts.now ?? Date.now()
  const groups = parseGroups(prune.groups)
  const cond = prunable(groups, now, prune.inactiveDays)
  const byGroup: Record<string, number> = { ...prune.deletedByGroup }
  let { position, deleted, skipped } = prune

  const pageSize = opts.pageSize ?? PAGE
  const pages = opts.pages ?? PAGES_PER_RUN
  for (let p = 0; p < pages && position < prune.subscriberIds.length; p++) {
    const ids = prune.subscriberIds.slice(position, position + pageSize)
    const where = sql`${inIds(ids)} and ${cond}`
    const [, gone] = await db.batch([
      // Before the delete, from the same predicate: the address outlives the row.
      db
        .insert(suppressions)
        .select(
          db
            .select({
              id: sql<number>`null`.as('id'),
              email: subscribers.email,
              reason: sql<'pruned' | 'hard_bounce' | 'complaint'>`case subscribers.status
                when 'unsubscribed' then 'pruned' when 'bounced' then 'hard_bounce' else 'complaint' end`.as(
                'reason',
              ),
              createdAt: sql<Date>`${now}`.as('created_at'),
            })
            .from(subscribers)
            .where(sql`${where} and subscribers.status in ('unsubscribed', 'bounced', 'complained')`),
        )
        .onConflictDoNothing(),
      db.delete(subscribers).where(where).returning({ status: subscribers.status }),
    ])
    for (const r of gone) {
      const g = groupOfStatus(r.status)
      byGroup[g] = (byGroup[g] ?? 0) + 1
    }
    deleted += gone.length
    skipped += ids.length - gone.length
    position += ids.length
  }

  const done = position >= prune.subscriberIds.length
  const [updated] = await db
    .update(listPrunes)
    .set({
      position,
      deleted,
      skipped,
      deletedByGroup: byGroup,
      ...(done ? { status: 'done' as const, finishedAt: new Date(now) } : {}),
    })
    .where(eq(listPrunes.id, id))
    .returning()
  return { ok: true, prune: updated! }
}

/** Throw a planned clean-up away. Nothing was deleted, so nothing to undo. */
export async function cancelPrune(db: Db, id: number): Promise<boolean> {
  const res = await db
    .update(listPrunes)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(sql`${listPrunes.id} = ${id} and ${listPrunes.status} = 'planned'`)
    .returning({ id: listPrunes.id })
  return res.length > 0
}
