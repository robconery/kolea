/**
 * slop — finds the sentences that read as machine-written, and says which ones.
 *
 * Not a detector. A detector answers "did a model write this?" with a number,
 * and a number cannot be edited. This answers "which words, and why?", so the
 * writer can do something about it: every hit is a character range, a name for
 * what it is, and a sentence on what to do instead.
 *
 * Pure TypeScript. No dependencies, no DOM, no network, no model. It runs the
 * same in a browser, a Worker, Node, Bun and Deno, and a newsletter takes a
 * couple of milliseconds — fast enough to run on every keystroke.
 *
 *   import { findSlop } from './slop'
 *   const report = findSlop("Here's the thing — it's not a bug, it's a feature.")
 *   report.score   // 0–100
 *   report.hits    // [{ rule: 'heres-the-thing', start: 0, end: 16, why: … }, …]
 *
 * It takes a string, or — when the caller knows the document's structure — a
 * list of blocks, which is what lets an editor map a hit back to the exact node
 * it came from.
 */

import {
  type BlockKind,
  type Category,
  type CustomRule,
  NOTES,
  type NoteRule,
  type PatternRule,
  RULES,
  type Rule,
  type RuleBlock,
  type RuleDoc,
  type Span,
} from './rules.ts'
import { countWords, fold, sentences } from './text.ts'

export type { BlockKind, Category, CustomRule, NoteRule, PatternRule, Rule }
export { NOTES, RULES }

/** One stretch of writing: a paragraph, a heading, a list item. */
export interface Block {
  text: string
  kind?: BlockKind
  /** Length of the bold run the block opens with. Lets the bullet rule see formatting. */
  leadBold?: number
  /** Where this block began in the original string, when it came from `fromText`. */
  offset?: number
}

export interface Hit {
  rule: string
  category: Category
  label: string
  /** The job, as an instruction: "Replace the em-dashes". */
  fix: string
  why: string
  weight: number
  /** Index into the blocks that were scanned. */
  block: number
  /** Character range within that block's text. */
  start: number
  end: number
  /** The offending words themselves. */
  text: string
}

export interface Note {
  rule: string
  category: Category
  label: string
  fix: string
  why: string
  weight: number
}

export type Band = 'clean' | 'some' | 'heavy'

export interface Report {
  /** 0–100. How much of a reader's patience this draft spends on tells. */
  score: number
  band: Band
  words: number
  /** Pointable tells, in document order. */
  hits: Hit[]
  /** Document-level tells: they count, and they point at nothing. */
  notes: Note[]
  /** Hits per category, for a one-line summary. */
  counts: Partial<Record<Category, number>>
}

export interface Options {
  /** Rule ids or whole categories to switch off. A house style is allowed its own opinions. */
  disable?: string[]
  /** Rules to run as well as the built-in ones. */
  extra?: Rule[]
}

/**
 * Scores are a density, not a count: three tells in 2,000 words is a clean
 * piece, three in sixty is not. Short drafts are measured against this floor so
 * a single em-dash in a two-line note doesn't peg the dial.
 */
const WORD_FLOOR = 120

/**
 * The density at which the score reads 50. The curve is `d / (d + HALF)`: it
 * climbs fast at first, so the first few tells in a clean piece register, and
 * it never quite reaches 100, so in a draft that is wall-to-wall slop every
 * single fix still moves the needle. A curve that pegs is a curve that tells
 * someone halfway through a rewrite that nothing they have done has counted.
 *
 * Tuned so one strong tell per ~200 words reads as "some", and an unedited
 * chatbot draft (six or more points per hundred words) lands in the 60s and up.
 */
const HALF = 4

