// Theming the public site — Handlebars themes, Ghost-compatible, and the
// opinionated URL scheme: a post's primary topic is its first URL segment.
//
// Not yet in docs/SPEC.md (that doc belongs to /design). This file is the
// executable statement of the behaviour until it gets its clauses.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { strToU8, zipSync } from 'fflate'
import { setPostTags, tagSlug } from '../../src/core/post-tags.ts'
import { publishPost } from '../../src/core/posts.ts'
import { helpers } from '../../src/core/theme/helpers.ts'
import { renderString } from '../../src/core/theme/interpreter.ts'
import { parse, TemplateSyntaxError } from '../../src/core/theme/parser.ts'
import { installThemeZip, ThemeInstallError } from '../../src/core/theme/store.ts'
import { postTags, subscriberTags, tags, themeFiles, themes } from '../../src/db/schema.ts'
import { aBroadcast } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const SITE = 'https://site.example.test'

function siteWorld(): World {
  return createWorld({ SITE_URL: SITE, SITE_TITLE: 'Big Machine', SITE_AUTHOR: 'Rob Conery', SITE_FORM_SLUG: 'newsletter' })
}

async function aPost(w: World, subject: string, topics: string[] = []): Promise<{ id: number; slug: string }> {
  const id = await aBroadcast(w, { subject, body: `The body of ${subject}.` })
  const post = await publishPost(w.db, id)
  if (topics.length) await setPostTags(w.db, id, topics)
  return { id, slug: post.slug }
}

/** A minimal Ghost-shaped theme, zipped the way GitHub's "Download ZIP" does it. */
function ghostThemeZip(files: Record<string, string> = {}, wrapper = 'Tiny-main/'): Uint8Array {
  const all: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'tiny',
      version: '2.1.0',
      config: {
        posts_per_page: 5,
        custom: { header_style: { type: 'select', options: ['Center', 'Left'], default: 'Center' } },
      },
    }),
    'default.hbs':
      '<!doctype html><html><head><title>{{meta_title}}</title><link rel="stylesheet" href="{{asset "built/screen.css"}}">{{ghost_head}}</head><body class="{{body_class}}">{{{body}}}{{ghost_foot}}</body></html>',
    'index.hbs':
      '{{!< default}}<h1 class="tiny-{{@custom.header_style}}">{{@site.title}}</h1>{{#foreach posts}}{{> "post-card"}}{{/foreach}}{{pagination}}',
    'post.hbs':
      '{{!< default}}{{#post}}<article class="{{post_class}}"><h1>{{title}}</h1>{{#if primary_tag}}<a class="topic" href="{{primary_tag.url}}">{{primary_tag.name}}</a>{{/if}}{{content}}</article>{{/post}}{{#get "posts" filter="id:-{{post.id}}" limit="3" as |more|}}<aside>{{#foreach more}}<a class="more" href="{{url}}">{{title}}</a>{{/foreach}}</aside>{{/get}}',
    'partials/post-card.hbs': '<a class="card" href="{{url}}">{{title}} · {{date format="YYYY"}}</a>',
    'assets/built/screen.css': 'body{color:rebeccapurple}',
    'README.md': 'not part of the theme',
    ...files,
  }
  return zipSync(Object.fromEntries(Object.entries(all).map(([k, v]) => [`${wrapper}${k}`, strToU8(v)])))
}

async function uploadTheme(w: World, zip: Uint8Array): Promise<Response> {
  const form = new FormData()
  form.set('file', new File([zip as unknown as ArrayBuffer], 'theme.zip', { type: 'application/zip' }))
  return w.fetch('/themes/upload', { method: 'POST', body: form })
}

