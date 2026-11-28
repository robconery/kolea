import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { subscribers, tags } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { getBroadcast, launchBroadcast } from './broadcasts.ts'
import { canReceiveBroadcastIn, loadConsentSnapshot } from './consent.ts'
import { fieldKeys } from './fields.ts'
import { type DevLink, devLinkRefusal, devLinks } from './link-safety.ts'
import { authoredLead, postUrl } from './posts.ts'
import { consumePreflight, digestOf, mintPreflight } from './preflight.ts'
import { previewHtml, renderEmail } from './render.ts'
import { countSegment, describeRule, resolveSegment } from './segments.ts'
import { getSequence, sequenceStats, setSequenceActive, stepsFor } from './sequences.ts'
import { MERGE_TAG } from './text.ts'
import { trackingBaseUrl } from './tracking-host.ts'

/**
 * ⭐ The two irreversible acts — sending a broadcast, taking a sequence live —
 * and the preview each must follow.
 *
 * One implementation for every door: MCP and the REST API both call these, so
 * "preview, then spend the token the preview minted" is one rule, not two.
 * The agent send switch is checked by each door before it gets here (MCP's
 * tools, `/api/v1`'s send gate), since both take the same admin keys. The token
 * is checked for everyone.
 */

/**
 * Merge tags the renderer knows. Anything else is passed through to the reader
 * verbatim, braces and all — no error, no blank. Exactly the silent failure a
 * preflight exists to surface.
 */
const BUILTIN_MERGE_FIELDS = ['name', 'first_name', 'email']

/**
 * Segment pages the preflight walks. `resolveSegment` pages at 400 and each page
 * costs a handful of D1 queries, so five pages counts 2,000 people well inside
 * the 1,000-query cap. Beyond that the preflight reports what it counted.
 */
const PREFLIGHT_PAGES = 5

/** Tags nothing resolves. Declared custom fields count as known. */
export function unknownMergeFields(text: string, keys: readonly string[]): string[] {
  const known = new Set([...BUILTIN_MERGE_FIELDS, ...keys])
  const found = new Set<string>()
  for (const m of text.matchAll(MERGE_TAG)) {
    const field = m[1]!
    if (!known.has(field)) found.add(field)
  }
  return [...found]
}

/** What a broadcast's preflight token is bound to. Any edit to these invalidates it. */
export async function broadcastDigest(b: {
  subject: string
  bodyMd: string
  bodyJson: unknown
  segment: unknown
}): Promise<string> {
  return await digestOf([b.subject, b.bodyMd, b.bodyJson, b.segment])
}

/** Activation is bound to the trigger and the whole step list, so any step edit invalidates it. */
export async function sequenceDigest(db: Db, id: number): Promise<string> {
  const seq = await getSequence(db, id)
  const steps = await stepsFor(db, id)
  return await digestOf([
    seq?.trigger,
    seq?.triggerTagId,
    steps.map((s) => [s.id, s.position, s.delayDays, s.subject, s.bodyMd, s.bodyJson]),
  ])
}

export type Refusal = { ok: false; reason: string; code: 'not_found' | 'conflict' | 'preflight' | 'dev_links' }

export interface BroadcastPreflight {
  broadcast: { id: number; subject: string; status: string; campaignId: number | null }
  audience: string
  candidates: number
  examined: number
  willReceive: number
  countsAreComplete: boolean
  filteredOut: Record<string, number>
  warnings: string[]
  /** Links a reader could not open (SPEC 3.15). The send is refused while any remain, unless overridden. */
  devLinks: DevLink[]
  sampleRenderedFor: string
  sampleText: string
  preflight_token: string
  expiresAt: Date
}

/**
 * Who a draft would reach, who is filtered out and why, unresolved merge tags,
 * a rendered sample — and a single-use token for `sendBroadcastWithToken`.
 * Writes nothing but the token row.
 */