export function findSlop(input: string | Block[], options: Options = {}): Report {
  const source = typeof input === 'string' ? fromText(input) : input
  const doc = prepare(source)
  const off = new Set(options.disable ?? [])
  const on = <T extends { id: string; category: string }>(r: T) => !off.has(r.id) && !off.has(r.category)

  const found: Hit[] = []
  for (const rule of [...RULES, ...(options.extra ?? [])].filter(on)) {
    const spans = 'find' in rule ? rule.find(doc) : matchPattern(rule, doc)
    for (const s of spans) {
      const block = doc.blocks[s.block]
      if (!block || s.end <= s.start) continue
      // Trim the span to its words, so an underline never hangs off into a space.
      const raw = block.text.slice(s.start, s.end)
      const start = s.start + (raw.length - raw.trimStart().length)
      const end = s.end - (raw.length - raw.trimEnd().length)
      // A span that was all whitespace is nothing to point at.
      if (end <= start) continue
      found.push({
        rule: rule.id,
        category: rule.category,
        label: rule.label,
        fix: rule.fix,
        why: rule.why,
        weight: rule.weight,
        block: s.block,
        start,
        end,
        text: (source[s.block]?.text ?? block.text).slice(start, end),
      })
    }
  }

  const hits = settle(found)
  const notes: Note[] = NOTES.filter(on)
    .filter((n) => n.test(doc))
    .map(({ id, category, label, fix, why, weight }) => ({ rule: id, category, label, fix, why, weight }))

  const words = doc.blocks.reduce((n, b) => n + b.words, 0)
  const points = [...hits, ...notes].reduce((n, h) => n + h.weight, 0)
  const per100 = (points / Math.max(words, WORD_FLOOR)) * 100
  const score = Math.round((100 * per100) / (per100 + HALF))

  const counts: Partial<Record<Category, number>> = {}
  for (const h of hits) counts[h.category] = (counts[h.category] ?? 0) + 1

  return { score, band: bandFor(score), words, hits, notes, counts }
}

export function bandFor(score: number): Band {
  if (score < 15) return 'clean'
  if (score < 45) return 'some'
  return 'heavy'
}

/**
 * Plain text or light markdown to blocks, one per line. Quoted lines (`>`) and
 * fenced code are dropped: somebody else's words and a code listing are not the
 * writer's prose, and scoring them would be scoring the wrong person.
 *
 * Every block keeps the `offset` of its text in the original string, so
 * `offset + hit.start` is a position in what you passed in.
 */
export function fromText(text: string): Block[] {
  const blocks: Block[] = []
  let at = 0
  let fenced = false
  for (const line of text.split('\n')) {
    const lineAt = at
    at += line.length + 1
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced || !line.trim() || /^\s*>/.test(line) || /^ {4,}\S/.test(line)) continue

    const heading = /^\s*#{1,6}\s+/.exec(line)
    const item = /^\s*(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/.exec(line)
    const marker = (heading ?? item)?.[0].length ?? 0
    const body = line.slice(marker)
    const bold = /^(\*\*|__)(.+?)\1/.exec(body)

    blocks.push({
      text: body,
      kind: heading ? 'heading' : item ? 'listItem' : 'paragraph',
      offset: lineAt + marker,
      // Markdown's asterisks are in the text, so the run includes them.
      leadBold: bold ? bold[0].length : 0,
    })
  }
  return blocks
}

/* ──────────────────────────────────────────────────────────────── internals */

function prepare(blocks: Block[]): RuleDoc {
  const prepared: RuleBlock[] = blocks.map((b) => {
    const text = fold(b.text)
    return {
      text,
      kind: b.kind ?? 'paragraph',
      leadBold: b.leadBold ?? 0,
      words: countWords(text),
      sentences: sentences(text),
    }
  })
  const prose = prepared.flatMap((b, i) => (b.kind !== 'heading' && b.words > 0 ? [i] : []))
  return { blocks: prepared, prose }
}

function matchPattern(rule: PatternRule, doc: RuleDoc): Span[] {
  const kinds = rule.kinds ?? ['paragraph', 'listItem']
  const zone =
    rule.zone === 'opening' ? doc.prose.slice(0, 2) : rule.zone === 'closing' ? doc.prose.slice(-2) : null
  // `matchAll` needs the global flag, and a shared global regex carries
  // `lastIndex` between calls — so each scan gets its own copy.
  const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`
  const re = new RegExp(rule.pattern.source, flags)

  const spans: Span[] = []
  doc.blocks.forEach((b, i) => {
    if (!kinds.includes(b.kind) || (zone && !zone.includes(i))) return
    for (const m of b.text.matchAll(re)) {
      if (m[0].length) spans.push({ block: i, start: m.index, end: m.index + m[0].length })
    }
  })
  return spans
}

/**
 * Two rules often land on the same words ("in the realm of" is both a hedge and
 * a vocabulary hit). The reader should be told once, by the rule with the most
 * to say: heavier first, then longer. Returned in document order.
 */
function settle(found: Hit[]): Hit[] {
  const ranked = [...found].sort((a, b) => b.weight - a.weight || b.end - b.start - (a.end - a.start))
  const kept: Hit[] = []
  for (const h of ranked) {
    const clash = kept.some((k) => k.block === h.block && h.start < k.end && k.start < h.end)
    if (!clash) kept.push(h)
  }
  return kept.sort((a, b) => a.block - b.block || a.start - b.start)
}
