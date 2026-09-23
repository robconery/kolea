// The front page is a landing page for the person who writes the site: the
// signup at the top, who they are, where to start, chosen topics. The archive
// moves to /writing; the long bio lives at /about. All of it is driven by the
// Site screen, falling back to the SITE_* environment variables.
//
// Not yet in docs/SPEC.md (owned by /design). This file states the behaviour.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { setPostTags, tagSlug } from '../../src/core/post-tags.ts'
import { publishPost, setPostFeatured } from '../../src/core/posts.ts'
import { broadcasts, postTags } from '../../src/db/schema.ts'
import { aBroadcast } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const SITE = 'https://site.example.test'

function siteWorld(): World {
  return createWorld({ SITE_URL: SITE, SITE_TITLE: 'Big Machine', SITE_AUTHOR: 'Rob Conery', SITE_FORM_SLUG: 'newsletter' })
}

async function aPost(w: World, subject: string, topics: string[] = []): Promise<number> {
  const id = await aBroadcast(w, { subject, body: `The body of ${subject}.` })
  await publishPost(w.db, id)
  if (topics.length) await setPostTags(w.db, id, topics)
  return id
}

const doc = (text: string) =>
  JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

async function saveSite(w: World, fields: Record<string, string | string[]>): Promise<Response> {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) form.append(k, one)
  }
  return w.fetch('/site', { method: 'POST', body: form })
}

const page = async (w: World, path: string) => (await w.fetch(`${SITE}${path}`)).text()

describe('Feature: the front page sells the writer', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a fresh install, nothing configured', () => {
    let html: string

    beforeAll(async () => {
      const w = siteWorld()
      await aPost(w, 'First Light')
      html = await page(w, '/')
    })

    it('puts the signup form in the hero', () => {
      expect(html).toContain('id="hero-email"')
    })

    it('names the site from the environment', () => {
      expect(html).toContain('Big Machine</h1>')
    })

    it('falls back to the latest posts when nothing is featured', () => {
      expect(html).toContain('First Light')
    })

    it('has no About section without a short bio', () => {
      expect(html).not.toContain('id="about-title"')
    })

    it('does not link to an About page that does not exist', () => {
      expect(html).not.toContain('href="/about"')
    })
  })

  describe('Scenario: the operator fills in the Site screen', () => {
    let w: World
    let home: string
    let about: Response

    beforeAll(async () => {
      w = siteWorld()
      await aPost(w, 'Anything')
      await saveSite(w, {
        title: 'Rob Writes',
        tagline: 'Candid notes.',
        author_name: 'Rob C',
        short_bio: 'I write about code.\n\nAnd business.',
        social_github: 'https://github.com/robconery',
        body_json: doc('The long story of how I got here.'),
      })
      home = await page(w, '/')
      about = await w.fetch(`${SITE}/about`)
    })

    it('renames the site', () => {
      expect(home).toContain('<title>Rob Writes</title>')
    })

    it('leads with the tagline', () => {
      expect(home).toContain('Candid notes.</h1>')
    })

    it('shows the short bio as paragraphs', () => {
      expect(home).toContain('<p>I write about code.</p><p>And business.</p>')
    })

    it('links to the About page', () => {
      expect(home).toContain('href="/about"')
    })

    it('lists the author’s links', () => {
      expect(home).toContain('href="https://github.com/robconery"')
    })

    it('serves the long bio at /about', async () => {
      expect(await about.text()).toContain('The long story of how I got here.')
    })
  })

  describe('Scenario: a blank field on the Site screen', () => {
    let html: string

    beforeAll(async () => {
      const w = siteWorld()
      await saveSite(w, { title: '', short_bio: 'Hi.' })
      html = await page(w, '/')
    })

    it('keeps the environment’s value', () => {
      expect(html).toContain('Big Machine</h1>')
    })
  })

  describe('Scenario: featuring posts', () => {
    let html: string

    beforeAll(async () => {
      const w = siteWorld()
      const older = await aPost(w, 'Older Pick')
      await aPost(w, 'Not Picked')
      const newer = await aPost(w, 'Newer Pick')
      await setPostFeatured(w.db, older, true)
      await setPostFeatured(w.db, newer, true)
      html = await page(w, '/')
    })

    it('fills "Start here"', () => {
      expect(html).toContain('Start here')
    })

    it('lists featured posts newest first', () => {
      expect(html.indexOf('Newer Pick')).toBeLessThan(html.indexOf('Older Pick'))
    })

    it('leaves unfeatured posts out', () => {
      expect(html).not.toContain('Not Picked')
    })
  })

  describe('Scenario: featuring a post from its Publishing screen', () => {
    let featured: boolean | undefined

    beforeAll(async () => {
      const w = siteWorld()
      const id = await aBroadcast(w, { subject: 'Pick Me' })
      await w.post(`/broadcasts/${id}/publish`, { slug: '', excerpt: '', tags: '', featured: 'on' })
      featured = (await w.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get())?.featured
    })

    it('marks it featured', () => {
      expect(featured).toBe(true)
    })
  })

  describe('Scenario: choosing topics for the front page', () => {
    let before: string
    let after: string

    beforeAll(async () => {
      const w = siteWorld()
      await aPost(w, 'Agents', ['AI'])
      await aPost(w, 'Joins', ['Databases'])
      before = await page(w, '/')
      const ai = await w.db.select().from(postTags).where(eq(postTags.slug, 'ai')).get()
      await saveSite(w, { home_topics: [String(ai?.id)] })
      after = await page(w, '/')
    })

    it('shows no topic shelves by default', () => {
      expect(before).not.toContain('id="shelf-ai"')
    })

    it('shows a shelf for a ticked topic', () => {
      expect(after).toContain('id="shelf-ai"')
    })

    it('leaves unticked topics off', () => {
      expect(after).not.toContain('id="shelf-databases"')
    })
  })

  describe('Scenario: the archive', () => {
    let w: World

    beforeAll(async () => {
      w = siteWorld()
      await aPost(w, 'In The Archive')
    })

    it('lives at /writing', async () => {
      expect(await page(w, '/writing')).toContain('In The Archive')
    })

    it('sends the old /page/2 to /writing/page/2', async () => {
      const res = await w.fetch(`${SITE}/page/2`)
      expect(res.headers.get('location')).toBe('/writing/page/2')
    })

    it('sends the old /?page=2 to /writing/page/2', async () => {
      const res = await w.fetch(`${SITE}/?page=2`)
      expect(res.headers.get('location')).toBe('/writing/page/2')
    })

    it('lists /writing in the sitemap', async () => {
      expect(await page(w, '/sitemap.xml')).toContain(`${SITE}/writing</loc>`)
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: /about with no long bio', () => {
    let res: Response

    beforeAll(async () => {
      const w = siteWorld()
      await saveSite(w, { short_bio: 'Short only.' })
      res = await w.fetch(`${SITE}/about`)
    })

    it('is a 404', () => {
      expect(res.status).toBe(404)
    })
  })

  describe('Scenario: a topic named like the new pages', () => {
    it('cannot take /about', () => {
      expect(tagSlug('About')).toBe('about-tag')
    })

    it('cannot take /writing', () => {
      expect(tagSlug('Writing')).toBe('writing-tag')
    })
  })
})
