import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { subscriberTags, subscribers, tags } from '../db/schema.ts'
import { logActivity } from './activity.ts'
import {
  type FieldChanges,
  type FieldType,
  castFieldValue,
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
   */
  status?: 'pending' | 'active'
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
    const promoting = existing.status === 'pending' && wantedStatus === 'active'
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
    })
    .returning({ id: subscribers.id })

  const id = inserted[0]!.id

  // `pending` is "we have their address, they did not ask for mail" — a buyer on
  // file. Logging it as `subscribed` would inflate every growth chart with people
  // who never joined, so it gets its own type and stays out of the joined count.
  await logActivity(db, {
    type: wantedStatus === 'active' ? 'subscribed' : 'pending_added',
    subscriberId: id,
    meta: { email, origin: input.source ?? null },
    dedupeKey: `${wantedStatus === 'active' ? 'subscribed' : 'pending'}:${id}`,
  })

  // A CSV import is history, not news (Kōlea SPEC 20.2): it emits nothing.
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

/**
 * Tag someone. Idempotent — an already-present tag is skipped, which is what
 * keeps a `tag_added` sequence from re-firing every time a rule matches again.
 * Returns how many tags were actually new.
 */
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

export interface ImportReport {
  created: number
  updated: number
  invalid: number
  rows: number
  /** Custom-field columns the header matched, by key. */
  fieldColumns: string[]
  /**
   * Field values that did not fit their type, one entry per cell. The person on
   * that row is still imported — only the bad value is left out (Kōlea's import
   * is lenient the same way: an unreadable attribute is noted, not fatal).
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
 */
export async function importCsv(db: Db, csv: string): Promise<ImportReport> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const report: ImportReport = {
    created: 0,
    updated: 0,
    invalid: 0,
    rows: 0,
    fieldColumns: [],
    fieldErrors: [],
  }
  if (lines.length === 0) return report

  const header = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase())
  const emailIdx = header.indexOf('email')
  const nameIdx = header.indexOf('name')
  const tagsIdx = header.indexOf('tags')
  if (emailIdx === -1) return report

  // One read of the definitions for the whole file.
  const types = await fieldTypes(db)
  const fieldCols: { idx: number; key: string; type: FieldType }[] = []
  header.forEach((h, idx) => {
    if (idx === emailIdx || idx === nameIdx || idx === tagsIdx) return
    const key = types.has(h) ? h : keyFor(h)
    const type = types.get(key)
    if (type && !fieldCols.some((c) => c.key === key)) fieldCols.push({ idx, key, type })
  })
  report.fieldColumns = fieldCols.map((c) => c.key)

  for (const line of lines.slice(1)) {
    report.rows++
    const cells = splitCsvLine(line)
    const email = cells[emailIdx]?.trim()
    if (!email) {
      report.invalid++
      continue
    }

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
    const { outcome, id } = await upsertSubscriber(db, {
      email,
      name: nameIdx >= 0 ? (cells[nameIdx]?.trim() ?? null) : null,
      source: 'import',
      triggerSubscribeSequences: false,
    })
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
