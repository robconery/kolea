import { and, count, eq, gt, inArray } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { formConfirmations, sales, subscriberTags, subscribers, tags } from '../db/schema.ts'
import { logActivity } from './activity.ts'
import { isPrunedIn, loadConsentSnapshot } from './consent.ts'
import {
  type FieldChanges,
  type FieldType,
  castFieldValue,
  castFieldValues,
  fieldTypes,
  keyFor,
  setFieldValues,
} from './fields.ts'
import { isValidEmail, normalizeEmail, randomToken, slugify } from './ids.ts'
import { enrollOnSubscribe, enrollOnTag, exitOnTag } from './sequences.ts'
import { emitWebhook, subscriberPayload } from './webhooks.ts'

export interface UpsertInput {
  email: string
  name?: string | null
  source?: string | null
  tagIds?: number[]
  /**
   * Whether creating this person should fire `subscribe`-triggered sequences.
   * Defaults to true — they joined the list, so the welcome series is the point.
   *
   * Set false when the address is created as a side effect of something that
   * isn't a signup: a receipt, a purchase. Those people should be greeted by
   * whatever their tags trigger, not by "thanks for subscribing!".
   */
  triggerSubscribeSequences?: boolean
  /**
   * What status a *newly created* row gets. Defaults to `active`, because the
   * ordinary way onto this list is a signup.
   *
   * Pass `pending` when the address arrives as a side effect of something that
   * is not a request to be mailed — a purchase, a receipt. `pending` is invisible
   * to broadcasts (`core/segments.ts` filters on `active`) but still reachable by
   * sequences and transactional mail, which is exactly the shape a buyer who has
   * not joined the newsletter should have.
   *
   * `unsubscribed`, `bounced` and `complained` are for a CSV import bringing
   * somebody back in the state the file says (a clean-up backup), only ever
   * narrower than `active`. They arrive with nothing fired and no webhook.
   */
  status?: 'pending' | 'active' | 'unsubscribed' | 'bounced' | 'complained'
  /**
   * Whether an existing `pending` person may be promoted to `active` by this
   * call when it asks for `active`. Defaults to true. A CSV import passes
   * false: a file is not the person asking, and `pending` includes somebody
   * who has not yet clicked a double opt-in link.
   */
  promotePending?: boolean
  /**
   * Set only by the double opt-in click (`confirmSignup`). Every other caller
   * is refused the promotion while the person has an open confirmation: they
   * were asked to prove the address is theirs, and a public `/subscribe`, an
   * MCP upsert or a single opt-in form must not answer that for them.
   */
  viaConfirmation?: boolean
}

/** `promoted` is an `updated` that also flipped `pending` → `active`. */
export type UpsertOutcome = 'created' | 'updated' | 'promoted' | 'invalid'

/**
 * Create or update a subscriber by address.
 *
 * Never resurrects an `unsubscribed` subscriber to `active` (SPEC 1.2) — an
 * import must not undo somebody's stated preference. The only status change this
 * function will ever make is `pending` → `active`, and only when the caller is
 * asking for `active`: that is somebody who was on file as a buyer actually
 * joining the list. Every other status is left exactly as it was found.
 */
