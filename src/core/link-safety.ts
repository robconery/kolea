import type { DocNode } from '../db/schema.ts'

/**
 * ⭐ Links a reader cannot open, found before the mail goes out.
 *
 * Written after a broadcast went to a few hundred people carrying a link to
 * the operator's own dev server (`http://localhost:5555/...`). Kōlea sent the
 * link exactly as written, which is right in general and wrong for that one
 * kind of link: an address that only exists on the writer's own machine or
 * network. Dozens of readers clicked it and landed nowhere.
 *
 * Pure, so every door that can send (the confirmation screen, MCP, the REST
 * API) asks the same question and gets the same answer. Nothing here reads the
 * database or the network: it judges the URL text, which is all a send has.
 */

/** A body as it is stored: the editor's document, and the markdown beside it. */
export interface LinkBody {
  json: DocNode | null | undefined
  md?: string | null
}

export interface DevLink {
  url: string
  /** Why, in words an operator reads on the confirmation screen. */
  reason: string
}

const LOCAL = 'only opens on your own computer'
const PRIVATE = 'only opens inside a private network'
const TEST_NAME = 'uses a test name that does not exist on the internet'
const NO_DOMAIN = 'has no domain, so it only opens on your own network'

/**
 * Names reserved for testing and local networks: they never resolve on the
 * public internet (RFC 2606, RFC 6762 for `.local`, `.internal` by ICANN).
 * `example.com` is deliberately absent: it is a real, reachable site, and the
 * whole test suite uses it for addresses.
 */
const TEST_SUFFIXES = ['local', 'test', 'internal', 'example', 'localhost']

/** Schemes that are links to something other than a web page, and are fine in mail. */
const SAFE_SCHEMES = new Set(['mailto', 'tel'])

/**
 * Why a link would not open for a reader, or null when it is fine.
 *
 * Only absolute links are judged. A relative link, an `#anchor` or a merge tag
 * (`{{testimonial_link}}`) is not an address yet, and `mailto:`/`tel:` are not
 * web pages. Any other scheme (`file:`, `javascript:`, `ftp:`) is flagged: a
 * mail client either refuses it or opens something on the reader's machine.
 */
export function devLinkReason(raw: string): string | null {
  const url = raw.trim()
  if (!url || url.startsWith('#') || url.startsWith('/') || url.startsWith('{{')) return null

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  if (!scheme) return null
  if (SAFE_SCHEMES.has(scheme)) return null
  if (scheme !== 'http' && scheme !== 'https') {
    // `localhost:5555/courses` parses as the scheme `localhost`. It is a host
    // and a port with the `http://` left off, so judge it as one.
    if (/^[a-z0-9.-]+:\d+(\/|$)/i.test(url)) return hostReason(url.split(':')[0]!) ?? `is missing http://`
    return `is not a web link (${scheme}:)`
  }

  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return 'is not a valid address'
  }
  return hostReason(host)
}

/** Why a host is not reachable from a reader's inbox, or null. */
function hostReason(rawHost: string): string | null {
  // `URL` keeps the brackets on an IPv6 host, and a trailing dot is legal DNS.
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return 'is not a valid address'
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return LOCAL

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127) return LOCAL
    if (a === 10) return PRIVATE
    if (a === 172 && b >= 16 && b <= 31) return PRIVATE
    if (a === 192 && b === 168) return PRIVATE
    return null
  }
  // Any other IPv6 literal is left alone: the loopback is the one a dev
  // server is reached on, and judging the rest needs more than text.
  if (host.includes(':')) return null

  const tld = host.split('.').pop()!
  if (TEST_SUFFIXES.includes(tld)) return tld === 'localhost' ? LOCAL : TEST_NAME
  // `http://devbox:3000/` names a machine, not a site: every public address
  // has at least one dot.
  if (!host.includes('.')) return NO_DOMAIN
  return null
}

/**
 * Every link in a body, once each, in the order a reader meets them.
 *
 * The document is the truth when there is one; the markdown is read as well,
 * because a body that arrived as markdown (MCP, the API, an import) keeps its
 * links there, and a link in either is a link that can be mailed.
 */
export function linksIn(body: LinkBody): string[] {
  const seen = new Set<string>()
  const add = (href: unknown) => {
    if (typeof href !== 'string') return
    const url = href.trim()
    if (url) seen.add(url)
  }
  if (body.json) walk(body.json, (node) => {
    // Image and button blocks carry their link as a node attribute; text
    // carries it as a mark. Both are tracked and mailed the same way.
    add(node.attrs?.href)
    for (const mark of node.marks ?? []) if (mark.type === 'link') add(mark.attrs?.href)
  })
  for (const url of markdownLinks(body.md ?? '')) add(url)
  return [...seen]
}

