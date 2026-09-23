import type { Db } from '../../db/index.ts'
import type { PostTag } from '../../db/schema.ts'
import type { Env } from '../../types.ts'
import { slugify } from '../ids.ts'
import {
  getPostTagBySlug,
  listPublicTags,
  tagsForPost,
  tagsForPosts,
  type TagWithCount,
} from '../post-tags.ts'
import {
  type Post,
  type PostQuery,
  adjacentPost,
  countPosts,
  listPosts,
  postPath,
  shareOnXUrl,
} from '../posts.ts'
import { renderPostHtml } from '../render-web.ts'
import { escapeHtml } from '../text.ts'
import { helpers } from './helpers.ts'
import { Renderer, safe } from './interpreter.ts'
import type {
  GetQuery,
  GhostAuthor,
  GhostPost,
  GhostTag,
  PageMeta,
  Pagination,
  ThemeServices,
} from './model.ts'
import type { LoadedTheme } from './store.ts'

/**
 * The public site, as views rendered through the active theme.
 *
 * This is the only place that knows both Kōlea's data and Ghost's shapes. Routes
 * in `web/site.tsx` decide *which* view; this decides what the theme sees and
 * which template renders it, in Ghost's fallback order (`tag-ai` → `tag` →
 * `index`), so a Ghost theme that ships only `index.hbs` and `post.hbs` still
 * gets every page.
 */

export interface SiteConfig {
  origin: string
  title: string
  tagline: string
  author: string
  /** The signup form endpoint on the admin host, or null. */
  signupAction: string | null
}

export function siteConfig(env: Env): SiteConfig {
  const publicUrl = (env.PUBLIC_URL ?? '').replace(/\/$/, '')
  return {
    origin: (env.SITE_URL ?? '').replace(/\/$/, ''),
    title: env.SITE_TITLE ?? 'Writing',
    tagline: env.SITE_TAGLINE ?? '',
    author: env.SITE_AUTHOR ?? env.FROM_NAME ?? '',
    signupAction: env.SITE_FORM_SLUG && publicUrl ? `${publicUrl}/f/${env.SITE_FORM_SLUG}` : null,
  }
}

export interface SiteRequest {
  db: Db
  cfg: SiteConfig
  theme: LoadedTheme
  /** The request path, for navigation highlighting and canonical URLs. */
  path: string
  /**
   * Where `{{asset}}` points. The site serves the *active* theme's assets at
   * `/assets`, so previewing an inactive theme passes the admin's own route.
   */
  assetBase?: string
}

export interface Rendered {
  status: number
  html: string
}

// ─────────────────────────────────────────────────────────── shapes

/**
 * Hues chosen by eye rather than spun round the wheel: an evenly spaced wheel
 * lands on muddy olive and bruise-brown. Eight that each hold up as a flood of
 * colour behind dark text.
 */
const HUES = [28, 52, 88, 148, 186, 236, 284, 334]

/**
 * The same idea confined to blues and violets, for themes that live at night
 * and want no warm colour at all. Indexed the same way, so a topic's cool hue
 * is as stable as its full one.
 */
const COOL_HUES = [258, 292, 206, 318, 236, 272, 222, 304]

export function coolHueForTag(id: number): number {
  return COOL_HUES[(id - 1) % COOL_HUES.length] as number
}

/** A topic's hue, by its id: the first eight topics never share a colour, and a topic keeps its colour for life. */
export function hueForTag(id: number): number {
  return HUES[(id - 1) % HUES.length] as number
}

/** For things with no topic: FNV-1a over the slug, so it spreads across all eight. */
export function hueFor(slug: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < slug.length; i++) h = Math.imul(h ^ slug.charCodeAt(i), 0x01000193)
  return HUES[(h >>> 0) % HUES.length] as number
}

export function ghostTag(tag: PostTag, posts = 0): GhostTag {
  return {
    id: String(tag.id),
    name: tag.name,
    slug: tag.slug,
    description: tag.description,
    url: `/${tag.slug}`,
    feature_image: null,
    visibility: 'public',
    accent_color: null,
    meta_title: null,
    meta_description: null,
    count: { posts },
    hue: hueForTag(tag.id),
    hue_cool: coolHueForTag(tag.id),
  }
}

