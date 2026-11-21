/**
 * The writing helpers, the models they may use, and what those models cost.
 *
 * Pure data and pure functions. `settings.ts` reads the operator's choices from
 * D1 and asks this file what they resolve to.
 *
 * Models are named the OpenRouter way (`maker/model`) everywhere. OpenRouter
 * serves every model on the list; an Anthropic key serves only `anthropic/…`
 * and an OpenAI key only `openai/…`.
 */

/**
 * Every job a model does. The helpers that exist today, plus the names the
 * next ones (the council, the Ghostwriter, Launch Studio) will file under, so
 * adding one is a line in `HELPERS` and nothing else.
 */
export type AiTask =
  | 'subject'
  | 'cleanup'
  | 'sequence-plan'
  | 'sequence-mail'
  | 'council'
  | 'ghostwriter'
  | 'launch'

export interface Helper {
  task: AiTask
  label: string
  /** One line on the settings screen: what the model is asked to do. */
  what: string
}

/** The helpers on the settings screen, in the order the composer meets them. */
export const HELPERS: Helper[] = [
  { task: 'subject', label: 'Suggest a subject', what: 'Short in, very short out. Taste more than stamina.' },
  { task: 'cleanup', label: 'Clean this up', what: "Rewrites a draft without flattening the writer's voice." },
  { task: 'sequence-plan', label: 'Sequence plan', what: 'Reads the brief and plans the story a sequence tells.' },
  { task: 'sequence-mail', label: 'Sequence mails', what: 'Writes each mail of a drafted sequence, all at once.' },
  { task: 'council', label: 'Reader council', what: 'Three readers and an editor read a draft and say what to keep and cut.' },
  { task: 'launch', label: 'Launch angle', what: 'Reads a launch brief and outlines the points the sales copy should make.' },
  { task: 'ghostwriter', label: 'Ghostwriter', what: 'Drafts a mail, or every mail of a take, in the voice on the sliders.' },
]

export type Maker = 'anthropic' | 'openai'

export interface CatalogueModel {
  id: string
  label: string
  maker: Maker
  /** List price, US dollars per million tokens, in and out. */
  inPerM: number
  outPerM: number
}

/**
 * The models an operator can pick, with list prices (November 2026). The
 * prices are only used to estimate a call on a key whose provider reports
 * tokens but not money; OpenRouter's own figure is used whenever there is one.
 */
export const CATALOGUE: CatalogueModel[] = [
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', maker: 'anthropic', inPerM: 4, outPerM: 20 },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', maker: 'anthropic', inPerM: 2, outPerM: 10 },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', maker: 'anthropic', inPerM: 1, outPerM: 5 },
  { id: 'openai/gpt-5', label: 'GPT-5', maker: 'openai', inPerM: 1.25, outPerM: 10 },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 mini', maker: 'openai', inPerM: 0.25, outPerM: 2 },
]

/** Who pays: the install's `OPENROUTER_KEY`, or one of the operator's own keys. */
export type Payer = 'env' | 'openrouter' | 'anthropic' | 'openai'

export const PAYERS: Payer[] = ['env', 'openrouter', 'anthropic', 'openai']

export function isPayer(v: unknown): v is Payer {
  return typeof v === 'string' && (PAYERS as string[]).includes(v)
}

export function isTask(v: unknown): v is AiTask {
  return typeof v === 'string' && HELPERS.some((h) => h.task === v)
}

/**
 * The defaults, chosen for this job and this price list:
 *
 * - Subject lines: Sonnet 5. About a cent a click.
 * - Clean-up: Opus 5.5. Rewriting prose without flattening the writer's voice
 *   is the hardest thing on this list. About 5 to 10 cents.
 * - Sequence drafts: Opus 5.5. A plan plus one call per mail, around 20 to 40
 *   cents for a seven-mail sequence.
 *
 * On an OpenAI key the same split, in OpenAI's models.
 */
const DEFAULTS: Record<Maker, Record<AiTask, string>> = {
  anthropic: {
    subject: 'anthropic/claude-sonnet-5',
    cleanup: 'anthropic/claude-opus-5.5',
    'sequence-plan': 'anthropic/claude-opus-5.5',
    'sequence-mail': 'anthropic/claude-opus-5.5',
    council: 'anthropic/claude-opus-5.5',
    ghostwriter: 'anthropic/claude-opus-5.5',
    launch: 'anthropic/claude-sonnet-5',
  },
  openai: {
    subject: 'openai/gpt-5-mini',
    cleanup: 'openai/gpt-5',
    'sequence-plan': 'openai/gpt-5',
    'sequence-mail': 'openai/gpt-5',
    council: 'openai/gpt-5',
    ghostwriter: 'openai/gpt-5',
    launch: 'openai/gpt-5-mini',
  },
}

/** The default model for `task` on a key paid by `payer`. */
export function defaultModel(payer: Payer, task: AiTask): string {
  return DEFAULTS[payer === 'openai' ? 'openai' : 'anthropic'][task]
}

/** `anthropic/claude-opus-5.5` → `anthropic`; anything else → null. */
export function makerOf(model: string): Maker | null {
  if (model.startsWith('anthropic/')) return 'anthropic'
  if (model.startsWith('openai/')) return 'openai'
  return null
}

/** Whether the key `payer` names can serve `model` at all. OpenRouter serves everything. */
export function serves(payer: Payer, model: string): boolean {
  if (payer === 'env' || payer === 'openrouter') return true
  return makerOf(model) === payer
}

/** The catalogue models a payer can serve, for the screen's pickers. */
export function modelsFor(payer: Payer): CatalogueModel[] {
  return CATALOGUE.filter((m) => serves(payer, m.id))
}

export function inCatalogue(model: string): boolean {
  return CATALOGUE.some((m) => m.id === model)
}

/**
 * Tokens × list price, or null when the model has no list price here. Null is
 * recorded as 0 and flagged, never guessed.
 */
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number | null {
  const m = CATALOGUE.find((c) => c.id === model || model.startsWith(`${c.id}:`))
  if (!m) return null
  return (promptTokens * m.inPerM + completionTokens * m.outPerM) / 1_000_000
}

/** "anthropic/claude-opus-5.5" → "Claude Opus 5.5", for a button's small print. */
export function modelLabel(model: string): string {
  const known = CATALOGUE.find((m) => m.id === model)
  if (known) return known.label
  const name = model.split('/').pop() ?? model
  return name
    .split('-')
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}
