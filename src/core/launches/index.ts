import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import {
  type Launch,
  conversions,
  launches,
  sequenceTemplates,
  storeOffers,
  stripeProducts,
} from '../../db/schema.ts'
import type { Env } from '../../types.ts'
import { complete, modelLabel } from '../ai/openrouter.ts'
import { draftSequence, writeDraftIntoSequence } from '../ai/sequence-draft.ts'
import { WRITING_GUIDE } from '../ai/style.ts'
import { type StepPerf, sequenceSteps } from '../analytics.ts'
import { type CampaignStats, campaignStats, createCampaign, getCampaign } from '../campaigns.ts'
import { slugify } from '../ids.ts'
import { salesForCampaign } from '../sales.ts'
import {
  createSequenceFromTemplate,
  findPlaceholders,
  getTemplate,
  type SequenceTemplateRow,
} from '../sequence-templates/index.ts'
import { deleteSequence, getSequence, stepsFor } from '../sequences.ts'
import { findOrCreateTag } from '../subscribers.ts'
import { type LaunchEvent, type LaunchStep, briefText, transition } from './steps.ts'

export * from './steps.ts'

/**
 * Launch Studio: one push to sell one thing, as seven screens (see `steps.ts`).
 *
 * ⚠️ Nothing in this file sends mail, enrolls anybody, activates a sequence,
 * schedules a broadcast or publishes a post. It writes the launch row, a
 * campaign, a tag, and a PAUSED sequence through the same core functions the
 * hand-made path uses, and it reads analytics. Taking the sequence live stays
 * the sequence screen's own Go live, behind its own preflight; announcing it
 * stays the broadcast composer's Send. The studio links to both.
 */

export type Result<T = { id: number }> = ({ ok: true } & T) | { ok: false; reason: string }

/** The families a launch can be built from: a launch proper, or a sale. */
export const LAUNCH_FAMILIES = ['launch', 'sale'] as const

const MAX_FIELD = 6000
const MAX_NAME = 120

export interface BriefInput {
  name: string
  offer: string
  audience?: string
  problem?: string
  promise?: string
  story?: string
  objections?: string
  priceNote?: string
  storeOfferId?: number | null
}

const BRIEF_KEYS = ['offer', 'audience', 'problem', 'promise', 'story', 'objections', 'priceNote'] as const

function clean(v: string | undefined | null): string | null {
  const t = (v ?? '').trim()
  return t ? t : null
}

/** The brief, trimmed and checked. A message rather than a row when it doesn't fit. */
async function readBrief(db: Db, input: BriefInput): Promise<Result<{ brief: Partial<Launch> }>> {
  const name = (input.name ?? '').trim()
  if (!name) return { ok: false, reason: 'Give the launch a name.' }
  if (name.length > MAX_NAME) return { ok: false, reason: `Keep the name under ${MAX_NAME} characters.` }
  const brief: Partial<Launch> = { name }
  for (const k of BRIEF_KEYS) {
    const v = clean(input[k])
    if (v && v.length > MAX_FIELD) return { ok: false, reason: `Keep each answer under ${MAX_FIELD} characters.` }
    brief[k] = v
  }
  if (!brief.offer) return { ok: false, reason: 'Say what you are selling, in a sentence or two.' }
  if (input.storeOfferId) {
    const o = await db.select({ id: storeOffers.id }).from(storeOffers).where(eq(storeOffers.id, input.storeOfferId)).get()
    if (!o) return { ok: false, reason: 'That store offer is not for sale any more.' }
  }
  brief.storeOfferId = input.storeOfferId ?? null
  return { ok: true, brief }
}

async function uniqueSlug(db: Db, name: string): Promise<string> {
  const base = slugify(name) || 'launch'
  let slug = base
  for (let n = 2; await db.select({ id: launches.id }).from(launches).where(eq(launches.slug, slug)).get(); n++) {
    slug = `${base}-${n}`
  }
  return slug
}

/** Run `event` against the launch as `patch` would leave it, and write both. */
async function apply(db: Db, l: Launch, event: LaunchEvent, patch: Partial<Launch> = {}): Promise<Result> {
  const t = transition(l, event)
  if (!t.ok) return t
  const now = new Date()
  await db
    .update(launches)
    .set({
      ...patch,
      step: t.step,
      status: t.status,
      updatedAt: now,
      ...(t.status === 'handed_off' && !l.handedOffAt ? { handedOffAt: now } : {}),
      ...(t.status === 'closed' ? { closedAt: now } : {}),
    })
    .where(eq(launches.id, l.id))
  return { ok: true, id: l.id }
}