export function ghostAuthor(cfg: SiteConfig, posts = 0): GhostAuthor {
  const slug = slugify(cfg.author) || 'author'
  return {
    id: '1',
    name: cfg.author,
    slug,
    url: `/author/${slug}`,
    profile_image: null,
    cover_image: null,
    bio: null,
    website: null,
    location: null,
    twitter: null,
    facebook: null,
    meta_title: null,
    meta_description: null,
    count: { posts },
  }
}

export function ghostPost(post: Post, tags: PostTag[], cfg: SiteConfig): GhostPost {
  const author = ghostAuthor(cfg)
  const gTags = tags.map((t) => ghostTag(t))
  const url = postPath(post.slug, tags[0]?.slug)
  const published = post.publishedAt.toISOString()

  const caption = post.featureImageCredit
    ? safe(
        `Photo by <a href="${escapeHtml(post.featureImageCreditUrl ?? '#')}" rel="noopener nofollow">${escapeHtml(post.featureImageCredit)}</a> on <a href="https://unsplash.com?utm_source=kolea&amp;utm_medium=referral" rel="noopener nofollow">Unsplash</a>`,
      )
    : null

  const out = {
    id: String(post.id),
    uuid: `kolea-${post.id}`,
    title: post.subject,
    slug: post.slug,
    excerpt: post.excerpt ?? '',
    custom_excerpt: post.excerpt,
    url,
    feature_image: post.featureImage,
    feature_image_alt: null,
    feature_image_caption: caption,
    featured: false,
    page: false,
    visibility: 'public',
    access: true,
    comments: false,
    published_at: published,
    updated_at: published,
    created_at: published,
    tags: gTags,
    primary_tag: gTags[0] ?? null,
    authors: [author],
    primary_author: author,
    meta_title: null,
    meta_description: null,
    og_image: null,
    twitter_image: null,
    broadcast_id: post.id,
    hue: gTags[0]?.hue ?? hueFor(post.slug),
    hue_cool: gTags[0]?.hue_cool ?? 258,
    share_x_url: shareOnXUrl(`${cfg.origin}${url}`, post.subject),
  } as unknown as GhostPost

  // The body and its reading time are rendered on first read, not up front:
  // an archive page of twelve cards reads neither.
  let html: string | null = null
  const body = () => (html ??= renderPostHtml({ json: post.bodyJson, md: post.bodyMd }))
  Object.defineProperty(out, 'html', { enumerable: true, get: body })
  Object.defineProperty(out, 'reading_time', {
    enumerable: true,
    get: () => {
      const words = body()
        .replace(/<[^>]+>/g, ' ')
        .split(/\s+/)
        .filter(Boolean).length
      return Math.max(1, Math.round(words / 265))
    },
  })
  return out
}

async function ghostPosts(db: Db, posts: Post[], cfg: SiteConfig): Promise<GhostPost[]> {
  const tags = await tagsForPosts(
    db,
    posts.map((p) => p.id),
  )
  return posts.map((p) => ghostPost(p, tags.get(p.id) ?? [], cfg))
}

/** A page that isn't a post — `/subscribe`, or search on a theme without `search.hbs`. */
function syntheticPage(title: string, html: string, url: string, cfg: SiteConfig): GhostPost {
  const author = ghostAuthor(cfg)
  const now = new Date().toISOString()
  return {
    id: '0',
    uuid: 'kolea-page',
    title,
    slug: slugify(title),
    html,
    excerpt: '',
    custom_excerpt: null,
    url,
    feature_image: null,
    feature_image_alt: null,
    feature_image_caption: null,
    featured: false,
    page: true,
    visibility: 'public',
    access: true,
    comments: false,
    published_at: now,
    updated_at: now,
    created_at: now,
    reading_time: 1,
    tags: [],
    primary_tag: null,
    authors: [author],
    primary_author: author,
    meta_title: null,
    meta_description: null,
    og_image: null,
    twitter_image: null,
    broadcast_id: 0,
    hue: hueFor(slugify(title)),
    hue_cool: 258,
  }
}

