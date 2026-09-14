import { Hono } from 'hono'
import type { Context } from 'hono'
import type { FC, PropsWithChildren } from 'hono/jsx'
import {
  type Post,
  allPostSlugs,
  getPostBySlug,
  listPosts,
  recentPosts,
  shareOnXUrl,
} from '../core/posts.ts'
import { escapeHtml } from '../core/text.ts'
import { renderPostHtml } from '../core/render-web.ts'
import { getDb } from '../db/index.ts'
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
 * Everything here is read-only, server-rendered, and carries no JavaScript. The
 * one interactive thing on the page is the signup form, and it posts to the
 * ordinary public form endpoint on the admin host, so consent arrives through
 * exactly the same path as a signup from anywhere else. No shortcut, no second
 * implementation.
 */
export const site = new Hono<{ Bindings: Env }>()

const PAGE_SIZE = 12

function conf(env: Env) {
  return {
    origin: (env.SITE_URL ?? '').replace(/\/$/, ''),
    title: env.SITE_TITLE ?? 'Writing',
    tagline: env.SITE_TAGLINE ?? '',
    author: env.SITE_AUTHOR ?? env.FROM_NAME ?? '',
    formSlug: env.SITE_FORM_SLUG ?? '',
    /** Signup posts to the admin host, which is where the form endpoint lives. */
    formAction: env.SITE_FORM_SLUG ? `${(env.PUBLIC_URL ?? '').replace(/\/$/, '')}/f/${env.SITE_FORM_SLUG}` : '',
  }
}

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

// ─────────────────────────────────────────────────────────── pages

site.get('/', async (c) => {
  const db = getDb(c.env)
  const cfg = conf(c.env)
  const q = (c.req.query('q') ?? '').trim()
  const page = Math.max(Number(c.req.query('page') ?? 1) || 1, 1)

  const { posts, hasMore } = await listPosts(db, {
    q,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  })

  return c.html(
    <SiteLayout
      env={c.env}
      title={q ? `Search: ${q}` : cfg.title}
      description={cfg.tagline}
      path={q ? `/?q=${encodeURIComponent(q)}` : '/'}
      // A search result page is a view of the archive, not a document. Keeping
      // paginated and query pages out of the index stops the same post being
      // crawled under a dozen URLs.
      noindex={Boolean(q) || page > 1}
    >
      {page === 1 && !q ? (
        <header class="masthead">
          <h1>{cfg.title}</h1>
          {cfg.tagline ? <p class="tagline">{cfg.tagline}</p> : null}
        </header>
      ) : null}

      <SearchBox q={q} />

      {q ? (
        <p class="result-count">
          {posts.length === 0
            ? `Nothing matches “${q}”.`
            : `${posts.length}${hasMore ? '+' : ''} post${posts.length === 1 ? '' : 's'} matching “${q}”`}
          {' · '}
          <a href="/">clear</a>
        </p>
      ) : null}

      {posts.length === 0 && !q ? <p class="result-count">Nothing published yet.</p> : null}

      <div class="cards">
        {posts.map((p) => (
          <Card post={p} />
        ))}
      </div>

      <Pager page={page} hasMore={hasMore} q={q} />

      {!q ? <Subscribe env={c.env} /> : null}
    </SiteLayout>,
  )
})

/** `/search?q=` exists because it is the URL people type. Same page. */
site.get('/search', (c) => {
  const q = c.req.query('q') ?? ''
  return c.redirect(q ? `/?q=${encodeURIComponent(q)}` : '/', 302)
})

site.get('/feed.xml', async (c) => {
  const db = getDb(c.env)
  const posts = await recentPosts(db, 20)
  return new Response(rss(c.env, posts), {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
    },
  })
})

