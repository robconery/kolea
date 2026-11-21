import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { ghostwriterVoices } from '../../db/schema.ts'

/**
 * The Ghostwriter's voice: six influence sliders (0 off to 5 strong), the
 * target length, whether to read the operator's own sent mail, how a mail is
 * built (structure), how finished it is (the draft dial) and the marketing
 * approach a sequence take follows (pitch). Ported from Kōlea's
 * `Kolea.Ghostwriter.Voice`, `Structure`, `Draft` and `Pitch`.
 *
 * Everything the model is told here is Kōlea's words. An influence is a set
 * of traits, never "write like X": borrow how they write, never what.
 */

export type Influence = 'king' | 'hemingway' | 'vonnegut' | 'didion' | 'bryson' | 'graham'
export type Length = 'short' | 'medium' | 'long'
export type Structure = 'punchline' | 'story' | 'problem' | 'list'
export type DraftStop = 'outline' | 'rough' | 'first' | 'second' | 'third'
export type Pitch = 'none' | 'brunson' | 'cochrane' | 'godin' | 'ferriss'

export interface Voice {
  king: number
  hemingway: number
  vonnegut: number
  didion: number
  bryson: number
  graham: number
  length: Length
  useMyMail: boolean
  structure: Structure
  draft: DraftStop
  pitch: Pitch
}

export const INFLUENCES: { key: Influence; name: string; label: string; traits: string }[] = [
  {
    key: 'king',
    name: 'Stephen King',
    label: 'Direct storyteller',
    traits:
      'Tells it as a story, talking straight to the reader like a friend across the kitchen table. Plain everyday words, specific ordinary details (brand names, places, what someone said), and a scene before the point.',
  },
  {
    key: 'hemingway',
    name: 'Ernest Hemingway',
    label: 'Bare bones',
    traits:
      'Short declarative sentences. Concrete nouns and strong verbs, very few adjectives and almost no adverbs. Leaves things unsaid and trusts the reader to feel them.',
  },
  {
    key: 'vonnegut',
    name: 'Kurt Vonnegut',
    label: 'Wry and humane',
    traits:
      'Short paragraphs and plain talk about big things. Deadpan humour that never sneers, a kind heart under the jokes, and a willingness to say the simple true thing out loud.',
  },
  {
    key: 'didion',
    name: 'Joan Didion',
    label: 'Cool observer',
    traits:
      'Precise, cool, exact. Notices the telling detail other people walk past, and lets a carefully weighted sentence carry the feeling rather than saying it.',
  },
  {
    key: 'bryson',
    name: 'Bill Bryson',
    label: 'Curious explainer',
    traits:
      'Delighted by facts and by the odd people behind them. Self-deprecating, takes the reader along on the finding out, and makes a dry subject funny without making it smaller.',
  },
  {
    key: 'graham',
    name: 'Paul Graham',
    label: 'Plain reasoner',
    traits:
      'Thinks out loud in simple words, follows one idea to its end, and states conclusions plainly. Prefers a clear example to an abstraction and says when something is uncertain.',
  },
]

export const LENGTHS: { key: Length; label: string; words: number }[] = [
  { key: 'short', label: 'Short, about 250 words', words: 250 },
  { key: 'medium', label: 'Medium, about 500 words', words: 500 },
  { key: 'long', label: 'Long, about 900 words', words: 900 },
]

const STRENGTH: Record<number, string> = {
  1: 'a faint trace of',
  2: 'a touch of',
  3: 'clearly',
  4: 'strongly',
  5: 'above all',
}

export const STRUCTURES: { key: Structure; label: string; hint: string; text: string }[] = [
  {
    key: 'punchline',
    label: 'Lead with the punchline',
    hint: 'The point first, three reasons, a finish.',
    text: 'Lead with the punchline. State the conclusion plainly in the first two or three sentences, so a reader who stops there still has the point. Then make three points that earn it, each in its own short stretch with one concrete example or moment, ordered so the strongest comes last. Finish by coming back to the opening claim in a sentence or two, sharper now the reader has seen why. The finish is not a recap: never list the three points again.',
  },
  {
    key: 'story',
    label: 'Tell a story',
    hint: 'A moment, what was at stake, what changed.',
    text: "Tell it as a story. Open inside a moment: a place, a time, a person, something happening. Build what was at stake or what went wrong, then the turn, what changed or what the sender realised. Only then step out of the story and say, in a few sentences, what it means for this reader. The story carries most of the length. Use the story in the sender's notes; if the notes have none, leave the scene itself as a placeholder like [[ the moment this happened to you ]] and write around it. Never invent the sender's story.",
  },
  {
    key: 'problem',
    label: 'Problem, then the fix',
    hint: 'Their problem, why it sticks, what to do.',
    text: 'Problem, then the fix. Open with a problem this reader has, described the way they would describe it, concretely. Show why it matters and why the usual advice does not solve it. Then give the fix: what to do instead, specific enough that they could try it this week. End with what is different once they do, in a line or two.',
  },
  {
    key: 'list',
    label: 'A numbered list',
    hint: 'A short intro, then three to seven points.',
    text: 'A numbered list. One short opening paragraph says why this list is worth reading. Then three to seven numbered items. Each item starts with a bold one-line point, followed by a short paragraph with an example or a reason. Bold at the start of each item is allowed here, as is the numbered list itself. End with one plain closing line after the last item, never a summary of the items.',
  },
]

