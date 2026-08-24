import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { campaigns, conversionKinds, conversions, goals } from '../db/schema.ts'

/**
 * ⭐ Goals — a target, over a named period.
 *
 * A conversion is an *event* ("Rob Smith bought The Pivot on Tuesday"). A goal is
 * a *target* ("30 cohort signups in Q2"). Keeping them apart is the whole point:
 * the event log is the truth, and a goal is one lens onto it.
 *
 * ## Periods are named, never arbitrary
 *
 * June 2026. Q2 2026. 2026. Not "3 May to 19 July" — a goal that spans an
 * arbitrary range cannot be held against the one before it, and comparing this
 * quarter to last is most of what a goal is for. So the period is stored as
 * (type, year, index) and the dates are *derived* here, which means the same
 * label always resolves to exactly the same window.
 *
 * ## Goals overlap on purpose
 *
 * A quarterly goal and a campaign goal both count the same conversion. They are
 * lenses, not buckets — a sale is not "spent" by being counted once. Totals
 * across goals therefore do not sum to anything, and the UI must not imply they
 * do.
 *
 * ## Refunds are not subtracted
 *
 * A sale is a sale (Rob's call). `conversions` carries no refund status at all;
 * the refund lives on `sales.status` for accounting. Progress here counts every
 * conversion in the window, full stop.
 */

/**
 * The month the fiscal year opens on, 1-indexed. January — Rob's "2026" means the
 * calendar year. Change this one number and every year-typed goal shifts with it;
 * nothing else in the file hardcodes a month.
 */
export const FISCAL_YEAR_START_MONTH = 1

export type PeriodType = 'month' | 'quarter' | 'year'

export interface Period {
  type: PeriodType
  year: number
  /** 1–12 for a month, 1–4 for a quarter, 0 for a year. */
  index: number
}

export interface Window {
  start: Date
  /** Exclusive — the first instant of the next period. */
  end: Date
  label: string
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * Turn a named period into the window it covers.
 *
 * Built with `Date.UTC` and month arithmetic rather than day counts, so leap
 * years and 31-day months take care of themselves — month 13 rolls to January of
 * the next year on its own.
 */
export function windowFor(period: Period): Window {
  const offset = FISCAL_YEAR_START_MONTH - 1

  if (period.type === 'year') {
    const start = Date.UTC(period.year, offset, 1)
    const end = Date.UTC(period.year + 1, offset, 1)
    // A fiscal year that does not open in January spans two calendar years, and
    // labelling it with one of them would be a lie half the time.
    const label = offset === 0 ? `${period.year}` : `FY ${period.year}–${period.year + 1}`
    return { start: new Date(start), end: new Date(end), label }
  }

  if (period.type === 'quarter') {
    const q = Math.min(4, Math.max(1, period.index))
    const start = Date.UTC(period.year, offset + (q - 1) * 3, 1)
    const end = Date.UTC(period.year, offset + q * 3, 1)
    return { start: new Date(start), end: new Date(end), label: `Q${q} ${period.year}` }
  }

  const m = Math.min(12, Math.max(1, period.index))
  const start = Date.UTC(period.year, offset + (m - 1), 1)
  const end = Date.UTC(period.year, offset + m, 1)
  // Read the real calendar month back off the date, so a shifted fiscal year
  // still names the month a human would name.
  const name = MONTHS[new Date(start).getUTCMonth()]
  return { start: new Date(start), end: new Date(end), label: `${name} ${period.year}` }
}

/** The period containing `now` — the sensible default when creating a goal. */
export function currentPeriod(type: PeriodType, now = new Date()): Period {
  const offset = FISCAL_YEAR_START_MONTH - 1
  // Shift into fiscal space, so December of a July-start fiscal year lands in the
  // year that opened in July rather than the calendar one.
  const shifted = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1))
  const year = shifted.getUTCFullYear()
  const monthIndex = shifted.getUTCMonth() // 0-based, within the fiscal year

  if (type === 'year') return { type, year, index: 0 }
  if (type === 'quarter') return { type, year, index: Math.floor(monthIndex / 3) + 1 }
  return { type, year, index: monthIndex + 1 }
}

// ───────────────────────────────────────────────────── crud

export interface GoalInput {
  name: string
  kindId: number | null
  periodType: PeriodType
  periodYear: number
  periodIndex: number
  targetCount: number | null
  targetCents: number | null
  campaignId: number | null
}

export async function createGoal(db: Db, input: GoalInput): Promise<number | null> {
  if (!input.name.trim()) return null
  const inserted = await db
    .insert(goals)
    .values({ ...input, name: input.name.trim(), createdAt: new Date() })
    .returning({ id: goals.id })
  return inserted[0]?.id ?? null
}

export async function updateGoal(db: Db, id: number, patch: Partial<GoalInput>) {
  await db.update(goals).set(patch).where(eq(goals.id, id))
}

export async function deleteGoal(db: Db, id: number) {
  await db.delete(goals).where(eq(goals.id, id))
}

export async function getGoal(db: Db, id: number) {
  return await db.select().from(goals).where(eq(goals.id, id)).get()
}

