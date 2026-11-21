import type { Db } from '../../db/index.ts'
import type { DocNode } from '../../db/schema.ts'
import { findSlop } from '../../slop/index.ts'
import type { Env } from '../../types.ts'
import { mdToDoc } from '../md-to-doc.ts'
import { problems } from './cleanup.ts'
import { GUARD_RULE, check, clean, fence, neutralise } from './guard.ts'
import {
  type Voice,
  describeDraft,
  describeStructure,
  describeVoice,
  getVoice,
  reviseFor,
  wordsFor,
} from './ghostwriter-voice.ts'
import { complete } from './openrouter.ts'
import { resolveAi } from './settings.ts'
import { SUBJECT_GUIDE, WRITING_GUIDE } from './style.ts'
import { voiceSamples } from './voice.ts'

/**
 * The Ghostwriter, one mail: a topic and the writer's notes in, a draft in
 * the writer's tuned voice out. Ported from Kōlea's `Kolea.Ghostwriter.write`
 * and `Kolea.AI.Ghostwrite`.
 *
 * ⚠️ Saves nothing and sends nothing. The draft goes back to the composer,
 * which puts it in the editor as one undoable change; the writer reads it,
 * changes it, and saves or sends it the usual way.
 *
 * Model output is untrusted: it goes through `guard.clean` (no markup, no
 * images, no links the writer did not give, no merge tags but
 * `{{first_name}}`), then `mdToDoc`, which only ever makes text nodes. Facts
 * come only from the notes; what the model does not know becomes `[[ … ]]`,
 * which a sequence step cannot go live with (`setSequenceActive`).
 */

export const GHOST_RULES = `
# Ghostwriting rules

You are ghostwriting one email that a real person will send under their own name to people who chose to hear from them. They will read your draft, change what they like, and send it. It has to read as if they wrote it on a good day, and nobody who reads it should suspect a machine was involved.

- First person, as the sender, to one reader.
- You may explain ideas from general knowledge you are sure of. But every specific number, date, name, study, quote, price or result must come from the sender's notes. If it is not there, you do not know it: never invent a statistic, a study, a quote, a customer, a result or a personal story. Where the email needs one, leave a placeholder like [[ the number from your own list ]].
- The sender's own experiences are theirs to tell. Where the email wants a personal moment that the notes do not give you, leave a placeholder in double square brackets saying what belongs there, like [[ a time you got this wrong ]]. Four placeholders at most.
- Link only to URLs the sender gave in their notes. Never write "research shows", "studies show" or "experts say".
- One idea, followed through. Pick the single most interesting thing for this reader and build the email around it. A newsletter is not a report.
- Open with something concrete: a fact, a moment, a scene, a real question the sender has. Never open by announcing the topic, with a definition, with "Imagine", or with a question you then answer.
- No headings unless the length is long and the piece really has parts. Bullets only for genuinely parallel items. Bold at most once.
- End when you are done: a plain closing line, or a question to the reader. No summary, no takeaway, no moral, no call to action the notes did not ask for. No sign-off and no name; the sender adds their own.
- Use {{first_name}} only if greeting the reader by name fits the voice. No other merge tags.
- Hit the target length within about fifteen percent.
- Before you answer, reread every sentence against the guide above. Rewrite anything a tired reader would recognise as machine-written. Em dashes are forbidden.
`.trim()

const REVISE = `
# Your task now: revise

This is your own draft. A checker that finds machine-written prose still found the problems listed. Fix every one of them, and anything else in the draft that breaks the guide. Keep the facts, the links, the placeholders in [[ double brackets ]], the merge tags, the structure, the voice and the length. Do not swap one stock phrase for another: if a phrase adds nothing, delete it.

Return only the revised email in markdown. No preamble, no notes, no code fences.
`.trim()

const SCHEMA = {
  name: 'ghostwritten_email',
  schema: {
    type: 'object',
    properties: {
      subjects: { type: 'array', description: 'Three subject lines for this email, best first.', items: { type: 'string' } },
      body: { type: 'string', description: 'The email body in markdown.' },
    },
    required: ['subjects', 'body'],
    additionalProperties: false,
  },
}

export const MAX_TOPIC = 500
export const MAX_ANGLE = 4000

/** The system prompt every Ghostwriter call shares. */
export function ghostSystem(voice: Voice): string {
  return [
    WRITING_GUIDE,
    SUBJECT_GUIDE,
    GHOST_RULES,
    `# The structure\n\n${describeStructure(voice.structure)}`,
    `# How finished\n\n${describeDraft(voice.draft)}`,
    `# The voice\n\n${neutralise(describeVoice(voice))}`,
    GUARD_RULE,
  ].join('\n\n')
}

