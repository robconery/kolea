import { asc, eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { type SequenceTemplateRow, sequenceTemplates, sequences } from '../../db/schema.ts'
import { slugify } from '../ids.ts'
import { mdToDoc } from '../md-to-doc.ts'
import { type SequenceInput, addStep, createSequence, normalizeDelayDays } from '../sequences.ts'
import { seinfeldWeek, soapOpera, webinarReplay } from './funnels.ts'
import { bigSale, productLaunch } from './launches.ts'
import { customerOnboarding, leadMagnet, newsletterWelcome, valueWelcome, winBack } from './staples.ts'
import {
  type SequenceTemplate,
  TEMPLATE_FAMILIES,
  type TemplateFamily,
  type TemplateStep,
} from './types.ts'

export type { SequenceTemplate, TemplateFamily, TemplateStep } from './types.ts'
export type { SequenceTemplateRow } from '../../db/schema.ts'
export { FAMILY_LABEL, TEMPLATE_FAMILIES } from './types.ts'
export { findPlaceholders } from './placeholders.ts'

/**
 * The starters: ten shapes that ship with the app.
 *
 * They are *seed data*, not the library. The library is `sequence_templates`,
 * where every template — starter or hand-made — is an ordinary row that can be
 * edited and deleted. `restoreStarterTemplates` copies in whichever of these
 * are missing, by slug, and never overwrites one that is there: an edited
 * starter is the operator's template now, and a deleted one stays deleted until
 * they ask for it back.
 *
 * Order here is the order they land in, famous ones first.
 */
export const STARTER_TEMPLATES: readonly SequenceTemplate[] = [
  soapOpera,
  valueWelcome,
  productLaunch,
  leadMagnet,
  newsletterWelcome,
  bigSale,
  webinarReplay,
  seinfeldWeek,
  customerOnboarding,
  winBack,
]

const TRIGGERS = ['subscribe', 'tag_added', 'manual'] as const

/** The day each step lands, counting enrollment as day 0. */
export function templateSchedule(steps: readonly TemplateStep[]): number[] {
  let day = 0
  return steps.map((s) => (day += s.delayDays))
}

/** A fresh step for the editor's "add a mail" button. */
export function blankTemplateStep(position: number): TemplateStep {
  return {
    delayDays: position <= 1 ? 0 : 1,
    label: '',
    purpose: '',
    subject: '',
    bodyMd: '',
  }
}

// ─────────────────────────────────────────────────── reading

export async function listTemplates(db: Db): Promise<SequenceTemplateRow[]> {
  return await db.select().from(sequenceTemplates).orderBy(asc(sequenceTemplates.id)).all()
}

export async function getTemplate(db: Db, slug: string): Promise<SequenceTemplateRow | null> {
  return (
    (await db.select().from(sequenceTemplates).where(eq(sequenceTemplates.slug, slug)).get()) ??
    null
  )
}

/** Starters that are not in the library right now, deleted or never loaded. */
export async function missingStarters(db: Db): Promise<SequenceTemplate[]> {
  const have = new Set(
    (await db.select({ slug: sequenceTemplates.slug }).from(sequenceTemplates).all()).map(
      (r) => r.slug,
    ),
  )
  return STARTER_TEMPLATES.filter((t) => !have.has(t.slug))
}

// ─────────────────────────────────────────────────── writing

/**
 * One place that decides what a stored template looks like, shared by create
 * and update so the two can't drift.
 *
 * A blank subject or body becomes a `[[ placeholder ]]` rather than an empty
 * string: a sequence made from it then cannot go live until somebody writes
 * the mail, which is the right failure for "I'll fill that in later".
 */
function normalize(input: Partial<SequenceTemplate>) {
  const lines = (xs: readonly string[] | undefined) =>
    (xs ?? []).map((x) => x.trim()).filter(Boolean)
  const family = TEMPLATE_FAMILIES.includes(input.family as TemplateFamily)
    ? (input.family as TemplateFamily)
    : 'funnel'
  const trigger = TRIGGERS.includes(input.suggestedTrigger as (typeof TRIGGERS)[number])
    ? input.suggestedTrigger!
    : 'manual'

  return {
    name: (input.name ?? '').trim(),
    family,
    source: (input.source ?? '').trim(),
    tagline: (input.tagline ?? '').trim(),
    description: (input.description ?? '').trim(),
    bestFor: lines(input.bestFor),
    needs: lines(input.needs),
    suggestedTrigger: trigger,
    triggerHint: (input.triggerHint ?? '').trim(),
    defaultName: (input.defaultName ?? '').trim(),
    defaultDescription: (input.defaultDescription ?? '').trim(),
    steps: (input.steps ?? []).map((s, i) => ({
      delayDays: normalizeDelayDays(s.delayDays, i + 1),
      label: (s.label ?? '').trim() || `Mail ${i + 1}`,
      purpose: (s.purpose ?? '').trim(),
      subject: (s.subject ?? '').trim() || '[[ Subject ]]',
      bodyMd: (s.bodyMd ?? '').trim() || '[[ Write this mail ]]',
    })),
  }
}

/** `base`, or `base-2`, `base-3`… — the first one no template is using. */
async function freeSlug(db: Db, base: string): Promise<string> {
  const root = base || 'template'
  const taken = new Set(
    (await db.select({ slug: sequenceTemplates.slug }).from(sequenceTemplates).all()).map(
      (r) => r.slug,
    ),
  )
  if (!taken.has(root)) return root
  for (let n = 2; ; n++) {
    const candidate = `${root.slice(0, 56)}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

type Written = { ok: true; slug: string } | { ok: false; reason: string }

export async function createTemplate(
  db: Db,
  input: Partial<SequenceTemplate>,
  opts: { slug?: string } = {},
): Promise<Written> {
  const values = normalize(input)
  if (!values.name) return { ok: false, reason: 'a template needs a name' }

  const slug = await freeSlug(db, opts.slug ?? slugify(values.name))
  const now = new Date()
  await db.insert(sequenceTemplates).values({ ...values, slug, createdAt: now, updatedAt: now })
  return { ok: true, slug }
}

/** Replaces the template whole. The slug is the URL and does not follow the name. */
export async function updateTemplate(
  db: Db,
  slug: string,
  input: Partial<SequenceTemplate>,
): Promise<Written> {
  const existing = await getTemplate(db, slug)
  if (!existing) return { ok: false, reason: 'no such template' }

  const values = normalize(input)
  if (!values.name) return { ok: false, reason: 'a template needs a name' }

  await db
    .update(sequenceTemplates)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(sequenceTemplates.id, existing.id))
  return { ok: true, slug }
}

/**
 * Safe at any time: no sequence points back at its template (see the schema
 * note), so nothing made from this one changes or breaks.
 */
export async function deleteTemplate(db: Db, slug: string): Promise<Written> {
  const existing = await getTemplate(db, slug)
  if (!existing) return { ok: false, reason: 'no such template' }
  await db.delete(sequenceTemplates).where(eq(sequenceTemplates.id, existing.id))
  return { ok: true, slug }
}

export async function duplicateTemplate(db: Db, slug: string): Promise<Written> {
  const t = await getTemplate(db, slug)
  if (!t) return { ok: false, reason: 'no such template' }
  return await createTemplate(db, { ...t, name: `${t.name} (copy)` })
}

/** Insert the starters that are missing. Never overwrites one that exists. */
export async function restoreStarterTemplates(db: Db): Promise<number> {
  const missing = await missingStarters(db)
  for (const t of missing) await createTemplate(db, t, { slug: t.slug })
  return missing.length
}

// ─────────────────────────────────────────────────── using one

/**
 * Copy a template into a real sequence.
 *
 * Goes through `createSequence` and `addStep` rather than inserting rows, so a
 * templated sequence is indistinguishable from a hand-built one: it lands
 * paused, and activating it is the same deliberate act as for any other. On top
 * of that, `setSequenceActive` refuses while any `[[ placeholder ]]` survives.
 *
 * Nothing here enrolls anybody or sends anything.
 */
export async function createSequenceFromTemplate(
  db: Db,
  templateSlug: string,
  input: Partial<SequenceInput>,
): Promise<{ ok: true; id: number } | { ok: false; reason: string }> {
  const t = await getTemplate(db, templateSlug)
  if (!t) return { ok: false, reason: 'no such template' }

  const name = (input.name ?? '').trim() || t.defaultName || t.name
  const trigger = input.trigger ?? t.suggestedTrigger

  // `sequences.slug` is unique and derived from the name. Checked here so a
  // second "Welcome" is a message on the form rather than a constraint error.
  const clash = await db
    .select({ id: sequences.id })
    .from(sequences)
    .where(eq(sequences.slug, slugify(name)))
    .get()
  if (clash) return { ok: false, reason: `a sequence named “${name}” already exists` }

  const id = await createSequence(db, {
    name,
    description: input.description?.trim() || t.defaultDescription || null,
    trigger,
    triggerTagId: input.triggerTagId ?? null,
    campaignId: input.campaignId ?? null,
  })

  for (const step of t.steps) {
    await addStep(db, id, {
      subject: step.subject,
      bodyMd: step.bodyMd,
      bodyJson: mdToDoc(step.bodyMd),
      delayDays: step.delayDays,
    })
  }

  return { ok: true, id }
}
