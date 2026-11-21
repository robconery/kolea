import type { DocNode } from '../db/schema.ts'
import { MAIL_BLOCK_GAP, MAIL_COLOUR, MAIL_COLUMN, MAIL_MONO, mailType } from './mail-style.ts'
import { escapeHtml } from './text.ts'

/**
 * TipTap/ProseMirror JSON → email-safe HTML.
 *
 * Hand-written on purpose. TipTap's own `generateHTML` needs a DOM (happy-dom on
 * the server), and there is no DOM in a Worker. Writing the walker is also the
 * only way to get *email* HTML rather than web HTML: every style is inlined,
 * because Gmail strips <style> blocks, and buttons are nested tables, because
 * Outlook ignores padding on anchors.
 *
 * Anything unrecognized falls through to its children, so a new editor extension
 * degrades to its text content instead of vanishing.
 */

/** Where a paragraph sits decides its type: body, inside a quote, or in a table cell. */
type Place = 'body' | 'quote' | 'cell'

const C = MAIL_COLOUR
const GAP = MAIL_BLOCK_GAP

const PARAGRAPH: Record<Place, string> = {
  body: `margin:0 0 ${GAP};${mailType(17, 1.65)}`,
  quote: `margin:0 0 12px;${mailType(17, 1.65, { colour: 'muted' })}`,
  cell: `margin:0;${mailType(15, 1.55)}`,
}

const HEADING: Record<number, string> = {
  1: `margin:32px 0 12px;${mailType(28, 1.25, { weight: 600 })};letter-spacing:-0.02em`,
  2: `margin:30px 0 10px;${mailType(22, 1.3, { weight: 600 })};letter-spacing:-0.01em`,
  3: `margin:26px 0 8px;${mailType(18, 1.35, { weight: 600 })}`,
  4: `margin:22px 0 8px;${mailType(16, 1.4, { weight: 600 })}`,
  5: `margin:20px 0 6px;${mailType(14, 1.4, { weight: 600, colour: 'muted' })}`,
  6: `margin:20px 0 6px;${mailType(13, 1.4, { weight: 600, colour: 'muted' })}`,
}

const LIST = `margin:0 0 ${GAP};padding-left:24px;${mailType(17, 1.65)}`
const LINK = `color:${C.accent};text-decoration:underline`

export interface DocRenderOptions {
  /** Rewrites hrefs for click tracking. Identity when tracking is off. */
  trackLink: (url: string) => string
  /**
   * Resolves merge tags like {{first_name}} at render time. `fallback` is the
   * node's own `attrs.fallback`, when the writer gave one.
   */
  mergeValue: (field: string, fallback?: string) => string
}

/** A merge-tag node's written fallback, if it has a non-empty one. */
function fallbackOf(node: DocNode): string | undefined {
  const f = node.attrs?.fallback
  return typeof f === 'string' && f.trim() ? f.trim() : undefined
}

export function renderDocToEmailHtml(doc: DocNode, opts: DocRenderOptions): string {
  return children(doc, opts, 'body')
}

function children(node: DocNode, o: DocRenderOptions, place: Place): string {
  return (node.content ?? []).map((c) => renderNode(c, o, place)).join('')
}

