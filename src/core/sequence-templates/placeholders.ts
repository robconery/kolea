import type { DocNode } from '../../db/schema.ts'
import { docIsEmpty } from '../render-doc.ts'

/**
 * Template scaffolding is wrapped in `[[ double brackets ]]`. This finds what is
 * left of it.
 *
 * Reads the same body the renderer would send: `body_json` when it has content,
 * `body_md` otherwise (see `render.ts`). Scanning the other one would block a
 * sequence over markdown that stopped being the mail the moment the step was
 * saved from the editor.
 */
const PLACEHOLDER = /\[\[\s*([^\]]+?)\s*\]\]/g

export function findPlaceholders(step: {
  subject: string
  bodyJson: DocNode | null
  bodyMd: string
}): string[] {
  const body =
    step.bodyJson && !docIsEmpty(step.bodyJson) ? docText(step.bodyJson) : step.bodyMd
  const found: string[] = []
  for (const source of [step.subject, body]) {
    for (const m of source.matchAll(PLACEHOLDER)) found.push(m[1]!)
  }
  return found
}

/**
 * Text per block, joined by newlines. Adjacent text nodes are concatenated
 * first because the editor splits a run wherever a mark starts, and a
 * placeholder with one bold word in it must still read as one placeholder.
 */
function docText(node: DocNode): string {
  if (node.type === 'text') return String(node.text ?? '')
  const kids = (node.content ?? []).map(docText)
  const inline = (node.content ?? []).every((k) => k.type === 'text' || k.type === 'mergeTag')
  return kids.join(inline ? '' : '\n')
}
