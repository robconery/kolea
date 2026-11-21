import { type SQL, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import type { ActivityType } from './activity.ts'

/**
 * ⭐ The event log — everything that happened, in plain words, for 90 days.
 *
 * A READ MODEL, not a table. Every fact on this page is already a row
 * somewhere, written at the point of decision by the code that owns it:
 *
 *   `activities`    — what happened to a person (joined, left a series, bought)
 *   `broadcasts`    — when a send started and finished
 *   `messages`      — single mail sent, and every send that failed or was held
 *   `stripe_events` — every webhook and what we did with it
 *   `sync_runs`     — every nightly reconcile and what it found
 *   `audit_entries` — every console and API-key write, refusals included
 *   `mcp_calls`     — every agent tool call, refusals included
 *
 * A second `event_log` table written beside each of those would be a second
 * place to count the same fact, and `activities` already says why that is
 * wrong: "two places to count the same mail is two places to get it wrong".
 * A double-write also fails independently — the log would be a story that
 * can disagree with the data it describes. Reading the sources directly, the
 * log can never claim a send the `messages` table does not have.
 *
 * What is deliberately NOT read:
 *   - `events` opens and clicks: thousands per send, and the Activity pulse
 *     already tells that story as numbers. Bounces and complaints are not read
 *     from `events` either, because `core/events.ts` already logs each as an
 *     activity — reading both would print every bounce twice.
 *   - broadcast and sequence sends one by one: a broadcast is two lines
 *     (started, finished with a count), a sequence step is the person's
 *     `sequence.advanced`. Failures and holds are always shown individually.
 *
 * Retention: the 90 days is a read floor. Nothing is pruned, because every
 * source table answers other questions for longer (list growth, a person's
 * timeline, send stats, Stripe dedupe). Deleting those rows to keep a log
 * tidy would quietly break the screens that own them.
 *
 * Cost: one D1 query per page, whatever the filters. Each source is its own
 * branch ordered by an indexed time column and cut at the page size, so a
 * page reads roughly `limit` rows per source rather than 90 days of history.
 *
 * Text people wrote (names, subjects, Stripe notes) is DATA. The admin page
 * renders it through JSX, which escapes it; MCP returns it under a key that
 * says so (`mcp/tools/ops.ts`).
 */

export const LOG_RETENTION_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export type LogLevel = 'info' | 'warning' | 'error'
export type LogCategory =
  | 'subscribers'
  | 'sequences'
  | 'broadcasts'
  | 'mail'
  | 'forms'
  | 'sales'
  | 'stripe'
  | 'audit'

/** The filters a person sees, in this order. */
export const LOG_CATEGORIES: { id: LogCategory; label: string }[] = [
  { id: 'subscribers', label: 'Subscribers' },
  { id: 'sequences', label: 'Sequences' },
  { id: 'broadcasts', label: 'Broadcasts' },
  { id: 'mail', label: 'Mail' },
  { id: 'forms', label: 'Forms' },
  { id: 'sales', label: 'Sales' },
  { id: 'stripe', label: 'Stripe' },
  { id: 'audit', label: 'Audit' },
]

export interface LogType {
  type: string
  category: LogCategory
  level: LogLevel
  /** What the type means, for `log_types` and the filter. */
  meaning: string
}

/** Activity type → log type. Every activity type must be here (typed). */
const FROM_ACTIVITY: Record<ActivityType, string> = {
  subscribed: 'subscriber.joined',
  pending_added: 'subscriber.pending',
  promoted: 'subscriber.confirmed',
  imported: 'subscriber.imported',
  form_submitted: 'form.submitted',
  unsubscribed: 'subscriber.unsubscribed',
  resubscribed: 'subscriber.resubscribed',
  unsubscribed_all: 'subscriber.left_everything',
  suppressed: 'subscriber.suppressed',
  unsuppressed: 'subscriber.unsuppressed',
  bounced: 'subscriber.bounced',
  complained: 'subscriber.complained',
  sequence_enrolled: 'sequence.enrolled',
  sequence_advanced: 'sequence.advanced',
  sequence_completed: 'sequence.completed',
  sequence_cancelled: 'sequence.cancelled',
  sequence_opted_out: 'sequence.left',
  sequence_rejoined: 'sequence.rejoined',
  tagged: 'tag.added',
  untagged: 'tag.removed',
  touched: 'campaign.touched',
  purchased: 'sale.purchased',
  refunded: 'sale.refunded',
}

const t = (type: string, category: LogCategory, meaning: string, level: LogLevel = 'info'): LogType => ({
  type,
  category,
  level,
  meaning,
})

/** Every type the log can show. `log_types` returns this. */
export const LOG_TYPES: LogType[] = [
  t('subscriber.joined', 'subscribers', 'Someone joined the list.'),
  t('subscriber.pending', 'subscribers', 'Someone was added and has not confirmed yet.'),
  t('subscriber.confirmed', 'subscribers', 'Someone confirmed their subscription.'),
  t('subscriber.imported', 'subscribers', 'Someone was brought in by an import.'),
  t('subscriber.unsubscribed', 'subscribers', 'Someone left the newsletter.', 'warning'),
  t('subscriber.resubscribed', 'subscribers', 'Someone came back to the newsletter.'),
  t('subscriber.left_everything', 'subscribers', 'Someone unsubscribed from all mail.', 'warning'),
  t('subscriber.suppressed', 'subscribers', 'An address was suppressed: nothing goes to it.', 'warning'),
  t('subscriber.unsuppressed', 'subscribers', 'A suppression was lifted.'),
  t('subscriber.bounced', 'subscribers', 'Mail to someone hard-bounced.', 'warning'),
  t('subscriber.complained', 'subscribers', 'Someone marked mail as spam.', 'warning'),
  t('tag.added', 'subscribers', 'Someone was tagged.'),
  t('tag.removed', 'subscribers', 'A tag came off someone.'),
  t('sequence.enrolled', 'sequences', 'Someone started a sequence.'),
  t('sequence.advanced', 'sequences', 'Someone was sent the next step of a sequence.'),
  t('sequence.completed', 'sequences', 'Someone finished a sequence.'),
  t('sequence.cancelled', 'sequences', 'Someone was taken out of a sequence (bought, bounced, exit tag).'),
  t('sequence.left', 'sequences', 'Someone chose to leave one sequence.', 'warning'),
  t('sequence.rejoined', 'sequences', 'Someone rejoined a sequence.'),
  t('broadcast.started', 'broadcasts', 'A broadcast started sending.'),
  t('broadcast.finished', 'broadcasts', 'A broadcast finished, with how many were sent.'),
  t('mail.sent', 'mail', 'A single (transactional or form) mail was sent.'),
  t('mail.failed', 'mail', 'A mail could not be sent.', 'error'),
  t('mail.suppressed', 'mail', 'A mail was held back because the address may not be mailed.', 'warning'),
  t('form.submitted', 'forms', 'Someone filled in a form.'),
  t('campaign.touched', 'sales', 'Someone arrived through a campaign link.'),
  t('sale.purchased', 'sales', 'Someone bought something.'),
  t('sale.refunded', 'sales', 'A sale was refunded.', 'warning'),
  t('stripe.received', 'stripe', 'A Stripe webhook arrived and is not processed yet.'),
  t('stripe.processed', 'stripe', 'A Stripe webhook was acted on.'),
  t('stripe.ignored', 'stripe', 'A Stripe webhook needed nothing from us.'),
  t('stripe.failed', 'stripe', 'A Stripe webhook could not be processed.', 'error'),
  t('sync.running', 'stripe', 'A Stripe sync started.'),
  t('sync.ok', 'stripe', 'A Stripe sync finished.'),
  t('sync.partial', 'stripe', 'A Stripe sync finished with some charges it could not book.', 'warning'),
  t('sync.failed', 'stripe', 'A Stripe sync failed.', 'error'),
  t('audit.ok', 'audit', 'A change by the operator, an API key or an agent went through.'),
  t('audit.denied', 'audit', 'A change by the operator, an API key or an agent was refused.', 'warning'),
  t('audit.error', 'audit', 'A change by the operator, an API key or an agent failed with an error.', 'error'),
]

const BY_TYPE = new Map(LOG_TYPES.map((x) => [x.type, x]))

export function isLogCategory(v: string): v is LogCategory {
  return LOG_CATEGORIES.some((c) => c.id === v)
}

// ───────────────────────────────────────────────── searching

export interface LogFilter {
  category?: string
  type?: string
  /** Text to find in names, addresses, subjects, notes and the type. */
  q?: string
  limit?: number
  /** `nextCursor` from the previous page. */
  cursor?: string
}

export interface LogEvent {
  /** Stable across pages: source + row id. */
  id: string
  at: Date
  type: string
  category: LogCategory
  level: LogLevel
  /** The sentence. Contains subscriber-written text (names, subjects). */
  summary: string
  /** Subscriber-written or external text, kept apart so callers can mark it. */
  name: string | null
  email: string | null
  ref: string | null
  detail: string | null
  /** Audit lines: who acted (operator, key, agent) and on what. */
  actor?: 'operator' | 'key' | 'agent'
  target?: string | null
}

export interface LogPage {
  events: LogEvent[]
  nextCursor: string | null
}

export type LogResult = { ok: true; page: LogPage } | { ok: false; reason: string }

/** One source of the log. `select` must yield the shared column list. */
interface Branch {
  src: string
  select: (floor: number) => SQL
}

/**
 * Columns every branch yields, in this order:
 * src, sid, at, type, name, email, ref, n1, n2, detail, x, target, hay.
 * `hay` is the lower-cased text the search runs over.
 */
const BRANCHES: Branch[] = [
  {
    src: 'a',
    select: (floor) => {
      const typeCase = sql.raw(
        `case a.type ${Object.entries(FROM_ACTIVITY)
          .map(([from, to]) => `when '${from}' then '${to}'`)
          .join(' ')} end`,
      )
      return sql`
        select 'a' as src, a.id as sid, a.occurred_at as at, ${typeCase} as type,
          s.name as name, s.email as email,
          case
            when a.type in ('tagged','untagged') then json_extract(a.meta, '$.tag')
            when a.type in ('purchased','refunded') then json_extract(a.meta, '$.product')
            when a.type = 'form_submitted' then json_extract(a.meta, '$.formName')
            when a.type = 'touched' then c.name
            else q.name
          end as ref,
          json_extract(a.meta, '$.amountCents') as n1, null as n2,
          json_extract(a.meta, '$.reason') as detail,
          json_extract(a.meta, '$.currency') as x, null as target,
          lower(coalesce(s.email,'') || ' ' || coalesce(s.name,'') || ' ' || coalesce(q.name,'')
            || ' ' || coalesce(c.name,'') || ' ' || coalesce(json_extract(a.meta, '$.tag'),'')
            || ' ' || coalesce(json_extract(a.meta, '$.product'),'')
            || ' ' || coalesce(json_extract(a.meta, '$.formName'),'')
            || ' ' || coalesce(json_extract(a.meta, '$.reason'),'')) as hay
        from activities a
        join subscribers s on s.id = a.subscriber_id
        left join sequences q on q.id = a.sequence_id
        left join campaigns c on c.id = a.campaign_id
        where a.occurred_at >= ${floor} and a.source <> 'import'`
    },
  },
  {
    src: 'bf',
    select: (floor) => sql`
      select 'bf' as src, b.id as sid, b.sent_at as at, 'broadcast.finished' as type,
        null as name, null as email, b.subject as ref,
        (select count(*) from messages m where m.broadcast_id = b.id and m.status = 'sent') as n1,
        (select count(*) from messages m where m.broadcast_id = b.id and m.status in ('failed','suppressed')) as n2,
        null as detail, null as x, null as target, lower(b.subject) as hay
      from broadcasts b
      where b.status = 'sent' and b.sent_at >= ${floor}`,
  },
  {
    src: 'bs',
    select: (floor) => sql`
      select 'bs' as src, b.id as sid, b.started_at as at, 'broadcast.started' as type,
        null as name, null as email, b.subject as ref, null as n1, null as n2,
        null as detail, null as x, null as target, lower(b.subject) as hay
      from broadcasts b
      where b.started_at >= ${floor}`,
  },
  {
    src: 'm',
    select: (floor) => sql`
      select 'm' as src, m.id as sid, m.created_at as at,
        case m.status when 'sent' then 'mail.sent' when 'failed' then 'mail.failed' else 'mail.suppressed' end as type,
        s.name as name, m.to_email as email, m.subject as ref, null as n1, null as n2,
        coalesce(m.error, m.suppressed_reason) as detail, m.kind as x, null as target,
        lower(m.to_email || ' ' || coalesce(s.name,'') || ' ' || m.subject || ' '
          || coalesce(m.error,'') || ' ' || coalesce(m.suppressed_reason,'')) as hay
      from messages m
      join subscribers s on s.id = m.subscriber_id
      where m.created_at >= ${floor}
        and (m.status in ('failed','suppressed')
          or (m.status = 'sent' and m.kind in ('transactional','form')))`,
  },
  {
    src: 'se',
    select: (floor) => sql`
      select 'se' as src, e.rowid as sid, e.received_at as at, 'stripe.' || e.status as type,
        null as name, null as email, e.type as ref, null as n1, null as n2,
        e.note as detail, e.object_id as x, null as target,
        lower(e.type || ' ' || coalesce(e.note,'') || ' ' || coalesce(e.object_id,'')) as hay
      from stripe_events e
      where e.received_at >= ${floor}`,
  },
  {
    src: 'sr',
    select: (floor) => sql`
      select 'sr' as src, r.id as sid, coalesce(r.finished_at, r.started_at) as at,
        'sync.' || r.status as type, null as name, null as email, r.kind as ref,
        r.charges_seen as n1, r.sales_recorded as n2,
        case when r.notes = '[]' then null else r.notes end as detail, r.trigger as x, null as target,
        lower(r.kind || ' ' || r.notes) as hay
      from sync_runs r
      where r.started_at >= ${floor}`,
  },
  {
    src: 'au',
    select: (floor) => sql`
      select 'au' as src, u.id as sid, u.at as at, 'audit.' || u.outcome as type,
        case u.actor_kind when 'key' then coalesce(k.name, 'key ' || u.actor_id) when 'operator' then case when u.actor_id = 'dev-bypass' then u.actor_id else coalesce(u.actor_id || ' (' || u.actor_role || ')', u.actor_id) end else u.actor_id end as name,
        null as email, u.action as ref, u.status as n1, null as n2,
        coalesce(u.detail, case when u.summary = '{}' then null else u.summary end) as detail,
        u.actor_kind as x, u.target as target,
        lower(coalesce(u.actor_id,'') || ' ' || coalesce(k.name,'') || ' ' || u.action || ' '
          || coalesce(u.target,'') || ' ' || coalesce(u.detail,'') || ' ' || u.summary || ' ' || u.actor_kind || ' ' || coalesce(u.actor_role,'')) as hay
      from audit_entries u
      left join api_keys k on k.id = u.api_key_id
      where u.at >= ${floor}`,
  },
  {
    src: 'mc',
    select: (floor) => sql`
      select 'mc' as src, c.id as sid, c.created_at as at, 'audit.' || c.outcome as type,
        k.name as name, null as email, c.tool as ref, c.duration_ms as n1, c.api_key_id as n2,
        c.detail as detail, 'agent' as x, null as target,
        lower(c.tool || ' ' || coalesce(c.detail,'') || ' ' || coalesce(k.name,'') || ' agent') as hay
      from mcp_calls c
      left join api_keys k on k.id = c.api_key_id
      where c.created_at >= ${floor}`,
  },
]

interface Cursor {
  at: number
  src: string
  sid: number
}

function encodeCursor(c: Cursor): string {
  return btoa(`${c.at}.${c.src}.${c.sid}`).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/')
    const [at, src, sid] = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)).split('.')
    const c = { at: Number(at), src: src ?? '', sid: Number(sid) }
    if (!Number.isFinite(c.at) || !Number.isFinite(c.sid) || !/^[a-z]{1,3}$/.test(c.src)) return null
    return c
  } catch {
    return null
  }
}

