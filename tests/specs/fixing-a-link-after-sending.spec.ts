// SPEC 5.15 — a link in sent mail can be fixed, and delivered copies follow it
//
// Mail that has gone out cannot be edited. Every tracked link in it comes back
// through /t/click first, though, so a fix is a row the click route reads: the
// reader of a copy delivered last week lands on the corrected page. The stored
// body is rewritten as well, so the web page and a resumed send are right
// without the redirect. Recording the click must still never break it (5.4).
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { getBroadcast, startBroadcast } from '../../src/core/broadcasts.ts'
import { publishPost } from '../../src/core/posts.ts'
import { createTagRule } from '../../src/core/tagging.ts'
import { events, linkFixes, messages, subscriberTags, tags } from '../../src/db/schema.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { MCP_SECRET, type ToolReply, agentFor } from '../support/mcp.ts'
import { createWorld, type World } from '../support/world.ts'

const SITE = 'https://site.example.test'
const OLD = 'http://localhost:5555/courses'
const NEW = 'https://example.com/courses'
const OTHER = 'https://example.com/notes'
const BODY = `Start the course: [open it](${OLD})\n\nOr read [the notes](${OTHER}).`

interface Sent {
  w: World
  id: number
  messageId: number
}

/** One reader, one broadcast with a dev link in it, already delivered. */
async function aSentBroadcast(overrides: Parameters<typeof createWorld>[0] = {}): Promise<Sent> {
  const w = createWorld(overrides)
  await aPerson(w, { email: 'reader@example.test' })
  const id = await aBroadcast(w, { subject: 'The course is open', body: BODY })
  await startBroadcast(w.env, w.db, id)
  await w.tick()
  const messageId = (await w.db.select({ id: messages.id }).from(messages).get())!.id
  return { w, id, messageId }
}

/** A reader clicking a link in their delivered copy. */
const click = (s: Sent, url: string) =>
  s.w.fetch(`/t/click/${s.messageId}?u=${encodeURIComponent(url)}`, { redirect: 'manual' })

const fix = (s: Sent, from: string, to: string) =>
  s.w.post(`/broadcasts/${s.id}/links/fix`, { fix_from: from, fix_to: to, subject: 'ignored', body: 'ignored' })