export type Revise = 'never' | 'when_needed' | 'always'

export const DRAFT_STOPS: { key: DraftStop; label: string; hint: string; revise: Revise; text: string }[] = [
  {
    key: 'outline',
    label: 'Just an outline',
    hint: 'The bones. You write it.',
    revise: 'never',
    text: 'Write an outline, not the email. The sender will write every sentence themselves; give them the plan. In markdown bullets, following the structure: what to open with (one line naming the concrete moment, fact or question), each point in the order it comes with a few words on the example that would carry it, and how to close. Each bullet is a short note to the sender, not a finished sentence for the reader. Put anything you do not know in [[ double brackets ]]. No more than about 150 words, whatever the target length says: the target length is for the email they will write from this. The subject ideas are still for the finished email.',
  },
  {
    key: 'rough',
    label: 'Rough',
    hint: 'Every part there, nothing polished.',
    revise: 'never',
    text: "Write a rough draft: the whole email from the first line to the last, but quick and unpolished, the way a writer gets it down before going back. Some paragraphs can be one or two plain sentences saying what goes there. Leave [[ double brackets ]] wherever the sender's own story, numbers or wording belong; up to eight is fine at this stage. Aim for about half the target length. Do not reach for clever lines; plain and clear is right for a rough draft.",
  },
  {
    key: 'first',
    label: 'First round',
    hint: 'A full draft to rework.',
    revise: 'never',
    text: 'Write a complete first draft at the target length: every paragraph written out, start to finish, in the voice. Get it all down and keep it honest; it will be reworked, so favour clarity over polish.',
  },
  {
    key: 'second',
    label: 'Second round',
    hint: 'A worked draft, checked for slop.',
    revise: 'when_needed',
    text: "Write a worked draft at the target length: complete, in the voice, each paragraph earning its place. It should need only the sender's own details and a light edit.",
  },
  {
    key: 'third',
    label: 'Third round',
    hint: 'Finished. Fill the brackets and send.',
    revise: 'always',
    text: 'Write a finished draft at the target length, as if it has already been through two rounds of editing: the opening line is the strongest it can be, every paragraph is tight, nothing is there that the reader could skip, and the last line lands. It should be ready to send once the sender fills in anything in [[ double brackets ]].',
  },
]

