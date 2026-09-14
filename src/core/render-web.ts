import { marked } from 'marked'
import type { DocNode } from '../db/schema.ts'
import { docIsEmpty } from './render-doc.ts'
import { escapeHtml, mergeFields } from './render.ts'

/**
 * TipTap/ProseMirror JSON → HTML for the public web site.
 *
 * A sibling of `renderDocToEmailHtml`, not a mode of it. The two walk the same
 * document and agree on nothing else:
 *
 *  - Email inlines every style because Gmail strips <style>; the web uses classes
 *    and a real stylesheet, because a page can have one.
 *  - Email rewrites hrefs for click tracking against a message id. A published
 *    page has no message and no recipient, so a tracked link here would be a
 *    redirect through a row that doesn't exist. Links go out untouched.
 *  - Email resolves merge tags per recipient. Nobody is reading this *as* anyone,
 *    so tags fall back to neutral copy rather than leaking `{{first_name}}`.
 *  - Email has no <details>, <iframe> or interactive checkbox. The web has all
 *    three, so the fallbacks the mail clients force are dropped here.
 *
 * Collapsing them into one function with flags was the obvious move and the wrong
 * one: the flags multiply, and the failure mode is an unsubscribe link rendered
 * onto a public page.
 */

/** What a merge tag renders as with no recipient behind it. */
function neutral(field: string): string {
  switch (field) {
    case 'name':
    case 'first_name':
      return 'there'
    // `email`, `link` and anything else are per-person by definition. Rendering
    // a placeholder would be worse than rendering nothing.
    default:
      return ''
  }
}

export function renderDocToWebHtml(doc: DocNode): string {
  return children(doc)
}

function children(node: DocNode): string {
  return (node.content ?? []).map(renderNode).join('')
}

function renderNode(node: DocNode): string {
  switch (node.type) {
    case 'text':
      return applyMarks(node)

    case 'hardBreak':
      return '<br />'

    case 'paragraph': {
      const inner = children(node)
      if (!inner.trim()) return ''
      return `<p${cls(node)}>${inner}</p>`
    }

    case 'heading': {
      const level = clampLevel(node.attrs?.level)
      // Headings get ids so a reader can link to a section, and so the post page
      // can grow a table of contents later without re-rendering anything.
      const id = anchorId(textOf(node))
      return `<h${level} id="${escapeHtml(id)}"${cls(node)}>${children(node)}</h${level}>`
    }

    case 'bulletList':
      return `<ul>${children(node)}</ul>`

    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      return `<ol${start > 1 ? ` start="${start}"` : ''}>${children(node)}</ol>`
    }

    case 'listItem':
      return `<li>${children(node)}</li>`

    case 'taskList':
      return `<ul class="task-list">${children(node)}</ul>`

    case 'taskItem': {
      const done = node.attrs?.checked === true
      // Disabled, not omitted: the box is information about the content, and a
      // live checkbox on a published page would invite a click that saves nothing.
      return `<li class="task-item${done ? ' done' : ''}"><input type="checkbox" disabled${done ? ' checked' : ''} /><span>${children(node)}</span></li>`
    }

    case 'blockquote':
      return `<blockquote>${children(node)}</blockquote>`

    case 'codeBlock': {
      const lang = String(node.attrs?.language ?? '')
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : ''
      return `<pre><code${langClass}>${escapeHtml(textOf(node))}</code></pre>`
    }

    case 'horizontalRule':
      return '<hr />'

    case 'image': {
      const src = String(node.attrs?.src ?? '')
      if (!src) return ''
      const alt = escapeHtml(String(node.attrs?.alt ?? ''))
      const caption = String(node.attrs?.title ?? '')
      // `loading="lazy"` is free here and impossible in mail.
      const img = `<img src="${escapeHtml(src)}" alt="${alt}" loading="lazy" decoding="async" />`
      const href = node.attrs?.href ? String(node.attrs.href) : ''
      const wrapped = href ? `<a href="${escapeHtml(href)}">${img}</a>` : img
      return caption
        ? `<figure>${wrapped}<figcaption>${escapeHtml(caption)}</figcaption></figure>`
        : `<figure>${wrapped}</figure>`
    }

    // An email button is a call to action that still makes sense on the page —
    // it just stops being a nested table and becomes a link.
    case 'emailButton': {
      const label = children(node).trim() || escapeHtml(String(node.attrs?.label ?? 'Click here'))
      const href = String(node.attrs?.href ?? '#')
      const align = String(node.attrs?.align ?? 'left')
      return `<p class="cta${align === 'center' ? ' center' : ''}"><a class="btn" href="${escapeHtml(href)}">${label}</a></p>`
    }

    case 'mergeTag':
      return escapeHtml(neutral(String(node.attrs?.field ?? '')))

    case 'table':
      // The wrapper is what keeps a wide table from pushing the whole page
      // sideways on a phone.
      return `<div class="table-wrap"><table><tbody>${children(node)}</tbody></table></div>`

    case 'tableRow':
      return `<tr>${children(node)}</tr>`

    case 'tableHeader':
      return `<th>${children(node)}</th>`

    case 'tableCell':
      return `<td>${children(node)}</td>`

    case 'details':
      return `<details>${children(node)}</details>`

    case 'detailsSummary':
      return `<summary>${children(node)}</summary>`

    case 'detailsContent':
      return children(node)

    case 'youtube': {
      const src = String(node.attrs?.src ?? '')
      if (!src) return ''
      const embed = youtubeEmbedUrl(src)
      if (!embed) return `<p><a href="${escapeHtml(src)}">Watch the video</a></p>`
      return `<div class="video"><iframe src="${escapeHtml(embed)}" title="Video" loading="lazy" allowfullscreen allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"></iframe></div>`
    }

    default:
      return children(node)
  }
}

