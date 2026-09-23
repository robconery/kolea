import { Hono } from 'hono'
import type { Context } from 'hono'
import { getPostTagBySlug, listPublicTags, tagsForPost, tagsForPosts } from '../core/post-tags.ts'
import { type Post, allPostSlugs, getPostBySlug, postPath, recentPosts } from '../core/posts.ts'
import { renderPostHtml } from '../core/render-web.ts'
import {
  type Rendered,
  type SiteConfig,
  type SiteRequest,
  loadSiteConfig,
  renderAbout,
  renderAuthor,
  renderError,
  renderHome,
  renderIndex,
  renderPost,
  renderSearch,
  renderSubscribe,
  renderTag,
  siteConfig,
} from '../core/theme/site.ts'
import { loadActiveTheme, readThemeAsset } from '../core/theme/store.ts'
import { escapeHtml } from '../core/text.ts'
import { recordDwell, recordPageView } from '../core/traffic.ts'
import { getDb } from '../db/index.ts'
import type { PostTag } from '../db/schema.ts'
import type { Env } from '../types.ts'

/**
 * ⭐ The public site.
 *
 * Its own Hono app, dispatched by hostname in `worker.tsx` — it is never mounted
 * into the admin app. That is deliberate and it is the security boundary: the
 * admin app sits behind `requireOperator` and Cloudflare Access, and the way to
 * be certain a public route can never be reached with operator powers (or an
 * operator route reached without them) is for the two never to share a router.
 *
 * Every page renders through the active **theme** (`core/theme/`): Handlebars
 * templates, Ghost-compatible, run by our own interpreter. This file only
 * decides which view a URL is. The URL scheme is fixed and opinionated — there
 * is no routes file:
 *
 *   /                      the front page: a landing page for the writer
 *   /writing               every post, newest first     /writing/page/2
 *   /about                 the long bio, when there is one
 *   /<tag>                 a topic's archive    /<tag>/page/2
 *   /<tag>/<slug>          a post whose primary tag is <tag>
 *   /<slug>                a post with no tags — or a redirect to /<tag>/<slug>
 *   /author/<slug>         the author's archive (there is one author)
 *   /search?q=  /subscribe  /feed.xml  /sitemap.xml  /robots.txt  /assets/*
 *
 * The signup form posts to the ordinary public form endpoint on the admin host,
 * so consent arrives through exactly the same path as a signup from anywhere
 * else. No shortcut, no second implementation.
 */
export const site = new Hono<{ Bindings: Env }>()

type Ctx = Context<{ Bindings: Env }>

/** Whether this request is for the public site rather than the admin console. */
export function isSiteHost(request: Request, env: Env): boolean {
  // No SITE_URL means the public site does not exist. Unset is the kill switch,
  // and it is the default — a fresh install publishes nothing.
  if (!env.SITE_URL) return false
  try {
    return new URL(request.url).host === new URL(env.SITE_URL).host
  } catch {
    return false
  }
}

async function siteRequest(c: Ctx): Promise<SiteRequest> {
  const db = getDb(c.env)
  const [cfg, theme] = await Promise.all([loadSiteConfig(db, c.env), loadActiveTheme(db)])
  return { db, cfg, theme, path: c.req.path }
}

/**
 * Short shared cache: a correction should show up in minutes, not on the next
 * deploy, and a post that just went out gets its traffic spike anyway.
 */
const PAGE_CACHE = { 'Cache-Control': 'public, max-age=60, s-maxage=300' }

function send(
  c: Ctx,
  r: Rendered | null,
  req: SiteRequest,
  postId?: number,
): Promise<Response> | Response {
  if (!r) return notFound(c, req)
  const html = r.status === 200 ? withBeacon(r.html, postId ?? null) : r.html
  return c.html(html, r.status as 200, r.status === 200 ? PAGE_CACHE : undefined)
}

// ─────────────────────────────────────────────────────────── the beacon