export const PITCHES: { key: Pitch; label: string; source: string; hint: string; arc: string; moves: string }[] = [
  {
    key: 'none',
    label: 'Just the sequence',
    source: '',
    hint: 'No marketing angle. Each mail does the job its place gives it.',
    arc: '',
    moves: '',
  },
  {
    key: 'brunson',
    label: 'Story to offer',
    source: 'Russell Brunson · DotCom Secrets, Expert Secrets',
    hint: 'One true story, told so the stacked offer makes sense.',
    arc: "The series tells one true story from the sender's life in parts, and the story is the reason the offer makes sense. Set the stage, open a loop at the end of each mail that the next one closes, reach the low point, then the epiphany (the moment it clicked, which is the bridge the reader can cross too), then what the sender built because of it. The offer comes after the reader believes, never before. When the offer arrives it is stacked: everything they get, each with what it does for them, and an honest reason to act now if the sender's notes give one.",
    moves: [
      '- Open with a hook: the most curious, specific line from this part of the story.',
      '- Keep the story moving; teach only what the story earns.',
      '- End on an open loop that makes the next mail wanted (unless this is the last).',
      '- When the mail is the offer, stack it plainly and name who it is for.',
      '- Urgency only from a real deadline in the notes. Never invent scarcity.',
    ].join('\n'),
  },
  {
    key: 'cochrane',
    label: 'Give first, sell quietly',
    source: 'In the spirit of Graham Cochrane · How to Get Paid for What You Know',
    hint: 'Generous, useful help first, then a soft offer.',
    arc: 'The series earns trust by being useful before it asks for anything. Most of the mails give: a quick win, the sender\'s best free material, a short honest story about why they do this. One mail asks the reader what they are stuck on and invites a reply. The offer comes late and quietly, for the people who want to go faster, and the series makes clear the free help continues whether they buy or not.',
    moves: [
      '- Each mail gives the reader something they can use today.',
      '- Speak to one specific person with one specific problem.',
      '- Ask for a reply where it fits; replies are the point, not a trick.',
      '- When the mail is the offer, describe it plainly, say who it is not for, and lower the pressure.',
    ].join('\n'),
  },
  {
    key: 'godin',
    label: 'Permission and trust',
    source: 'In the spirit of Seth Godin · Permission Marketing, This Is Marketing',
    hint: 'Short, generous, for a few. Earn trust, not the sale.',
    arc: "The series treats the reader's attention as a gift they can take back. Each mail is anticipated, personal and relevant: short, generous, and about one idea. It speaks to the smallest audience the sender wants to serve, names what \"people like us do things like this\" means for them, and builds tension toward a change the reader wants to make. Any offer is an invitation to the people it is for, made without pushing; the series is happy to say who should not buy.",
    moves: [
      '- Short. One idea per mail, often under 200 words.',
      "- Talk about the change the reader wants, not the product's features.",
      '- Name the people this is for, and let the others go.',
      '- Leave the reader looking forward to the next one; never trick them into it.',
      '- No hype words, no countdowns, no false scarcity.',
    ].join('\n'),
  },
  {
    key: 'ferriss',
    label: 'Experiments and frameworks',
    source: 'In the spirit of Tim Ferriss · The 4-Hour Workweek, Tools of Titans',
    hint: 'Tactical, testable steps the reader can try this week.',
    arc: "The series is a short course in doing something, built from small experiments. It starts by questioning an assumption the reader holds (what if you did the opposite?), then gives one tactical, testable step per mail: the minimum effective dose, a framework or checklist, the tool or question that makes it easy, and what to watch for. The reader should be able to try each mail's experiment this week and see a result. The offer, if there is one, is the faster or deeper version of the experiments they have already run.",
    moves: [
      '- Lead with a challenge to a common assumption, or a specific question.',
      '- Give one experiment the reader can run in a day or a week, with clear steps.',
      '- Use a short framework, a checklist, or a numbered process where it helps.',
      '- Say what to measure, and what to do if it does not work.',
      "- Specific beats inspiring: tools, time boxes and examples from the sender's notes.",
    ].join('\n'),
  },
]

const BORROW =
  "Borrow the approach, never the name: no one is quoted or mentioned, and the reader should feel the shape without seeing a formula. The shape you are given, the sender's facts and every rule about honesty still win: never invent a deadline, a discount, a result or a testimonial to make the pitch work."

/** A new install's voice: mostly direct storytelling, with some bare bones. */
export const DEFAULT_VOICE: Voice = {
  king: 3,
  hemingway: 2,
  vonnegut: 0,
  didion: 0,
  bryson: 0,
  graham: 0,
  length: 'medium',
  useMyMail: true,
  structure: 'punchline',
  draft: 'second',
  pitch: 'cochrane',
}

const oneOf = <T extends string>(list: { key: T }[], v: unknown): v is T =>
  typeof v === 'string' && list.some((x) => x.key === v)

export const isDraftStop = (v: unknown): v is DraftStop => oneOf(DRAFT_STOPS, v)
export const isPitch = (v: unknown): v is Pitch => oneOf(PITCHES, v)

/** The voice row, or the defaults when never saved. Values out of range fall back. */
export async function getVoice(db: Db): Promise<Voice> {
  const row = await db.select().from(ghostwriterVoices).where(eq(ghostwriterVoices.id, 1)).get()
  if (!row) return { ...DEFAULT_VOICE }
  const v: Voice = { ...DEFAULT_VOICE }
  for (const i of INFLUENCES) {
    const n = row[i.key]
    v[i.key] = Number.isInteger(n) && n >= 0 && n <= 5 ? n : DEFAULT_VOICE[i.key]
  }
  if (oneOf(LENGTHS, row.length)) v.length = row.length
  if (oneOf(STRUCTURES, row.structure)) v.structure = row.structure
  if (isDraftStop(row.draft)) v.draft = row.draft
  if (isPitch(row.pitch)) v.pitch = row.pitch
  v.useMyMail = row.useMyMail
  return v
}