describe('Feature: the public site renders through a theme', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a reader opens the archive on a fresh install', () => {
    let res: Response
    let html: string

    beforeAll(async () => {
      const w = siteWorld()
      await aPost(w, 'Hello World')
      res = await w.fetch(`${SITE}/`)
      html = await res.text()
    })

    it('answers 200', () => {
      expect(res.status).toBe(200)
    })

    it('lists the post', () => {
      expect(html).toContain('Hello World')
    })

    it('renders with Folio, the default built-in theme', () => {
      expect(html).toMatch(/href="\/assets\/folio\.css\?v=/)
    })

    it('carries a canonical link from ghost_head', () => {
      expect(html).toContain(`<link rel="canonical" href="${SITE}/">`)
    })

    it('shows the signup form posting to the ordinary form endpoint', () => {
      expect(html).toContain('action="https://mail.example.test/f/newsletter"')
    })
  })

  describe('Scenario: the built-in theme serves its own stylesheet', () => {
    let res: Response

    beforeAll(async () => {
      const w = siteWorld()
      res = await w.fetch(`${SITE}/assets/folio.css?v=x`)
    })

    it('answers with CSS', () => {
      expect(res.headers.get('content-type')).toContain('text/css')
    })
  })
})

describe('Feature: a post’s primary topic is its URL', () => {
  describe('Scenario: a post tagged AI', () => {
    let w: World
    let slug: string

    beforeAll(async () => {
      w = siteWorld()
      ;({ slug } = await aPost(w, 'Agents Are Here', ['AI', 'Opinion']))
    })

    it('lives under its primary topic', async () => {
      const res = await w.fetch(`${SITE}/ai/${slug}`)
      expect(res.status).toBe(200)
    })

    it('renders the topic onto the page', async () => {
      const html = await (await w.fetch(`${SITE}/ai/${slug}`)).text()
      expect(html).toContain('>AI</a>')
    })

    it('⭐ redirects the bare slug — the shape every sent “read online” link has — to the topic URL', async () => {
      const res = await w.fetch(`${SITE}/${slug}`)
      expect(res.headers.get('location')).toBe(`/ai/${slug}`)
    })

    it('redirects a stale topic in the URL to the live one', async () => {
      const res = await w.fetch(`${SITE}/opinion/${slug}`)
      expect(res.headers.get('location')).toBe(`/ai/${slug}`)
    })

    it('permanently', async () => {
      const res = await w.fetch(`${SITE}/opinion/${slug}`)
      expect(res.status).toBe(301)
    })

    it('lists it on the topic’s archive', async () => {
      const html = await (await w.fetch(`${SITE}/ai`)).text()
      expect(html).toContain('Agents Are Here')
    })

    it('lists it under a secondary topic too', async () => {
      const html = await (await w.fetch(`${SITE}/opinion`)).text()
      expect(html).toContain('Agents Are Here')
    })

    it('puts the topic URL in the sitemap', async () => {
      const xml = await (await w.fetch(`${SITE}/sitemap.xml`)).text()
      expect(xml).toContain(`${SITE}/ai/${slug}`)
    })

    it('puts the topic URL in the feed', async () => {
      const xml = await (await w.fetch(`${SITE}/feed.xml`)).text()
      expect(xml).toContain(`<link>${SITE}/ai/${slug}</link>`)
    })
  })

  describe('Scenario: a post with no topic', () => {
    let res: Response

    beforeAll(async () => {
      const w = siteWorld()
      const { slug } = await aPost(w, 'Untagged Thoughts')
      res = await w.fetch(`${SITE}/${slug}`)
    })

    it('lives at the root', () => {
      expect(res.status).toBe(200)
    })
  })

  describe('Scenario: tagging a post', () => {
    let w: World

    beforeAll(async () => {
      w = siteWorld()
      await aPost(w, 'Anything', ['Customer', 'ruby'])
    })

    it('⭐ never touches subscriber tags', async () => {
      const n = (await w.db.select({ n: count() }).from(tags).get())?.n
      expect(n).toBe(0)
    })

    it('⭐ never tags a person', async () => {
      const n = (await w.db.select({ n: count() }).from(subscriberTags).get())?.n
      expect(n).toBe(0)
    })

    it('creates post topics instead', async () => {
      const n = (await w.db.select({ n: count() }).from(postTags).get())?.n
      expect(n).toBe(2)
    })
  })

  describe('Scenario: a topic named like a fixed route', () => {
    it('gets a slug that cannot shadow it', () => {
      expect(tagSlug('Author')).toBe('author-tag')
    })
  })

  describe('Scenario: old archive URLs', () => {
    let w: World

    beforeAll(async () => {
      w = siteWorld()
    })

    it('sends ?q= to the search page', async () => {
      const res = await w.fetch(`${SITE}/?q=agents`)
      expect(res.headers.get('location')).toBe('/search?q=agents')
    })

    it('sends a trailing slash to the canonical URL', async () => {
      const res = await w.fetch(`${SITE}/ai/`)
      expect(res.headers.get('location')).toBe('/ai')
    })
  })

  describe('Scenario: a URL that is nothing', () => {
    let res: Response

    beforeAll(async () => {
      const w = siteWorld()
      res = await w.fetch(`${SITE}/no-such-thing`)
    })

    it('is a 404', () => {
      expect(res.status).toBe(404)
    })

    it('rendered by the theme', async () => {
      expect(await res.text()).toContain("This page isn't in the book.")
    })
  })
})