/** The links in a body that a reader could not open. Empty when there are none. */
export function devLinks(body: LinkBody): DevLink[] {
  const found: DevLink[] = []
  for (const url of linksIn(body)) {
    const reason = devLinkReason(url)
    if (reason) found.push({ url, reason })
  }
  return found
}

/**
 * The refusal an agent or API caller reads when a send is stopped for these
 * links: each one with its reason, and the flag that says "send anyway".
 * `flag` is the caller's own spelling of it.
 */
export function devLinkRefusal(links: DevLink[], flag: string): string {
  const list = links.map((l) => `${l.url} (${l.reason})`).join('; ')
  const one = links.length === 1
  return `Not sent: ${one ? 'a link' : `${links.length} links`} in it ${one ? 'points' : 'point'} somewhere readers can't open: ${list}. Fix ${one ? 'it' : 'them'}, or pass ${flag}: true if ${one ? 'it is' : 'they are'} intended.`
}

/**
 * Links written in markdown: `[text](url)`, `[ref]: url`, `<url>`, an HTML
 * `href`, and a bare `https://…` (GFM turns those into links). Images
 * (`![alt](src)`) are pictures, not links, and are left out.
 */
function markdownLinks(md: string): string[] {
  if (!md) return []
  const out: string[] = []
  for (const m of md.matchAll(/(?<!!)\[[^\]]*\]\(\s*<?([^\s)>]+)/g)) out.push(m[1]!)
  for (const m of md.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)/gm)) out.push(m[1]!)
  for (const m of md.matchAll(/<([a-z][a-z0-9+.-]*:[^\s>]+)>/gi)) out.push(m[1]!)
  for (const m of md.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) out.push(m[1]!)
  for (const m of md.matchAll(/(?<![(<"'=\w/])https?:\/\/[^\s<>()"'\]]+/gi)) out.push(m[0].replace(/[.,;:!?]+$/, ''))
  return out
}

function walk(node: DocNode, visit: (n: DocNode) => void): void {
  visit(node)
  for (const child of node.content ?? []) walk(child, visit)
}

/**
 * The same body with every occurrence of one link swapped for another.
 *
 * Exact matches only: fixing `https://example.com/a` must not touch
 * `https://example.com/a/b`. In the markdown that means the old link has to end
 * where a link ends (a bracket, a quote, whitespace or the end of the text).
 * The document is copied, never edited in place: the caller's row is still the
 * as-mailed record until it is written back.
 */
export function replaceLink(
  body: LinkBody,
  from: string,
  to: string,
): { json: DocNode | null; md: string; replaced: number } {
  let replaced = 0
  const swap = (node: DocNode): DocNode => {
    const next: DocNode = { ...node }
    if (node.attrs && node.attrs.href === from) {
      next.attrs = { ...node.attrs, href: to }
      replaced++
    }
    if (node.marks) {
      next.marks = node.marks.map((m) => {
        if (m.type !== 'link' || m.attrs?.href !== from) return m
        replaced++
        return { ...m, attrs: { ...m.attrs, href: to } }
      })
    }
    if (node.content) next.content = node.content.map(swap)
    return next
  }
  const json = body.json ? swap(body.json) : null

  const md = body.md ?? ''
  let out = ''
  let at = 0
  for (let i = md.indexOf(from); i !== -1; i = md.indexOf(from, at)) {
    const end = i + from.length
    const next = md[end]
    if (next === undefined || /[\s)>"'\]<]/.test(next)) {
      out += md.slice(at, i) + to
      replaced++
    } else {
      out += md.slice(at, end)
    }
    at = end
  }
  out += md.slice(at)

  return { json, md: out, replaced }
}

/**
 * What is wrong with a corrected link, or null when it can be used.
 *
 * The point of a fix is to send readers somewhere that works, so the new link
 * must be a web address a reader can reach: http or https, and not itself a
 * dev address.
 */
export function fixedLinkProblem(raw: string): string | null {
  const url = raw.trim()
  if (!url) return 'Enter the corrected link.'
  if (url.length > 2000) return 'That link is too long.'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'That is not a full link. Start it with https://'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'The corrected link must start with https:// or http://'
  }
  const reason = devLinkReason(url)
  if (reason) return `The corrected link ${reason}.`
  return null
}
