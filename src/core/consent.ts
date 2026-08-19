import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  sequenceEnrollments,
  sequenceOptouts,
  sequences,
  subscribers,
  suppressions,
} from '../db/schema.ts'
// `sequences` is used for existence checks as well as the preference listing.
import { normalizeEmail } from './ids.ts'

/**
 * ⭐ Scoped consent.
 *
 * The reason big-mailer exists. On Kit, leaving one sequence removes you from
 * everything, forever. Here there are three independent scopes and a narrow
 * action never escalates to a wider one:
 *
 *   sequence  → `sequence_optouts`            off ONE sequence
 *   broadcast → `subscribers.status`          off the newsletter
 *   global    → `suppressions`                off everything
 *
 * Only `unsubscribeAll`, a hard bounce, or a complaint may write a suppression.
 * Every other path in this codebase must go through the functions below rather
 * than writing those tables directly.
 */

export type Scope = { kind: 'broadcast' } | { kind: 'sequence'; sequenceId: number }

export function parseScope(raw: string | undefined | null): Scope | null {
  if (!raw) return null
  if (raw === 'broadcast') return { kind: 'broadcast' }
  const m = /^sequence:(\d+)$/.exec(raw)
  return m ? { kind: 'sequence', sequenceId: Number(m[1]) } : null
}

export function formatScope(scope: Scope): string {
  return scope.kind === 'broadcast' ? 'broadcast' : `sequence:${scope.sequenceId}`
}

// ───────────────────────────────────────────────── eligibility

export type Block = { blocked: true; reason: string } | { blocked: false }

const OK: Block = { blocked: false }

/** D1 caps bound parameters at 100 per query. */
const PARAM_CHUNK = 100

/**
 * ⭐ The consent facts for a whole batch of people, in a handful of queries.
 *
 * Eligibility gets asked once per recipient, so asking the database each time is
 * what made a 400-person broadcast page cost 400 queries — half of D1's
 * per-invocation budget spent on one question. The rules below read from this
 * snapshot instead. The single-subscriber helpers build a one-row snapshot and
 * delegate to the same functions, so there is exactly one copy of the rules.
 */
export interface ConsentSnapshot {
  /** normalized email → suppression reason */
  suppressions: Map<string, string>
  /** `${subscriberId}:${sequenceId}` for every recorded opt-out */
  sequenceOptouts: Set<string>
}

export async function loadConsentSnapshot(
  db: Db,
  emails: string[],
  subscriberIds: number[] = [],
  sequenceIds: number[] = [],
): Promise<ConsentSnapshot> {
  const suppressed = new Map<string, string>()
  const wanted = [...new Set(emails.map(normalizeEmail))]
  for (let i = 0; i < wanted.length; i += PARAM_CHUNK) {
    const rows = await db
      .select({ email: suppressions.email, reason: suppressions.reason })
      .from(suppressions)
      .where(inArray(suppressions.email, wanted.slice(i, i + PARAM_CHUNK)))
      .all()
    for (const r of rows) suppressed.set(r.email, r.reason)
  }

  const optouts = new Set<string>()
  const subs = [...new Set(subscriberIds)]
  const seqs = [...new Set(sequenceIds)]
  if (subs.length > 0 && seqs.length > 0) {
    // The sequence ids ride along in every chunk, so they come out of the same
    // 100-parameter budget as the subscriber ids.
    const perChunk = Math.max(1, PARAM_CHUNK - seqs.length)
    for (let i = 0; i < subs.length; i += perChunk) {
      const rows = await db
        .select({
          subscriberId: sequenceOptouts.subscriberId,
          sequenceId: sequenceOptouts.sequenceId,
        })
        .from(sequenceOptouts)
        .where(
          and(
            inArray(sequenceOptouts.subscriberId, subs.slice(i, i + perChunk)),
            inArray(sequenceOptouts.sequenceId, seqs),
          ),
        )
        .all()
      for (const r of rows) optouts.add(`${r.subscriberId}:${r.sequenceId}`)
    }
  }

  return { suppressions: suppressed, sequenceOptouts: optouts }
}