/** Number a listing page from the top of the archive down: newest = total. */
function numbered(posts: GhostPost[], total: number, offset: number): GhostPost[] {
  posts.forEach((p, i) => {
    p.number = total - offset - i
  })
  return posts
}

function pagination(page: number, limit: number, total: number): Pagination {
  const pages = Math.max(Math.ceil(total / limit), 1)
  return { page, limit, pages, total, next: page < pages ? page + 1 : null, prev: page > 1 ? page - 1 : null }
}

// ─────────────────────────────────────────────────────────── {{#get}}

/**
 * The NQL Kōlea understands, which is the NQL themes actually write:
 * `id:-{{id}}`, `tag:x`, `tags:[a,b]`, `primary_tag:x`, joined with `+`.
 * Anything else is ignored rather than rejected, so an unfamiliar filter widens
 * a "related posts" list instead of blanking it. `featured:true` matches
 * nothing — there are no featured posts here.
 */
async function nqlToQuery(db: Db, filter: string): Promise<PostQuery | null> {
  const q: PostQuery = {}
  for (const clause of filter.split('+').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z_.]+):(-?)(\[[^\]]*]|'[^']*'|[^\s]+)$/i.exec(clause)
    if (!m) continue
    const [, field, neg, rawValue] = m as unknown as [string, string, string, string]
    const values = rawValue
      .replace(/^\[|]$/g, '')
      .split(',')
      .map((v) => v.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
    switch (field) {
      case 'id':
        if (neg) q.excludeIds = [...(q.excludeIds ?? []), ...values.map(Number).filter(Number.isFinite)]
        break
      case 'tag':
      case 'tags':
      case 'tags.slug':
      case 'primary_tag':
      case 'primary_tag.slug': {
        if (neg) break
        const tag = values[0] ? await getPostTagBySlug(db, values[0]) : null
        if (!tag) return null
        if (field.startsWith('primary_tag')) q.primaryTagId = tag.id
        else q.tagId = tag.id
        break
      }
      case 'featured':
        if (!neg && values[0] === 'true') return null
        break
    }
  }
  return q
}

const MAX_GETS_PER_RENDER = 10

// ─────────────────────────────────────────────────────────── rendering

interface View {
  /** Candidate templates, most specific first. */
  templates: string[]
  contexts: string[]
  root: Record<string, unknown>
  meta: Omit<PageMeta, 'canonical'> & { canonical?: string }
  pageUrl?: (n: number) => string
  status?: number
}