describe('Feature: fixing a link after sending', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the operator fixes a link in the console', () => {
    let s: Sent
    let saved: Response
    let redirected: Response
    let other: Response
    let clicked: typeof events.$inferSelect | undefined

    beforeAll(async () => {
      s = await aSentBroadcast()
      saved = await fix(s, OLD, NEW)
      redirected = await click(s, OLD)
      other = await click(s, OTHER)
      clicked = await s.w.db.select().from(events).where(eq(events.type, 'click')).get()
    })

    it('says it is fixed and nothing was sent', () => {
      expect(decodeURIComponent(saved.headers.get('location') ?? '')).toContain('Nothing was sent.')
    })

    it('⭐ a click from the delivered copy goes to the corrected link', () => {
      expect(redirected.headers.get('location')).toBe(NEW)
    })

    it('a click on a link that was not fixed goes where it says', () => {
      expect(other.headers.get('location')).toBe(OTHER)
    })

    it('records the click against the link as mailed', () => {
      expect(clicked?.meta.url).toBe(OLD)
    })

    it('records where the reader was sent', () => {
      expect(clicked?.meta.fixed_to).toBe(NEW)
    })

    it('rewrites the link in the stored body', async () => {
      expect((await getBroadcast(s.w.db, s.id))?.bodyMd).toContain(NEW)
    })

    it('leaves no copy of the old link in the stored body', async () => {
      expect((await getBroadcast(s.w.db, s.id))?.bodyMd).not.toContain(OLD)
    })

    it('keeps the copy as mailed', async () => {
      expect((await getBroadcast(s.w.db, s.id))?.originalBodyMd).toContain(OLD)
    })

    it('ignores the rest of the composer form that rode along', async () => {
      expect((await getBroadcast(s.w.db, s.id))?.subject).toBe('The course is open')
    })

    it('⭐ sends nothing', async () => {
      expect(await s.w.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: the sent broadcast’s screen', () => {
    let before: string
    let after: string

    beforeAll(async () => {
      const s = await aSentBroadcast()
      await click(s, OLD)
      before = await (await s.w.fetch(`/broadcasts/${s.id}`)).text()
      await fix(s, OLD, NEW)
      after = await (await s.w.fetch(`/broadcasts/${s.id}`)).text()
    })

    it('has a Fix a link section', () => {
      expect(before).toContain('Fix a link')
    })

    it('lists the links with how many clicked', () => {
      expect(before).toContain('· 1 click')
    })

    it('posts the fix without saving the editor', () => {
      expect(before).toMatch(/formaction="\/broadcasts\/\d+\/links\/fix"/)
    })

    it('shows where a fixed link goes now', () => {
      expect(after).toContain(`→ <span class="mono" style="word-break:break-all">${NEW}</span>`)
    })

    it('offers to remove the fix', () => {
      expect(after).toContain('Remove fix')
    })
  })

  describe('Scenario: a draft has nothing to fix', () => {
    let page: string

    beforeAll(async () => {
      const w = createWorld()
      const id = await aBroadcast(w, { body: BODY })
      page = await (await w.fetch(`/broadcasts/${id}`)).text()
    })

    it('shows no Fix a link section', () => {
      expect(page).not.toContain('Fix a link')
    })
  })

  describe('Scenario: the broadcast is also a post', () => {
    let page: string

    beforeAll(async () => {
      const s = await aSentBroadcast({ SITE_URL: SITE })
      const post = await publishPost(s.w.db, s.id)
      await fix(s, OLD, NEW)
      page = await (await s.w.fetch(`${SITE}/${post.slug}`)).text()
    })

    it('the web page carries the corrected link', () => {
      expect(page).toContain(NEW)
    })

    it('the web page no longer carries the old one', () => {
      expect(page).not.toContain(OLD)
    })
  })

  describe('Scenario: a tag rule written for the old link', () => {
    let tagged: number

    beforeAll(async () => {
      const s = await aSentBroadcast()
      await createTagRule(s.w.db, { name: 'Course clickers', event: 'click', tagName: 'course', urlContains: 'localhost:5555' })
      await fix(s, OLD, NEW)
      await click(s, OLD)
      tagged = (await s.w.db.select().from(subscriberTags).innerJoin(tags, eq(tags.id, subscriberTags.tagId)).all()).length
    })

    it('still tags a reader who clicks it in a delivered copy', () => {
      expect(tagged).toBe(1)
    })
  })

  describe('Scenario: a tag rule written for the corrected link', () => {
    let tagged: number

    beforeAll(async () => {
      const s = await aSentBroadcast()
      await createTagRule(s.w.db, { name: 'Course clickers', event: 'click', tagName: 'course', urlContains: 'example.com/courses' })
      await fix(s, OLD, NEW)
      await click(s, OLD)
      tagged = (await s.w.db.select().from(subscriberTags).all()).length
    })

    it('tags a reader whose old copy was redirected to it', () => {
      expect(tagged).toBe(1)
    })
  })

  describe('Scenario: fixing the fixed link again', () => {
    let s: Sent
    let res: Response

    beforeAll(async () => {
      s = await aSentBroadcast()
      await fix(s, OLD, NEW)
      await fix(s, NEW, 'https://example.com/courses/start')
      res = await click(s, OLD)
    })

    it('a click on the original link goes to the latest correction', () => {
      expect(res.headers.get('location')).toBe('https://example.com/courses/start')
    })

    it('the body carries the latest correction', async () => {
      expect((await getBroadcast(s.w.db, s.id))?.bodyMd).toContain('https://example.com/courses/start')
    })
  })

  describe('Scenario: removing a fix', () => {
    let res: Response
    let s: Sent

    beforeAll(async () => {
      s = await aSentBroadcast()
      await fix(s, OLD, NEW)
      const row = (await s.w.db.select().from(linkFixes).get())!
      await s.w.post(`/broadcasts/${s.id}/links/${row.id}/remove`, {})
      res = await click(s, OLD)
    })

    it('clicks go where the delivered link says again', () => {
      expect(res.headers.get('location')).toBe(OLD)
    })

    it('the body keeps the corrected link', async () => {
      expect((await getBroadcast(s.w.db, s.id))?.bodyMd).toContain(NEW)
    })
  })

  describe('Scenario: an agent fixes a link', () => {
    let s: Sent
    let listed: ToolReply
    let fixed: ToolReply
    let res: Response

    beforeAll(async () => {
      s = await aSentBroadcast({ MCP_PATH_SECRET: MCP_SECRET })
      await click(s, OLD)
      const agent = await agentFor(s.w)
      listed = await agent.call('broadcast_links', { id: s.id })
      fixed = await agent.call('broadcast_fix_link', { id: s.id, from_url: OLD, to_url: NEW })
      res = await click(s, OLD)
    })

    it('broadcast_links lists the link with its clicks', () => {
      expect(listed.json[0]).toEqual({ url: OLD, clicks: 1, inBody: true, fixedTo: null })
    })

    it('broadcast_fix_link says nothing was sent', () => {
      expect(fixed.json.sent).toBe(0)
    })

    it('⭐ the next click goes to the corrected link', () => {
      expect(res.headers.get('location')).toBe(NEW)
    })
  })

  describe('Scenario: an agent removes a fix', () => {
    let res: Response

    beforeAll(async () => {
      const s = await aSentBroadcast({ MCP_PATH_SECRET: MCP_SECRET })
      const agent = await agentFor(s.w)
      await agent.call('broadcast_fix_link', { id: s.id, from_url: OLD, to_url: NEW })
      await agent.call('broadcast_remove_link_fix', { id: s.id, from_url: OLD })
      res = await click(s, OLD)
    })

    it('clicks go where the delivered link says again', () => {
      expect(res.headers.get('location')).toBe(OLD)
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: the corrected link is itself a dev link', () => {
    let s: Sent
    let res: Response

    beforeAll(async () => {
      s = await aSentBroadcast()
      res = await fix(s, OLD, 'http://localhost:5556/courses')
    })

    it('is refused, saying why', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('only opens on your own computer')
    })

    it('writes no fix', async () => {
      expect(await s.w.db.select().from(linkFixes).all()).toHaveLength(0)
    })

    it('leaves the body alone', async () => {
      expect((await getBroadcast(s.w.db, s.id))?.bodyMd).toBe(BODY)
    })
  })

  describe('Scenario: the corrected link is not a web link', () => {
    let s: Sent

    beforeAll(async () => {
      s = await aSentBroadcast()
      await fix(s, OLD, 'ftp://example.com/courses')
    })

    it('writes no fix', async () => {
      expect(await s.w.db.select().from(linkFixes).all()).toHaveLength(0)
    })
  })

  describe('Scenario: a link that is not in the broadcast', () => {
    let s: Sent
    let res: Response

    beforeAll(async () => {
      s = await aSentBroadcast()
      res = await fix(s, 'https://example.com/never-mailed', NEW)
    })

    it('is refused', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('not in this broadcast')
    })

    it('writes no fix', async () => {
      expect(await s.w.db.select().from(linkFixes).all()).toHaveLength(0)
    })
  })

  describe('Scenario: a broadcast that has not been sent', () => {
    let w: World

    beforeAll(async () => {
      w = createWorld()
      const id = await aBroadcast(w, { body: BODY })
      await w.post(`/broadcasts/${id}/links/fix`, { fix_from: OLD, fix_to: NEW })
    })

    it('writes no fix: a draft is fixed by editing it', async () => {
      expect(await w.db.select().from(linkFixes).all()).toHaveLength(0)
    })
  })

  describe('Scenario: the fix cannot be looked up', () => {
    let res: Response

    beforeAll(async () => {
      const s = await aSentBroadcast()
      await fix(s, OLD, NEW)
      // The worst case: the table the lookup reads is not there at all.
      await s.w.db.run(sql`drop table link_fixes`)
      res = await click(s, OLD)
    })

    it('⭐ still redirects, to the link as written', () => {
      expect(res.headers.get('location')).toBe(OLD)
    })
  })
})