export function isSuppressedIn(snap: ConsentSnapshot, email: string): boolean {
  return snap.suppressions.has(normalizeEmail(email))
}

/**
 * Can we send this broadcast to this subscriber?
 * Global suppression, then broadcast-scoped consent.
 */
export function canReceiveBroadcastIn(
  snap: ConsentSnapshot,
  sub: { id: number; email: string; status: string },
): Block {
  if (isSuppressedIn(snap, sub.email)) return { blocked: true, reason: 'suppressed' }
  if (sub.status !== 'active') return { blocked: true, reason: `status:${sub.status}` }
  return OK
}

/**
 * Can we send this sequence step to this subscriber?
 *
 * Deliberately does NOT consult `status === 'unsubscribed'` — that flag is
 * broadcast-scoped. Someone who left the newsletter still gets the onboarding
 * sequence they explicitly signed up for. That asymmetry is the product.
 */
export function canReceiveSequenceIn(
  snap: ConsentSnapshot,
  sub: { id: number; email: string; status: string },
  sequenceId: number,
): Block {
  if (isSuppressedIn(snap, sub.email)) return { blocked: true, reason: 'suppressed' }
  if (sub.status === 'bounced' || sub.status === 'complained') {
    return { blocked: true, reason: `status:${sub.status}` }
  }
  if (snap.sequenceOptouts.has(`${sub.id}:${sequenceId}`)) {
    return { blocked: true, reason: 'sequence_optout' }
  }
  return OK
}

/**
 * Can we send this transactional message?
 *
 * Receipts and password resets are not marketing: an unsubscribe or a global
 * opt-out must not stop someone getting the download they paid for. Only a dead
 * address (hard bounce) or a spam complaint blocks a transactional send.
 */
export function canReceiveTransactionalIn(snap: ConsentSnapshot, email: string): Block {
  const reason = snap.suppressions.get(normalizeEmail(email))
  if (reason === 'hard_bounce' || reason === 'complaint') return { blocked: true, reason }
  return OK
}

// Single-subscriber forms. One row's worth of snapshot, same rules.

export async function isSuppressed(db: Db, email: string): Promise<boolean> {
  return isSuppressedIn(await loadConsentSnapshot(db, [email]), email)
}

export async function canReceiveBroadcast(
  db: Db,
  sub: { id: number; email: string; status: string },
): Promise<Block> {
  return canReceiveBroadcastIn(await loadConsentSnapshot(db, [sub.email]), sub)
}

export async function canReceiveSequence(
  db: Db,
  sub: { id: number; email: string; status: string },
  sequenceId: number,
): Promise<Block> {
  const snap = await loadConsentSnapshot(db, [sub.email], [sub.id], [sequenceId])
  return canReceiveSequenceIn(snap, sub, sequenceId)
}

export async function canReceiveTransactional(db: Db, email: string): Promise<Block> {
  return canReceiveTransactionalIn(await loadConsentSnapshot(db, [email]), email)
}

// ───────────────────────────────────────────────── consent changes

/**
 * Leave ONE sequence. Writes an opt-out row and cancels that enrollment.
 * Touches nothing else: no suppression, no status change, no other sequence.
 *
 * Returns false for an unknown sequence. The preference center is public and
 * takes this id from a form, so a stale or hand-edited value must be a no-op,
 * not a 500 — D1 enforces the foreign key and would otherwise throw.
 */
export async function leaveSequence(
  db: Db,
  subscriberId: number,
  sequenceId: number,
): Promise<boolean> {
  const exists = await db
    .select({ id: sequences.id })
    .from(sequences)
    .where(eq(sequences.id, sequenceId))
    .get()
  if (!exists) return false

  const now = new Date()
  await db
    .insert(sequenceOptouts)
    .values({ subscriberId, sequenceId, optedOutAt: now })
    .onConflictDoNothing()
  await db
    .update(sequenceEnrollments)
    .set({ status: 'cancelled', nextRunAt: null })
    .where(
      and(
        eq(sequenceEnrollments.subscriberId, subscriberId),
        eq(sequenceEnrollments.sequenceId, sequenceId),
        eq(sequenceEnrollments.status, 'active'),
      ),
    )
  return true
}