async function render(req: SiteRequest, view: View): Promise<Rendered> {
  const { db, cfg, theme } = req
  const name = view.templates.find((t) => theme.hasTemplate(t))
  const template = name ? theme.template(name) : null
  if (!template) return { status: view.status ?? 500, html: bareError(view.status ?? 500, cfg) }

  const topTags = await listPublicTags(db, 8)
  let gets = 0

  const services: ThemeServices = {
    origin: cfg.origin,
    path: req.path,
    pageUrl: view.pageUrl ?? ((n) => (n <= 1 ? '/' : `/page/${n}`)),
    contexts: view.contexts,
    meta: { canonical: `${cfg.origin}${req.path}`, ...view.meta },
    assetUrl: (path) => `${req.assetBase ?? '/assets'}/${path.replace(/^\/+/, '')}?v=${theme.stamp}`,
    signupAction: cfg.signupAction,
    hasPartial: (n) => theme.hasPartial(n),
    translate: (key) => theme.translate(key),
    get: (resource, query) => {
      if (++gets > MAX_GETS_PER_RENDER) return Promise.resolve({ items: [], pagination: pagination(1, 1, 0) })
      return runGet(req, resource, query)
    },
    adjacent: async (post, direction, inPrimaryTag) => {
      const primary = inPrimaryTag && post.primary_tag ? Number(post.primary_tag.id) : undefined
      const other = await adjacentPost(
        db,
        { id: post.broadcast_id, publishedAt: new Date(post.published_at) },
        direction,
        primary,
      )
      if (!other) return null
      return ghostPost(other, await tagsForPost(db, other.id), cfg)
    },
  }

  const renderer = new Renderer({
    helpers,
    partial: (n) => theme.partial(n),
    template: (n) => theme.template(n),
    data: {
      site: {
        title: cfg.title,
        description: cfg.tagline,
        url: cfg.origin,
        logo: null,
        icon: '/favicon.png',
        cover_image: null,
        accent_color: '#0ea5e9',
        locale: 'en',
        lang: 'en',
        timezone: 'Etc/UTC',
        // Tags are the navigation. No menu editor to keep in sync: the topics
        // you actually write about, busiest first.
        navigation: [
          { label: 'Home', url: '/', hue: 236, hue_cool: 258 },
          ...topTags.map((t) => ({
            label: t.name,
            url: `/${t.slug}`,
            hue: hueForTag(t.id),
            hue_cool: coolHueForTag(t.id),
          })),
        ],
        secondary_navigation: [],
        members_enabled: Boolean(cfg.signupAction),
        allow_self_signup: Boolean(cfg.signupAction),
        members_invite_only: false,
        paid_members_enabled: false,
        members_support_address: null,
        comments_enabled: false,
        recommendations_enabled: false,
        twitter: null,
        facebook: null,
        // ── Kōlea's own
        author: cfg.author,
        signup_action: cfg.signupAction,
        search_url: '/search',
        now: new Date().toISOString(),
      },
      custom: theme.custom,
      config: { posts_per_page: theme.postsPerPage },
      page: { show_title_and_feature_image: true },
      member: null,
      labs: {},
    },
    services,
  })

  try {
    return { status: view.status ?? 200, html: await renderer.renderTemplate(template, view.root) }
  } catch (err) {
    // A theme bug should cost one page, not the site: say what broke, in a page
    // that doesn't depend on the theme.
    console.error('theme render failed', err)
    return { status: 500, html: bareError(500, cfg, err instanceof Error ? err.message : String(err)) }
  }
}

async function runGet(
  req: SiteRequest,
  resource: string,
  query: GetQuery,
): Promise<{ items: unknown[]; pagination: Pagination }> {
  const { db, cfg } = req
  const empty = { items: [], pagination: pagination(1, query.limit, 0) }
  switch (resource) {
    case 'posts': {
      const pq = await nqlToQuery(db, query.filter)
      if (!pq) return empty
      pq.limit = query.limit
      pq.offset = (query.page - 1) * query.limit
      pq.order = /published_at\s+asc/i.test(query.order) ? 'oldest' : 'newest'
      const [{ posts }, total] = await Promise.all([listPosts(db, pq), countPosts(db, pq)])
      return { items: await ghostPosts(db, posts, cfg), pagination: pagination(query.page, query.limit, total) }
    }
    case 'tags': {
      const tags: TagWithCount[] = await listPublicTags(db, query.limit)
      return { items: tags.map((t) => ghostTag(t, t.posts)), pagination: pagination(1, query.limit, tags.length) }
    }
    case 'authors':
      return { items: [ghostAuthor(cfg, await countPosts(db))], pagination: pagination(1, query.limit, 1) }
    default:
      // pages, tiers, newsletters: Kōlea has none of these.
      return empty
  }
}

// ─────────────────────────────────────────────────────────── views

export async function renderIndex(req: SiteRequest, page: number): Promise<Rendered | null> {
  const { db, cfg, theme } = req
  const limit = theme.postsPerPage
  const [{ posts }, total] = await Promise.all([
    listPosts(db, { limit, offset: (page - 1) * limit }),
    countPosts(db),
  ])
  if (page > 1 && posts.length === 0) return null
  const home = page === 1
  return render(req, {
    templates: home ? ['home', 'index'] : ['index'],
    contexts: home ? ['home', 'index'] : ['index', 'paged'],
    root: {
      posts: numbered(await ghostPosts(db, posts, cfg), total, (page - 1) * limit),
      pagination: pagination(page, limit, total),
    },
    meta: {
      title: home ? cfg.title : `${cfg.title} (Page ${page})`,
      description: cfg.tagline || null,
      image: null,
      type: 'website',
      publishedAt: null,
      // Paginated archive pages stay out of the index: one post, one URL.
      noindex: !home,
    },
    pageUrl: (n) => (n <= 1 ? '/' : `/page/${n}`),
  })
}

