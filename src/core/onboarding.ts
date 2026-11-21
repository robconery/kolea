import { count, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  broadcasts,
  forms,
  importRuns,
  ONBOARDING_STEPS,
  onboarding,
  onboardingSteps,
  type OnboardingStepId,
  sendingDomains,
  sequences,
  siteSettings,
  subscribers,
} from '../db/schema.ts'
import type { Env } from '../types.ts'
import { createBroadcast } from './broadcasts.ts'
import { createSequenceFromTemplate, getTemplate, restoreStarterTemplates } from './sequence-templates/index.ts'

/**
 * First-run onboarding, as a checklist on the dashboard.
 *
 * Progress is derived from the real state wherever the state can say it: a
 * verified domain, a form or an import, a sequence that starts on subscribe, a
 * broadcast. `onboarding_steps` only holds what the state cannot: a "later" and
 * the site's explicit no. Facts win over decisions, so a domain added after the
 * step was skipped reads as waiting.
 *
 * ⭐ Onboarding never sends mail and never activates anything. The welcome
 * sequence it makes lands paused (`createSequenceFromTemplate` → `createSequence`),
 * and `setSequenceActive` refuses while a `[[ placeholder ]]` survives; the first
 * broadcast is a draft, sent later by the composer's own confirmation. Every
 * other step links to the screen that owns it rather than duplicating it.
 *
 * The From name and address stay environment variables (`FROM_NAME`,
 * `FROM_EMAIL`). This install has one sender, read by every send path, and an
 * override row would be a second source of truth for the header on every mail.
 * The step shows the values and says where to change them.
 */

export type StepState = 'done' | 'waiting' | 'skipped' | 'declined' | 'todo'
export type AudiencePath = 'form' | 'import'

export interface Facts {
  fromName: string
  fromEmail: string
  /** The best standing among the sending domains. */
  domain: 'none' | 'pending' | 'failed' | 'verified'
  siteFilled: boolean
  audience: AudiencePath | null
  welcome: boolean
  broadcast: boolean
}

export interface Step {
  id: OnboardingStepId
  state: StepState
  /** The path the audience step took, when it took one. */
  choice?: AudiencePath
}

export type Decisions = Partial<Record<OnboardingStepId, 'skipped' | 'declined'>>

/** Only the public site can be declined. */
export const DECLINABLE: readonly OnboardingStepId[] = ['site']

/**
 * Whether the From name and address are really set: both present, and not the
 * template's `{{FROM_EMAIL}}` or an `example.com` placeholder, which is what a
 * fresh `wrangler.jsonc` carries and no inbox will accept mail from.
 */
export function senderSet(name: string, email: string): boolean {
  const n = name.trim()
  const e = email.trim().toLowerCase()
  if (!n || !e || n.includes('{{') || e.includes('{{')) return false
  const domain = e.split('@')[1] ?? ''
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/(^|\.)example\.(com|org|net)$/.test(domain)
}

export const isStepId = (s: string): s is OnboardingStepId => (ONBOARDING_STEPS as readonly string[]).includes(s)

// ───────────────────────────────────────────────── the pure checklist

function stepFor(id: OnboardingStepId, f: Facts, decision: 'skipped' | 'declined' | undefined): Step {
  const undecided = (): Step => ({ id, state: decision === 'skipped' ? 'skipped' : 'todo' })
  switch (id) {
    case 'sender':
      return senderSet(f.fromName, f.fromEmail) ? { id, state: 'done' } : undecided()
    case 'domain':
      if (f.domain === 'verified') return { id, state: 'done' }
      if (f.domain === 'pending' || f.domain === 'failed') return { id, state: 'waiting' }
      return undecided()
    case 'site':
      if (f.siteFilled) return { id, state: 'done' }
      if (decision === 'declined') return { id, state: 'declined' }
      return undecided()
    case 'audience':
      return f.audience ? { id, state: 'done', choice: f.audience } : undecided()
    case 'welcome':
      return f.welcome ? { id, state: 'done' } : undecided()
    case 'broadcast':
      return f.broadcast ? { id, state: 'done' } : undecided()
  }
}

/** The steps, in order, with their states. Pure. */
export function checklist(facts: Facts, decisions: Decisions): Step[] {
  return ONBOARDING_STEPS.map((id) => stepFor(id, facts, decisions[id]))
}

/** Done, or out of the operator's hands (DNS propagating). */
export const isComplete = (s: Step) => s.state === 'done' || s.state === 'waiting'

/**
 * Whether the checklist has nothing left to ask: every step complete or
 * declined. A skipped step keeps it open: "later" is not "never".
 */
export const isFinished = (steps: Step[]) => steps.every((s) => isComplete(s) || s.state === 'declined')

/** Where to pick up: the first step neither complete nor declined. */
export function currentStep(steps: Step[]): OnboardingStepId | null {
  return steps.find((s) => s.state === 'todo')?.id ?? steps.find((s) => s.state === 'skipped')?.id ?? null
}

// ───────────────────────────────────────────────── reading the real state