/** Rejoin a sequence. Leaving is reversible by the subscriber (SPEC 2.9). */
export async function rejoinSequence(db: Db, subscriberId: number, sequenceId: number) {
  await db
    .delete(sequenceOptouts)
    .where(
      and(
        eq(sequenceOptouts.subscriberId, subscriberId),
        eq(sequenceOptouts.sequenceId, sequenceId),
      ),
    )
}

/** Off the newsletter. Sequence enrollments keep running. */
export async function unsubscribeBroadcasts(db: Db, subscriberId: number) {
  await db
    .update(subscribers)
    .set({ status: 'unsubscribed', unsubscribedAt: new Date() })
    .where(eq(subscribers.id, subscriberId))
}

export async function resubscribeBroadcasts(db: Db, subscriberId: number) {
  await db
    .update(subscribers)
    .set({ status: 'active', unsubscribedAt: null })
    .where(eq(subscribers.id, subscriberId))
}

/**
 * The legal escape hatch: off everything. The only subscriber-initiated path
 * that may write a suppression — and it must be an explicit, separate choice
 * in the UI, never the default action (SPEC 2a.3).
 */
export async function unsubscribeAll(db: Db, subscriberId: number, email: string) {
  const now = new Date()
  await db
    .insert(suppressions)
    .values({ email: normalizeEmail(email), reason: 'unsubscribed_all', createdAt: now })
    .onConflictDoNothing()
  await db
    .update(subscribers)
    .set({ status: 'unsubscribed', unsubscribedAt: now })
    .where(eq(subscribers.id, subscriberId))
  await db
    .update(sequenceEnrollments)
    .set({ status: 'cancelled', nextRunAt: null })
    .where(
      and(
        eq(sequenceEnrollments.subscriberId, subscriberId),
        eq(sequenceEnrollments.status, 'active'),
      ),
    )
}

export async function suppressAddress(
  db: Db,
  email: string,
  reason: 'hard_bounce' | 'complaint' | 'manual',
) {
  await db
    .insert(suppressions)
    .values({ email: normalizeEmail(email), reason, createdAt: new Date() })
    .onConflictDoNothing()
}

export async function unsuppressAddress(db: Db, email: string) {
  await db.delete(suppressions).where(eq(suppressions.email, normalizeEmail(email)))
}

// ───────────────────────────────────────────────── preference center data

export interface PreferenceRow {
  sequenceId: number
  name: string
  description: string | null
  enrolled: boolean
  optedOut: boolean
}

/**
 * Everything the preference center needs: every active sequence the subscriber
 * has any relationship with, plus whether they've opted out of each.
 */
export async function preferencesFor(db: Db, subscriberId: number): Promise<PreferenceRow[]> {
  const enrollments = await db
    .select({ sequenceId: sequenceEnrollments.sequenceId, status: sequenceEnrollments.status })
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.subscriberId, subscriberId))
    .all()

  const optouts = await db
    .select({ sequenceId: sequenceOptouts.sequenceId })
    .from(sequenceOptouts)
    .where(eq(sequenceOptouts.subscriberId, subscriberId))
    .all()

  const ids = [...new Set([...enrollments.map((e) => e.sequenceId), ...optouts.map((o) => o.sequenceId)])]
  if (ids.length === 0) return []

  const seqs = await db.select().from(sequences).where(inArray(sequences.id, ids)).all()
  const optedOutIds = new Set(optouts.map((o) => o.sequenceId))
  const activeIds = new Set(
    enrollments.filter((e) => e.status === 'active').map((e) => e.sequenceId),
  )

  return seqs.map((s) => ({
    sequenceId: s.id,
    name: s.name,
    description: s.description,
    enrolled: activeIds.has(s.id),
    optedOut: optedOutIds.has(s.id),
  }))
}
