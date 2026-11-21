import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import {
  type SequenceStep,
  type SequenceTake,
  type SequenceTakeMail,
  sequenceSteps,
  sequenceTakeMails,
  sequenceTakes,
} from '../../db/schema.ts'
import type { Env } from '../../types.ts'
import { mdToDoc } from '../md-to-doc.ts'
import { docIsEmpty } from '../render-doc.ts'
import { getSequence, stepsFor, updateStep } from '../sequences.ts'
import { docToPlainText } from './doc-markdown.ts'
import { sampleBlock } from './ghostwriter.ts'
import { describeDraft, describeVoice, getVoice, pitchArc, pitchMoves } from './ghostwriter-voice.ts'
import { GUARD_RULE, check, clean, fence, neutralise } from './guard.ts'
import { aiReady, complete } from './openrouter.ts'
import { resolveAi } from './settings.ts'
import { DRAFT_RULES } from './sequence-draft.ts'
import { SUBJECT_GUIDE, WRITING_GUIDE } from './style.ts'

/**
 * Takes: the Ghostwriter writing every mail of a sequence that already
 * exists, BESIDE it, for the operator to read mail by mail. Ported from
 * Kōlea's `Kolea.Ghostwriter.Takes`.
 *
 * ⚠️ The rules that keep a take from ever being mail:
 *
 * - A take writes into its own rows (`sequence_takes`, `sequence_take_mails`),
 *   never into a step. Starting, writing and finishing a take change nothing
 *   in the sequence.
 * - A take mail reaches its step only by `useTakeMail` (an explicit click),
 *   only while the sequence is paused, and it carries a `[[ AI draft … ]]`
 *   placeholder on its first line, so `setSequenceActive` still refuses to go
 *   live until a person has read that step and deleted the line.
 * - Nothing here activates, enrolls, sends or publishes.
 *
 * Worker limits: a take is a plan call plus one call per mail, a minute or two
 * of model time. It is written on the minutely cron (`advanceTakes`), a few
 * mails per tick, with the rows as the only state: nothing is held in memory
 * between requests, and a tick that dies mid-call leaves a lease that
 * expires. A mail whose call was cut off is marked failed rather than retried,
 * because a retry would pay for it twice (Kōlea's job is `max_attempts: 1`).
 */

/** How many mails one tick writes, in parallel. Seven mails take two ticks. */
export const MAILS_PER_TICK = 4
/** A tick's hold on a take. Longer than the slowest call it makes. */
const LEASE_MS = 6 * 60_000
/** A take still `writing` this long after it last moved has stopped part way. */
const STOPPED_AFTER_MS = 15 * 60_000
const MIN_BRIEF_WORDS = 12

export type TakeState = 'writing' | 'stopped' | 'done' | 'failed'

export interface TakeWithMails extends SequenceTake {
  mails: SequenceTakeMail[]
}

export type TakeResult = { ok: true; take: TakeWithMails } | { ok: false; reason: string }

export function takeState(take: SequenceTake, now = new Date()): TakeState {
  if (take.status !== 'writing') return take.status
  return now.getTime() - take.updatedAt.getTime() >= STOPPED_AFTER_MS ? 'stopped' : 'writing'
}

/** Mails written and waiting to be read: neither used nor left. */
export function toRead(take: TakeWithMails): number {
  return take.mails.filter((m) => m.status === 'written').length
}

/* ─────────────────────────────────────────────────────────── reading */

export async function listTakes(db: Db, sequenceId: number): Promise<TakeWithMails[]> {
  const takes = await db
    .select()
    .from(sequenceTakes)
    .where(eq(sequenceTakes.sequenceId, sequenceId))
    .orderBy(desc(sequenceTakes.number))
    .all()
  if (!takes.length) return []
  const mails = await db
    .select()
    .from(sequenceTakeMails)
    .where(
      inArray(
        sequenceTakeMails.takeId,
        takes.map((t) => t.id),
      ),
    )
    .orderBy(asc(sequenceTakeMails.position))
    .all()
  return takes.map((t) => ({ ...t, mails: mails.filter((m) => m.takeId === t.id) }))
}