export async function renderTag(req: SiteRequest, tag: PostTag, page: number): Promise<Rendered | null> {
  const { db, cfg, theme } = req
  const limit = theme.postsPerPage
  const q: PostQuery = { tagId: tag.id, limit, offset: (page - 1) * limit }
  const [{ posts }, total] = await Promise.all([listPosts(db, q), countPosts(db, { tagId: tag.id })])
  if (posts.length === 0 && (page > 1 || total === 0)) return null
  return render(req, {
    templates: [`tag-${tag.slug}`, 'tag', 'index'],
    contexts: page > 1 ? ['tag', 'paged'] : ['tag'],
    root: {
      tag: ghostTag(tag, total),
      posts: numbered(await ghostPosts(db, posts, cfg), total, (page - 1) * limit),
      pagination: pagination(page, limit, total),
    },
    meta: {
      title: page > 1 ? `${tag.name} (Page ${page}) · ${cfg.title}` : `${tag.name} · ${cfg.title}`,
      description: tag.description ?? cfg.tagline ?? null,
      image: null,
      type: 'website',
      publishedAt: null,
      noindex: page > 1,
    },
    pageUrl: (n) => (n <= 1 ? `/${tag.slug}` : `/${tag.slug}/page/${n}`),
  })
}

export async function renderAuthor(req: SiteRequest, slug: string, page: number): Promise<Rendered | null> {
  const { db, cfg, theme } = req
  const author = ghostAuthor(cfg)
  if (slug !== author.slug) return null
  const limit = theme.postsPerPage
  const [{ posts }, total] = await Promise.all([
    listPosts(db, { limit, offset: (page - 1) * limit }),
    countPosts(db),
  ])
  if (page > 1 && posts.length === 0) return null
  author.count.posts = total
  return render(req, {
    templates: [`author-${slug}`, 'author', 'index'],
    contexts: page > 1 ? ['author', 'paged'] : ['author'],
    root: { author, posts: await ghostPosts(db, posts, cfg), pagination: pagination(page, limit, total) },
    meta: {
      title: `${author.name} · ${cfg.title}`,
      description: cfg.tagline || null,
      image: null,
      type: 'website',
      publishedAt: null,
      noindex: page > 1,
    },
    pageUrl: (n) => (n <= 1 ? author.url : `${author.url}/page/${n}`),
  })
}

export async function renderPost(req: SiteRequest, post: Post, tags: PostTag[]): Promise<Rendered> {
  const { cfg } = req
  const gp = ghostPost(post, tags, cfg)
  return render(req, {
    templates: [`post-${post.slug}`, 'post'],
    contexts: ['post'],
    root: { post: gp },
    meta: {
      canonical: `${cfg.origin}${gp.url}`,
      title: post.subject,
      description: post.excerpt ?? (cfg.tagline || null),
      image: post.featureImage,
      type: 'article',
      publishedAt: gp.published_at,
      noindex: false,
    },
  })
}