function renderNode(node: DocNode, o: DocRenderOptions, place: Place): string {
  switch (node.type) {
    case 'text':
      return applyMarks(node, o)

    case 'hardBreak':
      return '<br>'

    case 'paragraph': {
      const inner = children(node, o, place)
      // A blank line the writer left on purpose: one gap's worth of space.
      if (!inner.trim()) return `<p style="margin:0;font-size:17px;line-height:${GAP}">&nbsp;</p>`
      return `<p style="${PARAGRAPH[place]}${align(node)}">${inner}</p>`
    }

    case 'heading': {
      const level = clampLevel(node.attrs?.level)
      return `<h${level} style="${HEADING[level]}${align(node)}">${children(node, o, place)}</h${level}>`
    }

    case 'blockquote':
      return `<blockquote style="margin:0 0 ${GAP};padding:2px 0 2px 18px;border-left:3px solid ${C.quoteRule}">${children(node, o, 'quote')}</blockquote>`

    case 'bulletList':
      return `<ul style="${LIST}">${children(node, o, place)}</ul>`

    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      const startAttr = Number.isInteger(start) && start !== 1 ? ` start="${start}"` : ''
      const kind = ['a', 'A', 'i', 'I'].includes(String(node.attrs?.type)) ? ` type="${String(node.attrs?.type)}"` : ''
      return `<ol${startAttr}${kind} style="${LIST}">${children(node, o, place)}</ol>`
    }

    case 'listItem':
      return `<li style="margin:0 0 6px">${itemContent(node, o, place)}</li>`

    // Checkboxes can't be interactive in mail, so they render as glyphs.
    case 'taskList':
      return `<ul style="padding:0;list-style:none;margin:0 0 ${GAP};${mailType(17, 1.65)}">${children(node, o, place)}</ul>`

    case 'taskItem': {
      const done = node.attrs?.checked === true
      const box = done ? '&#9745;' : '&#9744;'
      const style = done ? `color:${C.subtle};text-decoration:line-through` : ''
      return `<li style="margin:0 0 6px"><span style="display:inline-block;width:22px">${box}</span><span style="${style}">${itemContent(node, o, place)}</span></li>`
    }

    case 'codeBlock':
      // Syntax highlighting is intentionally dropped: the <span> soup that
      // lowlight produces is fragile across clients, and a mono block reads fine.
      //
      // ⭐ It wraps, and must. The mail is a table, and a table grows to fit the
      // widest thing that cannot break — so one long unwrapped line in here
      // widens the whole column and every paragraph in the mail runs off the
      // right edge with it. `overflow-x:auto` does not save it: a mail client
      // sizes the table first and never gets as far as scrolling.
      return `<pre style="margin:0 0 ${GAP};padding:14px 16px;background-color:${C.sunken};border:1px solid ${C.hairline};border-radius:8px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere"><code style="${mailType(13, 1.6, { mono: true })};white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere">${escapeHtml(textOf(node))}</code></pre>`

    case 'horizontalRule':
      return `<hr style="border:0;border-top:1px solid ${C.hairline};height:0;margin:28px 0">`

    case 'image': {
      const src = String(node.attrs?.src ?? '')
      if (!src) return ''
      const alt = escapeHtml(String(node.attrs?.alt ?? ''))
      const title = node.attrs?.title ? ` title="${escapeHtml(String(node.attrs.title))}"` : ''
      const img = (width: string): string =>
        `<img src="${escapeHtml(src)}" alt="${alt}"${title}${width} style="display:block;max-width:100%;height:auto;border:0;outline:none;border-radius:8px">`
      // Outlook on Windows ignores max-width and draws an image at its own
      // pixel width, so a big photo pushes the column off the screen. The
      // width attribute is the one size it reads: the image's own width, at
      // most the column's. When the document does not know the width, Outlook
      // alone is told the column's, so no other client stretches a small image.
      const known = node.attrs?.width
      const picture =
        typeof known === 'number' && Number.isInteger(known) && known > 0
          ? img(` width="${Math.min(known, MAIL_COLUMN)}"`)
          : `<!--[if mso]>${img(` width="${MAIL_COLUMN}"`)}<![endif]--><!--[if !mso]><!-->${img('')}<!--<![endif]-->`
      const href = node.attrs?.href ? String(node.attrs.href) : ''
      const wrapped = href
        ? `<a href="${escapeHtml(o.trackLink(href))}" style="display:block;text-decoration:none;border:0">${picture}</a>`
        : picture
      return `<div style="margin:0 0 ${GAP}">${wrapped}</div>`
    }

    // Email-specific node. A nested table because Outlook won't honour padding
    // on an <a>, which is how you get a button that isn't just underlined text.
    case 'emailButton': {
      // The label is inline content (typed in the editor), not an attribute —
      // `attrs.label` is only a fallback for documents written before that change.
      const label =
        children(node, o, place).trim() || escapeHtml(String(node.attrs?.label ?? 'Click here'))
      const href = o.trackLink(String(node.attrs?.href ?? '#'))
      const bg = escapeHtml(String(node.attrs?.background ?? C.accent))
      const a = ['left', 'center', 'right'].includes(String(node.attrs?.align)) ? String(node.attrs?.align) : 'left'
      const labelStyle = `display:inline-block;padding:13px 26px;${mailType(15, 1, { weight: 600, colour: 'paper' })};text-decoration:none`
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 ${GAP}"><tr><td align="${a}"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${bg}" style="background-color:${bg};border-radius:8px"><a href="${escapeHtml(href)}" style="${labelStyle}">${label}</a></td></tr></table></td></tr></table>`
    }

    case 'mergeTag': {
      // Resolved at send time, per recipient.
      const field = String(node.attrs?.field ?? '')
      return escapeHtml(o.mergeValue(field, fallbackOf(node)))
    }

    case 'table':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 ${GAP};${mailType(15, 1.55)}"><tbody>${children(node, o, 'cell')}</tbody></table>`

    case 'tableRow':
      return `<tr>${children(node, o, place)}</tr>`

    case 'tableHeader':
      return `<th${cellAttrs(node)} style="padding:9px 12px;border:1px solid ${C.hairline};background-color:${C.sunken};text-align:${cellAlign(node)};font-weight:600;vertical-align:top">${children(node, o, 'cell')}</th>`

    case 'tableCell':
      return `<td${cellAttrs(node)} style="padding:9px 12px;border:1px solid ${C.hairline};text-align:${cellAlign(node)};vertical-align:top">${children(node, o, 'cell')}</td>`

    case 'details':
      // No client supports <details> reliably, so it flattens to a titled block.
      return `<div style="margin:0 0 ${GAP};padding:14px 16px;border:1px solid ${C.hairline};border-radius:8px">${children(node, o, place)}</div>`

    case 'detailsSummary':
      return `<p style="margin:0 0 8px;${mailType(15, 1.5, { weight: 600 })}">${children(node, o, place)}</p>`

    case 'detailsContent':
      return `<div>${children(node, o, 'cell')}</div>`

    case 'youtube': {
      // Mail clients strip iframes. A titled link is the honest fallback.
      const src = String(node.attrs?.src ?? '')
      if (!src) return ''
      return `<p style="${PARAGRAPH[place]}"><a href="${escapeHtml(o.trackLink(src))}" style="${LINK}">&#9654;&nbsp;Watch the video</a></p>`
    }

    default:
      return children(node, o, place)
  }
}