export async function getTake(db: Db, sequenceId: number, number: number): Promise<TakeWithMails | null> {
  if (!Number.isInteger(number)) return null
  const take = await db
    .select()
    .from(sequenceTakes)
    .where(and(eq(sequenceTakes.sequenceId, sequenceId), eq(sequenceTakes.number, number)))
    .get()
  if (!take) return null
  return { ...take, mails: await mailsOf(db, take.id) }
}

async function mailsOf(db: Db, takeId: number): Promise<SequenceTakeMail[]> {
  return await db
    .select()
    .from(sequenceTakeMails)
    .where(eq(sequenceTakeMails.takeId, takeId))
    .orderBy(asc(sequenceTakeMails.position))
    .all()
}

/* ─────────────────────────────────────────────────────────── starting */

export interface TakeBrief {
  topic: string
  goal: string
  notes: string
}

export function briefText(b: TakeBrief): string {
  return [
    `What it is about: ${b.topic}`,
    b.goal ? `What the sequence should do: ${b.goal}` : '',
    b.notes ? `The sender's notes (their facts, their story, their links):\n${b.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Starts a take: numbers it, makes one waiting mail per step, and leaves the
 * writing to the cron. Writes to the voice's draft dial and pitch as they are
 * now. Refuses a sequence with no mails, a thin brief, and a second take
 * while one is still writing this sequence.
 */
export async function startTake(env: Env, db: Db, sequenceId: number, input: TakeBrief): Promise<TakeResult> {
  if (!(await aiReady(env, db))) return { ok: false, reason: 'AI is not set up. Choose a key on Settings, AI.' }
  const seq = await getSequence(db, sequenceId)
  if (!seq) return { ok: false, reason: 'No such sequence.' }

  const brief: TakeBrief = {
    topic: input.topic.trim().slice(0, 500),
    goal: input.goal.trim().slice(0, 1000),
    notes: input.notes.trim().slice(0, 4000),
  }
  if (!brief.topic) return { ok: false, reason: 'Say what the sequence is about first.' }
  const words = briefText(brief).split(/\s+/).filter(Boolean).length
  if (words < MIN_BRIEF_WORDS) {
    return { ok: false, reason: 'The brief needs a few sentences: what you are offering, who it is for, and why you care.' }
  }
  const refused = check([brief.topic, brief.goal, brief.notes])
  if (refused) return { ok: false, reason: refused }

  const steps = await stepsFor(db, sequenceId)
  if (!steps.length) {
    return { ok: false, reason: 'This sequence has no mails yet. Add the steps (or start it from a template) first; a take writes beside the mails that are there.' }
  }

  const now = new Date()
  const busy = await db
    .select({ id: sequenceTakes.id })
    .from(sequenceTakes)
    .where(
      and(
        eq(sequenceTakes.sequenceId, sequenceId),
        eq(sequenceTakes.status, 'writing'),
        sql`${sequenceTakes.updatedAt} > ${now.getTime() - STOPPED_AFTER_MS}`,
      ),
    )
    .get()
  if (busy) return { ok: false, reason: 'The Ghostwriter is already writing this sequence. Wait for that take.' }

  const voice = await getVoice(db)
  const last = await db
    .select({ n: sql<number>`coalesce(max(${sequenceTakes.number}), 0)` })
    .from(sequenceTakes)
    .where(eq(sequenceTakes.sequenceId, sequenceId))
    .get()

  const [take] = await db
    .insert(sequenceTakes)
    .values({
      sequenceId,
      number: Number(last?.n ?? 0) + 1,
      status: 'writing',
      draft: voice.draft,
      pitch: voice.pitch,
      ...brief,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  await db.insert(sequenceTakeMails).values(
    steps.map((s) => ({ takeId: take!.id, stepId: s.id, position: s.position, status: 'waiting' as const, updatedAt: now })),
  )
  return { ok: true, take: { ...take!, mails: await mailsOf(db, take!.id) } }
}

/* ─────────────────────────────────────────────────────────── writing (cron) */

const PLAN_SCHEMA = {
  name: 'take_plan',
  schema: {
    type: 'object',
    properties: {
      story: { type: 'string', description: 'Two to four sentences: the story this sequence tells and what it builds to.' },
      mails: {
        type: 'array',
        description: 'One entry per mail, in order.',
        items: {
          type: 'object',
          properties: { plan: { type: 'string', description: 'One or two sentences: what this mail says and how it moves the story on.' } },
          required: ['plan'],
          additionalProperties: false,
        },
      },
    },
    required: ['story', 'mails'],
    additionalProperties: false,
  },
}

const MAIL_SCHEMA = {
  name: 'take_mail',
  schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'The subject line.' },
      body: { type: 'string', description: 'The email body in markdown.' },
    },
    required: ['subject', 'body'],
    additionalProperties: false,
  },
}

function stepText(step: SequenceStep): string {
  return (step.bodyJson && !docIsEmpty(step.bodyJson) ? docToPlainText(step.bodyJson) : step.bodyMd).trim()
}

/**
 * The line at the top of every take mail. A `[[ placeholder ]]` on purpose:
 * a sequence cannot go live while any step still has one.
 */
export function banner(plan: string): string {
  const job = plan.replace(/[[\]]/g, '').trim()
  return `[[ AI draft. Rewrite this in your own words, then delete this line.${job ? ` This mail's job: ${job}` : ''} ]]`
}

/**
 * One tick's worth of take writing: the oldest take still writing, under a
 * lease. Plans it if it has no plan, then writes up to `MAILS_PER_TICK` of its
 * waiting mails at once, each saved the moment it lands. Never throws for a
 * model failure; that is a failed mail or a failed take, with the sentence.
 */
export async function advanceTakes(env: Env, db: Db, now = new Date()): Promise<void> {
  const take = await db
    .select()
    .from(sequenceTakes)
    .where(
      and(
        eq(sequenceTakes.status, 'writing'),
        or(isNull(sequenceTakes.lockedUntil), lt(sequenceTakes.lockedUntil, now)),
      ),
    )
    .orderBy(asc(sequenceTakes.createdAt))
    .limit(1)
    .get()
  if (!take) return

  const leased = await db
    .update(sequenceTakes)
    .set({ lockedUntil: new Date(now.getTime() + LEASE_MS) })
    .where(
      and(
        eq(sequenceTakes.id, take.id),
        or(isNull(sequenceTakes.lockedUntil), lt(sequenceTakes.lockedUntil, now)),
      ),
    )
    .returning({ id: sequenceTakes.id })
  if (!leased.length) return

  let cost = take.costUsd
  let failure: string | null = take.failure
  try {
    // Holding the lease means nobody else is writing this take. A mail still
    // `writing` was cut off by a tick that died; tried once, so it failed.
    await db
      .update(sequenceTakeMails)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(and(eq(sequenceTakeMails.takeId, take.id), eq(sequenceTakeMails.status, 'writing')))

    const seq = await getSequence(db, take.sequenceId)
    if (!seq) return await finish(db, take.id, cost, 'The sequence is gone.')
    const steps = await stepsFor(db, take.sequenceId)
    const byId = new Map(steps.map((s) => [s.id, s]))
    let mails = (await mailsOf(db, take.id)).filter((m) => byId.has(m.stepId))
    if (!mails.length) return await finish(db, take.id, cost, 'Every step of this take was deleted.')

    const setup = await resolveAi(env, db)
    const voice = await getVoice(db)
    const brief = briefText(take)
    let day = 0
    const days = new Map(steps.map((s) => [s.id, (day += s.delayDays)]))
    const outline = mails
      .map((m, i) => {
        const s = byId.get(m.stepId)!
        return `Mail ${i + 1}, day ${days.get(s.id)}: "${neutralise(s.subject) || `Mail ${i + 1}`}"`
      })
      .join('\n')
    const intro = [`Sequence name: ${neutralise(seq.name)}`, seq.description ? `What subscribers are told it is: ${neutralise(seq.description)}` : '', '', 'The mails, in order:', outline]
      .filter((l, i) => l !== '' || i > 0)
      .join('\n')

    // ── The plan, once.
    let story = take.story
    if (story === null) {
      const arc = pitchArc(take.pitch)
      const planned = await complete(env, db, {
        task: 'sequence-plan',
        setup,
        messages: [
          {
            role: 'system',
            content: [
              "You plan email sequences. Given the sequence's mails and the sender's brief, you decide the story the sequence tells and what each mail contributes to it, so the mails read as one connected series rather than separate emails.",
              'Use only what the brief says. Where the brief is thin, plan around it rather than inventing facts.',
              `Return exactly ${mails.length} mail plans, one per mail, in order.`,
              arc ? `# The approach\n\n${arc}` : '',
              GUARD_RULE,
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
          { role: 'user', content: `${intro}\n\nThe sender's brief:\n${fence('brief', brief)}` },
        ],
        maxTokens: 2500,
        schema: PLAN_SCHEMA,
        timeoutMs: 90_000,
      })
      if (!planned.ok) return await finish(db, take.id, cost, planned.reason)
      cost += planned.costUsd
      const plan = planned.json as { story?: unknown; mails?: { plan?: unknown }[] }
      story = clean(String(plan.story ?? ''), [brief]) || ''
      await db.update(sequenceTakes).set({ story, costUsd: cost, updatedAt: new Date() }).where(eq(sequenceTakes.id, take.id))
      for (const [i, m] of mails.entries()) {
        const p = clean(String(plan.mails?.[i]?.plan ?? ''), [brief])
        await db.update(sequenceTakeMails).set({ plan: p }).where(eq(sequenceTakeMails.id, m.id))
        m.plan = p
      }
    }

    // ── A few mails, at once.
    const fullPlan = mails.map((m, i) => `Mail ${i + 1}: ${m.plan ?? ''}`).join('\n')
    const moves = pitchMoves(take.pitch)
    const system = [
      WRITING_GUIDE,
      SUBJECT_GUIDE,
      DRAFT_RULES,
      `# How finished\n\n${describeDraft(take.draft)}`,
      `# The voice\n\n${neutralise(describeVoice(voice))}`,
      moves ? `# The approach\n\n${moves}` : '',
      GUARD_RULE,
    ]
      .filter(Boolean)
      .join('\n\n')
    const samples = await sampleBlock(db, voice)

    const batch = mails.filter((m) => m.status === 'waiting').slice(0, MAILS_PER_TICK)
    await Promise.all(
      batch.map(async (m) => {
        const claimed = await db
          .update(sequenceTakeMails)
          .set({ status: 'writing', updatedAt: new Date() })
          .where(and(eq(sequenceTakeMails.id, m.id), eq(sequenceTakeMails.status, 'waiting')))
          .returning({ id: sequenceTakeMails.id })
        if (!claimed.length) return
        const i = mails.indexOf(m)
        const step = byId.get(m.stepId)!
        const text = stepText(step)
        const written = await complete(env, db, {
          task: 'ghostwriter',
          setup,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                samples,
                `The sender's brief:\n${fence('brief', brief)}`,
                `${intro}\n\nThe story of the whole sequence: ${story}\n\nThe plan for every mail:\n${fullPlan}`,
                [
                  `Write mail ${i + 1} of ${mails.length}.`,
                  `Its place in the story: ${m.plan ?? ''}`,
                  '',
                  "The mail as the sender has it now. Follow its structure and keep what they wrote that matters; the [[ brackets ]] show what the sender would put there:",
                  `<scaffolding>\nSubject: ${neutralise(step.subject) || '[[ Subject ]]'}\n\n${neutralise(text) || '[[ Write this mail ]]'}\n</scaffolding>`,
                ].join('\n'),
              ]
                .filter(Boolean)
                .join('\n\n'),
            },
          ],
          maxTokens: 4000,
          schema: MAIL_SCHEMA,
          timeoutMs: 120_000,
        })
        // The sender's own step text counts as given: a link already in their
        // mail survives, anything new becomes [[ link ]].
        const sources = [brief, step.subject, text]
        if (!written.ok) {
          failure = written.reason
          await settleMail(db, m.id, { status: 'failed' })
          return
        }
        cost += written.costUsd
        const out = written.json as { subject?: unknown; body?: unknown }
        const body = clean(String(out.body ?? ''), sources)
        const subject = clean(String(out.subject ?? ''), sources).slice(0, 200) || step.subject
        if (!body) {
          await settleMail(db, m.id, { status: 'failed' })
          return
        }
        const bodyMd = `${banner(m.plan ?? '')}\n\n${body}`
        await settleMail(db, m.id, { status: 'written', subject, bodyMd, bodyJson: mdToDoc(bodyMd) })
      }),
    )

    mails = await mailsOf(db, take.id)
    const left = mails.some((m) => m.status === 'waiting' || m.status === 'writing')
    if (!left) return await finish(db, take.id, cost, failure)
    await db.update(sequenceTakes).set({ costUsd: cost, failure, updatedAt: new Date() }).where(eq(sequenceTakes.id, take.id))
  } finally {
    await db.update(sequenceTakes).set({ lockedUntil: null }).where(eq(sequenceTakes.id, take.id))
  }
}

