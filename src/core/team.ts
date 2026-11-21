import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { type TeamMember, teamMembers } from '../db/schema.ts'
import { isValidEmail, normalizeEmail } from './ids.ts'

/**
 * ⭐ The team: several people on one install, each in a role. One install is
 * one team.
 *
 * Identity belongs to Cloudflare Access. By the time anything here runs, the
 * address has been verified by `web/auth.ts`; this module only answers "is
 * that address on the team, and as what". Every role rule lives here once:
 *
 *   owner  — everything, including managing other owners
 *   admin  — everything but managing owners: domains, keys, members,
 *            integrations and settings included
 *   writer — writes and edits drafts, posts and sequences, and reads the rest
 *            of what writing needs. Never sends, schedules, activates, imports,
 *            deletes people, or touches settings, keys, agents, webhooks,
 *            domains or the team. A writer cannot put mail in an inbox.
 *
 * Which ROUTES need which role is the table in `web/roles.ts`; it reads
 * `atLeast` from here and nothing else.
 */

export const ROLES = ['owner', 'admin', 'writer'] as const
export type Role = (typeof ROLES)[number]

const RANK: Record<Role, number> = { owner: 3, admin: 2, writer: 1 }

/** How long an invitation lasts. */
export const INVITE_DAYS = 7
const INVITE_MS = INVITE_DAYS * 24 * 60 * 60 * 1000

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/** Whether `role` meets the `min` a route asks for. No role meets anything. */
export function atLeast(role: Role | null | undefined, min: Role): boolean {
  return !!role && RANK[role] >= RANK[min]
}

/** The roles `actor` may hand out, by invitation or role change. */
export function grantableRoles(actor: Role | null | undefined): Role[] {
  if (actor === 'owner') return [...ROLES]
  if (actor === 'admin') return ['admin', 'writer']
  return []
}

/** Owners manage anyone; admins manage admins and writers, never an owner; writers manage nobody. */
export function manages(actor: Role | null | undefined, target: Role): boolean {
  if (actor === 'owner') return true
  if (actor === 'admin') return target !== 'owner'
  return false
}

export type MemberState = 'member' | 'invited' | 'expired' | 'removed'

export function stateOf(m: Pick<TeamMember, 'joinedAt' | 'removedAt' | 'invitedAt'>, now = new Date()): MemberState {
  if (m.removedAt) return 'removed'
  if (m.joinedAt) return 'member'
  return m.invitedAt.getTime() + INVITE_MS < now.getTime() ? 'expired' : 'invited'
}

/** Who is acting on the team screen. `email` is null only under DEV_AUTH_BYPASS. */
export interface Actor {
  email: string | null
  role: Role
}

// ───────────────────────────────────────────────── signing in

export type Resolution =
  | { ok: true; member: TeamMember; event: 'none' | 'joined' | 'first-owner' }
  | { ok: false; reason: 'not-member' | 'removed' | 'expired' }

/**
 * The team row for a verified Access address, read fresh on every request so a
 * removal or demotion takes effect on the person's very next click.
 *
 * - a member is returned as they are;
 * - a live invitation is accepted (`joined_at` stamped) on first arrival;
 * - on an install whose table is empty, the arrival becomes the owner — one
 *   conditional INSERT, so two people arriving at once cannot both win;
 * - anyone else is refused, with the reason the 403 page explains.
 */
export async function resolveMember(db: Db, rawEmail: string, now = new Date()): Promise<Resolution> {
  const email = normalizeEmail(rawEmail)
  const row = await db.select().from(teamMembers).where(eq(teamMembers.email, email)).get()

  if (row) {
    const state = stateOf(row, now)
    if (state === 'member') return { ok: true, member: row, event: 'none' }
    if (state === 'removed') return { ok: false, reason: 'removed' }
    if (state === 'expired') return { ok: false, reason: 'expired' }
    // Conditional on still being a live invitation, so a removal that lands
    // between the read and this write is not undone by it.
    const [joined] = await db
      .update(teamMembers)
      .set({ joinedAt: now })
      .where(and(eq(teamMembers.id, row.id), isNull(teamMembers.joinedAt), isNull(teamMembers.removedAt)))
      .returning()
    return joined ? { ok: true, member: joined, event: 'joined' } : { ok: false, reason: 'removed' }
  }

  // The bootstrap. Only ever on a table with no rows at all: once the first
  // owner exists the last-owner rule keeps one forever, and a removed member
  // must never be able to re-open this door.
  const at = now.getTime()
  await db.run(sql`
    INSERT INTO team_members (email, role, invited_at, joined_at)
    SELECT ${email}, 'owner', ${at}, ${at}
    WHERE NOT EXISTS (SELECT 1 FROM team_members)
  `)
  const seeded = await db.select().from(teamMembers).where(eq(teamMembers.email, email)).get()
  if (seeded && seeded.role === 'owner' && stateOf(seeded, now) === 'member') {
    return { ok: true, member: seeded, event: 'first-owner' }
  }
  return { ok: false, reason: 'not-member' }
}

