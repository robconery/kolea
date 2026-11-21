/**
 * The importers' write side: one page of records from any tool, written by one
 * set of rules. Every adapter in `providers/importers/` hands its page here, so
 * these rules exist exactly once.
 *
 * ⭐ Nothing here calls `upsertSubscriber()`, `addTags()`, `enrollOnSubscribe()`
 * or anything else that can enroll, send, or run a tag rule (ARCHITECTURE
 * invariant 5). Rows go straight into their tables in bulk, the way
 * `scripts/import-kit.ts` does it, chunked for D1's 100-bound-parameter cap.
 *
 * The rules:
 *   - an address already here keeps its consent. It may only NARROW: an
 *     `active`/`pending` person the other tool says unsubscribed, bounced or
 *     complained takes that status. `unsubscribed`, `bounced` and `complained`
 *     here never move, and nobody is ever made `active` by an import (SPEC 1.2,
 *     invariant 3). They gain the tool's tags, and a name if they had none;
 *   - an address already suppressed here is not added — the local suppression
 *     wins, and the import never writes over it (`ON CONFLICT DO NOTHING`);
 *   - an opt-out the tool recorded arrives as a suppression with the same reach
 *     the tool gave it, never wider (invariants 1–2);
 *   - a state the tool used that we do not know imports nobody;
 *   - broadcasts arrive `sent` with `sent_at` set and `published_at` null;
 *     drafts and scheduled mail are left behind; sequences arrive `manual` and
 *     off (invariant 6); a second run copies none of it twice.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import {
  type ImportNote,
  type ImportSourceId,
  activities,
  broadcasts,
  sequenceSteps,
  sequences,
  subscriberTags,
  subscribers,
  suppressions,
  tags,
} from '../../db/schema.ts'
import type {
  ImportedBroadcast,
  ImportedRecord,
  ImportedSequence,
  ImportedSubscriber,
  ImportedTagging,
} from '../../providers/importers/types.ts'
import { isValidEmail, normalizeEmail, randomToken, slugify } from '../ids.ts'
import { htmlToMarkdown } from './html.ts'

export interface WriteContext {
  runId: number
  source: ImportSourceId
  label: string
  now: number
}

export interface PageResult {
  created: number
  updated: number
  skipped: number
  invalid: number
  detail: Record<string, number>
  notes: ImportNote[]
}

/**
 * D1 binds at most 100 parameters per statement. Every chunk in this file is
 * sized from 90, not 100, so the handful of fixed parameters a statement adds
 * beside its list (a status, a timestamp, an `in ('active','pending')`) can
 * never tip it over. Sizing each chunk as "100 minus what I count today"
 * broke the first time a statement grew a parameter.
 */
const PARAMS = 90
const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
const rowsPer = (columns: number) => Math.floor(PARAMS / columns)

const empty = (): PageResult => ({ created: 0, updated: 0, skipped: 0, invalid: 0, detail: {}, notes: [] })

function add(into: PageResult, from: PageResult): PageResult {
  into.created += from.created
  into.updated += from.updated
  into.skipped += from.skipped
  into.invalid += from.invalid
  for (const [k, v] of Object.entries(from.detail)) into.detail[k] = (into.detail[k] ?? 0) + v
  into.notes = foldNotes([...into.notes, ...from.notes])
  return into
}