/** Only a mail still being written changes; one already acted on is left alone. */
async function settleMail(
  db: Db,
  id: number,
  set: Partial<Pick<SequenceTakeMail, 'status' | 'subject' | 'bodyMd' | 'bodyJson'>>,
): Promise<void> {
  await db
    .update(sequenceTakeMails)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(sequenceTakeMails.id, id), eq(sequenceTakeMails.status, 'writing')))
}

/** Whatever never landed failed; the take is done if anything was written, failed otherwise. */
async function finish(db: Db, takeId: number, cost: number, failure: string | null): Promise<void> {
  const now = new Date()
  await db
    .update(sequenceTakeMails)
    .set({ status: 'failed', updatedAt: now })
    .where(and(eq(sequenceTakeMails.takeId, takeId), inArray(sequenceTakeMails.status, ['waiting', 'writing'])))
  const mails = await mailsOf(db, takeId)
  const any = mails.some((m) => m.status !== 'failed')
  await db
    .update(sequenceTakes)
    .set({
      status: any ? 'done' : 'failed',
      costUsd: cost,
      failure: any ? failure : (failure ?? 'No mail could be written. Nothing was changed.'),
      updatedAt: now,
    })
    .where(eq(sequenceTakes.id, takeId))
}

/* ─────────────────────────────────────────────────────────── reading it over */