/** The operator's own sent mail as voice samples, fenced; empty when switched off or none sent. */
export async function sampleBlock(db: Db, voice: Voice): Promise<string> {
  if (!voice.useMyMail) return ''
  const samples = await voiceSamples(db)
  if (!samples.length) return ''
  return [
    'Here is how the sender writes, from mail they already sent. Match their voice, their sentence rhythm and their vocabulary. Do not reuse their content.',
    ...samples.map((s, i) => `<sample ${i + 1}>\n${neutralise(s)}\n</sample ${i + 1}>`),
  ].join('\n\n')
}

export type GhostwriteResult =
  | {
      ok: true
      doc: DocNode
      markdown: string
      subjects: string[]
      slop: number
      revised: boolean
      model: string
      costUsd: number
    }
  | { ok: false; reason: string }

export async function ghostwrite(
  env: Env,
  db: Db,
  input: { topic: string; angle: string; context: string },
): Promise<GhostwriteResult> {
  const topic = input.topic.trim()
  const angle = input.angle.trim()
  if (topic.length < 3) return { ok: false, reason: 'Give the Ghostwriter a topic first. A few words is enough. Nothing was changed.' }
  if (topic.length > MAX_TOPIC) return { ok: false, reason: `The topic is too long. Keep it under ${MAX_TOPIC} characters.` }
  if (angle.length > MAX_ANGLE) return { ok: false, reason: `The notes are too long. Keep them under ${MAX_ANGLE} characters.` }
  const refused = check([topic, angle])
  if (refused) return { ok: false, reason: refused }

  const setup = await resolveAi(env, db)
  const voice = await getVoice(db)
  const system = ghostSystem(voice)
  const sources = [topic, angle]
  const user = [
    await sampleBlock(db, voice),
    `What this is: ${neutralise(input.context).slice(0, 200)}`,
    `Target length: about ${wordsFor(voice)} words.`,
    `The topic:\n${fence('topic', topic, MAX_TOPIC)}`,
    angle ? `The sender's notes (their facts, their story, their links):\n${fence('notes', angle, MAX_ANGLE)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const first = await complete(env, db, {
    task: 'ghostwriter',
    setup,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxTokens: 16_000,
    schema: SCHEMA,
    timeoutMs: 180_000,
  })
  if (!first.ok) return first

  const out = first.json as { subjects?: unknown; body?: unknown }
  let markdown = clean(String(out.body ?? ''), sources)
  if (!markdown) return { ok: false, reason: 'The model answered with an empty draft. Nothing was changed.' }
  const subjects = [
    ...new Set(
      (Array.isArray(out.subjects) ? out.subjects : [])
        .filter((s): s is string => typeof s === 'string')
        .map((s) => clean(s, sources).replace(/^["']|["']$/g, '').slice(0, 200))
        .filter(Boolean),
    ),
  ].slice(0, 3)

  // One revision against the slop reader where the draft dial asks for it,
  // and the better of the two is kept (Kōlea `Ghostwrite.better/2`).
  let report = findSlop(markdown)
  let costUsd = first.costUsd
  let revised = false
  const revise = reviseFor(voice.draft)
  if (revise === 'always' || (revise === 'when_needed' && report.band !== 'clean')) {
    const second = await complete(env, db, {
      task: 'ghostwriter',
      setup,
      messages: [
        { role: 'system', content: `${system}\n\n${REVISE}` },
        {
          role: 'user',
          content: [problems(report), '', 'The draft:', '<draft>', markdown, '</draft>'].join('\n'),
        },
      ],
      maxTokens: 16_000,
      timeoutMs: 180_000,
    })
    if (second.ok) {
      costUsd += second.costUsd
      const better = clean(second.text.replace(/^\s*<draft>\s*|\s*<\/draft>\s*$/g, ''), sources)
      const r2 = better ? findSlop(better) : null
      if (better && r2 && r2.score < report.score) {
        markdown = better
        report = r2
        revised = true
      }
    }
  }

  const doc = mdToDoc(markdown)
  if (!doc) return { ok: false, reason: 'The model answered with an empty draft. Nothing was changed.' }
  return { ok: true, doc, markdown, subjects, slop: report.score, revised, model: first.model, costUsd }
}
