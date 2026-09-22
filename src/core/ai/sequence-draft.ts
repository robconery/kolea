import { asc, eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { type SequenceTemplateRow, sequenceSteps } from '../../db/schema.ts'
import type { Env } from '../../types.ts'
import { mdToDoc } from '../md-to-doc.ts'
import { templateSchedule } from '../sequence-templates/index.ts'
import { updateStep } from '../sequences.ts'
import { complete, modelFor } from './openrouter.ts'
import { SUBJECT_GUIDE, WRITING_GUIDE } from './style.ts'
import { voiceSamples } from './voice.ts'

/**
 * A first draft of a whole sequence, from a template and a brief.
 *
 * A template is a proven shape: seven mails, what each one is for, when each
 * one lands. What it can't give you is *your* story told through that shape.
 * This writes that first pass, so the writer starts from a draft with a
 * structure and an arc instead of a page of brackets.
 *
 * Two passes:
 *
 *  1. **The plan.** One call reads the brief and the template and writes the
 *     through-line: the story the sequence tells and what each mail does in
 *     it. Short, so it is fast.
 *  2. **The mails.** One call per mail, all at once, each holding the whole
 *     plan so mail four knows what mail three said. Parallel, so seven mails
 *     take about as long as one.
 *
 * ⚠️ A draft is scaffolding, not mail. Three rules keep it from pretending
 * otherwise:
 *
 * - The model is told to invent nothing: no testimonials, results, numbers,
 *   deadlines or stories that are not in the brief. What it doesn't know
 *   becomes a `[[ placeholder ]]`.
 * - Every drafted body opens with a `[[ AI draft … ]]` line saying what the
 *   mail is for and asking the writer to put it in their own words. That line
 *   is a placeholder, so `setSequenceActive` refuses to take the sequence live
 *   until the writer has been through every step and deleted it.
 * - The sequence itself is created paused, by the same path as any template.
 *   This only fills in the steps' words.
 */

export interface DraftedMail {
  subject: string
  bodyMd: string
}

export type DraftResult =
  | {
      ok: true
      mails: DraftedMail[]
      story: string
      costUsd: number
      /** Mails the model failed on, left as the template had them. */
      skipped: number
    }
  | { ok: false; reason: string }

const PLAN_SCHEMA = {
  name: 'sequence_plan',
  schema: {
    type: 'object',
    properties: {
      story: {
        type: 'string',
        description: 'Two to four sentences: the story this sequence tells and the pitch it builds to.',
      },
      mails: {
        type: 'array',
        description: 'One entry per mail in the template, in order.',
        items: {
          type: 'object',
          properties: {
            plan: {
              type: 'string',
              description: 'One or two sentences: what this mail says and how it moves the story on.',
            },
          },
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
  name: 'sequence_mail',
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

const DRAFT_RULES = `
# Drafting rules

You are drafting one email in an automated sequence for a writer who will rewrite it in their own words before it is sent. Your draft is a starting point that shows the structure and the argument, written well enough that the writer can see how it should sound.

- Write as the sender, in the first person, to one reader. Follow the template's structure for this mail: the scaffolding shows what goes where and in what order.
- Use only facts from the brief. You do not know anything else about this person, their product, their customers or their life.
- Anything the email needs that the brief does not give you goes in double square brackets describing what belongs there: [[ link to the course ]], [[ price ]], [[ the date the cart closes ]], [[ a student result, with their permission ]], [[ one or two sentences on the moment you decided to quit ]]. This is required, not optional: never invent a testimonial, a result, a statistic, a customer, a quote, a deadline, a discount, a price, a URL or a personal story.
- If the brief gives the writer's name, sign off with it. Otherwise end with [[ Sign off ]].
- Greet the reader with {{first_name}} if the template does. Write it exactly like that.
- Markdown only: paragraphs, **bold** for the one line that matters, lists only for genuinely parallel items, links as [text](url) only when the brief gives the URL.
- Keep to about the length of the template's scaffolding for this mail, usually 150 to 350 words. Sequences are read on phones.
- No fake urgency, no manipulation, no pressure. A sales mail can be direct about the offer and honest about who it is for and who it is not for.
`.trim()

/** A brief this short can't carry a sequence. */
const MIN_BRIEF_WORDS = 12

export async function draftSequence(
  env: Env,
  db: Db,
  input: { template: SequenceTemplateRow; brief: string; sequenceName: string },
): Promise<DraftResult> {
  const { template: t } = input
  const brief = input.brief.trim()
  if (brief.split(/\s+/).filter(Boolean).length < MIN_BRIEF_WORDS) {
    return { ok: false, reason: 'The brief needs a few sentences: what you are offering, who it is for, and why you care.' }
  }
  if (t.steps.length === 0) return { ok: false, reason: 'This template has no mails to draft.' }

  const model = modelFor(env, 'sequence')
  const days = templateSchedule(t.steps)
  const outline = t.steps
    .map((s, i) => `Mail ${i + 1}, day ${days[i]}: "${s.label}". ${s.purpose}`)
    .join('\n')
  const templateIntro = [
    `Template: ${t.name}${t.source ? ` (after ${t.source})` : ''}`,
    t.tagline,
    '',
    t.description,
    '',
    `Sequence name: ${input.sequenceName}`,
    '',
    'The mails, in order:',
    outline,
  ].join('\n')

  // ── Pass one: the plan
  const planned = await complete(env, db, {
    label: 'sequence-plan',
    model,
    messages: [
      {
        role: 'system',
        content: [
          'You plan email sequences. Given a proven template and the sender\'s brief, you decide the story the sequence tells and what each mail contributes to it, so the mails read as one connected series rather than separate emails.',
          'Use only what the brief says. Where the brief is thin, plan around it rather than inventing facts.',
          `Return exactly ${t.steps.length} mail plans, one per template mail, in order.`,
        ].join('\n'),
      },
      { role: 'user', content: `${templateIntro}\n\nThe sender's brief:\n<brief>\n${brief}\n</brief>` },
    ],
    maxTokens: 2500,
    schema: PLAN_SCHEMA,
    timeoutMs: 90_000,
  })
  if (!planned.ok) return planned

  const plan = planned.json as { story?: string; mails?: { plan?: string }[] }
  const story = String(plan.story ?? '').trim()
  const plans = t.steps.map((s, i) => String(plan.mails?.[i]?.plan ?? '').trim() || s.purpose)

  // ── Pass two: every mail at once
  const samples = await voiceSamples(db)
  const voice = samples.length
    ? [
        'Here is how the sender writes. Match their voice, their sentence rhythm and their vocabulary. Do not reuse their content.',
        ...samples.map((s, i) => `<sample ${i + 1}>\n${s}\n</sample ${i + 1}>`),
      ].join('\n\n')
    : ''
  const system = [WRITING_GUIDE, SUBJECT_GUIDE, DRAFT_RULES].join('\n\n')
  const fullPlan = plans.map((p, i) => `Mail ${i + 1} (day ${days[i]}, "${t.steps[i]!.label}"): ${p}`).join('\n')

  const drafted = await Promise.all(
    t.steps.map((step, i) =>
      complete(env, db, {
        label: 'sequence-mail',
        model,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              voice,
              `The sender's brief:\n<brief>\n${brief}\n</brief>`,
              `${templateIntro}\n\nThe story of the whole sequence: ${story}\n\nThe plan for every mail:\n${fullPlan}`,
              [
                `Write mail ${i + 1} of ${t.steps.length}: "${step.label}".`,
                `Its job: ${step.purpose}`,
                `Its place in the story: ${plans[i]}`,
                '',
                'The template scaffolding for this mail. Follow its structure; the [[ brackets ]] show what the sender would put there:',
                `<scaffolding>\nSubject: ${step.subject}\n\n${step.bodyMd}\n</scaffolding>`,
              ].join('\n'),
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
        maxTokens: 2500,
        schema: MAIL_SCHEMA,
        timeoutMs: 120_000,
      }),
    ),
  )

  // One mail failing should not throw away six good ones that are already paid
  // for. A failed mail keeps the template's own scaffolding, and says so.
  if (drafted.every((d) => !d.ok)) {
    const first = drafted[0]
    return { ok: false, reason: first && !first.ok ? first.reason : 'No mail could be drafted.' }
  }

  let costUsd = planned.costUsd
  let skipped = 0
  const mails = drafted.map((d, i) => {
    const step = t.steps[i]!
    if (!d.ok) {
      skipped++
      return { subject: step.subject, bodyMd: step.bodyMd }
    }
    costUsd += d.costUsd
    const out = d.json as { subject?: string; body?: string }
    const subject = dashless(String(out.subject ?? '').trim()) || step.subject
    const body = dashless(String(out.body ?? '').trim()) || step.bodyMd
    return { subject, bodyMd: `${banner(plans[i]!)}\n\n${body}` }
  })

  return { ok: true, mails, story, costUsd, skipped }
}

/**
 * The line at the top of every drafted mail. It is a `[[ placeholder ]]` on
 * purpose: the sequence cannot be activated while any step still has one, so
 * the writer has to open every mail, and the note tells them what it is for
 * while they rewrite it.
 */
function banner(plan: string): string {
  const job = plan.replace(/[[\]]/g, '').trim()
  return `[[ AI draft. Rewrite this in your own words, then delete this line. This mail's job: ${job} ]]`
}

function dashless(s: string): string {
  return s.replace(/\s*—\s*/g, ', ').replace(/ – /g, ', ')
}

/**
 * Put drafted mails into a sequence's steps, in position order. Only the
 * subject and body change; delays stay as the template set them.
 */
export async function writeDraftIntoSequence(
  db: Db,
  sequenceId: number,
  mails: DraftedMail[],
): Promise<void> {
  const steps = await db
    .select({ id: sequenceSteps.id })
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, sequenceId))
    .orderBy(asc(sequenceSteps.position))
    .all()
  for (const [i, step] of steps.entries()) {
    const mail = mails[i]
    if (!mail) break
    await updateStep(db, step.id, {
      subject: mail.subject,
      bodyMd: mail.bodyMd,
      bodyJson: mdToDoc(mail.bodyMd),
    })
  }
}