/** Where the beacon posts. Not a page, so it can never collide with a slug. */
const HIT_PATH = '/_k/hit'

/**
 * The page-view beacon, inlined into every page the site serves.
 *
 * Added here rather than in the theme so every theme counts the same way and an
 * uploaded theme can't forget it. It sends two things: the view, on load, and
 * the time the tab was visible, each time it is hidden. `sendBeacon` survives
 * the tab closing, which is exactly when the second one fires. No cookie, no
 * storage, no third party. See `core/traffic.ts` for what the server keeps.
 */
function beacon(postId: number | null): string {
  return `<script>(function(){try{var k=(crypto.randomUUID&&crypto.randomUUID())||(Date.now().toString(36)+Math.random().toString(36).slice(2)),u='${HIT_PATH}',v=Date.now(),a=0,h=0,out,go=function(d){var b=JSON.stringify(d);if(navigator.sendBeacon)navigator.sendBeacon(u,b);else fetch(u,{method:'POST',body:b,keepalive:true})};go({k:k,p:location.pathname,q:location.search,r:document.referrer,b:${postId ?? 'null'}});out=function(){if(h)return;h=1;a+=Date.now()-v;go({k:k,s:a/1000})};document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')out();else{h=0;v=Date.now()}});addEventListener('pagehide',out)}catch(e){}})();</script>`
}

function withBeacon(html: string, postId: number | null): string {
  const at = html.toLowerCase().lastIndexOf('</body>')
  const tag = beacon(postId)
  return at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at)
}

/**
 * Receives the beacon. Always 204, whatever happens — a reader's browser has no
 * use for our errors. A hit from another origin is dropped: the beacon is only
 * ever sent by our own pages, and anything else posting here is noise.
 */
site.post(HIT_PATH, async (c) => {
  const origin = c.req.header('Origin')
  if (origin && c.env.SITE_URL && origin !== new URL(c.env.SITE_URL).origin) return c.body(null, 204)

  let body: { k?: unknown; p?: unknown; q?: unknown; r?: unknown; b?: unknown; s?: unknown }
  try {
    const text = await c.req.text()
    if (text.length > 4096) return c.body(null, 204)
    body = JSON.parse(text)
  } catch {
    return c.body(null, 204)
  }
  if (typeof body.k !== 'string') return c.body(null, 204)

  const db = getDb(c.env)
  if (typeof body.s === 'number') {
    await recordDwell(db, body.k, body.s)
  } else if (typeof body.p === 'string') {
    const cf = (c.req.raw as unknown as { cf?: { country?: string } }).cf
    await recordPageView(db, {
      viewKey: body.k,
      path: body.p,
      search: typeof body.q === 'string' ? body.q : null,
      referrer: typeof body.r === 'string' && body.r ? body.r : null,
      broadcastId: typeof body.b === 'number' ? body.b : null,
      country: cf?.country ?? null,
      ip: c.req.header('CF-Connecting-IP') ?? null,
      userAgent: c.req.header('User-Agent') ?? null,
    })
  }
  return c.body(null, 204)
})

async function notFound(c: Ctx, req?: SiteRequest): Promise<Response> {
  const r = await renderError(req ?? (await siteRequest(c)), 404)
  return c.html(r.html, 404)
}

function pageParam(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,5}$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 ? n : null
}

// ─────────────────────────────────────────────────────────── URL hygiene

/** One URL per page: `/ai/` and `/ai` are the same page, and only one is canonical. */
site.use('*', async (c, next) => {
  const path = c.req.path
  if (path.length > 1 && path.endsWith('/')) {
    const url = new URL(c.req.url)
    return c.redirect(`${path.replace(/\/+$/, '')}${url.search}`, 301)
  }
  await next()
})

// ─────────────────────────────────────────────────────────── pages