/**
 * A list item's first paragraph sits on the bullet's line; its <p> margin
 * would push the text away from the marker. Later paragraphs keep a small gap.
 */
function itemContent(node: DocNode, o: DocRenderOptions, place: Place): string {
  return (node.content ?? [])
    .map((child, i) => {
      if (child.type !== 'paragraph') return renderNode(child, o, place)
      const inner = children(child, o, place)
      return i === 0 ? inner : `<p style="margin:8px 0 0">${inner}</p>`
    })
    .join('')
}

function cellAlign(node: DocNode): string {
  const a = String(node.attrs?.align ?? '')
  return ['left', 'center', 'right'].includes(a) ? a : 'left'
}

function cellAttrs(node: DocNode): string {
  const span = (name: string, value: unknown): string =>
    typeof value === 'number' && Number.isInteger(value) && value > 1 ? ` ${name}="${value}"` : ''
  const widths = node.attrs?.colwidth
  const width =
    Array.isArray(widths) && widths.length > 0 && widths.every((w) => typeof w === 'number' && Number.isInteger(w) && w > 0)
      ? ` width="${(widths as number[]).reduce((sum, w) => sum + w, 0)}"`
      : ''
  return `${span('colspan', node.attrs?.colspan)}${span('rowspan', node.attrs?.rowspan)}${width}`
}

function applyMarks(node: DocNode, o: DocRenderOptions): string {
  let out = escapeHtml(node.text ?? '')

  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        out = `<strong style="font-weight:600">${out}</strong>`
        break
      case 'italic':
        out = `<em>${out}</em>`
        break
      case 'strike':
        out = `<s>${out}</s>`
        break
      case 'underline':
        out = `<u>${out}</u>`
        break
      case 'code':
        out = `<code style="font-family:${MAIL_MONO};font-size:0.88em;background-color:${C.sunken};padding:2px 5px;border-radius:4px">${out}</code>`
        break
      case 'highlight': {
        const color = String(mark.attrs?.color ?? C.highlight)
        out = `<mark style="background-color:${escapeHtml(color)};color:inherit;padding:1px 2px">${out}</mark>`
        break
      }
      case 'textStyle': {
        const color = mark.attrs?.color
        if (color) out = `<span style="color:${escapeHtml(String(color))}">${out}</span>`
        break
      }
      case 'link': {
        const raw = String(mark.attrs?.href ?? '')
        if (!raw) break
        out = `<a href="${escapeHtml(o.trackLink(raw))}" style="${LINK}">${out}</a>`
        break
      }
    }
  }

  return out
}

