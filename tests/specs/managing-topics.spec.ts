// gap.md → Public site and members → "Topics": topics (post tags) as managed
// objects — a screen listing them with their post counts, their name,
// description and front-page shelf editable there and over MCP (topic_list,
// topic_update).
// Kōlea SPEC 15.3.1 (topics are not subscriber tags; names match case- and
// space-insensitively), 15.3.2 (public only with a published post; the
// description is on the archive and in its meta description).
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { setPostTags, tagsForPost } from '../../src/core/post-tags.ts'
import { publishPost } from '../../src/core/posts.ts'
import { postTags, tags } from '../../src/db/schema.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { MCP_SECRET, type ToolReply, agentFor } from '../support/mcp.ts'
import { createWorld, type World } from '../support/world.ts'

const SITE = 'https://site.example.test'

const topicWorld = () =>
  createWorld({ SITE_URL: SITE, SITE_TITLE: 'Big Machine', SITE_AUTHOR: 'Rob Conery', MCP_PATH_SECRET: MCP_SECRET })

/** Two posts tagged AI, one of them live. */
async function aiTopic(w: World): Promise<number> {
  const live = await aBroadcast(w, { subject: 'Live one' })
  await publishPost(w.db, live)
  await setPostTags(w.db, live, ['AI'])
  const draft = await aBroadcast(w, { subject: 'Not up yet' })
  await setPostTags(w.db, draft, ['AI'])
  return (await w.db.select().from(postTags).where(eq(postTags.slug, 'ai')).get())!.id
}

const topic = async (w: World, id: number) => (await w.db.select().from(postTags).where(eq(postTags.id, id)).get())!

describe('Feature: managing topics', () => {
  describe('Scenario: the operator opens Topics', () => {
    let html: string

    beforeAll(async () => {
      const w = topicWorld()
      await aiTopic(w)
      html = await (await w.fetch('/topics')).text()
    })

    it('lists the topic by name', () => {
      expect(html).toContain('value="AI"')
    })

    it('shows its URL segment', () => {
      expect(html).toContain('/ai</a>')
    })

    it('counts the posts that are not up yet apart', () => {
      expect(html).toContain('1 not up')
    })

    it('is in the menu', () => {
      expect(html).toContain('href="/topics"')
    })
  })

  describe('Scenario: the operator renames a topic, describes it and gives it a shelf', () => {
    let w: World
    let id: number
    let res: Response

    beforeAll(async () => {
      w = topicWorld()
      id = await aiTopic(w)
      res = await w.post(`/topics/${id}`, {
        name: 'Machine learning',
        description: 'Notes on models and the people who build them.',
        show_on_home: '1',
      })
    })

    it('saves the name', async () => {
      expect((await topic(w, id)).name).toBe('Machine learning')
    })

    it('⭐ keeps the slug, so no URL breaks', async () => {
      expect((await topic(w, id)).slug).toBe('ai')
    })

    it('saves the description', async () => {
      expect((await topic(w, id)).description).toBe('Notes on models and the people who build them.')
    })

    it('gives it a shelf on the front page', async () => {
      expect((await topic(w, id)).showOnHome).toBe(true)
    })

    it('says so', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('Saved “Machine learning”')
    })
  })

  describe('Scenario: a reader opens a described topic', () => {
    let html: string

    beforeAll(async () => {
      const w = topicWorld()
      const id = await aiTopic(w)
      await w.post(`/topics/${id}`, { name: 'AI', description: 'Notes on models.' })
      html = await (await w.fetch(`${SITE}/ai`)).text()
    })

    it('shows the description on the archive page', () => {
      expect(html).toContain('Notes on models.')
    })

    it('uses it as the meta description', () => {
      expect(html).toContain('<meta name="description" content="Notes on models."')
    })
  })

  describe('Scenario: a post is tagged with a renamed topic’s new name', () => {
    let w: World
    let id: number
    let found: number | undefined

    beforeAll(async () => {
      w = topicWorld()
      id = await aiTopic(w)
      await w.post(`/topics/${id}`, { name: 'Machine learning', description: '' })
      const post = await aBroadcast(w)
      await setPostTags(w.db, post, ['machine  LEARNING'])
      found = (await tagsForPost(w.db, post))[0]?.id
    })

    it('finds the same topic rather than making a second', () => {
      expect(found).toBe(id)
    })

    it('leaves exactly one topic', async () => {
      expect(await w.db.select().from(postTags).all()).toHaveLength(1)
    })
  })

  describe('Scenario: an agent lists and edits topics', () => {
    let w: World
    let id: number
    let list: ToolReply
    let updated: ToolReply

    beforeAll(async () => {
      w = topicWorld()
      id = await aiTopic(w)
      const agent = await agentFor(w)
      list = await agent.call('topic_list')
      updated = await agent.call('topic_update', {
        slug: 'ai',
        description: 'Models, mostly.',
        show_on_home: true,
      })
    })

    it('lists the topic with its live post count', () => {
      expect(list.json?.[0]?.published).toBe(1)
    })

    it('counts every post that carries it', () => {
      expect(list.json?.[0]?.tagged).toBe(2)
    })

    it('saves the description', async () => {
      expect((await topic(w, id)).description).toBe('Models, mostly.')
    })

    it('saves the shelf', () => {
      expect(updated.json?.showOnHome).toBe(true)
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: the operator renames a topic to another topic’s name', () => {
    let w: World
    let id: number
    let res: Response

    beforeAll(async () => {
      w = topicWorld()
      id = await aiTopic(w)
      const other = await aBroadcast(w)
      await setPostTags(w.db, other, ['Birds'])
      res = await w.post(`/topics/${id}`, { name: 'birds', description: '' })
    })

    it('is refused', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('already goes by that name')
    })

    it('keeps the old name', async () => {
      expect((await topic(w, id)).name).toBe('AI')
    })
  })

  describe('Scenario: a topic is edited while people carry a subscriber tag of the same name', () => {
    let w: World
    let tagNames: string[]

    beforeAll(async () => {
      w = topicWorld()
      await aPerson(w, { tags: ['AI'] })
      const id = await aiTopic(w)
      await (await agentFor(w)).call('topic_update', { id, name: 'Artificial intelligence' })
      tagNames = (await w.db.select({ name: tags.name }).from(tags).all()).map((t) => t.name)
    })

    it('⭐ never touches the subscriber tag', () => {
      expect(tagNames).toEqual(['AI'])
    })
  })

  describe('Scenario: an agent edits a topic that does not exist', () => {
    let reply: ToolReply

    beforeAll(async () => {
      const w = topicWorld()
      reply = await (await agentFor(w)).call('topic_update', { slug: 'nothing', description: 'x' })
    })

    it('is refused', () => {
      expect(reply.isError).toBe(true)
    })
  })
})
