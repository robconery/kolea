import type { SequenceTrigger } from '../sequences.ts'

/**
 * A sequence template is a proven *shape*: how many mails, how far apart, and
 * what job each one does. The copy inside is scaffolding, not finished mail.
 *
 * ⚠️ Every part the operator must rewrite is wrapped in `[[ double brackets ]]`.
 * That marker is load-bearing: `setSequenceActive` refuses to take a sequence
 * live while any step still contains one, so a half-filled template can never
 * reach a real inbox. Do not write a template step without at least one.
 */
export interface TemplateStep {
  /** Days after the PREVIOUS step, same meaning as `sequence_steps.delay_days`. */
  delayDays: number
  /** Two or three words naming the mail's job, e.g. "High drama". */
  label: string
  /** One or two sentences on what this mail is for. Shown on the picker only. */
  purpose: string
  subject: string
  bodyMd: string
}

export type TemplateFamily = 'funnel' | 'launch' | 'welcome' | 'sale' | 'customer'

export interface SequenceTemplate {
  slug: string
  name: string
  family: TemplateFamily
  /** Who the shape comes from. Credit, not endorsement. */
  source: string
  /** One line for the gallery. */
  tagline: string
  /** A few short paragraphs for the detail page. Plain text, split on blank lines. */
  description: string
  bestFor: string[]
  /** What the operator should have in hand before starting. */
  needs: string[]
  suggestedTrigger: SequenceTrigger
  /** Why that trigger, in a sentence. */
  triggerHint: string
  /** Prefills. The description is subscriber-facing (preference center). */
  defaultName: string
  defaultDescription: string
  steps: TemplateStep[]
}

export const FAMILY_LABEL: Record<TemplateFamily, string> = {
  funnel: 'Funnels',
  launch: 'Launches',
  welcome: 'Welcomes',
  sale: 'Sales',
  customer: 'Customers',
}
