import type { DocNode } from '../../db/schema.ts'
import { mdToDoc } from '../md-to-doc.ts'

/**
 * A draft, as a model can safely rewrite it, and back again.
 *
 * A model reads and writes markdown well and TipTap JSON badly. But a draft is
 * more than prose: an image, a call-to-action button, a code listing, a quote
 * from somebody else, a YouTube embed. A rewrite must never lose or mangle
 * those. So only prose becomes markdown (paragraphs, headings and simple
 * lists), and every other block is swapped out for a token on its own line:
 *
 *     ⟦KEEP 2⟧
 *
 * The model is told to leave tokens exactly where they are. On the way back
 * each token is replaced with the original node, untouched. A token that has
 * gone missing is a refusal, not a guess: better to change nothing than to
 * silently drop somebody's button.
 *
 * Quotes are kept, not rewritten, for the same reason the slop reader skips
 * them: somebody else's words are not the writer's to tidy.
 */

const TOKEN = (i: number) => `⟦KEEP ${i}⟧`
const TOKEN_RE = /^⟦KEEP (\d+)⟧$/

export interface Editable {
  markdown: string
  kept: DocNode[]
}

export function docToEditable(doc: DocNode): Editable {
  const kept: DocNode[] = []
  const parts: string[] = []
  for (const node of doc.content ?? []) {
    const md = blockToMd(node)
    if (md === null) {
      parts.push(TOKEN(kept.length))
      kept.push(node)
    } else if (md.trim()) {
      parts.push(md)
    }
  }
  return { markdown: parts.join('\n\n'), kept }
}

export type Restored = { ok: true; doc: DocNode } | { ok: false; reason: string }

export function editableToDoc(markdown: string, kept: DocNode[]): Restored {
  const md = stripFence(markdown).trim()
  const parsed = mdToDoc(md)
  if (!parsed) return { ok: false, reason: 'The rewrite came back empty. Nothing was changed.' }

  const used = new Set<number>()
  const content: DocNode[] = []
  for (const node of parsed.content ?? []) {
    const m = node.type === 'paragraph' ? TOKEN_RE.exec(inlineText(node).trim()) : null
    if (!m) {
      content.push(node)
      continue
    }
    const i = Number(m[1])
    const original = kept[i]
    // An invented token, or one repeated: drop it. The original goes in once.
    if (!original || used.has(i)) continue
    used.add(i)
    content.push(original)
  }

  const lost = kept.length - used.size
  if (lost > 0) {
    return {
      ok: false,
      reason: `The rewrite dropped ${lost === 1 ? 'an image, button or quote' : `${lost} images, buttons or quotes`}. Nothing was changed.`,
    }
  }
  // A stray token the parser folded into a sentence would reach the mail.
  if (content.some((n) => /⟦KEEP \d+⟧/.test(allText(n)))) {
    return { ok: false, reason: 'The rewrite garbled the draft layout. Nothing was changed.' }
  }
  return { ok: true, doc: { type: 'doc', content } }
}

/** The draft's words, for prompts that only need to read it. Kept blocks are skipped. */
export function docToPlainText(doc: DocNode | null | undefined): string {
  if (!doc) return ''
  return (doc.content ?? [])
    .map((n) => blockToMd(n))
    .filter((s): s is string => s !== null && s.trim().length > 0)
    .join('\n\n')
}

/* ─────────────────────────────────────────────────────────────── blocks */

/** Markdown for a block that is safe to rewrite, or null for one to keep whole. */
function blockToMd(node: DocNode): string | null {
  switch (node.type) {
    case 'paragraph': {
      // A paragraph that is only an image or embed is not prose.
      if ((node.content ?? []).some((c) => c.type !== 'text' && c.type !== 'mergeTag' && c.type !== 'hardBreak')) {
        return null
      }
      // Alignment is the one paragraph attribute markdown cannot carry.
      if (node.attrs?.textAlign && node.attrs.textAlign !== 'left') return null
      // A paragraph that happens to start like markdown must not become a
      // heading or a list on the way back.
      return inlineMd(node.content).replace(/^(#{1,6}\s|>|[-+*]\s|\d+[.)]\s)/, '\\$1')
    }
    case 'heading': {
      if (node.attrs?.textAlign && node.attrs.textAlign !== 'left') return null
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 2), 1), 6)
      return `${'#'.repeat(level)} ${inlineMd(node.content)}`
    }
    case 'bulletList':
    case 'orderedList':
      return listMd(node, 0)
    default:
      return null
  }
}