export type ActResult = { ok: true; message: string } | { ok: false; reason: string }

const LIVE =
  'Pause the sequence first. Ghostwritten mail opens with a note to read it over, and a live sequence would send it as it is.'
const CHANGED = 'That mail has changed. Reload the page.'

async function load(db: Db, takeId: number, position: number) {
  const take = await db.select().from(sequenceTakes).where(eq(sequenceTakes.id, takeId)).get()
  if (!take) return null
  const mail = await db
    .select()
    .from(sequenceTakeMails)
    .where(and(eq(sequenceTakeMails.takeId, takeId), eq(sequenceTakeMails.position, position)))
    .get()
  if (!mail) return null
  const seq = await getSequence(db, take.sequenceId)
  if (!seq) return null
  const step = await db.select().from(sequenceSteps).where(eq(sequenceSteps.id, mail.stepId)).get()
  if (!step) return null
  return { take, mail, seq, step }
}

/**
 * Uses the mail at `position`: its words are copied into the step, and the
 * step's own words are kept on the mail to put back. Only a written mail, and
 * only while the sequence is paused. The sequence stays paused.
 */
export async function useTakeMail(db: Db, takeId: number, position: number): Promise<ActResult> {
  const got = await load(db, takeId, position)
  if (!got) return { ok: false, reason: 'No such mail.' }
  const { mail, seq, step } = got
  if (seq.isActive) return { ok: false, reason: LIVE }
  if (mail.status !== 'written' || !mail.bodyMd) return { ok: false, reason: CHANGED }

  const claimed = await db
    .update(sequenceTakeMails)
    .set({
      status: 'used',
      beforeSubject: step.subject,
      beforeBodyMd: step.bodyMd,
      beforeBodyJson: step.bodyJson,
      updatedAt: new Date(),
    })
    .where(and(eq(sequenceTakeMails.id, mail.id), eq(sequenceTakeMails.status, 'written')))
    .returning({ id: sequenceTakeMails.id })
  if (!claimed.length) return { ok: false, reason: CHANGED }

  await updateStep(db, step.id, {
    subject: mail.subject ?? step.subject,
    bodyMd: mail.bodyMd,
    bodyJson: mail.bodyJson ?? mdToDoc(mail.bodyMd),
  })
  return { ok: true, message: `Mail ${position} is in step ${step.position}. Read it over and delete the AI draft line before going live.` }
}

