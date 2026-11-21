/**
 * Another tool's mail HTML → the Markdown `broadcasts.body_md` holds.
 *
 * Hand-written rather than turndown: turndown needs a DOM parser, and a Worker
 * has none (the old one-off Kit content import ran under Bun, where it did). This keeps the content — headings, paragraphs, links, emphasis, lists,
 * images, quotes, code — and drops the layout tables, `<style>` blocks and
 * tracking pixels every ESP wraps a mail in. Every tag that is not understood is
 * stripped, so nothing from the other tool's HTML reaches a page as markup.
 *
 * Imported bodies are archive copy: they never send from here (they land
 * `sent`), so "readable" is the bar, not "pixel-identical".
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  copy: '©',
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const attr = (tag: string, name: string) =>
  new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(2).find((v) => v !== undefined) ??
  null

/** Only links and images a mail client would follow; never `javascript:` or `data:`. */
const safeUrl = (u: string | null) => (u && /^(https?:|mailto:)/i.test(u.trim()) ? u.trim() : null)

export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return ''
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\n]+/g, ' ')

  s = s
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, inner: string) => {
      const code = inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      return `\n\n\`\`\`\n${code.trim()}\n\`\`\`\n\n`
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, inner: string) => {
      return `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`
    })
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = safeUrl(attr(tag, 'src'))
      const w = attr(tag, 'width')
      // 1×1 tracking pixels are not content.
      if (!src || w === '1' || w === '0') return ''
      return `![${(attr(tag, 'alt') ?? '').replace(/[[\]]/g, '')}](${src})`
    })
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
      const href = safeUrl(attr(`<a ${attrs}>`, 'href'))
      const label = inner.trim()
      return href && label ? `[${label}](${href})` : label
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => (inner.trim() ? `**${inner.trim()}**` : ''))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => (inner.trim() ? `*${inner.trim()}*` : ''))
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, inner: string) => `\`${inner}\``)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_m, inner: string) => {
      const body = inner.replace(/<\/?(p|div)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
      return `\n\n${body
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => `> ${l}`)
        .join('\n')}\n\n`
    })
    .replace(/<br\s*\/?>/gi, '  \n')
    .replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
    .replace(/<\/?(p|div|section|article|table|tr|ul|ol|header|footer|center|h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<\/?(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')

  // Decoded text may spell a tag (`&lt;script&gt;`). Markdown would render that
  // as markup, so `<` goes back to an entity: no tag can open in the result.
  return decode(s)
    .replace(/</g, '&lt;')
    .replace(/[​-‍﻿ ]/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+(?!-)/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
