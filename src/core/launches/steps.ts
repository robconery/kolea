/**
 * Launch Studio's seven steps, and the one function allowed to move a launch
 * between them. Pure: no database, no clock it does not take as an argument.
 *
 * Ports the rules of Kōlea's `Kolea.Launches` (the seven steps, each reading
 * from the brief; sequences made paused; going live is the sequence's own act)
 * onto Big Mailer's shape: the campaign and the sequence are rows of their own,
 * and the launch only remembers which.
 *
 * `step` on the row is the furthest screen reached. A screen at or behind it
 * can always be revisited; a screen ahead of it opens only when the step
 * before it is done. `transition` is the single place that decides both.
 */

export const STEPS = ['offer', 'plan', 'campaign', 'sequence', 'copy', 'handoff', 'review'] as const
export type LaunchStep = (typeof STEPS)[number]

export type LaunchStatus = 'draft' | 'handed_off' | 'closed'

export const STEP_LABEL: Record<LaunchStep, string> = {
  offer: 'Describe the offer',
  plan: 'Plan the launch',
  campaign: 'Open a campaign',
  sequence: 'Build the sequence',
  copy: 'Write the copy',
  handoff: 'Take it live',
  review: 'Review the launch',
}

/** What `transition` needs to know about a launch. A `Launch` row satisfies it. */
export interface LaunchState {
  step: LaunchStep
  status: LaunchStatus
  offer: string | null
  templateSlug: string | null
  campaignId: number | null
  sequenceId: number | null
}

/**
 * Completing a step. Each names the step it finishes; `close` finishes the
 * review and is the only way to `closed`. Every event is judged against the
 * launch as it stands BEFORE the step's own changes are written, so the event
 * carries the new values it is about (the brief's name and offer, the chosen
 * template, the campaign).
 */
export type LaunchEvent =
  | { kind: 'describe'; name: string; offer: string | null }
  | { kind: 'plan'; templateSlug: string }
  | { kind: 'campaign'; campaignId: number }
  | { kind: 'sequence'; sequenceId: number }
  | { kind: 'copy' }
  | { kind: 'handoff' }
  | { kind: 'close' }

export type Transition =
  | { ok: true; step: LaunchStep; status: LaunchStatus }
  | { ok: false; reason: string }

export function stepIndex(step: LaunchStep): number {
  return STEPS.indexOf(step)
}

export function isStep(v: unknown): v is LaunchStep {
  return typeof v === 'string' && (STEPS as readonly string[]).includes(v)
}

const furthest = (a: LaunchStep, b: LaunchStep): LaunchStep => (stepIndex(a) >= stepIndex(b) ? a : b)

/**
 * Why `step`'s screen cannot be opened yet, or null when it can. A screen the
 * launch has already reached always opens (to be read, at least).
 */
export function blockedReason(l: LaunchState, step: LaunchStep): string | null {
  if (stepIndex(step) <= stepIndex(l.step)) return null
  // The first unmet need on the way there, so skipping two steps names the
  // nearer one rather than the one that depends on it.
  for (const s of STEPS.slice(1, stepIndex(step) + 1)) {
    const why = prerequisite(l, s)
    if (why) return why
  }
  return null
}

/** The thing a step needs before it, as a sentence, or null. */
function prerequisite(l: LaunchState, step: LaunchStep): string | null {
  switch (step) {
    case 'offer':
      return null
    case 'plan':
      return l.offer ? null : 'Describe the offer first.'
    case 'campaign':
      return l.templateSlug ? null : 'Choose a launch template first.'
    case 'sequence':
      return l.campaignId ? null : 'Open the campaign first.'
    case 'copy':
    case 'handoff':
      return l.sequenceId ? null : 'Build the sequence first.'
    case 'review':
      return l.status === 'draft' ? 'Take it live first: the review reads what happened after.' : null
  }
}

const STEP_OF: Record<LaunchEvent['kind'], LaunchStep> = {
  describe: 'offer',
  plan: 'plan',
  campaign: 'campaign',
  sequence: 'sequence',
  copy: 'copy',
  handoff: 'handoff',
  close: 'review',
}

/**
 * Where a launch goes when `event` happens to it, or why it can't.
 *
 * The refusals are the illegal states: no step ahead of what is done, nothing
 * changed on a closed launch, no second template or campaign once the
 * sequence exists (the sequence was copied from the one and points at the
 * other, so changing either would leave the launch describing something it
 * did not build), and no second sequence.
 */
export function transition(l: LaunchState, event: LaunchEvent): Transition {
  if (l.status === 'closed') return { ok: false, reason: 'This launch is closed. It can be read, not changed.' }

  const step = STEP_OF[event.kind]
  const blocked = blockedReason(l, step)
  if (blocked) return { ok: false, reason: blocked }

  switch (event.kind) {
    case 'describe':
      if (!event.name.trim() || !event.offer?.trim()) {
        return { ok: false, reason: 'A launch needs a name and a sentence on what it sells.' }
      }
      break
    case 'plan':
      if (l.sequenceId && event.templateSlug !== l.templateSlug) {
        return { ok: false, reason: 'The sequence is already built from the template you chose.' }
      }
      break
    case 'campaign':
      if (l.sequenceId && event.campaignId !== l.campaignId) {
        return { ok: false, reason: 'The sequence already counts toward this launch’s campaign.' }
      }
      break
    case 'sequence':
      if (l.sequenceId) return { ok: false, reason: 'This launch already has its sequence.' }
      break
    case 'copy':
    case 'handoff':
      break
    case 'close':
      return { ok: true, step: 'review', status: 'closed' }
  }

  const next = STEPS[stepIndex(step) + 1] ?? 'review'
  const status: LaunchStatus = event.kind === 'handoff' || l.status === 'handed_off' ? 'handed_off' : 'draft'
  return { ok: true, step: furthest(l.step, next), status }
}

/** The brief as one block of prose, for a model that may use nothing else. */
export function briefText(l: {
  name: string
  offer: string | null
  audience: string | null
  problem: string | null
  promise: string | null
  story: string | null
  objections: string | null
  priceNote: string | null
}): string {
  const parts: [string, string | null][] = [
    ['The offer', l.offer],
    ['Price', l.priceNote],
    ['Who it is for', l.audience],
    ['What they are stuck on', l.problem],
    ['What it promises', l.promise],
    ['Why I care (the story)', l.story],
    ['What makes people hesitate', l.objections],
  ]
  return [
    `Launch: ${l.name}`,
    ...parts.filter(([, v]) => v?.trim()).map(([k, v]) => `${k}: ${v!.trim()}`),
  ].join('\n')
}
