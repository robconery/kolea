import type { Db } from '../../db/index.ts'
import type { DocNode } from '../../db/schema.ts'
import type { Env } from '../../types.ts'
import { type Report, findSlop } from '../../slop/index.ts'
import { docToEditable, editableToDoc } from './doc-markdown.ts'
import { complete, modelFor } from './openrouter.ts'
import { WRITING_GUIDE } from './style.ts'

/**
 * "Clean this up": rewrite the prose in a draft so it stops reading like slop.
 *
 * The slop reader already knows which sentences are the problem and why. This
 * hands those findings to a model along with the house style, asks for an
 * edit (not a new piece), and gives the result back to the composer to drop
 * into the editor as one undoable change.
 *
 * What makes it safe to press:
 *
 * - Only prose is rewritten. Images, buttons, quotes, code and embeds go
 *   through as sealed tokens and come back as the original nodes (see
 *   `doc-markdown.ts`). If one goes missing, nothing changes.
 * - Nothing is saved here. The composer applies the result to the editor, the
 *   writer sees it, and ⌘Z puts their words back.
 * - It is scored on the way out, with the same reader, so the writer sees
 *   whether it actually helped.
 */

export type CleanupResult =
  | {
      ok: true
      doc: DocNode
      before: number
      after: number
      model: string
      costUsd: number
    }
  | { ok: false; reason: string }

/** Past this, one call is slow and expensive, and a rewrite that long needs a human. */
const MAX_WORDS = 5000

const RULES = `
# Your task: edit this draft

You are editing someone else's email, not writing your own. They wrote it (or pasted in a draft they mean to make theirs) and they want it to read like a person wrote it.

- Keep their meaning, every fact, every claim and every link. Keep their paragraphs in the order they wrote them: do not move a paragraph, even to put a better one first. The structure is theirs. Keep their voice: their humour, slang, swearing, spelling (UK or US), and the way they address the reader. If a line is clearly a deliberate joke or aside in their voice, leave it alone.
- Fix the problems listed for this draft, and anything else in it that breaks the guide above.
- Where a run of one-line paragraphs is really one thought, join them into a paragraph that flows. Where a paragraph covers two things, split it.
- Do not add anything: no new facts, examples, numbers, stories, jokes, headings, calls to action or conclusion. Do not make it longer. Shorter is usually better.
- Do not swap one stock phrase for another. If a phrase adds nothing, delete it rather than rephrasing it.

# Things you must copy exactly

- Lines like ⟦KEEP 3⟧ stand for an image, button, quote or code block. Keep every one, on its own line, in the same place relative to the text around it.
- Merge tags like {{first_name}} stay exactly as written.
- Anything in double square brackets, like [[ link to the course ]], is a placeholder the writer will fill in. Keep it exactly.
- Link URLs stay exactly as they are. You may reword the link text.
- Keep the markdown: headings stay headings (you may reword them), lists stay lists, bold stays on the words that matter.

# Output

Return only the edited draft in markdown. No preamble, no notes, no explanation, no code fences.
`.trim()

export async function cleanUp(env: Env, db: Db, input: { doc: DocNode | null }): Promise<CleanupResult> {
  if (!input.doc) return { ok: false, reason: 'There is nothing to clean up yet.' }

  const { markdown, kept } = docToEditable(input.doc)
  const words = prose(markdown).split(/\s+/).filter(Boolean).length
  if (words < 10) return { ok: false, reason: 'There is nothing to clean up yet.' }
  if (words > MAX_WORDS) {
    return { ok: false, reason: `That is ${words.toLocaleString()} words. Clean it up a section at a time, under ${MAX_WORDS.toLocaleString()}.` }
  }

  const before = findSlop(prose(markdown))
  const user = [
    problems(before),
    '',
    'The draft:',
    '<draft>',
    markdown,
    '</draft>',
  ].join('\n')

  const result = await complete(env, db, {
    label: 'cleanup',
    model: modelFor(env, 'cleanup'),
    messages: [
      { role: 'system', content: `${WRITING_GUIDE}\n\n${RULES}` },
      { role: 'user', content: user },
    ],
    // Room for the draft at the same length and some slack; a rewrite should
    // come back shorter, and a cut-off one is refused rather than applied.
    maxTokens: Math.min(16_000, Math.ceil(markdown.length / 3) + 1500),
    timeoutMs: 120_000,
  })
  if (!result.ok) return result

  const rewritten = dashless(result.text.replace(/^\s*<draft>\s*|\s*<\/draft>\s*$/g, ''))
  const restored = editableToDoc(rewritten, kept)
  if (!restored.ok) return restored

  const after = findSlop(prose(rewritten))
  return {
    ok: true,
    doc: restored.doc,
    before: before.score,
    after: after.score,
    model: result.model,
    costUsd: result.costUsd,
  }
}

/** The draft's own tells, worst first, so the model is told what to stop doing. */
function problems(report: Report): string {
  if (report.hits.length === 0 && report.notes.length === 0) {
    return 'The slop checker found nothing specific in this draft. Tighten it against the guide anyway, and change as little as you need to.'
  }
  const byRule = new Map<string, { fix: string; why: string; weight: number; examples: Set<string> }>()
  for (const h of report.hits) {
    const r = byRule.get(h.rule) ?? { fix: h.fix, why: h.why, weight: 0, examples: new Set<string>() }
    r.weight += h.weight
    r.examples.add(h.text)
    byRule.set(h.rule, r)
  }
  for (const n of report.notes) {
    byRule.set(n.rule, { fix: n.fix, why: n.why, weight: n.weight, examples: new Set() })
  }
  const lines = [...byRule.values()]
    .sort((a, b) => b.weight - a.weight)
    .map((r) => {
      const ex = [...r.examples].slice(0, 4).map((e) => `"${e}"`).join(', ')
      return `- ${r.fix}. ${r.why}${ex ? ` Found: ${ex}.` : ''}`
    })
  return ['The slop checker found these problems in this draft:', ...lines].join('\n')
}

/** The markdown minus the sealed-block tokens, for scoring. */
function prose(markdown: string): string {
  return markdown.replace(/^⟦KEEP \d+⟧$/gm, '')
}

/**
 * The one rule with no exceptions, enforced after the fact. A model that slips
 * an em-dash in anyway gets a comma, which reads correctly nearly every time.
 * Leaves hyphenated words and number ranges alone.
 */
function dashless(s: string): string {
  return s.replace(/\s*—\s*/g, ', ').replace(/ – /g, ', ')
}