export async function upsertSubscriber(
  db: Db,
  input: UpsertInput,
): Promise<{ outcome: UpsertOutcome; id?: number }> {
  const email = normalizeEmail(input.email)
  if (!isValidEmail(email)) return { outcome: 'invalid' }

  const existing = await db.select().from(subscribers).where(eq(subscribers.email, email)).get()

  const wantedStatus = input.status ?? 'active'

  if (existing) {
    if (input.name && input.name !== existing.name) {
      await db.update(subscribers).set({ name: input.name }).where(eq(subscribers.id, existing.id))
    }

    // A buyer we only had on file because they paid us has now actually asked to
    // be here. Promote them, and give them the welcome series they just earned —
    // creating the row silently was the whole point of `pending`, so this is the
    // first moment the subscribe sequences are allowed to fire for them.
    //
    // Guarded on `pending` alone: `unsubscribed`, `bounced` and `complained`
    // are never walked back by this path, whatever the caller asks for.
    //
    // ⭐ And never past an open double opt-in: somebody who was sent a
    // confirmation link becomes `active` by clicking it, from nowhere else.
    const promoting =
      existing.status === 'pending' &&
      wantedStatus === 'active' &&
      input.promotePending !== false &&
      (input.viaConfirmation === true || !(await hasOpenConfirmation(db, existing.id)))
    if (promoting) {
      await db
        .update(subscribers)
        .set({ status: 'active', source: input.source ?? existing.source })
        .where(eq(subscribers.id, existing.id))
    }

    if (promoting) {
      await logActivity(db, {
        type: 'promoted',
        subscriberId: existing.id,
        meta: { from: 'pending', source: input.source ?? existing.source },
        // A person can only be promoted once — the branch is guarded on
        // `pending` — but a double-submitted form races itself, and two
        // "joined the list" rows for one joining is exactly the noise this
        // feed exists to not have.
        dedupeKey: `promoted:${existing.id}`,
      })
    }

    // A buyer on file joining the list is news to a receiver; an import is not.
    if (promoting && input.source !== 'import') {
      await emitWebhook(
        db,
        'subscribed',
        async () => {
          const subscriber = await subscriberPayload(db, existing.id)
          return subscriber && { subscriber, via: 'promoted' }
        },
        { dedupeKey: `promoted:${existing.id}` },
      )
    }

    if (input.tagIds?.length) await addTags(db, existing.id, input.tagIds)
    if (promoting && input.triggerSubscribeSequences !== false) {
      await enrollOnSubscribe(db, existing.id)
    }

    return { outcome: promoting ? 'promoted' : 'updated', id: existing.id }
  }

  const inserted = await db
    .insert(subscribers)
    .values({
      email,
      name: input.name ?? null,
      status: wantedStatus,
      source: input.source ?? null,
      unsubToken: randomToken(),
      createdAt: new Date(),
      unsubscribedAt: wantedStatus === 'unsubscribed' ? new Date() : null,
    })
    .returning({ id: subscribers.id })

  const id = inserted[0]!.id

  // `pending` is "we have their address, they did not ask for mail" — a buyer on
  // file. Logging it as `subscribed` would inflate every growth chart with people
  // who never joined, so it gets its own type and stays out of the joined count.
  // Somebody restored from a file already off the list is history: `imported`.
  const arrival =
    wantedStatus === 'active' ? 'subscribed' : wantedStatus === 'pending' ? 'pending_added' : 'imported'
  await logActivity(db, {
    type: arrival,
    subscriberId: id,
    meta: { email, origin: input.source ?? null, ...(arrival === 'imported' ? { status: wantedStatus } : {}) },
    dedupeKey: `${arrival === 'subscribed' ? 'subscribed' : arrival === 'pending_added' ? 'pending' : 'imported'}:${id}`,
  })

  // A CSV import is history, not news: it emits nothing.
  if (wantedStatus === 'active' && input.source !== 'import') {
    await emitWebhook(
      db,
      'subscribed',
      async () => {
        const subscriber = await subscriberPayload(db, id)
        return subscriber && { subscriber, via: 'subscribed' }
      },
      { dedupeKey: `subscribed:${id}` },
    )
  }

  if (input.tagIds?.length) await addTags(db, id, input.tagIds)
  // `pending` means "we have their address, they did not ask for mail" — the
  // welcome series is not a thing that can be true of them yet. It fires later,
  // if and when they subscribe for real and the promotion branch above runs.
  if (wantedStatus === 'active' && input.triggerSubscribeSequences !== false) {
    await enrollOnSubscribe(db, id)
  }

  return { outcome: 'created', id }
}

/** An unconfirmed, unexpired double opt-in confirmation for this person, on any form. */
async function hasOpenConfirmation(db: Db, subscriberId: number): Promise<boolean> {
  const row = await db
    .select({ id: formConfirmations.id })
    .from(formConfirmations)
    .where(
      and(
        eq(formConfirmations.subscriberId, subscriberId),
        eq(formConfirmations.status, 'pending'),
        gt(formConfirmations.expiresAt, new Date()),
      ),
    )
    .get()
  return Boolean(row)
}

/**
 * Tag someone. Idempotent — an already-present tag is skipped, which is what
 * keeps a `tag_added` sequence from re-firing every time a rule matches again.
 * Returns how many tags were actually new.
 */
