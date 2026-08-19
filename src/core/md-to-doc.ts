import { marked } from 'marked'
import type { DocNode } from '../db/schema.ts'

/**
 * Markdown → TipTap document JSON.
 *
 * Needed because the editor only reads `body_json`. Without this, opening a
 * markdown-authored broadcast would show an empty editor and saving it would
 * silently destroy the original text. Conversion happens on load, so nothing is
 * migrated until someone actually edits and saves.
 *
 * Also converts `{{first_name}}` into real mergeTag nodes, so old content gains
 * the same misspelling-proof personalization as new content.
 */
export function mdToDoc(md: string): DocNode | null {
  const trimmed = md.trim()
  if (!trimmed) return null

  // marked's Token is a discriminated union without an index signature; this
  // walker reads fields generically, so it works against a loose shape.
  const tokens = marked.lexer(trimmed) as unknown as Token[]
  const content = tokens.flatMap((t) => block(t))

  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

type Token = { type: string; [k: string]: unknown }

function block(token: Token): DocNode[] {
  switch (token.type) {
    case 'heading':
      return [
        {
          type: 'heading',
          attrs: { level: Math.min(Number(token.depth ?? 2), 6) },
          content: inline(token.tokens as Token[] | undefined, String(token.text ?? '')),
        },
      ]

    case 'paragraph':
      return [
        { type: 'paragraph', content: inline(token.tokens as Token[] | undefined, String(token.text ?? '')) },
      ]

    case 'text':
      return [
        { type: 'paragraph', content: inline(token.tokens as Token[] | undefined, String(token.text ?? '')) },
      ]

    case 'code':
      return [
        {
          type: 'codeBlock',
          attrs: { language: token.lang ? String(token.lang) : null },
          content: [{ type: 'text', text: String(token.text ?? '') }],
        },
      ]

    case 'blockquote':
      return [
        { type: 'blockquote', content: (token.tokens as Token[] | undefined)?.flatMap(block) ?? [] },
      ]

    case 'hr':
      return [{ type: 'horizontalRule' }]

    case 'list': {
      const items = (token.items as Token[] | undefined) ?? []
      return [
        {
          type: token.ordered ? 'orderedList' : 'bulletList',
          ...(token.ordered && Number(token.start) > 1 ? { attrs: { start: Number(token.start) } } : {}),
          content: items.map((item) => ({
            type: 'listItem',
            content: ((item.tokens as Token[] | undefined) ?? []).flatMap(block),
          })),
        },
      ]
    }

    case 'space':
      return []

    default: {
      // Unknown block (html, table, def) — keep the raw text rather than drop it.
      const raw = String(token.raw ?? token.text ?? '').trim()
      return raw ? [{ type: 'paragraph', content: [{ type: 'text', text: raw }] }] : []
    }
  }
}

const MERGE_RE = /\{\{\s*(first_name|name|email)\s*\}\}/g

function inline(tokens: Token[] | undefined, fallback: string): DocNode[] {
  if (!tokens || tokens.length === 0) return withMergeTags(fallback, [])
  return tokens.flatMap((t) => inlineToken(t, []))
}

function inlineToken(token: Token, marks: { type: string; attrs?: Record<string, unknown> }[]): DocNode[] {
  switch (token.type) {
    case 'text':
    case 'escape':
      return withMergeTags(String(token.text ?? ''), marks)

    case 'strong':
      return ((token.tokens as Token[]) ?? []).flatMap((t) =>
        inlineToken(t, [...marks, { type: 'bold' }]),
      )

    case 'em':
      return ((token.tokens as Token[]) ?? []).flatMap((t) =>
        inlineToken(t, [...marks, { type: 'italic' }]),
      )

    case 'del':
      return ((token.tokens as Token[]) ?? []).flatMap((t) =>
        inlineToken(t, [...marks, { type: 'strike' }]),
      )

    case 'codespan':
      return [{ type: 'text', text: String(token.text ?? ''), marks: [...marks, { type: 'code' }] }]

    case 'link': {
      const linkMarks = [...marks, { type: 'link', attrs: { href: String(token.href ?? '') } }]
      const inner = (token.tokens as Token[]) ?? []
      return inner.length
        ? inner.flatMap((t) => inlineToken(t, linkMarks))
        : [{ type: 'text', text: String(token.text ?? token.href ?? ''), marks: linkMarks }]
    }

    case 'br':
      return [{ type: 'hardBreak' }]

    case 'image':
      return [{ type: 'text', text: String(token.text ?? '[image]'), marks }]

    default:
      return withMergeTags(String(token.text ?? token.raw ?? ''), marks)
  }
}

/** Split a text run on `{{field}}` and emit mergeTag nodes for each match. */
function withMergeTags(
  text: string,
  marks: { type: string; attrs?: Record<string, unknown> }[],
): DocNode[] {
  if (!text) return []
  const out: DocNode[] = []
  let last = 0

  for (const m of text.matchAll(MERGE_RE)) {
    const start = m.index ?? 0
    if (start > last) out.push(textNode(text.slice(last, start), marks))
    out.push({ type: 'mergeTag', attrs: { field: m[1] } })
    last = start + m[0].length
  }
  if (last < text.length) out.push(textNode(text.slice(last), marks))

  return out.filter((n) => n.type !== 'text' || (n.text && n.text.length > 0))
}

function textNode(text: string, marks: { type: string; attrs?: Record<string, unknown> }[]): DocNode {
  return marks.length ? { type: 'text', text, marks } : { type: 'text', text }
}
