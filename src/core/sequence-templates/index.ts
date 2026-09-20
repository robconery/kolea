import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { sequences } from '../../db/schema.ts'
import { slugify } from '../ids.ts'
import { mdToDoc } from '../md-to-doc.ts'
import { type SequenceInput, addStep, createSequence } from '../sequences.ts'
import { leadMagnet, customerOnboarding, newsletterWelcome, valueWelcome, winBack } from './staples.ts'
import { seinfeldWeek, soapOpera, webinarReplay } from './funnels.ts'
import { bigSale, productLaunch } from './launches.ts'
import type { SequenceTemplate } from './types.ts'

export type { SequenceTemplate, TemplateFamily, TemplateStep } from './types.ts'
export { FAMILY_LABEL } from './types.ts'
export { findPlaceholders } from './placeholders.ts'

/**
 * The library is code, not rows. A template is a starting shape that gets
 * copied into `sequences` + `sequence_steps` once and never referenced again,
 * so there is nothing for a table to keep consistent — and editing a template
 * here can never touch a sequence somebody already made from it (invariant 9).
 *
 * Gallery order: the famous ones first, then by how often you'd reach for them.
 */
export const SEQUENCE_TEMPLATES: readonly SequenceTemplate[] = [
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

export function getSequenceTemplate(slug: string): SequenceTemplate | null {
  return SEQUENCE_TEMPLATES.find((t) => t.slug === slug) ?? null
}

/** The day each step lands, counting enrollment as day 0. */
export function templateSchedule(t: SequenceTemplate): number[] {
  let day = 0
  return t.steps.map((s) => (day += s.delayDays))
}

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
  const t = getSequenceTemplate(templateSlug)
  if (!t) return { ok: false, reason: 'no such template' }

  const name = (input.name ?? '').trim() || t.defaultName
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
    description: input.description?.trim() || t.defaultDescription,
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