/**
 * Upsert plus custom field values, all or nothing on the values: an unknown key
 * or a value of the wrong type refuses the whole call before anything is
 * written, so a bad value never leaves a half-written person. The one path for
 * every caller that takes `fields` (MCP `subscriber_upsert`, `POST
 * /api/v1/subscribers`). `null` or "" clears a value.
 */
export async function upsertWithFields(
  db: Db,
  input: UpsertInput,
  fields?: Record<string, string | number | boolean | null>,
): Promise<
  | { ok: true; outcome: Exclude<UpsertOutcome, 'invalid'>; id: number; fieldsWritten?: number }
  | { ok: false; reason: string; field: string; fieldErrors?: Record<string, string> }
> {
  const cast = fields ? castFieldValues(await fieldTypes(db), fields) : null
  if (cast && Object.keys(cast.errors).length) {
    const [first] = Object.keys(cast.errors)
    return {
      ok: false,
      reason: `Field values rejected: ${Object.entries(cast.errors)
        .map(([k, e]) => `${k} ${e}`)
        .join('; ')}.`,
      field: `fields.${first}`,
      fieldErrors: cast.errors,
    }
  }
  const result = await upsertSubscriber(db, input)
  if (result.outcome === 'invalid' || !result.id) {
    return { ok: false, reason: `"${input.email}" is not a valid address.`, field: 'email' }
  }
  const written = cast ? await setFieldValues(db, result.id, cast.changes) : undefined
  return {
    ok: true,
    outcome: result.outcome,
    id: result.id,
    ...(written === undefined ? {} : { fieldsWritten: written }),
  }
}

export async function addTags(db: Db, subscriberId: number, tagIds: number[]): Promise<number> {
  const now = new Date()
  // One lookup for the whole call, not one per tag. Tagging runs inside CSV
  // import and inside the queue consumer, and D1 allows 1,000 queries per
  // invocation — a per-tag name lookup is how a 13k import runs out of budget.
  const names = await tagNames(db, tagIds)
  let added = 0
  for (const tagId of tagIds) {
    const before = await db
      .select({ subscriberId: subscriberTags.subscriberId })
      .from(subscriberTags)
      .where(
        and(eq(subscriberTags.subscriberId, subscriberId), eq(subscriberTags.tagId, tagId)),
      )
      .get()
    if (before) continue

    await db
      .insert(subscriberTags)
      .values({ subscriberId, tagId, taggedAt: now })
      .onConflictDoNothing()
    await logActivity(db, {
      type: 'tagged',
      subscriberId,
      occurredAt: now,
      meta: { tagId, tag: names.get(tagId) ?? null },
      // `subscriber_tags` is a compound PK, so a tag lands at most once —
      // but it can be removed and re-added, and both of those are real
      // events. Keyed on the moment, not the pair.
      dedupeKey: `tagged:${subscriberId}:${tagId}:${now.getTime()}`,
    })
    // Out before in: one tag can end the pitch and start onboarding.
    await exitOnTag(db, subscriberId, tagId)
    await enrollOnTag(db, subscriberId, tagId)
    added++
  }
  return added
}

export async function removeTag(db: Db, subscriberId: number, tagId: number): Promise<void> {
  const name = (await tagNames(db, [tagId])).get(tagId) ?? null
  const removed = await db
    .delete(subscriberTags)
    .where(and(eq(subscriberTags.subscriberId, subscriberId), eq(subscriberTags.tagId, tagId)))
    .returning({ tagId: subscriberTags.tagId })

  // Only log a removal that removed something. Un-tagging somebody who was never
  // tagged is a no-op, and a feed full of no-ops is a feed nobody reads.
  if (removed.length === 0) return
  await logActivity(db, {
    type: 'untagged',
    subscriberId,
    meta: { tagId, tag: name },
  })
}

/** Names for the feed. A row saying "tagged: 47" is not a story. */
async function tagNames(db: Db, tagIds: number[]): Promise<Map<number, string>> {
  if (tagIds.length === 0) return new Map()
  const rows = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(inArray(tags.id, tagIds))
    .all()
  return new Map(rows.map((r) => [r.id, r.name]))
}

export async function findOrCreateTag(db: Db, name: string): Promise<number> {
  const slug = slugify(name)
  const existing = await db.select().from(tags).where(eq(tags.slug, slug)).get()
  if (existing) return existing.id
  const inserted = await db
    .insert(tags)
    .values({ slug, name, createdAt: new Date() })
    .returning({ id: tags.id })
  return inserted[0]!.id
}