export async function preflightBroadcast(
  env: Env,
  db: Db,
  id: number,
): Promise<{ ok: true; report: BroadcastPreflight } | Refusal> {
  const b = await getBroadcast(db, id)
  if (!b) return { ok: false, reason: 'No such broadcast.', code: 'not_found' }
  if (b.status !== 'draft') {
    return {
      ok: false,
      reason: `Broadcast #${id} is ${b.status}, not a draft — there is nothing to preflight.`,
      code: 'conflict',
    }
  }

  const totalCandidates = await countSegment(db, b.segment ?? {})

  // Walk the same pages the real send walks, so the numbers here are the
  // numbers that will happen. Capped: past the cap the counts become an
  // extrapolation and the response says so rather than quietly rounding.
  const blockedBy = new Map<string, number>()
  let examined = 0
  let willReceive = 0
  let first: { id: number; email: string; status: string } | undefined
  let cursor = 0

  for (let page = 0; page < PREFLIGHT_PAGES; page++) {
    const candidates = await resolveSegment(db, b.segment ?? {}, cursor)
    if (!candidates.length) break

    const snapshot = await loadConsentSnapshot(
      db,
      candidates.map((c) => c.email),
    )
    for (const c of candidates) {
      const block = canReceiveBroadcastIn(snapshot, c)
      if (block.blocked) blockedBy.set(block.reason, (blockedBy.get(block.reason) ?? 0) + 1)
      else {
        willReceive++
        first ??= c
      }
    }

    examined += candidates.length
    cursor = candidates[candidates.length - 1]!.id
  }

  const partial = examined < totalCandidates
  const sampleRow = first
    ? await db
        .select({ name: subscribers.name, attributes: subscribers.attributes })
        .from(subscribers)
        .where(eq(subscribers.id, first.id))
        .get()
    : undefined
  const declared = await fieldKeys(db)

  // Rendered against a real recipient where one exists, so the sample is the
  // mail that will actually land rather than an idealized version of it.
  const sample = renderEmail(
    { json: b.bodyJson, md: b.bodyMd },
    {
      publicUrl: env.PUBLIC_URL,
      trackingUrl: trackingBaseUrl(env),
      messageId: 0,
      unsubToken: 'sample-token',
      scope: { kind: 'broadcast' },
      scopeLabel: env.FROM_NAME,
      accountName: env.SITE_TITLE ?? null,
      postalAddress: env.POSTAL_ADDRESS ?? null,
      subscriber: first
        ? {
            email: first.email,
            name: sampleRow?.name ?? null,
            attributes: sampleRow?.attributes,
            fieldKeys: declared,
          }
        : { email: 'ada@example.com', name: 'Ada Lovelace', fieldKeys: declared },
      subject: b.subject,
      title: b.subject,
      lead: authoredLead(b.excerpt, { json: b.bodyJson, md: b.bodyMd }),
      postUrl: b.publishedAt ? postUrl(env.SITE_URL, b.slug) : null,
      trackOpens: true,
      trackClicks: true,
      showFooter: true,
    },
  )

  // The document too: a literal `{{plan}}` typed into the editor survives as
  // text, and only declared fields are resolved from it.
  const unresolved = unknownMergeFields(
    `${b.subject} ${b.bodyMd} ${b.bodyJson ? JSON.stringify(b.bodyJson) : ''}`,
    declared,
  )
  const allTags = await db.select().from(tags).orderBy(asc(tags.name)).all()
  const { token, expiresAt } = await mintPreflight(
    db,
    'broadcast_send',
    b.id,
    await broadcastDigest(b),
    willReceive,
  )

  const warnings: string[] = []
  if (!willReceive) warnings.push('Nobody would receive this — the audience resolves to zero.')
  if (unresolved.length) {
    warnings.push(
      `Unknown merge tags — these reach the reader literally, braces and all: ${unresolved
        .map((f) => `{{${f}}}`)
        .join(', ')}`,
    )
  }
  const local = devLinks({ json: b.bodyJson, md: b.bodyMd })
  if (local.length) warnings.push(devLinkRefusal(local, 'allow_dev_links').replace(/^Not sent: /, 'Will be refused: '))
  if (!b.campaignId) warnings.push('No campaign — clicks will not be attributed to anything.')
  if (partial) {
    warnings.push(
      `Audience is larger than the preflight walks: counted the first ${examined} of ${totalCandidates}. The rest are filtered by the same rules at send time.`,
    )
  }

  return {
    ok: true,
    report: {
      broadcast: { id: b.id, subject: b.subject, status: b.status, campaignId: b.campaignId },
      audience: describeRule(b.segment ?? {}, allTags),
      candidates: totalCandidates,
      examined,
      willReceive,
      countsAreComplete: !partial,
      filteredOut: Object.fromEntries(blockedBy),
      warnings,
      devLinks: local,
      sampleRenderedFor: first?.email ?? '(no real recipient — sample values used)',
      sampleText: sample.text.slice(0, 2000),
      preflight_token: token,
      expiresAt,
    },
  }
}

/**
 * ⭐ Send a draft for real, spending the token its preflight minted. Refused
 * unless the token is for this broadcast, unused, unexpired, and minted after
 * the last edit. Single-use is stamped before anything is sent.
 *
 * Refused too while the body links somewhere readers can't open (SPEC 3.15),
 * unless the caller says the links are intended. That check runs before the
 * token is spent, so fixing the links and calling again needs no new preflight
 * unless the fix was an edit (which it is, so it does).
 */