/** Plain-text alternative, walked from the same document. */
export function renderDocToText(doc: DocNode, o: DocRenderOptions): string {
  const lines: string[] = []
  walkText(doc, o, lines)
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function walkText(node: DocNode, o: DocRenderOptions, out: string[]): void {
  switch (node.type) {
    case 'text': {
      const link = node.marks?.find((m) => m.type === 'link')
      const text = node.text ?? ''
      append(out, link?.attrs?.href ? `${text} (${String(link.attrs.href)})` : text)
      return
    }
    case 'mergeTag':
      append(out, o.mergeValue(String(node.attrs?.field ?? ''), fallbackOf(node)))
      return
    case 'hardBreak':
      out.push('')
      return
    case 'emailButton': {
      const label = inlineText(node, o) || String(node.attrs?.label ?? 'Click here')
      out.push('')
      out.push(`${label}: ${String(node.attrs?.href ?? '')}`)
      out.push('')
      return
    }
    case 'horizontalRule':
      out.push('')
      out.push('---')
      out.push('')
      return
    case 'image': {
      const alt = String(node.attrs?.alt ?? '')
      out.push(alt ? `[image: ${alt}]` : '[image]')
      return
    }
    // Flattened to one line each: the inner paragraph would otherwise push a
    // blank line and leave the bullet stranded above its own text.
    case 'listItem':
      out.push(`• ${inlineText(node, o)}`)
      return

    case 'taskItem':
      out.push(`${node.attrs?.checked === true ? '[x]' : '[ ]'} ${inlineText(node, o)}`)
      return
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'codeBlock':
      out.push('')
      for (const c of node.content ?? []) walkText(c, o, out)
      out.push('')
      return
    default:
      for (const c of node.content ?? []) walkText(c, o, out)
  }
}

function append(out: string[], s: string): void {
  if (out.length === 0) out.push(s)
  else out[out.length - 1] += s
}

/** Collapse a subtree to a single line of text — for list items and buttons. */
function inlineText(node: DocNode, o: DocRenderOptions): string {
  const buf: string[] = []
  collect(node, o, buf)
  return buf.join('').replace(/\s+/g, ' ').trim()
}

function collect(node: DocNode, o: DocRenderOptions, buf: string[]): void {
  if (node.type === 'text') {
    const link = node.marks?.find((m) => m.type === 'link')
    buf.push(link?.attrs?.href ? `${node.text ?? ''} (${String(link.attrs.href)})` : node.text ?? '')
    return
  }
  if (node.type === 'mergeTag') {
    buf.push(o.mergeValue(String(node.attrs?.field ?? ''), fallbackOf(node)))
    return
  }
  for (const c of node.content ?? []) collect(c, o, buf)
}

function textOf(node: DocNode): string {
  if (node.text) return node.text
  return (node.content ?? []).map(textOf).join('')
}

function align(node: DocNode): string {
  const a = node.attrs?.textAlign
  return a && a !== 'left' ? `;text-align:${escapeHtml(String(a))}` : ''
}

function clampLevel(level: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = Number(level)
  return (n >= 1 && n <= 6 ? n : 2) as 1 | 2 | 3 | 4 | 5 | 6
}

export function docIsEmpty(doc: DocNode | null | undefined): boolean {
  if (!doc) return true
  const t = textOf(doc).trim()
  if (t.length > 0) return false
  // A doc can be visually non-empty with no text at all (image, button, rule).
  return !hasAtomicNode(doc)
}

function hasAtomicNode(node: DocNode): boolean {
  if (node.type && ['image', 'emailButton', 'horizontalRule', 'youtube'].includes(node.type)) {
    return true
  }
  return (node.content ?? []).some(hasAtomicNode)
}