export async function gatherFacts(env: Env, db: Db): Promise<Facts> {
  const [domains, site, formCount, runCount, subCount, welcome, anyBroadcast] = await Promise.all([
    db.select({ status: sendingDomains.status }).from(sendingDomains).all(),
    db.select().from(siteSettings).where(eq(siteSettings.id, 1)).get(),
    db.select({ n: count() }).from(forms).get(),
    db.select({ n: count() }).from(importRuns).where(inArray(importRuns.status, ['queued', 'running', 'completed'])).get(),
    db.select({ n: count() }).from(subscribers).get(),
    db.select({ id: sequences.id }).from(sequences).where(eq(sequences.trigger, 'subscribe')).limit(1).get(),
    db.select({ id: broadcasts.id }).from(broadcasts).limit(1).get(),
  ])

  const statuses = new Set(domains.map((d) => d.status))
  const domain = statuses.has('verified')
    ? 'verified'
    : statuses.has('pending')
      ? 'pending'
      : statuses.has('failed')
        ? 'failed'
        : 'none'

  // A form is the way people will keep arriving, so it names the path ahead of
  // an import. A CSV import leaves no run row, only people, so having anyone on
  // the list counts as an import.
  const audience: AudiencePath | null =
    (formCount?.n ?? 0) > 0 ? 'form' : (runCount?.n ?? 0) > 0 || (subCount?.n ?? 0) > 0 ? 'import' : null

  return {
    fromName: env.FROM_NAME ?? '',
    fromEmail: env.FROM_EMAIL ?? '',
    domain,
    siteFilled: Boolean(site?.title?.trim() || site?.shortBio?.trim()),
    audience,
    welcome: Boolean(welcome),
    broadcast: Boolean(anyBroadcast),
  }
}

async function decisions(db: Db): Promise<Decisions> {
  const rows = await db.select().from(onboardingSteps).all()
  return Object.fromEntries(rows.map((r) => [r.step, r.outcome]))
}

export interface Progress {
  steps: Step[]
  current: OnboardingStepId | null
  finished: boolean
  dismissed: boolean
  facts: Facts
}

export async function onboardingProgress(env: Env, db: Db): Promise<Progress> {
  const [facts, decided, row] = await Promise.all([
    gatherFacts(env, db),
    decisions(db),
    db.select().from(onboarding).where(eq(onboarding.id, 1)).get(),
  ])
  const steps = checklist(facts, decided)
  return { steps, current: currentStep(steps), finished: isFinished(steps), dismissed: Boolean(row?.dismissedAt), facts }
}

/** The dashboard offers the checklist until every step is settled or it is dismissed. */
export const offerChecklist = (p: Progress) => !p.finished && !p.dismissed

// ───────────────────────────────────────────────── decisions

export type Outcome = { ok: true } | { ok: false; reason: string }

/** "Later": the checklist keeps offering the step. */
export async function skipStep(db: Db, step: string): Promise<Outcome> {
  if (!isStepId(step)) return { ok: false, reason: 'no such step' }
  return await decide(db, step, 'skipped')
}

/** The explicit no. Only the public site can be declined. */
export async function declineStep(db: Db, step: string): Promise<Outcome> {
  if (!isStepId(step)) return { ok: false, reason: 'no such step' }
  if (!DECLINABLE.includes(step)) return { ok: false, reason: 'only the public site can be declined' }
  return await decide(db, step, 'declined')
}

/** Takes back a skip or a decline: the step is to-do again. */
export async function undoStep(db: Db, step: string): Promise<Outcome> {
  if (!isStepId(step)) return { ok: false, reason: 'no such step' }
  await db.delete(onboardingSteps).where(eq(onboardingSteps.step, step))
  return { ok: true }
}

async function decide(db: Db, step: OnboardingStepId, outcome: 'skipped' | 'declined'): Promise<Outcome> {
  const decidedAt = new Date()
  await db
    .insert(onboardingSteps)
    .values({ step, outcome, decidedAt })
    .onConflictDoUpdate({ target: onboardingSteps.step, set: { outcome, decidedAt } })
  return { ok: true }
}

/** Hide the checklist from the dashboard (or bring it back). Changes no step. */
export async function setDismissed(db: Db, dismissed: boolean): Promise<void> {
  const now = new Date()
  const dismissedAt = dismissed ? now : null
  await db
    .insert(onboarding)
    .values({ id: 1, dismissedAt, updatedAt: now })
    .onConflictDoUpdate({ target: onboarding.id, set: { dismissedAt, updatedAt: now } })
}

// ───────────────────────────────────────────────── the two cheap inline steps

/**
 * The welcome sequences the step offers, friendliest first. Each is a starter
 * template, so the mails live once, in the library.
 */
export const WELCOMES = [
  {
    template: 'newsletter-welcome',
    name: 'Say hello',
    feel: 'Warm, no selling',
    pickIf: 'The newsletter is the point, or you have nothing to sell yet.',
  },
  {
    template: 'value-first-welcome',
    name: 'Give first, then a quiet offer',
    feel: 'Generous, a soft offer at the end',
    pickIf: 'You teach, and a course, membership, or coaching sits behind the free work.',
  },
  {
    template: 'soap-opera',
    name: 'Tell the story, make the offer',
    feel: 'Story-driven, ends on your product',
    pickIf: 'You have a product you want every new reader to hear about.',
  },
] as const

/**
 * Makes the welcome sequence from a starter: triggered on subscribe, and
 * ⭐ paused. It enrolls nobody and sends nothing; the operator writes the mails
 * and turns it on from the sequence screen, where placeholders still block it.
 * A starter the operator deleted is put back first (only missing ones are).
 */
export async function makeWelcome(
  db: Db,
  template: string,
): Promise<{ ok: true; id: number } | { ok: false; reason: string }> {
  if (!WELCOMES.some((w) => w.template === template)) return { ok: false, reason: 'pick one of the three welcomes' }
  if (!(await getTemplate(db, template))) await restoreStarterTemplates(db)
  return await createSequenceFromTemplate(db, template, { trigger: 'subscribe' })
}

/** The first broadcast, as a ⭐ draft. Never scheduled, never sent from here. */
export async function createFirstBroadcast(
  db: Db,
  subject: string,
): Promise<{ ok: true; id: number } | { ok: false; reason: string }> {
  const s = subject.trim()
  if (!s) return { ok: false, reason: 'give it a subject' }
  return { ok: true, id: await createBroadcast(db, { subject: s, bodyMd: '' }) }
}