function listMd(list: DocNode, depth: number): string | null {
  const ordered = list.type === 'orderedList'
  const start = Number(list.attrs?.start ?? 1) || 1
  const pad = '   '.repeat(depth)
  const lines: string[] = []
  let n = start
  for (const item of list.content ?? []) {
    if (item.type !== 'listItem') return null
    const [first, ...rest] = item.content ?? []
    if (!first || first.type !== 'paragraph') return null
    const text = blockToMd(first)
    if (text === null) return null
    lines.push(`${pad}${ordered ? `${n++}.` : '-'} ${text}`)
    for (const child of rest) {
      if (child.type !== 'bulletList' && child.type !== 'orderedList') return null
      const nested = listMd(child, depth + 1)
      if (nested === null) return null
      lines.push(nested)
    }
  }
  return lines.join('\n')
}

/* ─────────────────────────────────────────────────────────────── inline */

type Mark = NonNullable<DocNode['marks']>[number]

function inlineMd(nodes: DocNode[] | undefined): string {
  const out: string[] = []
  const list = nodes ?? []
  let i = 0
  while (i < list.length) {
    const node = list[i]!
    const href = linkOf(node)
    if (href) {
      // Consecutive runs under one link become one link, however many
      // bold or italic pieces the editor split it into.
      const run: DocNode[] = []
      while (i < list.length && linkOf(list[i]!) === href) run.push(list[i++]!)
      out.push(`[${run.map((r) => leafMd(r, true)).join('')}](${href.replace(/\)/g, '%29')})`)
      continue
    }
    out.push(leafMd(node, false))
    i++
  }
  return out.join('')
}

function linkOf(node: DocNode): string | null {
  const link = node.marks?.find((m) => m.type === 'link')
  const href = link?.attrs?.href
  return typeof href === 'string' && href ? href : null
}

function leafMd(node: DocNode, inLink: boolean): string {
  if (node.type === 'mergeTag') return `{{${String(node.attrs?.field ?? 'first_name')}}}`
  if (node.type === 'hardBreak') return '  \n'
  if (node.type !== 'text') return ''
  const raw = node.text ?? ''
  const marks = (node.marks ?? []).map((m: Mark) => m.type)
  if (marks.includes('code')) return `\`${raw.replace(/`/g, '')}\``

  // Emphasis markers must hug the words: "** bold**" is not bold in markdown.
  const lead = raw.match(/^\s*/)?.[0] ?? ''
  const trail = raw.slice(lead.length).match(/\s*$/)?.[0] ?? ''
  let core = escapeMd(raw.slice(lead.length, raw.length - trail.length), inLink)
  if (!core) return raw
  if (marks.includes('strike')) core = `~~${core}~~`
  if (marks.includes('italic')) core = `*${core}*`
  if (marks.includes('bold')) core = `**${core}**`
  return `${lead}${core}${trail}`
}

function escapeMd(s: string, inLink: boolean): string {
  const escaped = s.replace(/([\\`*_~])/g, '\\$1')
  // Outside a link a bare "[" is harmless text, and escaping it would turn every
  // `[[ placeholder ]]` into backslash soup the model might "fix".
  return inLink ? escaped.replace(/([[\]])/g, '\\$1') : escaped
}

/* ─────────────────────────────────────────────────────────────── helpers */

function inlineText(node: DocNode): string {
  return (node.content ?? []).map((c) => c.text ?? '').join('')
}

function allText(node: DocNode): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(allText).join(' ')
}

/** A model that wraps its answer in ```markdown fences, despite being asked not to. */
function stripFence(s: string): string {
  const m = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(s)
  return m ? m[1]! : s
}