async function load(db: Db, id: number): Promise<Result<{ launch: Launch }>> {
  const launch = await getLaunch(db, id)
  return launch ? { ok: true, launch } : { ok: false, reason: 'No such launch.' }
}

// ─────────────────────────────────────────────────── reading

export async function listLaunches(db: Db): Promise<Launch[]> {
  return await db.select().from(launches).orderBy(desc(launches.updatedAt)).all()
}

export async function getLaunch(db: Db, id: number): Promise<Launch | null> {
  return (await db.select().from(launches).where(eq(launches.id, id)).get()) ?? null
}

/** The store offers a launch can point at, by name. */
export async function offerChoices(db: Db): Promise<{ id: number; slug: string; name: string }[]> {
  return await db
    .select({ id: storeOffers.id, slug: storeOffers.slug, name: stripeProducts.name })
    .from(storeOffers)
    .innerJoin(stripeProducts, eq(stripeProducts.id, storeOffers.productId))
    .orderBy(stripeProducts.name)
    .all()
}

/** The templates a launch can be built from: the `launch` and `sale` families. */
export async function launchTemplates(db: Db): Promise<SequenceTemplateRow[]> {
  return await db
    .select()
    .from(sequenceTemplates)
    .where(inArray(sequenceTemplates.family, [...LAUNCH_FAMILIES]))
    .orderBy(sequenceTemplates.name)
    .all()
}

// ─────────────────────────────────────────────────── step 1: the offer

export async function createLaunch(db: Db, input: BriefInput): Promise<Result> {
  const read = await readBrief(db, input)
  if (!read.ok) return read
  const fresh = { step: 'offer' as const, status: 'draft' as const, templateSlug: null, campaignId: null, sequenceId: null }
  const t = transition(
    { ...fresh, offer: null },
    { kind: 'describe', name: read.brief.name!, offer: read.brief.offer ?? null },
  )
  if (!t.ok) return t
  const now = new Date()
  const inserted = await db
    .insert(launches)
    .values({
      ...read.brief,
      name: read.brief.name!,
      slug: await uniqueSlug(db, read.brief.name!),
      step: t.step,
      status: t.status,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: launches.id })
  return { ok: true, id: inserted[0]!.id }
}

export async function saveBrief(db: Db, id: number, input: BriefInput): Promise<Result> {
  const got = await load(db, id)
  if (!got.ok) return got
  const read = await readBrief(db, input)
  if (!read.ok) return read
  return await apply(
    db,
    got.launch,
    { kind: 'describe', name: read.brief.name!, offer: read.brief.offer ?? null },
    read.brief,
  )
}

// ─────────────────────────────────────────────────── step 2: the plan

export async function choosePlan(
  db: Db,
  id: number,
  input: { templateSlug: string; startsOn?: Date | null },
): Promise<Result> {
  const got = await load(db, id)
  if (!got.ok) return got
  const t = await getTemplate(db, input.templateSlug)
  if (!t || !(LAUNCH_FAMILIES as readonly string[]).includes(t.family)) {
    return { ok: false, reason: 'Choose one of the launch templates.' }
  }
  return await apply(
    db,
    got.launch,
    { kind: 'plan', templateSlug: t.slug },
    { templateSlug: t.slug, startsOn: input.startsOn ?? null },
  )
}

// ─────────────────────────────────────────────────── step 3: the campaign

/**
 * Point the launch at a campaign: an existing one, or a new one named after
 * the launch. A campaign is attribution and nothing else, so making one sends
 * nothing.
 */
export async function openCampaign(
  db: Db,
  id: number,
  input: { campaignId?: number | null; goalCents?: number | null },
): Promise<Result<{ id: number; campaignId: number }>> {
  const got = await load(db, id)
  if (!got.ok) return got
  const l = got.launch
  let campaignId = input.campaignId ?? null
  if (campaignId) {
    if (!(await getCampaign(db, campaignId))) return { ok: false, reason: 'No such campaign.' }
  } else if (l.campaignId) {
    campaignId = l.campaignId
  } else {
    // Checked before creating, so a refusal leaves no orphan campaign behind.
    const dry = transition(l, { kind: 'campaign', campaignId: -1 })
    if (!dry.ok) return dry
    campaignId = await createCampaign(db, l.name, {
      description: l.offer,
      goalCents: input.goalCents ?? null,
    })
  }
  const r = await apply(db, l, { kind: 'campaign', campaignId }, { campaignId })
  return r.ok ? { ok: true, id: l.id, campaignId } : r
}