site.get('/', async (c) => {
  // The archive used to live here and take `?q=` and `?page=`. Links to those are out there.
  const q = c.req.query('q')
  if (q !== undefined) return c.redirect(q ? `/search?q=${encodeURIComponent(q)}` : '/search', 301)
  const legacyPage = pageParam(c.req.query('page'))
  if (legacyPage && legacyPage > 1) return c.redirect(`/writing/page/${legacyPage}`, 301)

  const req = await siteRequest(c)
  return send(c, await renderHome(req), req)
})

site.get('/writing', async (c) => {
  const req = await siteRequest(c)
  return send(c, await renderIndex(req, 1), req)
})

site.get('/writing/page/:n', async (c) => {
  const n = pageParam(c.req.param('n'))
  if (n === 1) return c.redirect('/writing', 301)
  const req = await siteRequest(c)
  return send(c, n ? await renderIndex(req, n) : null, req)
})

/** The archive's old pages, from before the front page became a landing page. */
site.get('/page/:n', (c) => {
  const n = pageParam(c.req.param('n'))
  return c.redirect(n && n > 1 ? `/writing/page/${n}` : '/writing', 301)
})

site.get('/about', async (c) => {
  const req = await siteRequest(c)
  return send(c, await renderAbout(req), req)
})

site.get('/search', async (c) => {
  const req = await siteRequest(c)
  const r = await renderSearch(req, c.req.query('q') ?? '', pageParam(c.req.query('page')) ?? 1)
  return c.html(r.html, r.status as 200)
})

site.get('/subscribe', async (c) => {
  const req = await siteRequest(c)
  return send(c, await renderSubscribe(req), req)
})

site.get('/author/:slug', async (c) => {
  const req = await siteRequest(c)
  return send(c, await renderAuthor(req, c.req.param('slug'), 1), req)
})

site.get('/author/:slug/page/:n', async (c) => {
  const req = await siteRequest(c)
  const n = pageParam(c.req.param('n'))
  if (n === 1) return c.redirect(`/author/${c.req.param('slug')}`, 301)
  return send(c, n ? await renderAuthor(req, c.req.param('slug'), n) : null, req)
})

/** Theme assets: CSS, JS, fonts, images. `?v=` in the URL makes them immutable. */
site.get('/assets/*', async (c) => {
  const db = getDb(c.env)
  const theme = await loadActiveTheme(db)
  let path: string
  try {
    path = decodeURIComponent(c.req.path.slice('/assets/'.length))
  } catch {
    return c.notFound()
  }
  const res = await readThemeAsset(theme, c.env.MEDIA, path)
  return res ?? c.text('Not found', 404)
})

site.get('/rss', (c) => c.redirect('/feed.xml', 301))

site.get('/feed.xml', async (c) => {
  const db = getDb(c.env)
  const posts = await recentPosts(db, 20)
  const tags = await tagsForPosts(
    db,
    posts.map((p) => p.id),
  )
  return new Response(rss(await loadSiteConfig(db, c.env), posts, tags), {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
    },
  })
})

site.get('/sitemap.xml', async (c) => {
  const db = getDb(c.env)
  const cfg = await loadSiteConfig(db, c.env)
  const rows = await allPostSlugs(db)
  const tags = await tagsForPosts(
    db,
    rows.map((r) => r.id),
  )
  const topics = await listPublicTags(db, 500)
  const urls = [
    `<url><loc>${escapeHtml(cfg.origin)}/</loc></url>`,
    `<url><loc>${escapeHtml(cfg.origin)}/writing</loc></url>`,
    ...(cfg.longBio ? [`<url><loc>${escapeHtml(cfg.origin)}/about</loc></url>`] : []),
    ...topics.map((t) => `<url><loc>${escapeHtml(`${cfg.origin}/${t.slug}`)}</loc></url>`),
    ...rows.map(
      (r) =>
        `<url><loc>${escapeHtml(`${cfg.origin}${postPath(r.slug, tags.get(r.id)?.[0]?.slug)}`)}</loc><lastmod>${r.publishedAt.toISOString().slice(0, 10)}</lastmod></url>`,
    ),
  ].join('')

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } },
  )
})

