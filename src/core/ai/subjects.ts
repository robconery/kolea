import type { Db } from '../../db/index.ts'
import type { DocNode } from '../../db/schema.ts'
import type { Env } from '../../types.ts'
import { findSlop } from '../../slop/index.ts'
import { docToPlainText } from './doc-markdown.ts'
import { complete, modelFor } from './openrouter.ts'
import { SUBJECT_GUIDE } from './style.ts'
import { recentSubjects } from './voice.ts'

/**
 * Subject lines, suggested from the body.
 *
 * The writer writes first and the subject falls out of the writing. So the
 * model reads the draft, finds the specific thing in it worth opening for, and
 * offers a handful of honest ways to say so, each from a different angle. The
 * writer picks one, or none. Nothing is filled in without a click.
 *
 * Every suggestion is run past the slop reader before it is shown, so a
 * subject with "unlock" or an em-dash in it never makes the list.
 */

export interface SubjectIdea {
  subject: string
  /** Why this one, in a few words: the angle it takes. */
  angle: string
}

export type SubjectResult =
  | { ok: true; ideas: SubjectIdea[]; model: string; costUsd: number }
  | { ok: false; reason: string }

const SCHEMA = {
  name: 'subject_lines',
  schema: {
    type: 'object',
    properties: {
      ideas: {
        type: 'array',
        description: 'Six subject lines, each taking a different angle on the email.',
        items: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'The subject line itself.' },
            angle: {
              type: 'string',
              description: 'Four to eight words on the angle this subject takes.',
            },
          },
          required: ['subject', 'angle'],
          additionalProperties: false,
        },
      },
    },
    required: ['ideas'],
    additionalProperties: false,
  },
}

/** Too little to find a subject in. */
const MIN_WORDS = 25
/** Enough to know what the mail is about; the rest is cost. */
const MAX_CHARS = 16_000

export async function suggestSubjects(
  env: Env,
  db: Db,
  input: { doc: DocNode | null; current?: string; context?: string },
): Promise<SubjectResult> {
  const body = docToPlainText(input.doc).trim()
  if (body.split(/\s+/).filter(Boolean).length < MIN_WORDS) {
    return { ok: false, reason: 'Write a paragraph or two first. The subject comes out of the words.' }
  }

  const past = await recentSubjects(db)
  const system = [
    'You suggest email subject lines for a writer who sends a newsletter to people who chose to get it.',
    '',
    SUBJECT_GUIDE,
    '',
    '# Your task',
    '',
    'Read the email. Find what is actually interesting in it: the specific detail, the story, the question it answers, the thing the reader gets. Then write six subject lines, each from a different angle, so the writer has a real choice. Examples of angles: the most specific detail, the question the email answers, a plain statement of what it is about, the moment in the story, the reader\'s problem.',
    '',
    'Match how this writer writes subjects (see their past subjects if given): their length, their casing, their tone. Do not copy any past subject.',
    'Every subject must be true to this email. Never promise something the email does not deliver.',
    'Use only words and facts that are in the email. Do not add numbers, names or claims that are not there.',
  ].join('\n')

  const user = [
    past.length ? `The writer's recent subject lines, newest first:\n${past.map((s) => `- ${s}`).join('\n')}\n` : '',
    input.context ? `Where this email goes: ${input.context}\n` : '',
    input.current?.trim() ? `The writer's current working subject (improve on it or ignore it): ${input.current.trim()}\n` : '',
    'The email:',
    '<email>',
    body.slice(0, MAX_CHARS),
    '</email>',
  ]
    .filter(Boolean)
    .join('\n')

  const result = await complete(env, db, {
    label: 'subject',
    model: modelFor(env, 'subject'),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxTokens: 1200,
    schema: SCHEMA,
    timeoutMs: 45_000,
  })
  if (!result.ok) return result

  const raw = ((result.json as { ideas?: SubjectIdea[] })?.ideas ?? [])
    .map((i) => ({ subject: tidy(String(i.subject ?? '')), angle: String(i.angle ?? '').trim() }))
    .filter((i) => i.subject.length > 0 && i.subject.length <= 90)

  // Drop anything the slop reader flags. If that leaves nothing, the model
  // missed badly, and an empty list says so more honestly than a bad one.
  const clean = raw.filter((i) => findSlop(i.subject).hits.length === 0)
  const seen = new Set<string>()
  const ideas = clean.filter((i) => {
    const k = i.subject.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  if (ideas.length === 0) {
    return { ok: false, reason: 'Nothing good came back. Try again, or write a little more first.' }
  }
  return { ok: true, ideas: ideas.slice(0, 6), model: result.model, costUsd: result.costUsd }
}

/** Quotes a model wraps a subject in, a trailing full stop, a stray dash. */
function tidy(s: string): string {
  return s
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/(?<![.!?])\.$/, '')
    .trim()
}