function applyMarks(node: DocNode): string {
  let out = escapeHtml(node.text ?? '')

  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        out = `<strong>${out}</strong>`
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
        out = `<code>${out}</code>`
        break
      case 'highlight': {
        const color = String(mark.attrs?.color ?? '')
        out = color ? `<mark style="background:${escapeHtml(color)}">${out}</mark>` : `<mark>${out}</mark>`
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
        // Untracked, and `noopener` because some of these are years old.
        out = `<a href="${escapeHtml(raw)}" rel="noopener">${out}</a>`
        break
      }
    }
  }

  return out
}

// ─────────────────────────────────────────────────────── body dispatch

export interface PostBody {
  json?: DocNode | null
  md: string
}

/**
 * The whole body of a post as page HTML. Same precedence rule as `renderEmail`:
 * the document wins when it has anything in it, markdown is the fallback that
 * keeps the imported Kit archive rendering.
 */
export function renderPostHtml(body: PostBody): string {
  if (body.json && !docIsEmpty(body.json)) return renderDocToWebHtml(body.json)
  // Imported markdown carries merge tags that no longer have a recipient.
  const neutralized = mergeFields(body.md, { email: '', name: null })
  return marked.parse(neutralized, { async: false }) as string
}

/**
 * The body flattened to prose — what `search_text` stores and what an excerpt is
 * cut from. Blocks are separated by spaces so two paragraphs never fuse into a
 * word that was never written ("...the end" + "Next up..." = "endNext").
 */
export function postPlainText(body: PostBody): string {
  const raw =
    body.json && !docIsEmpty(body.json) ? docText(body.json) : stripMarkdown(body.md)
  return raw.replace(/\s+/g, ' ').trim()
}

function docText(node: DocNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'mergeTag') return neutral(String(node.attrs?.field ?? ''))
  if (node.type === 'hardBreak') return ' '
  const inner = (node.content ?? []).map(docText).join('')
  return BLOCKS.has(node.type ?? '') ? `${inner} ` : inner
}

const BLOCKS = new Set([
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'tableCell',
  'tableHeader',
  'detailsSummary',
])

/** Crude on purpose — it feeds a `LIKE`, not a renderer. */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[#>\-*+\s]+/gm, ' ')
    .replace(/[*_~]/g, '')
}

/** Cut a card blurb at a word boundary. */
export function excerptFrom(text: string, max = 200): string {
  const clean = text.trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`
}

/**
 * The first image in the body, used as the card art when the operator hasn't
 * picked one. Best-effort: a post with no image just gets a text card.
 */
export function firstImageFrom(body: PostBody): string | null {
  if (body.json && !docIsEmpty(body.json)) {
    const found = findImage(body.json)
    if (found) return found
  }
  const md = /!\[[^\]]*\]\(([^)\s]+)/.exec(body.md)
  return md?.[1] ?? null
}

function findImage(node: DocNode): string | null {
  if (node.type === 'image') {
    const src = String(node.attrs?.src ?? '')
    return src || null
  }
  for (const child of node.content ?? []) {
    const found = findImage(child)
    if (found) return found
  }
  return null
}

// ─────────────────────────────────────────────────────── small helpers

function cls(node: DocNode): string {
  const a = node.attrs?.textAlign
  return a && a !== 'left' ? ` class="align-${escapeHtml(String(a))}"` : ''
}

function clampLevel(level: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = Number(level)
  // Headings inside a post sit under the <h1> that carries the title, so a
  // document's own h1 is demoted to h2 and the page keeps one top-level heading.
  const clamped = n >= 1 && n <= 6 ? n : 2
  return (clamped === 1 ? 2 : clamped) as 1 | 2 | 3 | 4 | 5 | 6
}

function textOf(node: DocNode): string {
  if (node.text) return node.text
  return (node.content ?? []).map(textOf).join('')
}

function anchorId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'section'
  )
}

/** youtu.be/ID, watch?v=ID and /embed/ID all reduce to the same embed URL. */
function youtubeEmbedUrl(src: string): string | null {
  const id =
    /(?:youtu\.be\/|\/embed\/|[?&]v=)([A-Za-z0-9_-]{6,})/.exec(src)?.[1] ?? null
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : null
}
