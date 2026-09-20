/**
 * Text primitives for the slop finder. No dependencies, no DOM, no regex state
 * shared between calls.
 *
 * The one rule every function here keeps: **offsets survive**. A finder that
 * says "there is slop in here somewhere" is a detector; one that says
 * "characters 212 to 228" is an editor. So nothing in this file may change the
 * length of a string it is handed.
 */

/**
 * Fold typographic punctuation to ASCII, character for character.
 *
 * Editors curl quotes as you type, so "here's" arrives as "here’s" and a
 * pattern written with a straight apostrophe silently never matches. Every
 * replacement is one code unit for one code unit, which is what keeps a match
 * position in the folded text valid in the original.
 */
export function fold(s: string): string {
  return s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ')
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu

export function countWords(s: string): number {
  return s.match(WORD)?.length ?? 0
}

export interface Sentence {
  start: number
  end: number
  words: number
}

/**
 * Split on terminal punctuation. Deliberately naive: "e.g." and "v2.0" will
 * split where they should not. The callers only ask about sentence *length* and
 * sentence *starts*, and a rare short fragment costs them nothing, where an
 * abbreviation table would cost this module its size and its one language.
 */
export function sentences(text: string): Sentence[] {
  const out: Sentence[] = []
  const re = /[^.!?…]+(?:[.!?…]+["')\]]*|$)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const lead = m[0].length - m[0].trimStart().length
    const body = m[0].trim()
    if (!body) continue
    const start = m.index + lead
    out.push({ start, end: start + body.length, words: countWords(body) })
  }
  return out
}