/** Leaves the mail at `position`: the operator keeps their own words. */
export async function keepMyMail(db: Db, takeId: number, position: number): Promise<ActResult> {
  const got = await load(db, takeId, position)
  if (!got || got.mail.status !== 'written') return { ok: false, reason: CHANGED }
  await db
    .update(sequenceTakeMails)
    .set({ status: 'kept', updatedAt: new Date() })
    .where(and(eq(sequenceTakeMails.id, got.mail.id), eq(sequenceTakeMails.status, 'written')))
  return { ok: true, message: `Kept your own mail ${position}.` }
}

/** Undoes the choice: a used mail puts the step's own words back (paused only); a left one is ready to read again. */
export async function undoTakeMail(db: Db, takeId: number, position: number): Promise<ActResult> {
  const got = await load(db, takeId, position)
  if (!got) return { ok: false, reason: 'No such mail.' }
  const { mail, seq, step } = got
  if (mail.status === 'kept') {
    await db
      .update(sequenceTakeMails)
      .set({ status: 'written', updatedAt: new Date() })
      .where(and(eq(sequenceTakeMails.id, mail.id), eq(sequenceTakeMails.status, 'kept')))
    return { ok: true, message: `Mail ${position} is back to read.` }
  }
  if (mail.status !== 'used') return { ok: false, reason: CHANGED }
  if (seq.isActive) return { ok: false, reason: LIVE }
  const claimed = await db
    .update(sequenceTakeMails)
    .set({ status: 'written', beforeSubject: null, beforeBodyMd: null, beforeBodyJson: null, updatedAt: new Date() })
    .where(and(eq(sequenceTakeMails.id, mail.id), eq(sequenceTakeMails.status, 'used')))
    .returning({ id: sequenceTakeMails.id })
  if (!claimed.length) return { ok: false, reason: CHANGED }
  await updateStep(db, step.id, {
    subject: mail.beforeSubject ?? step.subject,
    bodyMd: mail.beforeBodyMd ?? '',
    bodyJson: mail.beforeBodyJson ?? null,
  })
  return { ok: true, message: `Step ${step.position} has your own words back.` }
}

/** Uses every mail of the take still waiting to be read, in order. Paused only. */
export async function useRestOfTake(db: Db, takeId: number): Promise<ActResult> {
  const take = await db.select().from(sequenceTakes).where(eq(sequenceTakes.id, takeId)).get()
  if (!take) return { ok: false, reason: 'No such take.' }
  const seq = await getSequence(db, take.sequenceId)
  if (!seq) return { ok: false, reason: 'No such sequence.' }
  if (seq.isActive) return { ok: false, reason: LIVE }
  const waiting = (await mailsOf(db, takeId)).filter((m) => m.status === 'written')
  let used = 0
  for (const m of waiting) {
    const r = await useTakeMail(db, takeId, m.position)
    if (!r.ok) return used ? { ok: false, reason: `Used ${used}, then: ${r.reason}` } : r
    used++
  }
  return { ok: true, message: used ? `Used ${used} mail${used === 1 ? '' : 's'}. Read each step over before going live.` : 'Nothing left to use.' }
}