/**
 * Data rows one `importCsv` call works through. Each row costs a handful of
 * queries (the upsert, its tags, its fields), and D1 allows 1,000 per
 * invocation, so a 13k-row paste must not be one call. Same cap as the sales
 * import. Rows past it are reported, never half-written or a 500.
 */
export const IMPORT_ROW_LIMIT = 100

export interface ImportReport {
  created: number
  updated: number
  invalid: number
  rows: number
  /** Data rows past IMPORT_ROW_LIMIT, untouched. Import them in a later call. */
  notProcessed: number
  /** The 1-based data row the next call should start from, or null when none were left. */
  firstUnprocessedRow: number | null
  /** Custom-field columns the header matched, by key. */
  fieldColumns: string[]
  /**
   * Field values that did not fit their type, one entry per cell. The person on
   * that row is still imported — only the bad value is left out: an
   * unreadable value is noted, not fatal.
   * `row` is the 1-based data row, not counting the header.
   */
  fieldErrors: { row: number; email: string; field: string; error: string }[]
}

/**
 * Import CSV. Expects a header row containing at least `email`; `name` and
 * `tags` (semicolon-separated) are optional. Any other column whose header is a
 * custom field's key (or its label, reduced the same way — "Signup Plan" finds
 * `signup_plan`) fills that field, cast to its type. Columns that match no field
 * are ignored, as before. A malformed row is counted and skipped, never fatal
 * (SPEC 1.3).
 *
 * Field values are written with `setFieldValues`, never through
 * `upsertSubscriber`, so filling a field can't start a sequence. A blank cell
 * leaves a stored value alone: an export with an empty column must not wipe
 * what the list already knows.
 *
 * At most IMPORT_ROW_LIMIT data rows per call; the rest are counted in
 * `notProcessed` and left for the next call.
 *
 * An optional `status` column is honoured only in the narrowing direction
 * (`pending`, `unsubscribed`, `bounced`, `complained`), which is what lets the
 * clean-up backup restore people as they were. An address a clean-up left a
 * `pruned` marker on comes back `unsubscribed`.
 */
