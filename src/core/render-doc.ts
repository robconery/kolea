import type { DocNode } from '../db/schema.ts'
import { escapeHtml } from './render.ts'

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

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`
const INK = '#22262b'
const MUTED = '#6b7280'
const LINE = '#e6e3de'
const ACCENT = '#1f6f5c'

const P = `margin:0 0 16px;font:16px/1.65 ${FONT};color:${INK}`

const HEADING: Record<number, string> = {
  1: `margin:28px 0 12px;font:600 26px/1.25 ${FONT};color:${INK};letter-spacing:-.02em`,
  2: `margin:26px 0 10px;font:600 21px/1.3 ${FONT};color:${INK};letter-spacing:-.01em`,
  3: `margin:22px 0 8px;font:600 17px/1.35 ${FONT};color:${INK}`,
  4: `margin:20px 0 8px;font:600 15px/1.4 ${FONT};color:${INK}`,
  5: `margin:18px 0 6px;font:600 14px/1.4 ${FONT};color:${MUTED}`,
  6: `margin:18px 0 6px;font:600 13px/1.4 ${FONT};color:${MUTED}`,
}

export interface DocRenderOptions {
  /** Rewrites hrefs for click tracking. Identity when tracking is off. */
  trackLink: (url: string) => string
  /** Resolves merge tags like {{first_name}} at render time. */
  mergeValue: (field: string) => string
}

export function renderDocToEmailHtml(doc: DocNode, opts: DocRenderOptions): string {
  return children(doc, opts)
}

function children(node: DocNode, o: DocRenderOptions): string {
  return (node.content ?? []).map((c) => renderNode(c, o)).join('')
}

function renderNode(node: DocNode, o: DocRenderOptions): string {
  switch (node.type) {
    case 'text':
      return applyMarks(node, o)

    case 'hardBreak':
      return '<br />'

    case 'paragraph': {
      const inner = children(node, o)
      if (!inner.trim()) return `<p style="${P};height:8px">&nbsp;</p>`
      return `<p style="${P}${align(node)}">${inner}</p>`
    }

    case 'heading': {
      const level = clampLevel(node.attrs?.level)
      return `<h${level} style="${HEADING[level]}${align(node)}">${children(node, o)}</h${level}>`
    }

    case 'bulletList':
      return `<ul style="margin:0 0 16px;padding-left:24px;font:16px/1.65 ${FONT};color:${INK}">${children(node, o)}</ul>`

    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      const startAttr = start > 1 ? ` start="${start}"` : ''
      return `<ol${startAttr} style="margin:0 0 16px;padding-left:24px;font:16px/1.65 ${FONT};color:${INK}">${children(node, o)}</ol>`
    }

    case 'listItem':
      return `<li style="margin:0 0 6px">${stripOuterParagraph(children(node, o))}</li>`

    // Checkboxes can't be interactive in mail, so they render as glyphs.
    case 'taskList':
      return `<ul style="margin:0 0 16px;padding:0;list-style:none;font:16px/1.65 ${FONT};color:${INK}">${children(node, o)}</ul>`

    case 'taskItem': {
      const done = node.attrs?.checked === true
      const box = done ? '&#9745;' : '&#9744;'
      const style = done ? `color:${MUTED};text-decoration:line-through` : ''
      return `<li style="margin:0 0 6px"><span style="display:inline-block;width:20px">${box}</span><span style="${style}">${stripOuterParagraph(children(node, o))}</span></li>`
    }

    case 'blockquote':
      return `<blockquote style="margin:0 0 16px;padding:2px 0 2px 18px;border-left:3px solid ${LINE};color:${MUTED};font:italic 16px/1.65 ${FONT}">${children(node, o)}</blockquote>`

    case 'codeBlock':
      // Syntax highlighting is intentionally dropped: the <span> soup that
      // lowlight produces is fragile across clients, and a mono block reads fine.
      return `<pre style="margin:0 0 16px;padding:14px 16px;background:#f6f5f3;border:1px solid ${LINE};border-radius:8px;overflow-x:auto"><code style="font:13px/1.6 ${MONO};color:${INK};white-space:pre">${escapeHtml(textOf(node))}</code></pre>`

    case 'horizontalRule':
      return `<hr style="border:0;border-top:1px solid ${LINE};margin:28px 0" />`

    case 'image': {
      const src = String(node.attrs?.src ?? '')
      if (!src) return ''
      const alt = escapeHtml(String(node.attrs?.alt ?? ''))
      const title = node.attrs?.title ? ` title="${escapeHtml(String(node.attrs.title))}"` : ''
      const img = `<img src="${escapeHtml(src)}" alt="${alt}"${title} style="max-width:100%;height:auto;display:block;border:0;border-radius:8px" />`
      const href = node.attrs?.href ? String(node.attrs.href) : ''
      const wrapped = href ? `<a href="${escapeHtml(o.trackLink(href))}">${img}</a>` : img
      return `<div style="margin:0 0 18px">${wrapped}</div>`
    }

    // Email-specific node. A nested table because Outlook won't honour padding
    // on an <a>, which is how you get a button that isn't just underlined text.
    case 'emailButton': {
      // The label is inline content (typed in the editor), not an attribute —
      // `attrs.label` is only a fallback for documents written before that change.
      const label =
        children(node, o).trim() || escapeHtml(String(node.attrs?.label ?? 'Click here'))
      const href = o.trackLink(String(node.attrs?.href ?? '#'))
      const bg = String(node.attrs?.background ?? ACCENT)
      const a = String(node.attrs?.align ?? 'left')
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 22px${a === 'center' ? ';margin-left:auto;margin-right:auto' : ''}"><tr><td align="center" bgcolor="${escapeHtml(bg)}" style="background:${escapeHtml(bg)};border-radius:8px"><a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 26px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none">${label}</a></td></tr></table>`
    }

    case 'mergeTag': {
      // Resolved at send time, per recipient.
      const field = String(node.attrs?.field ?? '')
      return escapeHtml(o.mergeValue(field))
    }

    case 'table':
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 20px;font:15px/1.55 ${FONT};color:${INK}"><tbody>${children(node, o)}</tbody></table>`

    case 'tableRow':
      return `<tr>${children(node, o)}</tr>`

    case 'tableHeader':
      return `<th style="padding:9px 12px;border:1px solid ${LINE};background:#f6f5f3;text-align:left;font-weight:600">${children(node, o)}</th>`

    case 'tableCell':
      return `<td style="padding:9px 12px;border:1px solid ${LINE};vertical-align:top">${children(node, o)}</td>`

    case 'details':
      // No client supports <details> reliably, so it flattens to a titled block.
      return `<div style="margin:0 0 18px;padding:14px 16px;border:1px solid ${LINE};border-radius:8px">${children(node, o)}</div>`

    case 'detailsSummary':
      return `<p style="margin:0 0 8px;font:600 15px/1.5 ${FONT};color:${INK}">${children(node, o)}</p>`

    case 'detailsContent':
      return children(node, o)

    case 'youtube': {
      // Mail clients strip iframes. A titled link is the honest fallback.
      const src = String(node.attrs?.src ?? '')
      if (!src) return ''
      return `<p style="${P}"><a href="${escapeHtml(o.trackLink(src))}" style="color:${ACCENT}">▶ Watch the video</a></p>`
    }

    default:
      return children(node, o)
  }
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
        out = `<code style="font:13px ${MONO};background:#f1efec;padding:2px 5px;border-radius:4px">${out}</code>`
        break
      case 'highlight': {
        const color = String(mark.attrs?.color ?? '#fdf3c4')
        out = `<mark style="background:${escapeHtml(color)};padding:1px 2px">${out}</mark>`
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
        out = `<a href="${escapeHtml(o.trackLink(raw))}" style="color:${ACCENT};text-decoration:underline">${out}</a>`
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
      append(out, o.mergeValue(String(node.attrs?.field ?? '')))
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
      out.push('—')
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
    buf.push(o.mergeValue(String(node.attrs?.field ?? '')))
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

/** List items wrap their text in a paragraph; that <p> ruins <li> spacing. */
function stripOuterParagraph(html: string): string {
  const m = /^<p style="[^"]*">([\s\S]*)<\/p>$/.exec(html.trim())
  return m ? m[1]! : html
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
