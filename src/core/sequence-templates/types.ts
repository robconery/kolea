import type { TemplateStepDoc } from '../../db/schema.ts'
import type { SequenceTrigger } from '../sequences.ts'

/**
 * A sequence template is a proven *shape*: how many mails, how far apart, and
 * what job each one does. The copy inside is scaffolding, not finished mail.
 *
 * Templates are rows in `sequence_templates`. This interface is a template
 * without its row identity: what the starters are written as, and what the
 * create and edit forms produce.
 *
 * ⚠️ Every part the operator must rewrite is wrapped in `[[ double brackets ]]`.
 * That marker is load-bearing: `setSequenceActive` refuses to take a sequence
 * live while any step still contains one, so a half-filled template can never
 * reach a real inbox. Every starter step carries at least one.
 */
export type TemplateStep = TemplateStepDoc

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

export const TEMPLATE_FAMILIES: readonly TemplateFamily[] = [
  'funnel',
  'launch',
  'welcome',
  'sale',
  'customer',
]

export const FAMILY_LABEL: Record<TemplateFamily, string> = {
  funnel: 'Funnels',
  launch: 'Launches',
  welcome: 'Welcomes',
  sale: 'Sales',
  customer: 'Customers',
}
