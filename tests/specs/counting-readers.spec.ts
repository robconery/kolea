// Counting readers — the public site's page-view beacon, and the "Buzz" card at
// the top of the dashboard that reports it beside the list's opens and clicks.
//
// Not yet in docs/SPEC.md (that doc belongs to /design). This file is the
// executable statement of the behaviour until it gets its clauses.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { publishPost } from '../../src/core/posts.ts'
import { pageViews } from '../../src/db/schema.ts'
import { aBroadcast } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const SITE = 'https://site.example.test'
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15'

function siteWorld(): World {
  return createWorld({ SITE_URL: SITE, SITE_TITLE: 'Big Machine', SITE_AUTHOR: 'Rob Conery' })
}

async function aPost(w: World, subject: string): Promise<{ id: number; slug: string }> {
  const id = await aBroadcast(w, { subject, body: `The body of ${subject}.` })
  const post = await publishPost(w.db, id)
  return { id, slug: post.slug }
}

function hit(w: World, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return w.fetch(`${SITE}/_k/hit`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', Origin: SITE, 'User-Agent': BROWSER, ...headers },
    body: JSON.stringify(body),
  })
}

async function viewCount(w: World): Promise<number> {
  return (await w.db.select({ n: count() }).from(pageViews).get())?.n ?? 0
}

describe('Feature: the site counts its readers', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a reader arrives at a post from Hacker News and stays a while', () => {
    let w: World
    let post: { id: number; slug: string }
    let html: string
    let res: Response
    let row: typeof pageViews.$inferSelect | undefined

    beforeAll(async () => {
      w = siteWorld()
      post = await aPost(w, 'Owning your list')
      html = await (await w.fetch(`${SITE}/${post.slug}`)).text()
      res = await hit(w, {
        k: 'view-key-0001',
        p: `/${post.slug}`,
        q: '?ref=Mastodon',
        r: 'https://news.ycombinator.com/item?id=1',
        b: post.id,
      })
      await hit(w, { k: 'view-key-0001', s: 94.4 })
      row = await w.db.select().from(pageViews).where(eq(pageViews.viewKey, 'view-key-0001')).get()
    })

    it('ships the beacon inside the page', () => {
      expect(html).toContain('/_k/hit')
    })

    it('tells the beacon which post it is on', () => {
      expect(html).toContain(`b:${post.id}`)
    })

    it('answers the beacon with no content', () => {
      expect(res.status).toBe(204)
    })

    it('records the view against the post', () => {
      expect(row?.broadcastId).toBe(post.id)
    })

    it('keeps the host the reader came from', () => {
      expect(row?.referrerHost).toBe('news.ycombinator.com')
    })

    it('keeps the ref tag from the landing URL', () => {
      expect(row?.source).toBe('mastodon')
    })

    it('records how long the tab was visible', () => {
      expect(row?.seconds).toBe(94)
    })

    it('never stores the address it came from', () => {
      expect(row?.visitor).toMatch(/^[0-9a-f]{16}$/)
    })
  })

  describe('Scenario: the operator opens the dashboard after some reading', () => {
    let page: string

    beforeAll(async () => {
      const w = siteWorld()
      const post = await aPost(w, 'Why I left the ESP')
      await hit(w, { k: 'view-key-a001', p: `/${post.slug}`, r: 'https://lobste.rs/s/abc', b: post.id })
      await hit(w, { k: 'view-key-a002', p: `/${post.slug}`, r: '', b: post.id })
      await hit(w, { k: 'view-key-a003', p: '/', r: `${SITE}/writing`, b: null })
      page = await (await w.fetch('/')).text()
    })

    it('shows the Buzz card', () => {
      expect(page).toContain('Buzz · last 30 days')
    })

    it('reports the total reads', () => {
      expect(page).toContain('3 reads on the site')
    })

    it('lists the most-read post by its subject', () => {
      expect(page).toContain('Why I left the ESP')
    })

    it('names the referring site', () => {
      expect(page).toContain('lobste.rs')
    })

    it('leaves the site itself out of the referrers', () => {
      expect(page).not.toContain('site.example.test/writing')
    })

    it('plots the traffic chart', () => {
      expect(page).toContain('&quot;t&quot;:&quot;traffic&quot;')
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: a crawler runs the page', () => {
    let w: World

    beforeAll(async () => {
      w = siteWorld()
      await hit(w, { k: 'view-key-bot1', p: '/' }, { 'User-Agent': 'Googlebot/2.1' })
    })

    it('counts nothing', async () => {
      expect(await viewCount(w)).toBe(0)
    })
  })

  describe('Scenario: somebody else posts to the beacon from their own site', () => {
    let w: World

    beforeAll(async () => {
      w = siteWorld()
      await hit(w, { k: 'view-key-evil', p: '/' }, { Origin: 'https://elsewhere.example' })
    })

    it('counts nothing', async () => {
      expect(await viewCount(w)).toBe(0)
    })
  })

  describe('Scenario: the same beacon arrives twice', () => {
    let w: World

    beforeAll(async () => {
      w = siteWorld()
      await hit(w, { k: 'view-key-twice', p: '/' })
      await hit(w, { k: 'view-key-twice', p: '/' })
    })

    it('counts one view', async () => {
      expect(await viewCount(w)).toBe(1)
    })
  })

  describe('Scenario: a beacon names a broadcast that was never published', () => {
    let row: typeof pageViews.$inferSelect | undefined

    beforeAll(async () => {
      const w = siteWorld()
      const draft = await aBroadcast(w, { subject: 'Not public' })
      await hit(w, { k: 'view-key-draft', p: '/whatever', b: draft })
      row = await w.db.select().from(pageViews).get()
    })

    it('records the view without tying it to the draft', () => {
      expect(row?.broadcastId).toBeNull()
    })
  })
})