/**
 * The page order is (at desc, src asc, sid desc). Within one branch `src` is
 * constant, so "after the cursor" reduces to one of three predicates.
 */
function afterCursor(src: string, c: Cursor): SQL {
  if (src > c.src) return sql`at <= ${c.at}`
  if (src < c.src) return sql`at < ${c.at}`
  return sql`(at < ${c.at} or (at = ${c.at} and sid < ${c.sid}))`
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

interface Row {
  src: string
  sid: number
  at: number
  type: string
  name: string | null
  email: string | null
  ref: string | null
  n1: number | null
  n2: number | null
  detail: string | null
  x: string | null
  target: string | null
}

/** Search the log, newest first. Validates its own input (it comes from a URL or an agent). */
export async function searchLog(
  db: Db,
  filter: LogFilter = {},
  now = Date.now(),
): Promise<LogResult> {
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 50) || 50, 1), 200)
  const q = filter.q?.trim().toLowerCase() ?? ''
  if (q.length > 200) return { ok: false, reason: 'q is longer than 200 characters' }

  let types: string[] | null = null
  if (filter.type) {
    if (!BY_TYPE.has(filter.type)) {
      return { ok: false, reason: `unknown type "${filter.type}" — see log_types` }
    }
    types = [filter.type]
  } else if (filter.category) {
    if (!isLogCategory(filter.category)) {
      return { ok: false, reason: `unknown category "${filter.category}"` }
    }
    types = typesIn(filter.category)
  }

  let cursor: Cursor | null = null
  if (filter.cursor) {
    cursor = decodeCursor(filter.cursor)
    if (!cursor) return { ok: false, reason: 'cursor is not one this log handed out' }
  }

  const floor = now - LOG_RETENTION_DAYS * DAY_MS
  const parts = BRANCHES.map((b) => {
    const where: SQL[] = []
    if (types) where.push(sql`type in (${sql.join(types.map((x) => sql`${x}`), sql`, `)})`)
    if (q) where.push(sql`(hay || ' ' || type) like ${`%${escapeLike(q)}%`} escape '\\'`)
    if (cursor) where.push(afterCursor(b.src, cursor))
    const whereSql = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``
    return sql`select * from (select * from (${b.select(floor)}) ${whereSql} order by at desc, sid desc limit ${limit + 1})`
  })

  const rows = (await db.all(sql`
    select src, sid, at, type, name, email, ref, n1, n2, detail, x, target
    from (${sql.join(parts, sql` union all `)})
    order by at desc, src asc, sid desc
    limit ${limit + 1}
  `)) as Row[]

  const more = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    ok: true,
    page: {
      events: pageRows.map(toEvent),
      nextCursor: more && last ? encodeCursor({ at: Number(last.at), src: last.src, sid: Number(last.sid) }) : null,
    },
  }
}