export async function importCsv(db: Db, csv: string): Promise<ImportReport> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const report: ImportReport = {
    created: 0,
    updated: 0,
    invalid: 0,
    rows: 0,
    notProcessed: 0,
    firstUnprocessedRow: null,
    fieldColumns: [],
    fieldErrors: [],
  }
  if (lines.length === 0) return report

  const header = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase())
  const emailIdx = header.indexOf('email')
  const nameIdx = header.indexOf('name')
  const tagsIdx = header.indexOf('tags')
  const statusIdx = header.indexOf('status')
  if (emailIdx === -1) return report

  // One read of the definitions for the whole file.
  const types = await fieldTypes(db)
  const fieldCols: { idx: number; key: string; type: FieldType }[] = []
  header.forEach((h, idx) => {
    if (idx === emailIdx || idx === nameIdx || idx === tagsIdx || idx === statusIdx) return
    const key = types.has(h) ? h : keyFor(h)
    const type = types.get(key)
    if (type && !fieldCols.some((c) => c.key === key)) fieldCols.push({ idx, key, type })
  })
  report.fieldColumns = fieldCols.map((c) => c.key)

  const data = lines.slice(1)
  if (data.length > IMPORT_ROW_LIMIT) {
    report.notProcessed = data.length - IMPORT_ROW_LIMIT
    report.firstUnprocessedRow = IMPORT_ROW_LIMIT + 1
  }

  const page = data.slice(0, IMPORT_ROW_LIMIT).map(splitCsvLine)
  // One read for the page: who a clean-up left a `pruned` marker for. They
  // left the newsletter before they were deleted, so a file must not bring
  // them back to it: they arrive `unsubscribed`.
  const snapshot = await loadConsentSnapshot(
    db,
    page.map((cells) => cells[emailIdx]?.trim() ?? '').filter(Boolean),
  )

  for (const cells of page) {
    report.rows++
    const email = cells[emailIdx]?.trim()
    if (!email) {
      report.invalid++
      continue
    }

    // ⭐ A `status` column only ever narrows (invariant 3): `unsubscribed`,
    // `pending`, `bounced` and `complained` stay so, and nothing in a file
    // makes anybody `active` who is not already.
    const said = narrowingStatus(statusIdx >= 0 ? cells[statusIdx] : undefined)
    const pruned = isPrunedIn(snapshot, email)
    const forNew: NonNullable<UpsertInput['status']> =
      pruned && (said === null || said === 'pending') ? 'unsubscribed' : (said ?? 'active')

    const tagIds: number[] = []
    const rawTags = tagsIdx >= 0 ? cells[tagsIdx] : undefined
    if (rawTags) {
      for (const t of rawTags.split(';').map((s) => s.trim()).filter(Boolean)) {
        tagIds.push(await findOrCreateTag(db, t))
      }
    }

    // ⭐ Invariant 5: a bulk import must never start mail. No subscribe
    // sequences, and the tags are written straight to the junction rather than
    // through `addTags`, which would fire `tag_added` sequences and exits.
    //
    // ⭐ And it never promotes anybody: a `pending` person (a buyer on file, or
    // somebody who has not clicked their double opt-in link yet) stays pending.
    // New people still arrive `active`, as before.
    const { outcome, id } = await upsertSubscriber(db, {
      email,
      name: nameIdx >= 0 ? (cells[nameIdx]?.trim() ?? null) : null,
      source: 'import',
      status: forNew,
      triggerSubscribeSequences: false,
      promotePending: false,
    })
    if (id && outcome !== 'created' && outcome !== 'invalid' && said && said !== 'pending') {
      await narrowExisting(db, id, said)
    }
    if (id && outcome !== 'invalid' && tagIds.length) {
      const now = new Date()
      await db
        .insert(subscriberTags)
        .values(tagIds.map((tagId) => ({ subscriberId: id, tagId, taggedAt: now })))
        .onConflictDoNothing()
    }
    if (outcome === 'created') report.created++
    else if (outcome === 'invalid') report.invalid++
    else report.updated++

    if (id && outcome !== 'invalid' && fieldCols.length) {
      const changes: FieldChanges = {}
      for (const col of fieldCols) {
        const cast = castFieldValue(col.type, cells[col.idx])
        if (!cast.ok) {
          report.fieldErrors.push({ row: report.rows, email, field: col.key, error: cast.error })
        } else if (cast.value !== null) {
          changes[col.key] = cast.value
        }
      }
      await setFieldValues(db, id, changes)
    }
  }

  return report
}

const NARROWING = ['pending', 'unsubscribed', 'bounced', 'complained'] as const
type Narrowing = (typeof NARROWING)[number]

/** A `status` cell, when it names something narrower than `active`. Anything else is ignored. */
function narrowingStatus(raw: string | undefined): Narrowing | null {
  const v = raw?.trim().toLowerCase() ?? ''
  return (NARROWING as readonly string[]).includes(v) ? (v as Narrowing) : null
}

/**
 * The file says somebody already here has left (or their address is dead).
 * Only `active` and `pending` move, as the importers do it; `unsubscribed`,
 * `bounced` and `complained` are never overwritten. No suppression, no
 * webhook: an import is history, not news, and a file is not a fourth cause of
 * "off everything" (invariant 2).
 */
async function narrowExisting(db: Db, id: number, status: Exclude<Narrowing, 'pending'>): Promise<void> {
  const moved = await db
    .update(subscribers)
    .set({ status, ...(status === 'unsubscribed' ? { unsubscribedAt: new Date() } : {}) })
    .where(and(eq(subscribers.id, id), inArray(subscribers.status, ['active', 'pending'])))
    .returning({ id: subscribers.id })
  if (moved.length === 0) return
  await logActivity(db, { type: status, subscriberId: id, source: 'import', meta: { via: 'csv' } })
}

export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Erase one person and everything that cascades from them: messages, events,
 * enrollments, attribution touches and sales. For erasure requests only — to
 * stop mailing someone, suppress them; that keeps the history. Says how many
 * sales went with them, because revenue reports change.
 */
export async function eraseSubscriber(db: Db, id: number): Promise<{ salesDeleted: number }> {
  const owned = await db.select({ n: count() }).from(sales).where(eq(sales.subscriberId, id)).get()
  await db.delete(subscribers).where(eq(subscribers.id, id))
  return { salesDeleted: owned?.n ?? 0 }
}