describe('Feature: the built-in themes', () => {
  describe('Scenario: the operator opens the Themes screen', () => {
    let names: string[]

    beforeAll(async () => {
      const w = siteWorld()
      await w.fetch('/themes')
      names = (await w.db.select({ name: themes.name }).from(themes).all()).map((r) => r.name).sort()
    })

    it('lists Folio and Signal as themes of their own', () => {
      expect(names).toEqual(['folio', 'signal'])
    })
  })

  describe('Scenario: switching to Signal', () => {
    let html: string

    beforeAll(async () => {
      const w = siteWorld()
      await aPost(w, 'Loud Story', ['AI'])
      await w.fetch('/themes')
      const row = await w.db.select().from(themes).where(eq(themes.name, 'signal')).get()
      await w.fetch(`/themes/${row?.id}/activate`, { method: 'POST' })
      html = await (await w.fetch(`${SITE}/ai/loud-story`)).text()
    })

    it('renders the post with Signal', () => {
      expect(html).toMatch(/href="\/assets\/signal\.css\?v=/)
    })

    it('floods it in its topic’s hue', () => {
      expect(html).toContain('<article class="feature" style="--hue: 28">')
    })
  })

  describe('Scenario: trying to delete a built-in theme', () => {
    let remaining: number

    beforeAll(async () => {
      const w = siteWorld()
      await w.fetch('/themes')
      const row = await w.db.select().from(themes).where(eq(themes.name, 'folio')).get()
      await w.fetch(`/themes/${row?.id}/delete`, { method: 'POST' })
      remaining = (await w.db.select({ n: count() }).from(themes).get())?.n ?? 0
    })

    it('keeps it', () => {
      expect(remaining).toBe(2)
    })
  })

  describe('Scenario: uploading a theme that claims a built-in’s name', () => {
    let error: unknown

    beforeAll(async () => {
      const w = siteWorld()
      const zip = ghostThemeZip({ 'package.json': JSON.stringify({ name: 'folio', version: '9.9.9' }) })
      error = await installThemeZip(w.db, w.env.MEDIA, zip).catch((e) => e)
    })

    it('is refused', () => {
      expect(error).toBeInstanceOf(ThemeInstallError)
    })
  })
})

describe('Feature: installing a Ghost theme', () => {
  describe('Scenario: the operator uploads and activates a theme', () => {
    let w: World
    let upload: Response
    let html: string
    let postHtml: string

    beforeAll(async () => {
      w = siteWorld()
      await aPost(w, 'First Post', ['Databases'])
      const { slug } = await aPost(w, 'Second Post', ['Databases'])
      upload = await uploadTheme(w, ghostThemeZip())
      const row = await w.db.select().from(themes).where(eq(themes.name, 'tiny')).get()
      await w.fetch(`/themes/${row?.id}/activate`, { method: 'POST' })
      html = await (await w.fetch(`${SITE}/`)).text()
      postHtml = await (await w.fetch(`${SITE}/databases/${slug}`)).text()
    })

    it('redirects back to the Themes screen', () => {
      expect(upload.headers.get('location')).toStartWith('/themes?flash=Installed')
    })

    it('renders the archive with the theme’s index.hbs', () => {
      expect(html).toContain('<h1 class="tiny-Center">Big Machine</h1>')
    })

    it('renders the theme’s partials', () => {
      expect(html).toContain('class="card" href="/databases/first-post"')
    })

    it('marks the page as the home page for the theme', () => {
      expect(html).toContain('class="home-template"')
    })

    it('points {{asset}} at the site’s asset route', () => {
      expect(html).toMatch(/href="\/assets\/built\/screen\.css\?v=/)
    })

    it('renders a post with post.hbs', () => {
      expect(postHtml).toContain('<article class="post no-image tag-databases"><h1>Second Post</h1>')
    })

    it('answers {{#get}} with the other posts, filtered by the post’s id', () => {
      expect(postHtml).toContain('<a class="more" href="/databases/first-post">First Post</a>')
    })

    it('leaves the post being read out of {{#get}}', () => {
      expect(postHtml).not.toContain('class="more" href="/databases/second-post"')
    })

    it('serves the theme’s assets from R2', async () => {
      const res = await w.fetch(`${SITE}/assets/built/screen.css?v=1`)
      expect(await res.text()).toBe('body{color:rebeccapurple}')
    })

    it('keeps build tooling out of the theme', async () => {
      const paths = (await w.db.select({ path: themeFiles.path }).from(themeFiles).all()).map((r) => r.path)
      expect(paths).not.toContain('README.md')
    })
  })

  describe('Scenario: saving a theme setting', () => {
    let html: string

    beforeAll(async () => {
      const w = siteWorld()
      await aPost(w, 'Anything')
      await uploadTheme(w, ghostThemeZip())
      const row = await w.db.select().from(themes).where(eq(themes.name, 'tiny')).get()
      await w.fetch(`/themes/${row?.id}/activate`, { method: 'POST' })
      await w.post(`/themes/${row?.id}/settings`, { header_style: 'Left' })
      html = await (await w.fetch(`${SITE}/`)).text()
    })

    it('reaches the template as @custom', () => {
      expect(html).toContain('class="tiny-Left"')
    })
  })

  describe('Scenario: deleting the live theme', () => {
    let html: string

    beforeAll(async () => {
      const w = siteWorld()
      await aPost(w, 'Still Here')
      await uploadTheme(w, ghostThemeZip())
      const row = await w.db.select().from(themes).where(eq(themes.name, 'tiny')).get()
      await w.fetch(`/themes/${row?.id}/activate`, { method: 'POST' })
      await w.fetch(`/themes/${row?.id}/delete`, { method: 'POST' })
      html = await (await w.fetch(`${SITE}/`)).text()
    })

    it('⭐ falls back to the built-in theme rather than a blank site', () => {
      expect(html).toContain('/assets/folio.css')
    })
  })

  describe('Scenario: a theme that uses a helper Kōlea does not have', () => {
    let unknown: string[]

    beforeAll(async () => {
      const w = siteWorld()
      const r = await installThemeZip(
        w.db,
        w.env.MEDIA,
        ghostThemeZip({ 'index.hbs': '{{!< default}}{{#tiers_list limit="3"}}x{{/tiers_list}}{{price plan}}' }),
      )
      unknown = r.unknownHelpers
    })

    it('installs, and names it', () => {
      expect(unknown).toEqual(['tiers_list'])
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: a zip that is not a theme', () => {
    let w: World
    let error: unknown

    beforeAll(async () => {
      w = siteWorld()
      const zip = zipSync({ 'package.json': strToU8('{"name":"broken"}'), 'index.hbs': strToU8('hi') })
      error = await installThemeZip(w.db, w.env.MEDIA, zip).catch((e) => e)
    })

    it('is refused', () => {
      expect(error).toBeInstanceOf(ThemeInstallError)
    })

    it('writes nothing', async () => {
      const n = (await w.db.select({ n: count() }).from(themes).get())?.n
      expect(n).toBe(0)
    })
  })

  describe('Scenario: a theme with a template that does not parse', () => {
    let error: ThemeInstallError

    beforeAll(async () => {
      const w = siteWorld()
      error = (await installThemeZip(
        w.db,
        w.env.MEDIA,
        ghostThemeZip({ 'tag.hbs': '{{#if tag}}unclosed' }),
      ).catch((e) => e)) as ThemeInstallError
    })

    it('is refused, naming the file', () => {
      expect(error.details[0]).toStartWith('tag.hbs:')
    })
  })

  describe('Scenario: a zip with an entry that climbs out of the theme', () => {
    let paths: string[]

    beforeAll(async () => {
      const w = siteWorld()
      await installThemeZip(w.db, w.env.MEDIA, ghostThemeZip({ '../../escape.hbs': 'x' }, ''))
      paths = (await w.db.select({ path: themeFiles.path }).from(themeFiles).all()).map((r) => r.path)
    })

    it('⭐ drops the entry', () => {
      expect(paths.some((p) => p.includes('escape'))).toBe(false)
    })
  })
})

describe('Feature: the template language', () => {
  describe('Scenario: printing values', () => {
    it('escapes by default', async () => {
      expect(await renderString('{{x}}', { x: '<script>' })).toBe('&lt;script&gt;')
    })

    it('does not escape the triple-stash', async () => {
      expect(await renderString('{{{x}}}', { x: '<b>' })).toBe('<b>')
    })

    it('⭐ cannot reach the prototype chain', async () => {
      expect(await renderString('{{constructor.constructor}}{{__proto__.x}}', {})).toBe('')
    })
  })

  describe('Scenario: Ghost’s blocks', () => {
    it('iterates with @number and @last', async () => {
      const out = await renderString('{{#foreach xs}}{{@number}}{{#unless @last}},{{/unless}}{{/foreach}}', { xs: [1, 2, 3] }, { helpers })
      expect(out).toBe('1,2,3')
    })

    it('chains else-if', async () => {
      const out = await renderString('{{#if a}}a{{else if b}}b{{else}}c{{/if}}', { b: true }, { helpers })
      expect(out).toBe('b')
    })

    it('compares with match', async () => {
      const out = await renderString('{{#match n ">" 2}}big{{else}}small{{/match}}', { n: 3 }, { helpers })
      expect(out).toBe('big')
    })

    it('reaches the parent context with ../', async () => {
      const out = await renderString('{{#foreach xs}}{{../name}}{{/foreach}}', { name: 'n', xs: [1, 2] }, { helpers })
      expect(out).toBe('nn')
    })

    it('binds block params', async () => {
      const out = await renderString('{{#each xs as |x i|}}{{i}}{{x}}{{/each}}', { xs: ['a', 'b'] }, { helpers })
      expect(out).toBe('0a1b')
    })

    it('formats dates with moment tokens', async () => {
      const out = await renderString('{{date d format="D MMM YYYY"}}', { d: '2026-09-22T00:00:00Z' }, { helpers })
      expect(out).toBe('22 Sep 2026')
    })
  })

  describe('Scenario: a mustache inside a quoted argument', () => {
    it('parses as one tag, the way Ghost themes write {{#get}} filters', () => {
      const body = parse('{{#get "posts" filter="id:-{{id}}" as |p|}}{{/get}}').body
      expect(body.length).toBe(1)
    })
  })

  describe('Scenario: a partial block with a computed name, the way Casper writes one', () => {
    it('accepts Handlebars’ own {{/undefined}} closer', async () => {
      const src = '{{#> (concat "icons/" type)}}<span>{{name}}</span>{{/undefined}}'
      expect(await renderString(src, { type: 'x', name: 'X' }, { helpers })).toBe('<span>X</span>')
    })
  })

  describe('Scenario: a block closed by the wrong name', () => {
    it('is a syntax error with a line number', () => {
      expect(() => parse('{{#if x}}\n{{/each}}')).toThrow(TemplateSyntaxError)
    })
  })
})