/**
 * The asset at `public/robots.txt` disallows everything, and it is served on
 * every hostname this Worker answers — correct for the admin console, fatal for
 * a site that wants readers. `assets.run_worker_first` in `wrangler.jsonc` lists
 * this path so the Worker sees it first and the two hosts can answer differently.
 */
site.get('/robots.txt', (c) => {
  const cfg = siteConfig(c.env)
  return c.text(`User-agent: *\nAllow: /\n\nSitemap: ${cfg.origin}/sitemap.xml\n`, 200, {
    'Cache-Control': 'public, max-age=3600',
  })
})

// ── The catch-alls. Registered last: every fixed path above must win over them.

site.get('/:tag/page/:n', async (c) => {
  const req = await siteRequest(c)
  const n = pageParam(c.req.param('n'))
  if (n === 1) return c.redirect(`/${c.req.param('tag')}`, 301)
  const tag = await getPostTagBySlug(req.db, c.req.param('tag'))
  return send(c, tag && n ? await renderTag(req, tag, n) : null, req)
})

/** A post under its primary tag. A stale tag in the URL redirects to the live one. */
site.get('/:tag/:slug', async (c) => {
  const req = await siteRequest(c)
  const post = await getPostBySlug(req.db, c.req.param('slug'))
  if (!post) return notFound(c, req)
  const tags = await tagsForPost(req.db, post.id)
  const canonical = postPath(post.slug, tags[0]?.slug)
  if (canonical !== c.req.path) return c.redirect(canonical, 301)
  return send(c, await renderPost(req, post, tags), req, post.id)
})

/**
 * One segment: an untagged post, a tagged post reached by its bare slug (every
 * "read this online" link in sent mail has this shape, so it must resolve
 * forever), or a tag's archive. Posts win a collision — their URLs are older.
 */
site.get('/:slug', async (c) => {
  const req = await siteRequest(c)
  const slug = c.req.param('slug')
  const post = await getPostBySlug(req.db, slug)
  if (post) {
    const tags = await tagsForPost(req.db, post.id)
    if (tags[0]) return c.redirect(postPath(post.slug, tags[0].slug), 301)
    return send(c, await renderPost(req, post, tags), req, post.id)
  }
  const tag = await getPostTagBySlug(req.db, slug)
  return send(c, tag ? await renderTag(req, tag, 1) : null, req)
})

site.notFound((c) => notFound(c))

// ─────────────────────────────────────────────────────────── feed

function rss(cfg: SiteConfig, posts: Post[], tags: Map<number, PostTag[]>): string {
  const items = posts
    .map((p) => {
      const url = `${cfg.origin}${postPath(p.slug, tags.get(p.id)?.[0]?.slug)}`
      const body = renderPostHtml({ json: p.bodyJson, md: p.bodyMd })
      return [
        '<item>',
        `<title>${escapeHtml(p.subject)}</title>`,
        `<link>${escapeHtml(url)}</link>`,
        // Permanent and unique: the URL, which never changes once a slug is set.
        `<guid isPermaLink="true">${escapeHtml(url)}</guid>`,
        `<pubDate>${p.publishedAt.toUTCString()}</pubDate>`,
        p.excerpt ? `<description>${escapeHtml(p.excerpt)}</description>` : '',
        // Full text in the feed on purpose. The point of owning the list is that
        // the reader gets the whole thing wherever they read.
        `<content:encoded><![CDATA[${body.replaceAll(']]>', ']]&gt;')}]]></content:encoded>`,
        '</item>',
      ].join('')
    })
    .join('')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${escapeHtml(cfg.title)}</title>`,
    `<link>${escapeHtml(cfg.origin)}/</link>`,
    `<description>${escapeHtml(cfg.tagline)}</description>`,
    `<atom:link href="${escapeHtml(cfg.origin)}/feed.xml" rel="self" type="application/rss+xml" />`,
    '<language>en</language>',
    items,
    '</channel></rss>',
  ].join('')
}