export async function sendBroadcastWithToken(
  env: Env,
  db: Db,
  id: number,
  token: string,
  opts: { allowDevLinks?: boolean; flag?: string } = {},
): Promise<
  { ok: true; expectedRecipients: number; materialized: number; interrupted: string | null } | Refusal
> {
  const b = await getBroadcast(db, id)
  if (!b) return { ok: false, reason: 'No such broadcast.', code: 'not_found' }
  if (b.status !== 'draft') {
    return { ok: false, reason: `Broadcast #${id} is already ${b.status}.`, code: 'conflict' }
  }

  const local = devLinks({ json: b.bodyJson, md: b.bodyMd })
  if (local.length && !opts.allowDevLinks) {
    return { ok: false, reason: devLinkRefusal(local, opts.flag ?? 'allow_dev_links'), code: 'dev_links' }
  }

  const check = await consumePreflight(db, 'broadcast_send', id, await broadcastDigest(b), token)
  if (!check.ok) return { ok: false, reason: `Refusing to send: ${check.reason}.`, code: 'preflight' }

  // A page the database refused part-way is reported, not thrown: the send is
  // under way and the cron finishes it, and the token is already spent, so an
  // error here would only invite an agent to try a send that cannot be retried.
  const launched = await launchBroadcast(env, db, id)
  if (!launched.ok) throw new Error(`could not confirm the send started: ${launched.reason}`)
  return {
    ok: true,
    expectedRecipients: check.recipientCount,
    materialized: launched.materialized,
    interrupted: launched.interrupted,
  }
}

export interface SequencePreflight {
  sequence: { id: number; name: string; trigger: string; isActive: boolean }
  totalDurationDays: number
  schedule: { position: number; subject: string; delayDays: number; arrivesOnDay: number; preview: string }[]
  alreadyEnrolled: Awaited<ReturnType<typeof sequenceStats>>
  warnings: string[]
  preflight_token: string
  expiresAt: Date
}

/** Every step in order with its delay and a sample, and a token for `activateSequenceWithToken`. */
export async function preflightSequence(
  db: Db,
  id: number,
): Promise<{ ok: true; report: SequencePreflight } | Refusal> {
  const seq = await getSequence(db, id)
  if (!seq) return { ok: false, reason: 'No such sequence.', code: 'not_found' }
  if (seq.isActive) return { ok: false, reason: `Sequence #${id} is already live.`, code: 'conflict' }

  const steps = await stepsFor(db, id)
  const warnings: string[] = []
  if (!steps.length) warnings.push('No steps — activation will be refused.')
  if (seq.trigger === 'tag_added' && !seq.triggerTagId) {
    warnings.push('tag_added sequence with no trigger tag — activation will be refused.')
  }
  if (seq.trigger === 'subscribe') {
    warnings.push('Every new subscriber will be enrolled from the moment this goes live.')
  }

  let elapsed = 0
  const schedule = steps.map((s) => {
    elapsed += s.delayDays
    return {
      position: s.position,
      subject: s.subject,
      delayDays: s.delayDays,
      arrivesOnDay: elapsed,
      preview: previewHtml(s.bodyJson, s.bodyMd).slice(0, 600),
    }
  })

  const stats = await sequenceStats(db, id)
  const { token, expiresAt } = await mintPreflight(
    db,
    'sequence_activate',
    id,
    await sequenceDigest(db, id),
    stats.active,
  )

  return {
    ok: true,
    report: {
      sequence: { id: seq.id, name: seq.name, trigger: seq.trigger, isActive: seq.isActive },
      totalDurationDays: elapsed,
      schedule,
      alreadyEnrolled: stats,
      warnings,
      preflight_token: token,
      expiresAt,
    },
  }
}

/** ⭐ Take a sequence live, spending the token its preflight minted. */
export async function activateSequenceWithToken(
  db: Db,
  id: number,
  token: string,
): Promise<{ ok: true } | Refusal> {
  if (!(await getSequence(db, id))) return { ok: false, reason: 'No such sequence.', code: 'not_found' }
  const check = await consumePreflight(db, 'sequence_activate', id, await sequenceDigest(db, id), token)
  if (!check.ok) return { ok: false, reason: `Refusing to activate: ${check.reason}.`, code: 'preflight' }
  const result = await setSequenceActive(db, id, true)
  return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? 'refused', code: 'conflict' }
}