export async function renderSearch(req: SiteRequest, q: string, page: number): Promise<Rendered> {
  const { db, cfg, theme } = req
  const limit = theme.postsPerPage
  const query = q.trim()
  const { posts } = query ? await listPosts(db, { q: query, limit, offset: (page - 1) * limit }) : { posts: [] }
  const total = query ? await countPosts(db, { q: query }) : 0
  const gposts = await ghostPosts(db, posts, cfg)
  const pageUrl = (n: number) => {
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    if (n > 1) params.set('page', String(n))
    const s = params.toString()
    return s ? `/search?${s}` : '/search'
  }
  const meta = {
    title: query ? `Search: ${query} · ${cfg.title}` : `Search · ${cfg.title}`,
    description: null,
    image: null,
    type: 'website' as const,
    publishedAt: null,
    // A search result page is a view of the archive, not a document.
    noindex: true,
  }

  if (theme.hasTemplate('search')) {
    return render(req, {
      templates: ['search'],
      contexts: ['search'],
      root: { query, posts: gposts, pagination: pagination(page, limit, total) },
      meta,
      pageUrl,
    })
  }

  // Ghost themes have no search page — Ghost searches in a client-side popup.
  // So search renders as a page: a form and a list of results, in the theme's
  // own `page.hbs` or `post.hbs`, styled like everything else it renders.
  const e = escapeHtml
  const results = query
    ? gposts.length
      ? `<ul class="kolea-search-results">${gposts
          .map(
            (p) =>
              `<li><a href="${e(p.url)}"><strong>${e(p.title)}</strong></a>${p.excerpt ? `<br>${e(p.excerpt)}` : ''}</li>`,
          )
          .join('')}</ul>`
      : `<p>Nothing matches “${e(query)}”.</p>`
    : ''
  const more = page * limit < total ? `<p><a href="${e(pageUrl(page + 1))}">More results →</a></p>` : ''
  const html = `<form method="get" action="/search" role="search" class="kolea-search"><p><input type="search" name="q" value="${e(query)}" placeholder="Search everything" aria-label="Search posts" style="width:100%;max-width:32rem;padding:.6em .8em;font:inherit"> <button type="submit">Search</button></p></form>${results}${more}`
  return render(req, {
    templates: ['page', 'post'],
    contexts: ['page'],
    root: { post: syntheticPage('Search', html, '/search', cfg) },
    meta,
  })
}

export async function renderSubscribe(req: SiteRequest): Promise<Rendered> {
  const { cfg } = req
  const e = escapeHtml
  const html = cfg.signupAction
    ? `<p>New posts, by email. No spam, and every email carries a one-click way out.</p><form method="post" action="${e(cfg.signupAction)}" class="kolea-subscribe"><p><input type="email" name="email" required placeholder="you@example.com" aria-label="Email address" style="width:100%;max-width:24rem;padding:.6em .8em;font:inherit"> <button type="submit">Subscribe</button></p></form>`
    : '<p>Signups are closed right now.</p>'
  return render(req, {
    templates: ['subscribe', 'page', 'post'],
    contexts: ['page'],
    root: { post: syntheticPage('Subscribe', html, '/subscribe', cfg) },
    meta: {
      title: `Subscribe · ${cfg.title}`,
      description: cfg.tagline || null,
      image: null,
      type: 'website',
      publishedAt: null,
      noindex: false,
    },
  })
}

export async function renderError(req: SiteRequest, status: number, message?: string): Promise<Rendered> {
  const templates = [`error-${status}`, `error-${String(status)[0]}xx`, 'error']
  return render(req, {
    templates,
    contexts: ['error'],
    root: {
      statusCode: status,
      message: message ?? (status === 404 ? 'Page not found' : 'Something went wrong'),
      errorDetails: [],
    },
    meta: {
      title: status === 404 ? `Not found · ${req.cfg.title}` : req.cfg.title,
      description: null,
      image: null,
      type: 'website',
      publishedAt: null,
      noindex: true,
    },
    status,
  })
}

/** The page that renders when the theme can't — no theme, no helpers, no fonts. */
function bareError(status: number, cfg: SiteConfig, detail?: string): string {
  const e = escapeHtml
  const title = status === 404 ? 'Not here' : 'Something broke'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)} · ${e(cfg.title)}</title><meta name="robots" content="noindex"></head><body style="font:17px/1.6 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>${e(title)}</h1><p>${status === 404 ? "That page doesn't exist, or it isn't published." : 'The theme could not render this page.'}</p>${detail ? `<pre style="white-space:pre-wrap;opacity:.7">${e(detail)}</pre>` : ''}<p><a href="/">← Home</a></p></body></html>`
}