// ─────────────────────────────────────────────────── step 4: the sequence

export interface BuiltSequence {
  id: number
  sequenceId: number
  /** A sentence for the flash: how the build went, drafted or not. */
  message: string
  warn: boolean
}

/**
 * Copy the chosen template into a PAUSED sequence on the launch's campaign,
 * optionally drafting its mails from the brief with the existing sequence
 * drafter. A tag_added template gets the launch's own `launch-<slug>` tag to
 * start on; tagging anybody with it is still the operator's act, and does
 * nothing until the sequence is live.
 *
 * Never activates. `createSequenceFromTemplate` makes it paused, and core
 * refuses Go live while any `[[ placeholder ]]` survives.
 */
export async function buildSequence(
  env: Env,
  db: Db,
  id: number,
  opts: { draft?: boolean } = {},
): Promise<Result<BuiltSequence>> {
  const got = await load(db, id)
  if (!got.ok) return got
  const l = got.launch
  const dry = transition(l, { kind: 'sequence', sequenceId: -1 })
  if (!dry.ok) return dry

  const template = await getTemplate(db, l.templateSlug!)
  if (!template) return { ok: false, reason: 'The template this launch was planned on has been deleted. Choose another.' }

  const triggerTagId =
    template.suggestedTrigger === 'tag_added' ? await findOrCreateTag(db, `launch-${l.slug}`) : null
  const name = `${l.name}: ${template.defaultName || template.name}`
  const made = await createSequenceFromTemplate(db, template.slug, {
    name,
    trigger: template.suggestedTrigger,
    triggerTagId,
    campaignId: l.campaignId,
  })
  if (!made.ok) return made

  // A double-clicked Build: claim the launch's one sequence slot atomically, and
  // throw away the copy that lost, so no orphaned sequence (or second paid
  // draft) is left behind.
  const claimed = await db
    .update(launches)
    .set({ sequenceId: made.id })
    .where(and(eq(launches.id, l.id), sql`${launches.sequenceId} is null`))
    .returning({ id: launches.id })
  if (claimed.length === 0) {
    await deleteSequence(db, made.id)
    return { ok: false, reason: 'This launch already has its sequence.' }
  }

  const r = await apply(db, l, { kind: 'sequence', sequenceId: made.id }, { sequenceId: made.id, triggerTagId })
  if (!r.ok) return r

  let message = 'Built, paused. Rewrite every [[ placeholder ]] before taking it live.'
  let warn = false
  if (opts.draft) {
    const drafted = await draftSequence(env, db, { template, brief: briefText(l), sequenceName: name })
    if (drafted.ok) {
      await writeDraftIntoSequence(db, made.id, drafted.mails)
      message = `Built, paused, and drafted with ${modelLabel(drafted.model)} ($${drafted.costUsd.toFixed(2)}). Every mail opens with an [[ AI draft ]] line to rewrite and delete.`
    } else {
      message = `Built, paused, but not drafted: ${drafted.reason} The template's placeholders are in place instead.`
      warn = true
    }
  }
  return { ok: true, id: l.id, sequenceId: made.id, message, warn }
}

// ─────────────────────────────────────────────────── step 5: the copy

const OUTLINE_RULES = `
# Your job

Outline the sales angle for this launch: the points the sales page and the launch mails should make, in the order they should make them. Six to ten short bullet points in markdown, then one line naming the single sentence the whole launch hangs on.

- Use only facts from the brief. Never invent a testimonial, a result, a number, a price, a deadline or a story. What the brief does not say goes in [[ double brackets ]] describing what belongs there.
- Points, not prose: the writer writes the copy.
- No fake urgency and no pressure.
`.trim()

/**
 * A first pass at the sales angle from the brief, through the `launch` helper.
 * Budgeted and recorded by `complete` like every other call. Returns the text
 * for the operator to edit; saving it is `saveCopy`.
 */
