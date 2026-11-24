// The web panel — the post's metadata beside the writing
//
// The featured image, the excerpt, the topics and "email only" used to live on
// a Publishing screen of their own, reached by a link after the writing was
// done. They live in the composer now: the excerpt under the subject, the rest
// in the side panel. The image is saved the moment it is picked, by fetch, so
// its routes answer JSON to a request that asks for it.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getBroadcast } from '../../src/core/broadcasts.ts'
import { tagsForPost } from '../../src/core/post-tags.ts'
import { setFeatureImage } from '../../src/core/posts.ts'
import { broadcasts } from '../../src/db/schema.ts'
import { aBroadcast } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const SITE = { SITE_URL: 'https://site.example.test' }
const WRITING = { subject: 'Fridays, quietly', body: 'We ship on Thursdays now.' }

function aWorld(): World {
  return createWorld(SITE)
}

/** Mailed already, without mailing anyone: the status is all the composer reads. */
async function aSentBroadcast(world: World): Promise<number> {
  const id = await aBroadcast(world, WRITING)
  await world.db.update(broadcasts).set({ status: 'sent', sentAt: new Date() }).where(eq(broadcasts.id, id))
  return id
}

describe('Feature: the web panel', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: opening a draft', () => {
    let page: string

    beforeAll(async () => {
      const world = aWorld()
      const id = await aBroadcast(world, WRITING)
      page = await (await world.fetch(`/broadcasts/${id}`)).text()
    })

    it('has an excerpt under the subject', () => {
      expect(page).toContain('name="excerpt"')
    })

    it('offers email only', () => {
      expect(page).toContain('Email only')
    })

    it('has the featured image picker in the panel', () => {
      expect(page).toContain('data-fi')
    })

    it('has no link to a separate publishing screen', () => {
      expect(page).not.toContain('/publishing')
    })
  })

  describe('Scenario: the timed save carries the excerpt', () => {
    let excerpt: string | null | undefined

    beforeAll(async () => {
      const world = aWorld()
      const id = await aBroadcast(world, WRITING)
      await world.post('/broadcasts/autosave', {
        id: String(id),
        subject: WRITING.subject,
        body: WRITING.body,
        excerpt: '  Why the release   moved.  ',
      })
      excerpt = (await getBroadcast(world.db, id))?.excerpt
    })

    it('writes it, tidied', () => {
      expect(excerpt).toBe('Why the release moved.')
    })
  })

  describe('Scenario: choosing email only', () => {
    let publishOnSend: boolean | undefined

    beforeAll(async () => {
      const world = aWorld()
      const id = await aBroadcast(world, WRITING)
      await world.post('/broadcasts/autosave', {
        id: String(id),
        ...WRITING,
        publish_on_send_shown: '1',
        publish_on_send: '',
      })
      publishOnSend = (await getBroadcast(world.db, id))?.publishOnSend
    })

    it('turns publishing off, even from the timed save', () => {
      expect(publishOnSend).toBe(false)
    })
  })

  describe('Scenario: saving topics when the field is left', () => {
    let topics: string[]

    beforeAll(async () => {
      const world = aWorld()
      const id = await aBroadcast(world, WRITING)
      await world.post(`/broadcasts/${id}/topics`, { topics: 'AI, Databases' })
      topics = (await tagsForPost(world.db, id)).map((t) => t.name)
    })

    it('writes them in order', () => {
      expect(topics).toEqual(['AI', 'Databases'])
    })
  })

  describe('Scenario: removing the featured image from the panel', () => {
    let body: unknown
    let image: string | null | undefined

    beforeAll(async () => {
      const world = aWorld()
      const id = await aBroadcast(world, WRITING)
      await setFeatureImage(world.db, id, { url: 'https://images.unsplash.com/photo-1' })
      const res = await world.fetch(`/broadcasts/${id}/feature-image/clear`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      })
      body = await res.json()
      image = (await getBroadcast(world.db, id))?.featureImage
    })

    it('answers in JSON', () => {
      expect(body).toEqual({ ok: true, image: null })
    })

    it('clears it', () => {
      expect(image).toBeNull()
    })
  })

  describe('Scenario: publishing a sent broadcast from its Save', () => {
    let published: Date | null | undefined
    let excerpt: string | null | undefined

    beforeAll(async () => {
      const world = aWorld()
      const id = await aSentBroadcast(world)
      await world.post(`/broadcasts/${id}/revise`, {
        subject: WRITING.subject,
        body: WRITING.body,
        excerpt: 'Written for the card.',
        web_panel: '1',
        topics: 'Shipping',
        web: 'publish',
      })
      const b = await getBroadcast(world.db, id)
      published = b?.publishedAt
      excerpt = b?.excerpt
    })

    it('puts it on the web', () => {
      expect(published).toBeInstanceOf(Date)
    })

    it('keeps the excerpt that was written', () => {
      expect(excerpt).toBe('Written for the card.')
    })
  })

  describe('Scenario: the old publishing screen', () => {
    let location: string | null

    beforeAll(async () => {
      const world = aWorld()
      const id = await aBroadcast(world, WRITING)
      location = (await world.fetch(`/broadcasts/${id}/publishing`)).headers.get('location')
    })

    it('sends you to the broadcast', () => {
      expect(location).toMatch(/^\/broadcasts\/\d+$/)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: the timed save and a half-typed topic', () => {
    let topics: string[]

    beforeAll(async () => {
      const world = aWorld()
      const id = await aBroadcast(world, WRITING)
      await world.post('/broadcasts/autosave', { id: String(id), ...WRITING, topics: 'Datab' })
      topics = (await tagsForPost(world.db, id)).map((t) => t.name)
    })

    it('writes no topic', () => {
      expect(topics).toEqual([])
    })
  })

  describe('Scenario: a save from a page without the panel', () => {
    let featured: boolean | undefined
    let excerpt: string | null | undefined

    beforeAll(async () => {
      const world = aWorld()
      const id = await aBroadcast(world, WRITING)
      await world.db
        .update(broadcasts)
        .set({ featured: true, excerpt: 'Kept.' })
        .where(eq(broadcasts.id, id))
      await world.post(`/broadcasts/${id}/edit`, WRITING)
      const b = await getBroadcast(world.db, id)
      featured = b?.featured
      excerpt = b?.excerpt
    })

    it('leaves featured alone', () => {
      expect(featured).toBe(true)
    })

    it('leaves the excerpt alone', () => {
      expect(excerpt).toBe('Kept.')
    })
  })

  describe('Scenario: picking something that is not an Unsplash photo', () => {
    let status: number
    let image: string | null | undefined

    beforeAll(async () => {
      const world = aWorld()
      const id = await aBroadcast(world, WRITING)
      const body = new URLSearchParams({ url: 'https://evil.example.test/x.png' })
      const res = await world.fetch(`/broadcasts/${id}/feature-image/unsplash`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
      status = res.status
      image = (await getBroadcast(world.db, id))?.featureImage
    })

    it('refuses it', () => {
      expect(status).toBe(422)
    })

    it('sets nothing', () => {
      expect(image).toBeNull()
    })
  })
})