/** Same-key notes summed into one line, so a 50-page run reports one count, not fifty. */
export function foldNotes(notes: ImportNote[]): ImportNote[] {
  const byKey = new Map<string, ImportNote>()
  for (const n of notes) {
    if (n.count <= 0) continue
    const seen = byKey.get(n.key)
    byKey.set(n.key, seen ? { ...seen, count: seen.count + n.count } : { ...n })
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}

const note = (key: string, count: number, message: string): ImportNote[] =>
  count > 0 ? [{ key, count, message }] : []

export async function writePage(db: Db, ctx: WriteContext, records: ImportedRecord[]): Promise<PageResult> {
  const result = empty()
  const notes = records.filter((r) => r.kind === 'note')
  result.notes = foldNotes(notes.map(({ key, count, message }) => ({ key, count, message })))

  const tagNames = records.flatMap((r) => (r.kind === 'tag' ? [r.name] : []))
  if (tagNames.length) {
    const created = (await ensureTags(db, tagNames, ctx.now)).created
    add(result, { ...empty(), detail: { tags: created } })
  }

  const people = records.filter((r): r is ImportedSubscriber => r.kind === 'subscriber')
  if (people.length) add(result, await writeSubscribers(db, ctx, people))

  const taggings = records.filter((r): r is ImportedTagging => r.kind === 'tagging')
  if (taggings.length) add(result, await writeTaggings(db, ctx, taggings))

  const mail = records.filter((r): r is ImportedBroadcast => r.kind === 'broadcast')
  if (mail.length) add(result, await writeBroadcasts(db, ctx, mail))

  const series = records.filter((r): r is ImportedSequence => r.kind === 'sequence')
  if (series.length) add(result, await writeSequences(db, ctx, series))

  return result
}

// ─────────────────────────────────────────────────────────── tags

/** Tag ids by slug, creating the missing ones. Names that slug to nothing are dropped. */
async function ensureTags(
  db: Db,
  names: string[],
  now: number,
): Promise<{ ids: Map<string, number>; created: number }> {
  const bySlug = new Map<string, string>()
  for (const name of names) {
    const slug = slugify(name)
    if (slug && !bySlug.has(slug)) bySlug.set(slug, name.trim())
  }
  const slugs = [...bySlug.keys()]
  const ids = new Map<string, number>()
  if (slugs.length === 0) return { ids, created: 0 }

  for (const part of chunk(slugs, PARAMS)) {
    for (const t of await db.select({ id: tags.id, slug: tags.slug }).from(tags).where(inArray(tags.slug, part))) {
      ids.set(t.slug, t.id)
    }
  }
  const missing = slugs.filter((s) => !ids.has(s))
  let created = 0
  for (const part of chunk(missing, rowsPer(3))) {
    const rows = await db
      .insert(tags)
      .values(part.map((slug) => ({ slug, name: bySlug.get(slug)!, createdAt: new Date(now) })))
      .onConflictDoNothing()
      .returning({ id: tags.id, slug: tags.slug })
    created += rows.length
    for (const r of rows) ids.set(r.slug, r.id)
  }
  return { ids, created }
}

async function linkTags(db: Db, pairs: [number, number][], now: number): Promise<number> {
  const unique = [...new Map(pairs.map((p) => [`${p[0]}:${p[1]}`, p])).values()]
  let written = 0
  for (const part of chunk(unique, rowsPer(3))) {
    const rows = await db
      .insert(subscriberTags)
      .values(part.map(([subscriberId, tagId]) => ({ subscriberId, tagId, taggedAt: new Date(now) })))
      .onConflictDoNothing()
      .returning({ id: subscriberTags.subscriberId })
    written += rows.length
  }
  return written
}

async function existingPeople(db: Db, emails: string[]) {
  const out = new Map<string, { id: number; status: string; name: string | null }>()
  for (const part of chunk(emails, PARAMS)) {
    const rows = await db
      .select({ id: subscribers.id, email: subscribers.email, status: subscribers.status, name: subscribers.name })
      .from(subscribers)
      .where(inArray(subscribers.email, part))
    for (const r of rows) out.set(r.email, r)
  }
  return out
}

// ─────────────────────────────────────────────────────────── people

const NARROWER = new Set(['unsubscribed', 'bounced', 'complained'])

async function writeSubscribers(db: Db, ctx: WriteContext, records: ImportedSubscriber[]): Promise<PageResult> {
  const result = empty()
  const seen = new Set<string>()
  const known: (ImportedSubscriber & { status: NonNullable<ImportedSubscriber['status']> })[] = []
  const unknown = new Map<string, number>()
  let duplicates = 0

  for (const r of records) {
    const email = normalizeEmail(r.email ?? '')
    if (!isValidEmail(email)) {
      result.invalid++
      continue
    }
    if (r.status === null) {
      unknown.set(r.rawStatus || 'blank', (unknown.get(r.rawStatus || 'blank') ?? 0) + 1)
      result.skipped++
      continue
    }
    if (seen.has(email)) {
      duplicates++
      result.skipped++
      continue
    }
    seen.add(email)
    known.push({ ...r, email, status: r.status })
  }

  const emails = known.map((r) => r.email)
  const existing = await existingPeople(db, emails)
  const suppressed = new Set<string>()
  for (const part of chunk(emails, PARAMS)) {
    for (const s of await db.select({ email: suppressions.email }).from(suppressions).where(inArray(suppressions.email, part))) {
      suppressed.add(s.email)
    }
  }

  const fresh = known.filter((r) => !existing.has(r.email) && !suppressed.has(r.email))
  const alreadySuppressed = known.filter((r) => !existing.has(r.email) && suppressed.has(r.email)).length
  result.skipped += alreadySuppressed

  // New people. Straight SQL, never upsertSubscriber(): that would fire the
  // live `subscribe` sequences for every one of them (invariant 5).
  const ids = new Map<string, number>()
  for (const [email, s] of existing) ids.set(email, s.id)
  const inserted: typeof fresh = []
  for (const part of chunk(fresh, rowsPer(9))) {
    const rows = await db
      .insert(subscribers)
      .values(
        part.map((r) => {
          const joined = r.subscribedAt ?? ctx.now
          return {
            email: r.email,
            name: r.name,
            status: r.status,
            attributes: r.attributes,
            source: `${ctx.source}-import`,
            unsubToken: randomToken(),
            createdAt: new Date(joined),
            confirmedAt: r.confirmedAt ? new Date(r.confirmedAt) : null,
            unsubscribedAt: r.status === 'unsubscribed' ? new Date(r.unsubscribedAt ?? joined) : null,
          }
        }),
      )
      .onConflictDoNothing()
      .returning({ id: subscribers.id, email: subscribers.email })
    for (const row of rows) ids.set(row.email, row.id)
    const got = new Set(rows.map((r) => r.email))
    inserted.push(...part.filter((r) => got.has(r.email)))
  }
  result.created += inserted.length

  // People already here: consent may only narrow, never widen.
  const matched = known.filter((r) => existing.has(r.email))
  result.updated += matched.length
  const narrowed = matched.filter((r) => {
    const local = existing.get(r.email)!
    return (local.status === 'active' || local.status === 'pending') && NARROWER.has(r.status)
  })
  for (const status of ['unsubscribed', 'bounced', 'complained'] as const) {
    const group = narrowed.filter((r) => r.status === status).map((r) => existing.get(r.email)!.id)
    for (const part of chunk(group, PARAMS)) {
      await db
        .update(subscribers)
        .set({
          status,
          unsubscribedAt: status === 'unsubscribed' ? sql`coalesce(${subscribers.unsubscribedAt}, ${ctx.now})` : undefined,
        })
        .where(and(inArray(subscribers.id, part), inArray(subscribers.status, ['active', 'pending'])))
    }
  }

  // A name for people who had none. One CASE per chunk, not one UPDATE per person.
  const named = matched.filter((r) => r.name && !existing.get(r.email)!.name?.trim())
  for (const part of chunk(named, rowsPer(3))) {
    const cases = sql.join(
      part.map((r) => sql`when ${existing.get(r.email)!.id} then ${r.name}`),
      sql` `,
    )
    const partIds = part.map((r) => existing.get(r.email)!.id)
    await db
      .update(subscribers)
      .set({ name: sql`case ${subscribers.id} ${cases} end` })
      .where(and(inArray(subscribers.id, partIds), sql`(${subscribers.name} is null or trim(${subscribers.name}) = '')`))
  }

  // Tags, written as rows — `addTags()` would start `tag_added` sequences.
  const allTags = known.flatMap((r) => r.tags)
  let taggings = 0
  if (allTags.length) {
    const { ids: tagIds, created } = await ensureTags(db, allTags, ctx.now)
    result.detail.tags = created
    const pairs: [number, number][] = []
    for (const r of known) {
      const id = ids.get(r.email)
      if (!id) continue
      for (const t of r.tags) {
        const tagId = tagIds.get(slugify(t))
        if (tagId) pairs.push([id, tagId])
      }
    }
    taggings = await linkTags(db, pairs, ctx.now)
  }

  // The other tool's opt-outs, at their own reach. A local suppression wins.
  let suppressionsAdded = 0
  const optOuts = known.filter((r) => r.suppression && !suppressed.has(r.email))
  for (const part of chunk(optOuts, rowsPer(3))) {
    const rows = await db
      .insert(suppressions)
      .values(part.map((r) => ({ email: r.email, reason: r.suppression!, createdAt: new Date(ctx.now) })))
      .onConflictDoNothing()
      .returning({ id: suppressions.id })
    suppressionsAdded += rows.length
  }

  // The timeline. `source: 'import'` keeps a backfill out of every growth chart.
  const timeline = [
    ...inserted.map((r) => ({ id: ids.get(r.email)!, type: 'imported' as const, raw: r.rawStatus })),
    ...narrowed.map((r) => ({
      id: existing.get(r.email)!.id,
      type: r.status as 'unsubscribed' | 'bounced' | 'complained',
      raw: r.rawStatus,
    })),
  ]
  for (const part of chunk(timeline, rowsPer(5))) {
    await db.insert(activities).values(
      part.map((t) => ({
        subscriberId: t.id,
        type: t.type,
        occurredAt: new Date(ctx.now),
        source: 'import' as const,
        meta: { from: ctx.source, run: ctx.runId, status: t.raw },
      })),
    )
  }

  result.detail = {
    ...result.detail,
    subscribers: inserted.length,
    matched: matched.length,
    narrowed: narrowed.length,
    taggings,
    suppressions: suppressionsAdded,
  }
  result.notes = [
    ...note('invalid_emails', result.invalid, 'people had an address that cannot be stored and were not imported'),
    ...[...unknown].flatMap(([raw, n]) =>
      note(
        `unknown_status_${slugify(raw).replace(/-/g, '_') || 'blank'}`,
        n,
        `people had the status "${raw.slice(0, 40)}" in ${ctx.label}, which is not a choice to receive mail; they were not imported`,
      ),
    ),
    ...note('duplicates', duplicates, 'addresses appeared twice in one page; the first was used'),
    ...note('already_suppressed', alreadySuppressed, 'people are suppressed here and were not added'),
    ...note(
      'kept_status',
      matched.length - narrowed.length,
      'people already here kept their status; an import never moves anybody toward more mail',
    ),
    ...note(
      'narrowed',
      narrowed.length,
      `people already here had left in ${ctx.label}, and now have the same status here`,
    ),
  ]
  return result
}

async function writeTaggings(db: Db, ctx: WriteContext, records: ImportedTagging[]): Promise<PageResult> {
  const emails = [...new Set(records.map((t) => normalizeEmail(t.email)))]
  const people = await existingPeople(db, emails)
  const { ids: tagIds, created } = await ensureTags(
    db,
    records.map((t) => t.tag),
    ctx.now,
  )
  const pairs: [number, number][] = []
  let missing = 0
  for (const t of records) {
    const person = people.get(normalizeEmail(t.email))
    const tagId = tagIds.get(slugify(t.tag))
    if (person && tagId) pairs.push([person.id, tagId])
    else missing++
  }
  const written = await linkTags(db, pairs, ctx.now)
  return {
    ...empty(),
    detail: { taggings: written, tags: created },
    notes: note('taggings_skipped', missing, 'taggings named somebody who did not come over'),
  }
}

// ─────────────────────────────────────────────────────────── content

async function writeBroadcasts(db: Db, ctx: WriteContext, records: ImportedBroadcast[]): Promise<PageResult> {
  const result = empty()
  const sent = records.filter((b) => b.sent && b.sentAt !== null)
  const drafts = records.length - sent.length
  result.skipped += drafts

  const done = new Set<string>()
  for (const part of chunk(
    sent.map((b) => b.sourceId),
    PARAMS,
  )) {
    const rows = await db
      .select({ id: broadcasts.importedSourceId })
      .from(broadcasts)
      .where(and(eq(broadcasts.importedFrom, ctx.source), inArray(broadcasts.importedSourceId, part)))
    for (const r of rows) if (r.id) done.add(r.id)
  }
  // The one-off Kit archive has no source ids: same subject at the same moment
  // is the same mail, exactly as `scripts/import-kit-content.ts` decided.
  const sameSend = new Set<string>()
  for (const part of chunk([...new Set(sent.map((b) => b.sentAt!))], PARAMS)) {
    const rows = await db
      .select({ subject: broadcasts.subject, sentAt: broadcasts.sentAt })
      .from(broadcasts)
      .where(inArray(broadcasts.sentAt, part.map((t) => new Date(t))))
    for (const r of rows) sameSend.add(`${r.subject}|${r.sentAt?.getTime()}`)
  }
  const taken = new Set<string>()
  const wanted = sent.map((b) => b.slug).filter((s): s is string => !!s)
  for (const part of chunk(wanted, PARAMS)) {
    for (const r of await db.select({ slug: broadcasts.slug }).from(broadcasts).where(inArray(broadcasts.slug, part))) {
      if (r.slug) taken.add(r.slug)
    }
  }

  let again = 0
  let slugsDropped = 0
  let withTotals = 0
  for (const b of sent) {
    if (done.has(b.sourceId) || sameSend.has(`${b.subject}|${b.sentAt}`)) {
      again++
      continue
    }
    let slug = b.slug ? slugify(b.slug) || null : null
    if (slug && taken.has(slug)) {
      slug = null
      slugsDropped++
    }
    if (slug) taken.add(slug)
    const sentAt = new Date(b.sentAt!)
    // ⭐ `sent` + `sent_at`: the minutely tick only claims `sending` or
    // `scheduled`-and-due, so this row is unreachable by the send path. Not
    // published, and `publish_on_send` off: going on the web is a separate act.
    await db
      .insert(broadcasts)
      .values({
        subject: b.subject,
        bodyJson: null,
        bodyMd: htmlToMarkdown(b.html),
        segment: {},
        status: 'sent',
        scheduledAt: null,
        startedAt: sentAt,
        sentAt,
        cursorSubscriberId: 0,
        createdAt: new Date(b.createdAt ?? b.sentAt!),
        importedRecipients: b.totals?.recipients ?? null,
        importedOpened: b.totals ? b.totals.opened : null,
        importedClicked: b.totals ? b.totals.clicked : null,
        importedUnsubscribed: b.totals ? b.totals.unsubscribed : null,
        importedFrom: ctx.source,
        importedSourceId: b.sourceId,
        publishedAt: null,
        publishOnSend: false,
        featured: b.featured,
        slug,
        excerpt: b.excerpt,
        featureImage: b.featureImage,
      })
      .onConflictDoNothing()
    result.created++
    if (b.totals) withTotals++
  }
  result.skipped += again
  result.detail = { broadcasts: sent.length - again, imported_totals: withTotals }
  result.notes = [
    ...note('drafts_left_behind', drafts, `drafts or scheduled mails in ${ctx.label} never went out and were left behind`),
    ...note('broadcasts_already_here', again, 'broadcasts were already here and were not copied twice'),
    ...note('slugs_taken', slugsDropped, 'posts kept no slug because a broadcast here already uses it'),
  ]
  return result
}

async function writeSequences(db: Db, ctx: WriteContext, records: ImportedSequence[]): Promise<PageResult> {
  const result = empty()
  const done = new Set<string>()
  for (const part of chunk(
    records.map((s) => s.sourceId),
    PARAMS,
  )) {
    const rows = await db
      .select({ id: sequences.importedSourceId })
      .from(sequences)
      .where(and(eq(sequences.importedFrom, ctx.source), inArray(sequences.importedSourceId, part)))
    for (const r of rows) if (r.id) done.add(r.id)
  }
  const taken = new Set<string>()
  for (const part of chunk(
    records.map((s) => slugify(s.name)),
    PARAMS,
  )) {
    for (const r of await db.select({ slug: sequences.slug }).from(sequences).where(inArray(sequences.slug, part))) {
      taken.add(r.slug)
    }
  }

  let again = 0
  let steps = 0
  let rounded = 0
  for (const s of records) {
    const slug = slugify(s.name) || `${ctx.source}-sequence-${slugify(s.sourceId)}`
    // A sequence by that name is already here (the one-off Kit import made them
    // by slug, too): leave it alone rather than make a second copy.
    if (done.has(s.sourceId) || taken.has(slug)) {
      again++
      continue
    }
    taken.add(slug)
    // ⭐ `manual` and off. Every enrollment path gates on `is_active`, and
    // turning it on is a deliberate act with its own preflight.
    const row = await db
      .insert(sequences)
      .values({
        slug,
        name: s.name,
        description: `Imported from ${ctx.label}.`,
        trigger: 'manual',
        triggerTagId: null,
        isActive: false,
        createdAt: new Date(s.createdAt ?? ctx.now),
        importedFrom: ctx.source,
        importedSourceId: s.sourceId,
      })
      .returning({ id: sequences.id })
      .get()
    for (const part of chunk(
      s.steps.map((st, i) => ({ ...st, position: i + 1 })),
      rowsPer(7),
    )) {
      await db.insert(sequenceSteps).values(
        part.map((st) => ({
          sequenceId: row.id,
          position: st.position,
          delayDays: st.delayDays,
          subject: st.subject,
          bodyJson: null,
          bodyMd: htmlToMarkdown(st.html),
        })),
      )
    }
    steps += s.steps.length
    rounded += s.steps.filter((st) => st.rounded).length
    result.created++
  }
  result.skipped += again
  result.detail = { sequences: records.length - again, sequence_steps: steps }
  result.notes = [
    ...note(
      'sequences_off',
      records.length - again,
      'sequences arrived off, with a manual start; nothing sends until you turn one on',
    ),
    ...note('sequences_already_here', again, 'sequences with that name were already here and were left alone'),
    ...note('delays_rounded', rounded, 'sequence delays were not whole days and were rounded up'),
  ]
  return result
}
