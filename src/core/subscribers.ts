import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { subscriberTags, subscribers, tags } from '../db/schema.ts'
import { isValidEmail, normalizeEmail, randomToken, slugify } from './ids.ts'
import { enrollOnSubscribe, enrollOnTag } from './sequences.ts'

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
    await enrollOnTag(db, subscriberId, tagId)
    added++
  }
  return added
}

export async function removeTag(db: Db, subscriberId: number, tagId: number): Promise<void> {
  await db
    .delete(subscriberTags)
    .where(and(eq(subscriberTags.subscriberId, subscriberId), eq(subscriberTags.tagId, tagId)))
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
}

/**
 * Import CSV. Expects a header row containing at least `email`; `name` and
 * `tags` (semicolon-separated) are optional. A malformed row is counted and
 * skipped, never fatal (SPEC 1.3).
 */
export async function importCsv(db: Db, csv: string): Promise<ImportReport> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const report: ImportReport = { created: 0, updated: 0, invalid: 0, rows: 0 }
  if (lines.length === 0) return report

  const header = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase())
  const emailIdx = header.indexOf('email')
  const nameIdx = header.indexOf('name')
  const tagsIdx = header.indexOf('tags')
  if (emailIdx === -1) return report

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

    const { outcome } = await upsertSubscriber(db, {
      email,
      name: nameIdx >= 0 ? (cells[nameIdx]?.trim() ?? null) : null,
      source: 'import',
      tagIds,
    })
    if (outcome === 'created') report.created++
    else if (outcome === 'invalid') report.invalid++
    else report.updated++
  }

  return report
}

function splitCsvLine(line: string): string[] {
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
