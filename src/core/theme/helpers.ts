import { escapeHtml } from '../text.ts'
import { formatDate, timeAgo } from './date-format.ts'
import {
  type Helper,
  type HelperCall,
  SafeString,
  escapeExpression,
  isEmpty,
  prop,
  safe,
} from './interpreter.ts'
import type { GhostAuthor, GhostPost, GhostTag, Pagination, ThemeServices } from './model.ts'

/**
 * The helpers — Ghost's names and behaviour, trimmed to what a single-author,
 * free-newsletter site needs.
 *
 * Membership, tiers, comments and recommendations render nothing: Kōlea has a
 * list, not paid members, and a theme that asks for them should degrade to the
 * free-site version of itself rather than fail. `@site.members_enabled` is true
 * when there is a signup form, so a theme's "Subscribe" buttons stay, and
 * `ghost_foot` wires them to our form endpoint.
 */

function svc(call: HelperCall): ThemeServices {
  return call.render.services as ThemeServices
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const truthy = (v: unknown) => v === true || v === 'true'
const list = (v: unknown): string[] =>
  str(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

async function block(call: HelperCall, ok: boolean, context: unknown = call.context): Promise<string> {
  if (ok) return call.fn ? call.fn(context) : ''
  return call.inverse ? call.inverse(context) : ''
}

/** Iterate like Ghost's `{{#foreach}}`: `@number`, `@odd`, `@rowStart`, … */
async function iterate(call: HelperCall, items: unknown, opts: { columns?: number } = {}): Promise<string> {
  if (!call.fn) return ''
  let entries: [string | number, unknown][]
  if (Array.isArray(items)) entries = items.map((v, i) => [i, v])
  else if (items && typeof items === 'object') entries = Object.entries(items)
  else entries = []

  const from = Math.max(Number(call.hash.from ?? 1) || 1, 1) - 1
  const limit = Number(call.hash.limit) || Number.POSITIVE_INFINITY
  const to = Math.min(Number(call.hash.to) || entries.length, entries.length, from + limit)
  const slice = entries.slice(from, to)
  if (slice.length === 0) return call.inverse ? call.inverse(call.context) : ''

  const columns = opts.columns ?? (Number(call.hash.columns) || 0)
  let out = ''
  for (let i = 0; i < slice.length; i++) {
    const [key, value] = slice[i] as [string | number, unknown]
    const data = {
      ...call.data,
      index: i,
      number: i + 1,
      key,
      first: i === 0,
      last: i === slice.length - 1,
      even: i % 2 === 1,
      odd: i % 2 === 0,
      rowStart: columns ? i % columns === 0 : false,
      rowEnd: columns ? i % columns === columns - 1 || i === slice.length - 1 : false,
    }
    out += await call.fn(value, { data, blockParams: [value, key] })
  }
  return out
}

function textOf(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x?[0-9a-f]+;/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(text: string, hash: Record<string, unknown>): string {
  const words = Number(hash.words)
  const chars = Number(hash.characters)
  if (words > 0) return text.split(/\s+/).slice(0, words).join(' ')
  if (chars > 0) return text.slice(0, chars)
  return text
}

function absolute(url: string, origin: string): string {
  if (!url || /^[a-z]+:\/\//i.test(url) || url.startsWith('//')) return url
  return `${origin}${url.startsWith('/') ? '' : '/'}${url}`
}

function samePath(a: string, b: string): boolean {
  const norm = (s: string) => {
    try {
      s = new URL(s, 'http://x').pathname
    } catch {
      /* keep as-is */
    }
    return s.replace(/\/+$/, '') || '/'
  }
  return norm(a) === norm(b)
}

function linkList(items: (GhostTag | GhostAuthor)[], hash: Record<string, unknown>): SafeString {
  const from = Math.max(Number(hash.from ?? 1) || 1, 1) - 1
  const limit = Number(hash.limit) || items.length
  const to = Math.min(Number(hash.to) || items.length, from + limit)
  const autolink = hash.autolink === undefined ? true : truthy(hash.autolink)
  const separator = hash.separator === undefined ? ', ' : str(hash.separator)
  const parts = items.slice(from, to).map((t) =>
    autolink ? `<a href="${escapeHtml(t.url)}">${escapeHtml(t.name)}</a>` : escapeHtml(t.name),
  )
  if (!parts.length) return safe('')
  return safe(`${str(hash.prefix)}${parts.join(separator)}${str(hash.suffix)}`)
}

function rgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  let h = m[1] as string
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const n = Number.parseInt(h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Operator for `{{#match a "op" b}}`. */
function compare(a: unknown, op: string, b: unknown): boolean {
  const sa = str(a)
  const sb = str(b)
  switch (op) {
    case '=':
      return a === b || sa === sb
    case '!=':
      return !(a === b || sa === sb)
    case '<':
      return Number(a) < Number(b)
    case '>':
      return Number(a) > Number(b)
    case '<=':
      return Number(a) <= Number(b)
    case '>=':
      return Number(a) >= Number(b)
    case '~':
      return sa.includes(sb)
    case '~^':
      return sa.startsWith(sb)
    case '~$':
      return sa.endsWith(sb)
    default:
      return false
  }
}

// ─────────────────────────────────────────────────────────── the set

export const helpers: Record<string, Helper> = {
  // ── Handlebars' own

  if: (c) => block(c, c.hash.includeZero && c.params[0] === 0 ? true : !isEmpty(c.params[0])),
  unless: (c) => block(c, isEmpty(c.params[0])),
  with: (c) => (isEmpty(c.params[0]) ? block(c, false) : c.fn ? c.fn(c.params[0], { blockParams: [c.params[0]] }) : ''),
  each: (c) => iterate(c, c.params[0]),
  lookup: (c) => prop(c.params[0], str(c.params[1])),
  log: () => '',

  // ── Ghost: functional

  foreach: (c) => iterate(c, c.params[0]),

  is: (c) => {
    const want = list(c.params[0])
    return block(c, want.some((w) => svc(c).contexts.includes(w)))
  },

  has: (c) => {
    const ctx = c.context as Partial<GhostPost> & { name?: string }
    const checks: boolean[] = []
    const h = c.hash
    if (h.tag !== undefined) {
      const want = list(h.tag).map((s) => s.toLowerCase())
      const tags = ctx.tags ?? []
      checks.push(tags.some((t) => want.includes(t.name.toLowerCase()) || want.includes(t.slug)))
    }
    if (h.author !== undefined) {
      const want = list(h.author).map((s) => s.toLowerCase())
      checks.push((ctx.authors ?? []).some((a) => want.includes(a.name.toLowerCase()) || want.includes(a.slug)))
    }
    if (h.slug !== undefined) checks.push(str(ctx.slug) === str(h.slug))
    if (h.id !== undefined) checks.push(str(ctx.id) === str(h.id))
    if (h.visibility !== undefined) checks.push(list(h.visibility).includes('public'))
    if (h.any !== undefined) checks.push(list(h.any).some((f) => !isEmpty(fieldPath(c.context, f))))
    if (h.all !== undefined) checks.push(list(h.all).every((f) => !isEmpty(fieldPath(c.context, f))))
    const position = h.number ?? h.index
    if (position !== undefined) {
      const n = h.number !== undefined ? Number(c.data.number) : Number(c.data.index)
      checks.push(
        list(position).some((spec) => {
          const nth = /^nth:(\d+)$/.exec(spec)
          return nth ? n % Number(nth[1]) === 0 : Number(spec) === n
        }),
      )
    }
    return block(c, checks.length > 0 && checks.some(Boolean))
  },

  match: (c) => {
    const [a, op, b] = c.params
    const ok = c.params.length === 1 ? !isEmpty(a) : c.params.length === 2 ? compare(a, '=', op) : compare(a, str(op), b)
    return c.fn ? block(c, ok) : ok
  },

  get: async (c) => {
    const resource = str(c.params[0])
    const s = svc(c)
    // Ghost interpolates `{{field}}` inside filter strings against the context.
    const filter = str(c.hash.filter).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) =>
      str(fieldPath(c.context, path)),
    )
    const limit = c.hash.limit === 'all' ? 100 : Math.min(Math.max(Number(c.hash.limit ?? 15) || 15, 1), 100)
    const { items, pagination } = await s.get(resource, {
      limit,
      filter,
      order: str(c.hash.order),
      page: Math.max(Number(c.hash.page ?? 1) || 1, 1),
    })
    if (!items.length) return block(c, false)
    const result = { [resource]: items, pagination, meta: { pagination } }
    return c.fn ? c.fn(result, { blockParams: [items, pagination] }) : ''
  },

  prev_post: (c) => adjacent(c, 'prev'),
  next_post: (c) => adjacent(c, 'next'),

  // ── Ghost: data

  title: (c) => safe(escapeExpression(prop(c.context, 'title') ?? prop(c.context, 'name'))),

  content: (c) => {
    const html = str(prop(c.context, 'html'))
    if (c.hash.words) return safe(escapeHtml(truncate(textOf(html), { words: c.hash.words })))
    return safe(html)
  },

  excerpt: (c) => {
    const ctx = c.context as Partial<GhostPost>
    const text = ctx.custom_excerpt || ctx.excerpt || textOf(str(ctx.html))
    return safe(escapeHtml(truncate(str(text), c.hash)))
  },

  // URL helpers return pre-escaped strings, as Ghost's do: plain Handlebars
  // escaping would turn every `?v=` into `?v&#x3D;`.
  url: (c) => {
    const url = str(prop(c.context, 'url'))
    return safe(escapeHtml(truthy(c.hash.absolute) ? absolute(url, svc(c).origin) : url))
  },

  date: (c) => {
    const raw = c.params[0] ?? prop(c.context, 'published_at')
    if (!raw) return ''
    const d = raw instanceof Date ? raw : new Date(str(raw))
    if (Number.isNaN(d.getTime())) return ''
    if (truthy(c.hash.timeago)) return timeAgo(d)
    return formatDate(d, c.hash.format ? str(c.hash.format) : 'll')
  },

  img_url: (c) => {
    // No resizing yet: every size is the original. `srcset` still works, just
    // with one real candidate. Image Resizing on the zone is the upgrade path.
    const url = str(c.params[0])
    if (!url) return ''
    return safe(escapeHtml(truthy(c.hash.absolute) ? absolute(url, svc(c).origin) : url))
  },

  reading_time: (c) => {
    const minutes = Number(prop(c.context, 'reading_time')) || 1
    const one = c.hash.minute ? str(c.hash.minute) : '1 min read'
    const many = c.hash.minutes ? str(c.hash.minutes) : '% min read'
    return minutes <= 1 ? one : many.replace('%', String(minutes))
  },

  tags: (c) => linkList((prop(c.context, 'tags') as GhostTag[] | undefined) ?? [], c.hash),
  authors: (c) => linkList((prop(c.context, 'authors') as GhostAuthor[] | undefined) ?? [], c.hash),

  plural: (c) => {
    const n = Number(c.params[0]) || 0
    const pick = n === 0 ? c.hash.empty : n === 1 ? c.hash.singular : c.hash.plural
    return str(pick).replace('%', String(n))
  },

  navigation: async (c) => {
    const s = svc(c)
    const secondary = c.hash.type === 'secondary'
    const items = ((c.data.site as Record<string, unknown> | undefined)?.[
      secondary ? 'secondary_navigation' : 'navigation'
    ] ?? []) as { label: string; url: string }[]
    const navigation = items.map((item) => ({
      ...item,
      slug: item.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
      current: samePath(item.url, s.path),
    }))
    if (!navigation.length) return safe('')
    if (s.hasPartial('navigation')) {
      const partial = c.render.opts.partial('navigation')
      if (partial) {
        return safe(await c.render.renderRoot(partial, { navigation, isSecondary: secondary }))
      }
    }
    const lis = navigation
      .map(
        (i) =>
          `<li class="nav-${escapeHtml(i.slug)}${i.current ? ' nav-current' : ''}"><a href="${escapeHtml(i.url)}">${escapeHtml(i.label)}</a></li>`,
      )
      .join('')
    return safe(`<ul class="nav">${lis}</ul>`)
  },

  pagination: async (c) => {
    const s = svc(c)
    const root = c.data.root as { pagination?: Pagination } | undefined
    const p = (prop(c.context, 'pagination') as Pagination | undefined) ?? root?.pagination
    if (!p) return ''
    if (s.hasPartial('pagination')) {
      const partial = c.render.opts.partial('pagination')
      if (partial) return safe(await c.render.renderRoot(partial, p))
    }
    const newer = p.prev ? `<a class="newer-posts" href="${escapeHtml(s.pageUrl(p.prev))}">&larr; Newer Posts</a>` : ''
    const older = p.next ? `<a class="older-posts" href="${escapeHtml(s.pageUrl(p.next))}">Older Posts &rarr;</a>` : ''
    return safe(
      `<nav class="pagination" role="navigation">${newer}<span class="page-number">Page ${p.page} of ${p.pages}</span>${older}</nav>`,
    )
  },

  page_url: (c) => {
    const n = Number(c.params[0]) || 1
    return safe(escapeHtml(svc(c).pageUrl(n)))
  },

  // ── Ghost: utility

  asset: (c) => safe(escapeHtml(svc(c).assetUrl(str(c.params[0])))),

  body_class: (c) => {
    const s = svc(c)
    const root = c.data.root as { post?: GhostPost; tag?: GhostTag; author?: GhostAuthor } | undefined
    const classes: string[] = []
    const ctx = s.contexts
    if (ctx.includes('home')) classes.push('home-template')
    if (ctx.includes('post')) classes.push('post-template')
    if (ctx.includes('page')) classes.push('page-template')
    if (ctx.includes('tag')) classes.push('tag-template')
    if (ctx.includes('author')) classes.push('author-template')
    if (ctx.includes('error')) classes.push('error-template')
    if (ctx.includes('paged')) classes.push('paged')
    if (root?.post) for (const t of root.post.tags) classes.push(`tag-${t.slug}`)
    if (root?.tag) classes.push(`tag-${root.tag.slug}`)
    if (root?.author) classes.push(`author-${root.author.slug}`)
    return classes.join(' ')
  },

  post_class: (c) => {
    const ctx = c.context as Partial<GhostPost>
    const classes = ['post']
    if (ctx.featured) classes.push('featured')
    if (!ctx.feature_image) classes.push('no-image')
    for (const t of ctx.tags ?? []) classes.push(`tag-${t.slug}`)
    return classes.join(' ')
  },

  ghost_head: (c) => safe(ghostHead(svc(c), c.data)),
  ghost_foot: (c) => safe(ghostFoot(svc(c))),

  meta_title: (c) => svc(c).meta.title,
  meta_description: (c) => svc(c).meta.description ?? '',

  link_class: (c) => {
    const s = svc(c)
    const base = str(c.hash.class)
    const active = c.hash.activeClass === undefined ? 'nav-current' : str(c.hash.activeClass)
    const current = samePath(str(c.hash.for), s.path)
    return [base, current ? active : ''].filter(Boolean).join(' ')
  },

  link: async (c) => {
    const s = svc(c)
    const href = str(c.hash.href)
    const active = c.hash.activeClass === undefined ? 'nav-current' : str(c.hash.activeClass)
    const cls = [str(c.hash.class), samePath(href, s.path) ? active : ''].filter(Boolean).join(' ')
    const inner = c.fn ? await c.fn(c.context) : ''
    const target = c.hash.target ? ` target="${escapeHtml(str(c.hash.target))}"` : ''
    return safe(`<a href="${escapeHtml(href)}"${cls ? ` class="${escapeHtml(cls)}"` : ''}${target}>${inner}</a>`)
  },

  concat: (c) => {
    const sep = c.hash.separator === undefined ? '' : str(c.hash.separator)
    return c.params.map((p) => (p instanceof SafeString ? p.html : str(p))).join(sep)
  },

  encode: (c) => encodeURIComponent(str(c.params[0])),

  split: (c) => {
    const sep = c.hash.separator === undefined ? ',' : str(c.hash.separator)
    return str(c.params[0])
      .split(sep)
      .map((s) => s.trim())
      .filter(Boolean)
  },

  t: (c) => {
    let text = svc(c).translate(str(c.params[0]))
    for (const [k, v] of Object.entries(c.hash)) text = text.replaceAll(`{${k}}`, str(v))
    return text
  },

  contentFor: async (c) => {
    const name = str(c.params[0])
    const html = c.fn ? await c.fn(c.context) : ''
    const bucket = c.render.blocks.get(name) ?? []
    bucket.push(html)
    c.render.blocks.set(name, bucket)
    return ''
  },

  block: (c) => safe((c.render.blocks.get(str(c.params[0])) ?? []).join('')),

  readable_url: (c) => str(c.params[0]).replace(/^https?:\/\//, '').replace(/\/$/, ''),

  color_to_rgba: (c) => rgba(str(c.params[0]), Number(c.hash.alpha ?? 1)),

  contrast_text_color: (c) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(str(c.params[0]))
    if (!m) return '#FFFFFF'
    const n = Number.parseInt(m[1] as string, 16)
    const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
    return luminance > 0.6 ? '#000000' : '#FFFFFF'
  },

  search: () =>
    safe(
      '<button class="gh-search-icon" aria-label="search" data-ghost-search style="display:inline-flex;justify-content:center;align-items:center;width:32px;height:32px;padding:0;border:0;color:inherit;background-color:transparent;cursor:pointer;outline:none;"><svg width="20" height="20" fill="none" viewBox="0 0 24 24"><path d="M14.949 14.949a1 1 0 0 1 1.414 0l6.344 6.344a1 1 0 0 1-1.414 1.414l-6.344-6.344a1 1 0 0 1 0-1.414Z" fill="currentColor"/><path d="M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm-9 7a9 9 0 1 1 18 0 9 9 0 0 1-18 0Z" fill="currentColor"/></svg></button>',
    ),

  lang: () => 'en',

  // ── Ghost features Kōlea doesn't have. Present so themes that call them
  //    render the free-site version of themselves instead of an empty page.
  comments: () => '',
  comment_count: () => '',
  recommendations: () => '',
  total_members: () => '',
  total_paid_members: () => '',
  price: () => '',
  tiers: () => '',
  cancel_link: () => '',
  social_url: () => '',
  social_accounts: () => '',
  twitter_url: () => '',
  facebook_url: () => '',
}

function fieldPath(obj: unknown, path: string): unknown {
  let v = obj
  for (const part of path.split('.')) v = prop(v, part)
  return v
}

async function adjacent(c: HelperCall, direction: 'prev' | 'next'): Promise<string> {
  const post = c.context as GhostPost
  if (!post || typeof post !== 'object' || !('broadcast_id' in post)) return block(c, false)
  const other = await svc(c).adjacent(post, direction, str(c.hash.in) === 'primary_tag')
  return other ? (c.fn ? c.fn(other, { blockParams: [other] }) : '') : block(c, false)
}

// ─────────────────────────────────────────────────────────── head & foot

function ghostHead(s: ThemeServices, data: Record<string, unknown>): string {
  const m = s.meta
  const site = (data.site ?? {}) as { title?: string; accent_color?: string; icon?: string }
  const e = escapeHtml
  const lines = [
    m.description ? `<meta name="description" content="${e(m.description)}">` : '',
    `<link rel="canonical" href="${e(m.canonical)}">`,
    m.noindex ? '<meta name="robots" content="noindex,follow">' : '',
    '<meta name="referrer" content="no-referrer-when-downgrade">',
    `<meta property="og:site_name" content="${e(site.title ?? '')}">`,
    `<meta property="og:type" content="${m.type}">`,
    `<meta property="og:title" content="${e(m.title)}">`,
    m.description ? `<meta property="og:description" content="${e(m.description)}">` : '',
    `<meta property="og:url" content="${e(m.canonical)}">`,
    m.image ? `<meta property="og:image" content="${e(m.image)}">` : '',
    m.publishedAt ? `<meta property="article:published_time" content="${e(m.publishedAt)}">` : '',
    `<meta name="twitter:card" content="${m.image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${e(m.title)}">`,
    m.description ? `<meta name="twitter:description" content="${e(m.description)}">` : '',
    m.image ? `<meta name="twitter:image" content="${e(m.image)}">` : '',
    '<meta name="generator" content="Kōlea">',
    `<link rel="alternate" type="application/rss+xml" title="${e(site.title ?? '')}" href="${e(s.origin)}/feed.xml">`,
    // Ghost injects the accent colour as a custom property; themes read it.
    `<style>:root{--ghost-accent-color:${e(site.accent_color ?? '#3b82f6')}}</style>`,
    // There is no sign-in on a Kōlea site — a reader manages mail from the
    // preference-centre link in any email. Themes still render the button.
    '<style>[data-portal="signin"],[data-portal="account"],a[href="#/portal/signin"],a[href="#/portal/account"]{display:none!important}</style>',
  ]
  return lines.filter(Boolean).join('\n    ')
}

/**
 * Ghost themes subscribe people with `<form data-members-form>` and open
 * "Portal" with `data-portal` links. Neither exists here, so this rewires both
 * onto Kōlea: the form posts to the ordinary signup endpoint (same consent path
 * as every other signup), and portal links go to `/subscribe`. Search buttons
 * go to `/search`. Plain script, no dependencies, and nothing at all when the
 * site has no signup form.
 */
function ghostFoot(s: ThemeServices): string {
  const action = JSON.stringify(s.signupAction ?? '')
  return `<script>
(function(){
  var action=${action};
  function closest(el,sel){while(el&&el.nodeType===1){if(el.matches(sel))return el;el=el.parentElement}return null}
  document.addEventListener('submit',function(e){
    var f=closest(e.target,'form[data-members-form]');if(!f)return;e.preventDefault();
    if(!action)return;
    var email=f.querySelector('[data-members-email]')||f.querySelector('input[type=email]');
    if(!email||!email.value)return;
    var name=f.querySelector('[data-members-name]');
    var real=document.createElement('form');real.method='post';real.action=action;
    function add(k,v){var i=document.createElement('input');i.type='hidden';i.name=k;i.value=v;real.appendChild(i)}
    add('email',email.value);if(name&&name.value)add('name',name.value);
    document.body.appendChild(real);real.submit();
  });
  document.addEventListener('click',function(e){
    if(closest(e.target,'[data-ghost-search]')){e.preventDefault();location.href='/search';return}
    var p=closest(e.target,'[data-portal],a[href^="#/portal"]');
    if(p){e.preventDefault();location.href='/subscribe'}
  });
  if(location.hash.indexOf('#/portal')===0)location.replace('/subscribe');
})();
</script>`
}