// ───────────────────────────────────────────────────── progress

export interface GoalProgress {
  id: number
  name: string
  kindId: number | null
  kindSlug: string | null
  kindLabel: string
  period: Period
  window: Window
  campaignId: number | null
  campaignName: string | null
  targetCount: number | null
  targetCents: number | null
  /** What actually happened inside the window. */
  count: number
  cents: number
  /** 0–100+, over whichever target is set. Null when the goal has no target. */
  pctCount: number | null
  pctCents: number | null
  /** Where the period sits relative to now. */
  state: 'upcoming' | 'open' | 'closed'
  /** 0–1 through the window, for pace. Null unless open. */
  elapsed: number | null
}

function pct(actual: number, target: number | null): number | null {
  if (!target || target <= 0) return null
  return Math.round((actual / target) * 100)
}

/**
 * Score one goal against the conversion log.
 *
 * One query per goal. Goals are counted in single digits, and the alternative —
 * one grouped query covering every window at once — needs a join per period and
 * is markedly harder to read for no measurable gain.
 */
export async function goalProgress(
  db: Db,
  goal: typeof goals.$inferSelect,
  now = new Date(),
): Promise<GoalProgress> {
  const period: Period = {
    type: goal.periodType,
    year: goal.periodYear,
    index: goal.periodIndex,
  }
  const win = windowFor(period)

  const bounds = [
    gte(conversions.occurredAt, win.start),
    // `end` is exclusive: a sale at 00:00:00 on 1 July belongs to Q3, not Q2.
    sql`${conversions.occurredAt} < ${win.end.getTime()}`,
    ...(goal.kindId ? [eq(conversions.kindId, goal.kindId)] : []),
    ...(goal.campaignId ? [eq(conversions.campaignId, goal.campaignId)] : []),
  ]

  const row = await db
    .select({
      n: sql<number>`count(*)`,
      cents: sql<number>`coalesce(sum(${conversions.valueCents}), 0)`,
    })
    .from(conversions)
    .where(and(...bounds))
    .get()

  const kind = goal.kindId
    ? await db
        .select({ slug: conversionKinds.slug, label: conversionKinds.label })
        .from(conversionKinds)
        .where(eq(conversionKinds.id, goal.kindId))
        .get()
    : null

  const campaign = goal.campaignId
    ? await db
        .select({ name: campaigns.name })
        .from(campaigns)
        .where(eq(campaigns.id, goal.campaignId))
        .get()
    : null

  const t = now.getTime()
  const state = t < win.start.getTime() ? 'upcoming' : t >= win.end.getTime() ? 'closed' : 'open'
  const elapsed =
    state === 'open'
      ? (t - win.start.getTime()) / (win.end.getTime() - win.start.getTime())
      : null

  const count = row?.n ?? 0
  const cents = row?.cents ?? 0

  return {
    id: goal.id,
    name: goal.name,
    kindId: goal.kindId,
    kindSlug: kind?.slug ?? null,
    // A goal with no kind counts everything, and should say so rather than
    // render a blank where a category belongs.
    kindLabel: kind?.label ?? 'Any conversion',
    period,
    window: win,
    campaignId: goal.campaignId,
    campaignName: campaign?.name ?? null,
    targetCount: goal.targetCount,
    targetCents: goal.targetCents,
    count,
    cents,
    pctCount: pct(count, goal.targetCount),
    pctCents: pct(cents, goal.targetCents),
    state,
    elapsed,
  }
}

/** Every goal, newest period first, each scored. */
export async function listGoalProgress(db: Db, now = new Date()): Promise<GoalProgress[]> {
  const rows = await db
    .select()
    .from(goals)
    .orderBy(desc(goals.periodYear), desc(goals.periodIndex), asc(goals.id))
    .all()
  return await Promise.all(rows.map((g) => goalProgress(db, g, now)))
}

/**
 * The goals worth putting on the dashboard: the ones currently running.
 *
 * Falls back to the most recently closed ones so the card is never empty just
 * because a quarter rolled over and nothing has been set up for the new one.
 */
export async function activeGoals(db: Db, limit = 4, now = new Date()): Promise<GoalProgress[]> {
  const all = await listGoalProgress(db, now)
  const open = all.filter((g) => g.state === 'open')
  if (open.length) return open.slice(0, limit)
  return all.filter((g) => g.state === 'closed').slice(0, limit)
}

/** Kinds with a live count, for the goal editor's picker. */
export async function kindOptions(db: Db) {
  return await db
    .select({
      id: conversionKinds.id,
      slug: conversionKinds.slug,
      label: conversionKinds.label,
      isActive: conversionKinds.isActive,
    })
    .from(conversionKinds)
    .orderBy(asc(conversionKinds.priority), asc(conversionKinds.id))
    .all()
}

/** Years offered in the period picker: a little history, a little future. */
export function yearOptions(now = new Date()): number[] {
  const y = currentPeriod('year', now).year
  return [y - 2, y - 1, y, y + 1]
}

export const QUARTERS = [1, 2, 3, 4]
export const MONTH_OPTIONS = MONTHS.map((name, i) => ({ index: i + 1, name }))