export async function suggestOutline(env: Env, db: Db, id: number): Promise<Result<{ id: number; outline: string; costUsd: number; model: string }>> {
  const got = await load(db, id)
  if (!got.ok) return got
  if (got.launch.status === 'closed') return { ok: false, reason: 'This launch is closed. It can be read, not changed.' }
  const r = await complete(env, db, {
    task: 'launch',
    maxTokens: 1500,
    timeoutMs: 60_000,
    messages: [
      { role: 'system', content: `${WRITING_GUIDE}\n\n${OUTLINE_RULES}` },
      { role: 'user', content: `The brief, in the writer's words:\n\n${briefText(got.launch)}` },
    ],
  })
  if (!r.ok) return r
  return { ok: true, id, outline: r.text.trim(), costUsd: r.costUsd, model: r.model }
}

export async function saveCopy(db: Db, id: number, outline: string): Promise<Result> {
  const got = await load(db, id)
  if (!got.ok) return got
  const text = clean(outline)
  if (text && text.length > MAX_FIELD * 2) return { ok: false, reason: 'Keep the outline under 12,000 characters.' }
  return await apply(db, got.launch, { kind: 'copy' }, { outline: text })
}

// ─────────────────────────────────────────────────── step 6: the hand-off

/** Where the sequence stands: paused or live, and the scaffolding left in it. */
export interface Readiness {
  sequence: { id: number; name: string; isActive: boolean; steps: number; placeholders: number } | null
  campaign: { id: number; name: string } | null
  offer: { id: number; slug: string; name: string } | null
}

export async function readiness(db: Db, l: Launch): Promise<Readiness> {
  const seq = l.sequenceId ? await getSequence(db, l.sequenceId) : null
  const steps = seq ? await stepsFor(db, seq.id) : []
  const campaign = l.campaignId ? await getCampaign(db, l.campaignId) : null
  const offer = l.storeOfferId ? (await offerChoices(db)).find((o) => o.id === l.storeOfferId) ?? null : null
  return {
    sequence: seq
      ? {
          id: seq.id,
          name: seq.name,
          isActive: seq.isActive,
          steps: steps.length,
          placeholders: steps.reduce((n, s) => n + findPlaceholders(s).length, 0),
        }
      : null,
    campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
    offer,
  }
}

/**
 * Mark the launch handed off: the operator has everything and goes to the
 * sequence's own screen to take it live. Changes nothing outside this row.
 */
export async function handOff(db: Db, id: number): Promise<Result> {
  const got = await load(db, id)
  if (!got.ok) return got
  return await apply(db, got.launch, { kind: 'handoff' })
}

// ─────────────────────────────────────────────────── step 7: the review

export interface LaunchReview {
  stats: CampaignStats | null
  /** Conversions credited to the campaign, per kind. */
  conversions: { kindSlug: string; n: number; cents: number }[]
  steps: StepPerf[]
  sales: Awaited<ReturnType<typeof salesForCampaign>>
}

/** How it went, read from the campaign's and the sequence's existing numbers. */
export async function review(db: Db, l: Launch): Promise<LaunchReview> {
  const [stats, conv, steps, sales] = await Promise.all([
    l.campaignId ? campaignStats(db, l.campaignId) : null,
    l.campaignId
      ? db
          .select({
            kindSlug: conversions.kindSlug,
            n: sql<number>`count(*)`,
            cents: sql<number>`coalesce(sum(${conversions.valueCents}), 0)`,
          })
          .from(conversions)
          .where(and(eq(conversions.campaignId, l.campaignId)))
          .groupBy(conversions.kindSlug)
          .all()
      : [],
    l.sequenceId ? sequenceSteps(db, l.sequenceId) : [],
    l.campaignId ? salesForCampaign(db, l.campaignId, 20) : [],
  ])
  return {
    stats,
    conversions: conv.map((c) => ({ kindSlug: c.kindSlug, n: Number(c.n), cents: Number(c.cents) })),
    steps,
    sales,
  }
}

export async function closeLaunch(db: Db, id: number): Promise<Result> {
  const got = await load(db, id)
  if (!got.ok) return got
  return await apply(db, got.launch, { kind: 'close' })
}

/** Deleting the launch keeps what it made: the campaign and sequence are the operator's. */
export async function deleteLaunch(db: Db, id: number): Promise<void> {
  await db.delete(launches).where(eq(launches.id, id))
}

export type { LaunchStep }