export type SaveVoiceResult = { ok: true; voice: Voice } | { ok: false; reason: string }

/**
 * Saves the voice from a form. Every field is required (the form always
 * posts every slider); an influence outside 0 to 5 or an unknown length,
 * structure, draft stop or pitch refuses the whole save and changes nothing.
 */
export async function saveVoice(db: Db, input: Record<string, unknown>): Promise<SaveVoiceResult> {
  const v: Voice = { ...DEFAULT_VOICE }
  for (const i of INFLUENCES) {
    const n = Number(input[i.key])
    if (!Number.isInteger(n) || n < 0 || n > 5 || input[i.key] === '' || input[i.key] === undefined) {
      return { ok: false, reason: `${i.label} must be a whole number from 0 to 5. Nothing was changed.` }
    }
    v[i.key] = n
  }
  if (!oneOf(LENGTHS, input.length)) return { ok: false, reason: 'Choose a length. Nothing was changed.' }
  if (!oneOf(STRUCTURES, input.structure)) return { ok: false, reason: 'Choose a structure. Nothing was changed.' }
  if (!isDraftStop(input.draft)) return { ok: false, reason: 'Choose how finished. Nothing was changed.' }
  if (!isPitch(input.pitch)) return { ok: false, reason: 'Choose a pitch. Nothing was changed.' }
  v.length = input.length
  v.structure = input.structure
  v.draft = input.draft
  v.pitch = input.pitch
  v.useMyMail = input.useMyMail === true || input.useMyMail === 'on' || input.useMyMail === '1'

  const row = { ...v, updatedAt: new Date() }
  await db
    .insert(ghostwriterVoices)
    .values({ id: 1, ...row })
    .onConflictDoUpdate({ target: ghostwriterVoices.id, set: row })
  return { ok: true, voice: v }
}

export function wordsFor(voice: Voice): number {
  return LENGTHS.find((l) => l.key === voice.length)?.words ?? 500
}

/** "Direct storyteller 3, Bare bones 2", for small print. */
export function voiceSummary(voice: Voice): string {
  const on = INFLUENCES.filter((i) => voice[i.key] > 0).map((i) => `${i.label} ${voice[i.key]}`)
  return on.length ? on.join(', ') : 'Plain and clear'
}

/** The sliders as sentences for the prompt, strongest first. */
export function describeVoice(voice: Voice): string {
  const on = INFLUENCES.filter((i) => voice[i.key] > 0).sort((a, b) => voice[b.key] - voice[a.key])
  if (!on.length) return 'Write in a plain, clear, conversational voice. No borrowed style.'
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  return [
    'Blend these influences, weighted as shown. The strongest sets the rhythm; the lighter ones only season it.',
    ...on.map((i) => `- ${capital(STRENGTH[voice[i.key]]!)} like ${i.name} (${voice[i.key]} of 5): ${i.traits}`),
    '',
    'Borrow how they write, never what they wrote: no quotations, no references to their books or characters, no parody, and never mention them or a voice by name. The reader should not be able to name the influence, only feel it. Whatever the blend, the house rules above still win.',
  ].join('\n')
}

export function describeStructure(s: Structure): string {
  const text = STRUCTURES.find((x) => x.key === s)?.text ?? STRUCTURES[0]!.text
  return `${text}\n\nThis shape decides how the email is built. Where it allows something the ghostwriting rules above hold back, follow the shape. The house style and every rule about facts, links and placeholders still apply.`
}

export function describeDraft(d: DraftStop): string {
  const text = DRAFT_STOPS.find((x) => x.key === d)?.text ?? ''
  return `${text}\n\nThis decides how finished the draft is. Where it asks for less than the ghostwriting rules above (an outline, a shorter rough draft, more placeholders), do what it asks. The house style and every rule about facts and links still apply.`
}

export function reviseFor(d: DraftStop): Revise {
  return DRAFT_STOPS.find((x) => x.key === d)?.revise ?? 'never'
}

/** How the whole series moves, for the plan pass; null for `none`. */
export function pitchArc(p: Pitch): string | null {
  const x = PITCHES.find((y) => y.key === p)
  return x && x.arc ? `${x.arc}\n\n${BORROW}` : null
}

/** What each mail borrows, for the writing pass; null for `none`. */
export function pitchMoves(p: Pitch): string | null {
  const x = PITCHES.find((y) => y.key === p)
  return x && x.arc ? [x.arc, 'In each mail:', x.moves, BORROW].join('\n\n') : null
}