site.get('/sitemap.xml', async (c) => {
  const db = getDb(c.env)
  const cfg = conf(c.env)
  const rows = await allPostSlugs(db)
  const urls = [
    `<url><loc>${escapeHtml(cfg.origin)}/</loc></url>`,
    ...rows.map(
      (r) =>
        `<url><loc>${escapeHtml(`${cfg.origin}/${r.slug}`)}</loc><lastmod>${r.publishedAt.toISOString().slice(0, 10)}</lastmod></url>`,
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
  const cfg = conf(c.env)
  return c.text(`User-agent: *\nAllow: /\n\nSitemap: ${cfg.origin}/sitemap.xml\n`, 200, {
    'Cache-Control': 'public, max-age=3600',
  })
})

/**
 * The post page. Last route registered, because `/:slug` matches anything — a
 * new fixed path added below this line would be swallowed by it.
 */
site.get('/:slug', async (c) => {
  const db = getDb(c.env)
  const cfg = conf(c.env)
  const post = await getPostBySlug(db, c.req.param('slug'))
  if (!post) return notFound(c)

  const html = renderPostHtml({ json: post.bodyJson, md: post.bodyMd })

  return c.html(
    <SiteLayout
      env={c.env}
      title={post.subject}
      description={post.excerpt ?? cfg.tagline}
      path={`/${post.slug}`}
      image={post.featureImage}
      published={post.publishedAt}
      article
    >
      <article class="post">
        <header class="post-head">
          <p class="meta">
            <a href="/">{cfg.title}</a> · <time datetime={post.publishedAt.toISOString()}>{longDate(post.publishedAt)}</time>
          </p>
          <h1>{post.subject}</h1>
          {/* No standfirst. The excerpt is usually derived from the opening
              lines, so printing it above the body reads the first paragraph
              twice. Its job is the card and the meta description. */}
        </header>

        {post.featureImage ? (
          <figure class="feature-wrap">
            <img class="feature" src={post.featureImage} alt="" />
            {/* Unsplash's terms, and basic manners: the credit renders where the
                reader is, not in the admin where only Rob would see it. */}
            {post.featureImageCredit ? (
              <figcaption>
                Photo by{' '}
                <a href={post.featureImageCreditUrl ?? '#'} rel="noopener nofollow">
                  {post.featureImageCredit}
                </a>{' '}
                on{' '}
                <a href="https://unsplash.com?utm_source=kolea&utm_medium=referral" rel="noopener nofollow">
                  Unsplash
                </a>
              </figcaption>
            ) : null}
          </figure>
        ) : null}

        {/* Rendered by `core/render-web.ts`, from content this operator wrote. */}
        <div class="prose" dangerouslySetInnerHTML={{ __html: html }} />

        {/* A link, not an embed. No third-party script, nothing that phones home
            about who read what, and nothing to break when a platform changes its
            widget again. */}
        <p class="share">
          <a href={shareOnXUrl(`${cfg.origin}/${post.slug}`, post.subject)} rel="noopener nofollow">
            Post this on X
          </a>
        </p>
      </article>

      <Subscribe env={c.env} />
    </SiteLayout>,
    200,
    // Short shared cache: a correction should show up in minutes, not on the
    // next deploy, and a post that just went out gets its traffic spike anyway.
    { 'Cache-Control': 'public, max-age=60, s-maxage=300' },
  )
})

site.notFound((c) => notFound(c))

function notFound(c: Context<{ Bindings: Env }>) {
  return c.html(
    <SiteLayout env={c.env} title="Not found" path="/" noindex>
      <div class="empty">
        <h1>Not here</h1>
        <p>That page doesn't exist, or it isn't published.</p>
        <p>
          <a href="/">← Everything else</a>
        </p>
      </div>
    </SiteLayout>,
    404,
  )
}

// ─────────────────────────────────────────────────────────── components

const Card: FC<{ post: Post }> = ({ post }) => (
  <a class="card" href={`/${post.slug}`}>
    {post.featureImage ? (
      <div class="card-img">
        <img src={post.featureImage} alt="" loading="lazy" decoding="async" />
      </div>
    ) : null}
    <div class="card-b">
      <time class="card-date" datetime={post.publishedAt.toISOString()}>
        {shortDate(post.publishedAt)}
      </time>
      <h2>{post.subject}</h2>
      {post.excerpt ? <p>{post.excerpt}</p> : null}
    </div>
  </a>
)

const SearchBox: FC<{ q: string }> = ({ q }) => (
  <form class="search" method="get" action="/" role="search">
    <input
      type="search"
      name="q"
      value={q}
      placeholder="Search everything"
      aria-label="Search posts"
      autocomplete="off"
    />
    <button type="submit">Search</button>
  </form>
)

const Pager: FC<{ page: number; hasMore: boolean; q: string }> = ({ page, hasMore, q }) => {
  if (page === 1 && !hasMore) return null
  const link = (n: number) => {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (n > 1) params.set('page', String(n))
    const s = params.toString()
    return s ? `/?${s}` : '/'
  }
  return (
    <nav class="pager">
      {page > 1 ? <a href={link(page - 1)}>← Newer</a> : <span />}
      {hasMore ? <a href={link(page + 1)}>Older →</a> : <span />}
    </nav>
  )
}

/**
 * Signup. Posts straight to the public form endpoint on the admin host, which
 * runs the same consent, double-opt-in and tagging path as every other signup.
 * Hidden entirely when no form is configured — a box that silently drops
 * addresses is worse than no box.
 */
const Subscribe: FC<{ env: Env }> = ({ env }) => {
  const cfg = conf(env)
  if (!cfg.formAction) return null
  return (
    <section class="subscribe">
      <h2>Get these by email</h2>
      {cfg.tagline ? <p>{cfg.tagline}</p> : null}
      <form method="post" action={cfg.formAction}>
        <input type="email" name="email" required placeholder="you@example.com" aria-label="Email address" />
        <button type="submit">Subscribe</button>
      </form>
      <p class="fine">No spam. Unsubscribe from any email, one click, and it only stops what you asked it to stop.</p>
    </section>
  )
}

/**
 * The backdrop, carried over from the admin console so the two halves of Kōlea
 * look like one thing. Pure CSS — no script, no images beyond two inline SVG
 * noise tiles — and the whole layer is `pointer-events:none`, so it can never
 * get between a reader and a link.
 */
const Ocean: FC = () => (
  <>
    <div class="ocean" aria-hidden="true">
      <div class="rays" />
      <div class="rays-b" />
      <div class="caustic" />
      <div class="mote" />
      <div class="mote" />
      <div class="mote" />
      <div class="mote" />
    </div>
    <div class="grain" aria-hidden="true" />
  </>
)

const SiteLayout: FC<
  PropsWithChildren<{
    env: Env
    title: string
    path: string
    description?: string
    image?: string | null
    published?: Date
    article?: boolean
    noindex?: boolean
  }>
> = ({ env, title, path, description, image, published, article, noindex, children }) => {
  const cfg = conf(env)
  const canonical = `${cfg.origin}${path}`
  const full = title === cfg.title ? title : `${title} · ${cfg.title}`

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        <title>{full}</title>
        {description ? <meta name="description" content={description} /> : null}
        {noindex ? <meta name="robots" content="noindex,follow" /> : null}
        <link rel="canonical" href={canonical} />
        <link rel="alternate" type="application/rss+xml" title={cfg.title} href={`${cfg.origin}/feed.xml`} />
        <link rel="icon" href="/favicon.png" />

        <meta property="og:type" content={article ? 'article' : 'website'} />
        <meta property="og:title" content={title} />
        {description ? <meta property="og:description" content={description} /> : null}
        <meta property="og:url" content={canonical} />
        <meta property="og:site_name" content={cfg.title} />
        {image ? <meta property="og:image" content={image} /> : null}
        {published ? <meta property="article:published_time" content={published.toISOString()} /> : null}
        <meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />
        {cfg.author ? <meta name="author" content={cfg.author} /> : null}

        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link rel="stylesheet" href={FONTS} />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <Ocean />
        <div class="wrap">
          <nav class="top">
            <a class="home" href="/">
              <img src="/logo_200.png" alt="" width="24" height="23" />
              <span>{cfg.title}</span>
            </a>
            <a class="feed" href="/feed.xml">
              RSS
            </a>
          </nav>
          {children}
          <footer class="foot">
            <p>
              © {new Date().getFullYear()} {cfg.author || cfg.title} · <a href="/feed.xml">RSS</a>
            </p>
          </footer>
        </div>
      </body>
    </html>
  )
}

// ─────────────────────────────────────────────────────────── feed

function rss(env: Env, posts: Post[]): string {
  const cfg = conf(env)
  const items = posts
    .map((p) => {
      const url = `${cfg.origin}/${p.slug}`
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

// ─────────────────────────────────────────────────────────── formatting

function shortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function longDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// ─────────────────────────────────────────────────────────── style
//
// The console's palette, on a reading page. Same deep-water blues, same Inter,
// same fading hairlines, same two easing curves — a reader who follows a link
// from the newsletter into the archive should not feel like they changed sites.
//
// Inline rather than a file in `public/`: it changes with the markup it styles,
// and one round trip on a reading page is worth more than a cached stylesheet on
// the second one. It deliberately does NOT import `web/layout.tsx`'s stylesheet —
// that one is ~1,000 lines of admin chrome, and a public page should not ship a
// rail, a chart theme and a composer to render three paragraphs.

const FONTS =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap'

const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  /* depth — the console's three */
  --abyss:#03060f; --deep:#050c22;
  /* light */
  --cyan:#22d3ee; --azure:#3b82f6; --sky:#7dd3fc;
  /* ink */
  --ink:#eaf3ff; --muted:#9db2d4; --faint:#6d84a8;
  /* The dividers fade out at both ends, so a rule never ends in a hard corner. */
  --rule:linear-gradient(90deg,transparent,rgba(148,190,255,.17) 6%,
    rgba(148,190,255,.17) 94%,transparent);
  --edge:rgba(148,190,255,.14);
  --panel:rgba(255,255,255,.042);
  --sans:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,sans-serif;
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;
  --spring:cubic-bezier(.32,.72,0,1);
  --glide:cubic-bezier(.22,1,.36,1);
  --radius:14px;
  --gut:clamp(18px,3.4vw,48px);
}
html{-webkit-text-size-adjust:100%;scrollbar-color:rgba(148,190,255,.2) transparent}
body{margin:0;background:var(--abyss);color:var(--ink);
  font:17px/1.68 var(--sans);letter-spacing:-.005em;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:rgba(34,211,238,.28);color:#fff}
a{color:var(--sky);text-decoration:none;transition:color .35s var(--glide)}
a:hover{color:#a5f3fc}
img{max-width:100%;height:auto}
h1,h2,h3{margin:0;font-weight:600;letter-spacing:-.02em}

/* ── the ocean, one layer, behind everything, inert */
.ocean{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;
  background:
    radial-gradient(120% 78% at 50% -18%,rgba(56,189,248,.20),transparent 62%),
    radial-gradient(85% 58% at 88% 6%,rgba(139,92,246,.20),transparent 66%),
    radial-gradient(80% 60% at 4% 96%,rgba(45,212,191,.10),transparent 62%),
    radial-gradient(60% 45% at 78% 92%,rgba(99,102,241,.14),transparent 66%),
    linear-gradient(178deg,#07183a 0%,var(--deep) 42%,var(--abyss) 100%)}
.rays,.rays-b{position:absolute;left:-25%;top:-45%;width:150%;height:130%;
  will-change:transform;transform:translateZ(0)}
.rays{background:repeating-linear-gradient(99deg,
    rgba(186,230,253,.070) 0 2px,transparent 2px 11px,
    rgba(224,242,254,.045) 11px 14px,transparent 14px 34px);
  -webkit-mask-image:radial-gradient(58% 74% at 46% -4%,#000 0%,rgba(0,0,0,.55) 40%,transparent 76%);
  mask-image:radial-gradient(58% 74% at 46% -4%,#000 0%,rgba(0,0,0,.55) 40%,transparent 76%);
  animation:rake 26s var(--glide) infinite alternate}
.rays-b{background:repeating-linear-gradient(84deg,
    rgba(165,243,252,.055) 0 3px,transparent 3px 22px);
  -webkit-mask-image:radial-gradient(64% 60% at 68% -8%,#000 0%,transparent 72%);
  mask-image:radial-gradient(64% 60% at 68% -8%,#000 0%,transparent 72%);
  animation:rake-b 34s var(--glide) infinite alternate}
@keyframes rake{from{transform:translate3d(-2.5%,0,0) rotate(-1.1deg) scaleY(1)}
  to{transform:translate3d(3.5%,0,0) rotate(1.4deg) scaleY(1.06)}}
@keyframes rake-b{from{transform:translate3d(3%,0,0) rotate(1deg)}
  to{transform:translate3d(-3%,0,0) rotate(-1.2deg)}}
.caustic{position:absolute;inset:-20%;opacity:.24;mix-blend-mode:screen;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='320'%3E%3Cfilter id='c'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.012 0.018' numOctaves='2' seed='7'/%3E%3CfeColorMatrix values='0 0 0 0 0.42 0 0 0 0 0.78 0 0 0 0 1 0 0 0 -1.6 0.72'/%3E%3C/filter%3E%3Crect width='320' height='320' filter='url(%23c)'/%3E%3C/svg%3E");
  background-size:760px 760px;
  -webkit-mask-image:radial-gradient(70% 55% at 50% 0%,#000,transparent 78%);
  mask-image:radial-gradient(70% 55% at 50% 0%,#000,transparent 78%);
  animation:swell 40s linear infinite}
@keyframes swell{from{transform:translate3d(0,0,0) scale(1.04)}
  50%{transform:translate3d(-3%,2%,0) scale(1.12)}
  to{transform:translate3d(0,0,0) scale(1.04)}}
/* Four, not the console's six. There is text to read on this one. */
.mote{position:absolute;border-radius:50%;background:rgba(186,230,253,.62);
  box-shadow:0 0 12px 2px rgba(103,232,249,.35);animation:drift 26s var(--glide) infinite}
.mote:nth-child(3){width:3px;height:3px;left:12%;top:72%;animation-duration:31s}
.mote:nth-child(4){width:2px;height:2px;left:38%;top:88%;animation-duration:24s;animation-delay:-6s}
.mote:nth-child(5){width:4px;height:4px;left:66%;top:80%;animation-duration:38s;animation-delay:-14s;opacity:.6}
.mote:nth-child(6){width:2px;height:2px;left:86%;top:66%;animation-duration:28s;animation-delay:-3s}
@keyframes drift{0%{transform:translate3d(0,0,0);opacity:0}
  12%{opacity:.75}
  100%{transform:translate3d(38px,-78vh,0);opacity:0}}
.grain{position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.05;
  mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E")}
/* Water in motion is charm; water in motion while someone is trying to read is
   a problem. One switch turns all of it off. */
@media (prefers-reduced-motion:reduce){
  .rays,.rays-b,.caustic,.mote{animation:none}
  .mote{opacity:.4}
}

/* ── the page */
.wrap{position:relative;z-index:2;max-width:920px;margin:0 auto;
  padding:0 var(--gut) 90px}

.top{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:26px 0 24px;margin-bottom:44px;position:relative}
.top::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--rule)}
.top .home{display:flex;align-items:center;gap:10px;color:var(--ink);
  font:600 13px/1 var(--sans);letter-spacing:.15em;text-transform:uppercase}
.top .home img{display:block;filter:drop-shadow(0 0 10px rgba(103,232,249,.35))}
.top .feed{font:500 11.5px/1 var(--sans);letter-spacing:.19em;color:var(--faint)}
.top .feed:hover{color:var(--sky)}

/* Big type earns its presence from weight and tight tracking, not a second
   family — and the gradient is the one the console puts on every h1. */
.masthead{margin:0 0 40px}
.masthead h1{font:700 clamp(32px,5vw,46px)/1.06 var(--sans);letter-spacing:-.038em;
  background:linear-gradient(178deg,#ffffff 10%,#b6cff2 92%);
  -webkit-background-clip:text;background-clip:text;color:transparent}
.tagline{margin:16px 0 0;color:var(--muted);font-size:17px;max-width:56ch}

.search{display:flex;gap:10px;margin:0 0 40px}
.search input{flex:1;min-width:0;padding:12px 16px;border:1px solid var(--edge);
  border-radius:10px;background:rgba(255,255,255,.045);color:var(--ink);
  font:15px var(--sans);transition:border-color .35s var(--glide),background .35s var(--glide)}
.search input::placeholder{color:var(--faint)}
.search input:focus{outline:0;border-color:rgba(125,211,252,.55);background:rgba(255,255,255,.07)}
.search button,.subscribe button{padding:12px 22px;border:1px solid rgba(125,211,252,.4);
  border-radius:10px;background:rgba(56,189,248,.16);color:var(--ink);
  font:600 14px var(--sans);letter-spacing:.01em;cursor:pointer;
  transition:background .35s var(--glide),border-color .35s var(--glide)}
.search button:hover,.subscribe button:hover{background:rgba(56,189,248,.28);
  border-color:rgba(125,211,252,.7)}
.result-count{margin:-24px 0 30px;color:var(--muted);font-size:15px}

/* ── cards */
.cards{display:grid;gap:22px;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));
  align-items:start}
.card{display:flex;flex-direction:column;background:var(--panel);
  border:1px solid var(--edge);border-radius:var(--radius);overflow:hidden;
  color:inherit;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  transition:transform .5s var(--spring),border-color .4s var(--glide),box-shadow .5s var(--spring)}
.card:hover{transform:translateY(-3px);border-color:rgba(125,211,252,.42);
  box-shadow:0 18px 42px -18px rgba(3,12,34,.9),0 0 0 1px rgba(125,211,252,.08)}
.card-img{aspect-ratio:16/9;overflow:hidden;background:rgba(148,190,255,.07)}
.card-img img{width:100%;height:100%;object-fit:cover;display:block}
.card-b{padding:20px 22px 24px}
.card-date{display:block;font:500 11px/1 var(--mono);letter-spacing:.14em;
  text-transform:uppercase;color:var(--faint)}
.card h2{margin:11px 0 9px;font:600 19px/1.3 var(--sans);letter-spacing:-.022em;color:#e6f0ff}
.card:hover h2{color:#fff}
.card p{margin:0;color:var(--muted);font-size:14.5px;line-height:1.6}

.pager{display:flex;justify-content:space-between;margin:48px 0 0;font-size:14.5px}

/* ── the post */
.post-head{margin:6px 0 32px}
.post-head .meta{margin:0 0 16px;font:500 11.5px/1 var(--mono);letter-spacing:.14em;
  text-transform:uppercase;color:var(--faint)}
.post-head .meta a{color:var(--faint)}
.post-head .meta a:hover{color:var(--sky)}
.post-head h1{font:700 clamp(30px,4.2vw,42px)/1.1 var(--sans);letter-spacing:-.036em;
  background:linear-gradient(178deg,#ffffff 10%,#b6cff2 92%);
  -webkit-background-clip:text;background-clip:text;color:transparent}
.feature-wrap{margin:0 0 36px}
.feature{width:100%;max-height:460px;object-fit:cover;border-radius:var(--radius);
  display:block;border:1px solid var(--edge)}
.feature-wrap figcaption{margin-top:10px;font-size:12.5px;color:var(--faint);text-align:right}
.feature-wrap figcaption a{color:var(--faint);text-decoration:underline;
  text-decoration-color:rgba(148,190,255,.3)}
.feature-wrap figcaption a:hover{color:var(--sky)}

/* The reading column is narrower than the page. 920px is right for a grid of
   cards and much too wide for prose. */
.prose{max-width:68ch;font-size:18px;line-height:1.75;color:#dfeaf9}
.prose p,.prose ul,.prose ol,.prose pre,.prose blockquote,.prose figure,.prose .table-wrap{margin:0 0 26px}
.prose h2{margin:48px 0 15px;font:600 25px/1.28 var(--sans);letter-spacing:-.026em;color:#f2f7ff}
.prose h3{margin:36px 0 11px;font:600 19px/1.35 var(--sans);letter-spacing:-.02em;color:#eaf3ff}
.prose h4,.prose h5,.prose h6{margin:30px 0 9px;font:600 16px/1.4 var(--sans);color:var(--muted)}
.prose strong{color:#f4f8ff;font-weight:600}
.prose ul,.prose ol{padding-left:24px}
.prose li{margin:0 0 9px}
.prose li::marker{color:var(--faint)}
.prose blockquote{margin-left:0;padding:4px 0 4px 22px;border-left:2px solid rgba(125,211,252,.35);
  color:var(--muted);font-style:italic}
.prose pre{padding:18px 20px;background:rgba(3,10,26,.6);border:1px solid var(--edge);
  border-radius:12px;overflow-x:auto}
.prose code{font:13.5px/1.5 var(--mono);background:rgba(148,190,255,.12);padding:2px 6px;
  border-radius:5px;color:#cfe6ff}
.prose pre code{background:none;padding:0;font-size:13px;color:#d7e7fb}
.prose figure{margin-inline:0}
.prose figure img{border-radius:12px;display:block;border:1px solid var(--edge)}
.prose figcaption{margin-top:10px;font-size:13.5px;color:var(--faint);text-align:center}
.prose hr{border:0;height:1px;background:var(--rule);margin:44px 0}
.prose .table-wrap{overflow-x:auto}
.prose table{width:100%;border-collapse:collapse;font-size:15px}
.prose th,.prose td{padding:10px 13px;border:1px solid var(--edge);text-align:left;vertical-align:top}
.prose th{background:rgba(148,190,255,.08);font-weight:600;color:#e6f0ff}
.prose .task-list{list-style:none;padding-left:0}
.prose .task-item{display:flex;gap:11px;align-items:flex-start}
.prose .task-item.done span{color:var(--faint);text-decoration:line-through}
.prose .video{position:relative;aspect-ratio:16/9;margin:0 0 26px}
.prose .video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:12px}
.prose .cta{margin:32px 0}
.prose .cta.center{text-align:center}
.prose .btn{display:inline-block;padding:13px 28px;border-radius:10px;
  border:1px solid rgba(125,211,252,.45);background:rgba(56,189,248,.18);
  color:var(--ink);font-weight:600;font-size:16px;
  transition:background .35s var(--glide),border-color .35s var(--glide)}
.prose .btn:hover{background:rgba(56,189,248,.3);border-color:rgba(125,211,252,.75);color:#fff}
.prose .align-center{text-align:center}
.prose .align-right{text-align:right}

.share{margin:52px 0 0;padding-top:24px;position:relative;font-size:14.5px}
.share::before{content:'';position:absolute;left:0;right:0;top:0;height:1px;background:var(--rule)}
.share a{display:inline-block;padding:9px 18px;border:1px solid var(--edge);border-radius:999px;
  color:var(--muted);transition:border-color .35s var(--glide),color .35s var(--glide),
  background .35s var(--glide)}
.share a:hover{border-color:rgba(125,211,252,.5);color:var(--ink);background:rgba(56,189,248,.1)}

/* ── signup */
.subscribe{margin:72px 0 0;padding:34px;background:var(--panel);border:1px solid var(--edge);
  border-radius:var(--radius);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.subscribe h2{margin:0 0 10px;font:600 21px/1.3 var(--sans);letter-spacing:-.024em;color:#f2f7ff}
.subscribe p{margin:0 0 20px;color:var(--muted);font-size:15px}
.subscribe form{display:flex;gap:10px;flex-wrap:wrap}
.subscribe input{flex:1;min-width:200px;padding:12px 16px;border:1px solid var(--edge);
  border-radius:10px;background:rgba(3,10,26,.45);color:var(--ink);font:15px var(--sans)}
.subscribe input::placeholder{color:var(--faint)}
.subscribe input:focus{outline:0;border-color:rgba(125,211,252,.55)}
.subscribe .fine{margin:16px 0 0;font-size:13px;color:var(--faint)}

.empty{padding:90px 0;text-align:center}
.empty h1{margin:0 0 12px;font:700 34px/1.15 var(--sans);letter-spacing:-.034em;
  background:linear-gradient(178deg,#ffffff 10%,#b6cff2 92%);
  -webkit-background-clip:text;background-clip:text;color:transparent}
.empty p{color:var(--muted)}

.foot{margin:80px 0 0;padding-top:26px;position:relative;color:var(--faint);font-size:13.5px}
.foot::before{content:'';position:absolute;left:0;right:0;top:0;height:1px;background:var(--rule)}
.foot p{margin:0}

/* Phones. The page gutter is 18px and everything inside it gives its padding
   back to the text — on a 390px screen, a 20px gutter plus 22px of card padding
   was 42px of nothing on each side, which is a tenth of the display spent on
   margin. One column, tighter insets, same type size. */
@media (max-width:640px){
  .wrap{padding-left:18px;padding-right:18px}
  .cards{grid-template-columns:1fr;gap:18px}
  .card-b{padding:16px 17px 19px}
  .card h2{font-size:20px}
  .subscribe{padding:24px 18px}
  .subscribe form{gap:9px}
  .subscribe input{min-width:0;flex-basis:100%}
  .subscribe button{width:100%}
  .search{gap:8px}
  .top{padding:20px 0 18px;margin-bottom:34px}
  .masthead{margin-bottom:32px}
  .post-head{margin-bottom:26px}
  .prose{font-size:17px}
  .prose p,.prose ul,.prose ol,.prose pre,.prose blockquote,.prose figure,
  .prose .table-wrap{margin-bottom:22px}
  /* Code and images run to the gutter rather than sitting in their own inset
     box inside it — a phone has no width to spare for a second frame. */
  .prose pre{padding:14px 15px}
  .prose ul,.prose ol{padding-left:21px}
  .feature{border-radius:10px}
}
`