function typesIn(cat: string): string[] {
  return LOG_TYPES.filter((x) => x.category === cat).map((x) => x.type)
}

export function logTypeInfo(type: string): LogType | undefined {
  return BY_TYPE.get(type)
}

// ───────────────────────────────────────────────── plain words

const fmtN = (n: number | null) => Number(n ?? 0).toLocaleString('en-US')
const fmtCents = (cents: number | null, currency: string | null) =>
  `${(currency ?? 'usd').toUpperCase()} ${(Number(cents ?? 0) / 100).toFixed(2)}`

function toEvent(r: Row): LogEvent {
  const info = logTypeInfo(r.type)
  return {
    id: `${r.src}-${r.sid}`,
    at: new Date(Number(r.at)),
    type: r.type,
    category: info?.category ?? 'subscribers',
    level: info?.level ?? 'info',
    summary: describe(r),
    name: r.name,
    email: r.email,
    ref: r.ref,
    detail: r.detail,
    ...(r.type.startsWith('audit.')
      ? { actor: r.x as 'operator' | 'key' | 'agent', target: r.target }
      : {}),
  }
}

/** One sentence per row. */
function describe(r: Row): string {
  const who = r.name?.trim() || r.email || 'Someone'
  const ref = r.ref ?? 'a deleted item'
  switch (r.type) {
    case 'subscriber.joined':
      return `${who} joined the list`
    case 'subscriber.pending':
      return `${who} was added and has not confirmed yet`
    case 'subscriber.confirmed':
      return `${who} confirmed their subscription`
    case 'subscriber.imported':
      return `${who} was imported`
    case 'subscriber.unsubscribed':
      return `${who} unsubscribed from the newsletter`
    case 'subscriber.resubscribed':
      return `${who} subscribed again`
    case 'subscriber.left_everything':
      return `${who} unsubscribed from everything`
    case 'subscriber.suppressed':
      return `${who} was suppressed`
    case 'subscriber.unsuppressed':
      return `${who} is no longer suppressed`
    case 'subscriber.bounced':
      return `Mail to ${who} bounced`
    case 'subscriber.complained':
      return `${who} marked mail as spam`
    case 'tag.added':
      return `${who} was tagged "${ref}"`
    case 'tag.removed':
      return `${who} lost the tag "${ref}"`
    case 'sequence.enrolled':
      return `${who} started the ${ref} series`
    case 'sequence.advanced':
      return `${who} was sent the next step of the ${ref} series`
    case 'sequence.completed':
      return `${who} finished the ${ref} series`
    case 'sequence.cancelled':
      return `${who} was taken out of the ${ref} series`
    case 'sequence.left':
      return `${who} left the ${ref} series`
    case 'sequence.rejoined':
      return `${who} rejoined the ${ref} series`
    case 'form.submitted':
      return r.ref ? `${who} filled in the ${r.ref} form` : `${who} filled in a form`
    case 'campaign.touched':
      return `${who} came in through the ${ref} campaign`
    case 'sale.purchased':
      return `${who} bought ${r.ref ?? 'something'} for ${fmtCents(r.n1, r.x)}`
    case 'sale.refunded':
      return `${who} was refunded ${fmtCents(r.n1, r.x)} for ${r.ref ?? 'a sale'}`
    case 'broadcast.started':
      return `Broadcast "${ref}" started sending`
    case 'broadcast.finished':
      return `Broadcast "${ref}" finished: ${fmtN(r.n1)} sent${Number(r.n2) ? `, ${fmtN(r.n2)} not sent` : ''}`
    case 'mail.sent':
      return `Sent "${ref}" to ${r.email}`
    case 'mail.failed':
      return `"${ref}" to ${r.email} could not be sent`
    case 'mail.suppressed':
      return `Held back "${ref}" from ${r.email}`
    case 'stripe.received':
      return `Stripe sent ${ref}, waiting to be processed`
    case 'stripe.processed':
      return `Stripe ${ref} processed`
    case 'stripe.ignored':
      return `Stripe ${ref} needed nothing`
    case 'stripe.failed':
      return `Stripe ${ref} could not be processed`
    case 'sync.running':
      return `${syncName(r.ref)} started`
    case 'sync.ok':
    case 'sync.partial':
      return r.ref === 'stripe'
        ? `${syncName(r.ref)} finished: ${fmtN(r.n1)} charges seen, ${fmtN(r.n2)} sales recorded`
        : `${syncName(r.ref)} finished`
    case 'sync.failed':
      return `${syncName(r.ref)} failed`
    case 'audit.ok':
    case 'audit.denied':
    case 'audit.error':
      return describeAudit(r)
    default:
      return r.type
  }
}

function describeAudit(r: Row): string {
  const actor =
    r.x === 'operator'
      ? r.name && r.name !== 'dev-bypass'
        ? r.name
        : 'The operator'
      : r.x === 'key'
        ? `API key "${r.name ?? 'deleted'}"`
        : `Agent (key "${r.name ?? 'deleted'}")`
  const what = r.x === 'agent' ? `${r.ref}` : `${r.ref}${r.target ? ` on ${r.target}` : ''}`
  if (r.type === 'audit.denied') return `${actor} was refused: ${what}`
  if (r.type === 'audit.error') return `${actor} hit an error: ${what}`
  return r.x === 'agent' ? `${actor} called ${what}` : `${actor}: ${what}`
}

const syncName = (kind: string | null) => (kind === 'stripe_catalog' ? 'Stripe catalog sync' : 'Stripe sync')

export type { Row as LogRow }