// ───────────────────────────────────────────────── the team screen

export async function listTeam(db: Db): Promise<TeamMember[]> {
  const rows = await db
    .select()
    .from(teamMembers)
    .where(isNull(teamMembers.removedAt))
    .orderBy(asc(teamMembers.invitedAt), asc(teamMembers.id))
    .all()
  return rows.sort((a, b) => RANK[b.role] - RANK[a.role])
}

export type TeamResult = { ok: true; member: TeamMember } | { ok: false; reason: string }

/**
 * Invite an address in a role, or refresh a pending/expired invitation, or
 * bring back somebody who was removed. The invitee still has to get past the
 * Access policy; nothing here can let them in on its own.
 */
export async function invite(db: Db, actor: Actor, rawEmail: string, role: Role, now = new Date()): Promise<TeamResult> {
  const email = normalizeEmail(rawEmail)
  if (!isValidEmail(email)) return { ok: false, reason: 'that is not an email address' }
  if (!grantableRoles(actor.role).includes(role)) {
    return { ok: false, reason: `a ${actor.role} cannot make someone ${anOrA(role)} ${role}` }
  }

  const existing = await db.select().from(teamMembers).where(eq(teamMembers.email, email)).get()
  if (existing && stateOf(existing, now) === 'member') {
    return { ok: false, reason: `${email} is already on the team` }
  }
  if (existing && !existing.removedAt && !manages(actor.role, existing.role)) {
    return { ok: false, reason: `only an owner can change an owner's invitation` }
  }

  const values = { role, invitedAt: now, joinedAt: null, removedAt: null, invitedBy: actor.email }
  const [member] = existing
    ? await db.update(teamMembers).set(values).where(eq(teamMembers.id, existing.id)).returning()
    : await db.insert(teamMembers).values({ email, ...values }).returning()
  return { ok: true, member: member! }
}

/** Live owners: joined, not removed. A pending owner invitation keeps nobody in. */
const liveOwnerCount = sql`(SELECT count(*) FROM team_members WHERE role = 'owner' AND removed_at IS NULL AND joined_at IS NOT NULL)`

export async function changeRole(db: Db, actor: Actor, id: number, role: Role): Promise<TeamResult> {
  const target = await db.select().from(teamMembers).where(eq(teamMembers.id, id)).get()
  if (!target || target.removedAt) return { ok: false, reason: 'no such teammate' }
  if (!manages(actor.role, target.role)) return { ok: false, reason: `only an owner can change an owner` }
  if (!grantableRoles(actor.role).includes(role)) {
    return { ok: false, reason: `a ${actor.role} cannot make someone ${anOrA(role)} ${role}` }
  }
  if (target.role === role) return { ok: true, member: target }

  // One statement, so two owners demoting each other at once cannot leave the
  // install with none: the second sees a count of one and changes nothing.
  const [updated] = await db
    .update(teamMembers)
    .set({ role })
    .where(
      and(
        eq(teamMembers.id, id),
        isNull(teamMembers.removedAt),
        or(ne(teamMembers.role, 'owner'), isNull(teamMembers.joinedAt), sql`${liveOwnerCount} > 1`),
      ),
    )
    .returning()
  return updated ? { ok: true, member: updated } : { ok: false, reason: 'the last owner cannot be demoted' }
}

export async function removeMember(db: Db, actor: Actor, id: number, now = new Date()): Promise<TeamResult> {
  const target = await db.select().from(teamMembers).where(eq(teamMembers.id, id)).get()
  if (!target || target.removedAt) return { ok: false, reason: 'no such teammate' }
  if (!manages(actor.role, target.role)) return { ok: false, reason: `only an owner can remove an owner` }

  const [removed] = await db
    .update(teamMembers)
    .set({ removedAt: now })
    .where(
      and(
        eq(teamMembers.id, id),
        isNull(teamMembers.removedAt),
        or(ne(teamMembers.role, 'owner'), isNull(teamMembers.joinedAt), sql`${liveOwnerCount} > 1`),
      ),
    )
    .returning()
  return removed ? { ok: true, member: removed } : { ok: false, reason: 'the last owner cannot be removed' }
}

function anOrA(role: Role): string {
  return role === 'owner' || role === 'admin' ? 'an' : 'a'
}
