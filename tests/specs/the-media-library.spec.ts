// gap.md "Media library" — every uploaded image on one screen, reusable from the composer
// Kōlea SPEC 15.5.1 (the `media` table is the catalogue; newest first, paged;
// dimensions read from the header). Deleting refuses while something shows the image.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { imageDimensions } from '../../src/core/media.ts'
import { broadcasts, media } from '../../src/db/schema.ts'
import { aBroadcast } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

/** A PNG header the dimension reader can parse: signature, then an IHDR chunk. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, width)
  v.setUint32(20, height)
  return b
}

async function upload(w: World, name: string, bytes: Uint8Array): Promise<{ url: string; key: string }> {
  const body = new FormData()
  body.append('file', new File([bytes as unknown as ArrayBuffer], name, { type: 'image/png' }))
  const res = await w.fetch('/api/media/upload', { method: 'POST', body })
  return (await res.json()) as { url: string; key: string }
}

interface ApiPage {
  items: { filename: string; width: number | null; height: number | null }[]
  total: number
  pages: number
}

describe('Feature: the media library', () => {
  describe('Scenario: the operator uploads two images and opens the library', () => {
    let world: World
    let screen: string
    let api: ApiPage

    beforeAll(async () => {
      world = createWorld()
      await upload(world, 'first.png', png(640, 480))
      await upload(world, 'second.png', png(1200, 630))
      screen = await (await world.fetch('/media')).text()
      api = (await (await world.fetch('/api/media')).json()) as ApiPage
    })

    it('lists the first image on the screen', () => {
      expect(screen).toContain('first.png')
    })

    it('shows each image with its dimensions', () => {
      expect(screen).toContain('1200×630')
    })

    it('hands the composer the newest image first', () => {
      expect(api.items[0]?.filename).toBe('second.png')
    })

    it('records the width read from the header', () => {
      expect(api.items[0]?.width).toBe(1200)
    })

    it('counts every image', () => {
      expect(api.total).toBe(2)
    })
  })

  describe('Scenario: the library runs past one page', () => {
    let world: World
    let page2: ApiPage

    beforeAll(async () => {
      world = createWorld()
      for (let i = 0; i < 3; i++) await upload(world, `img-${i}.png`, png(10, 10))
      page2 = (await (await world.fetch('/api/media?per_page=2&page=2')).json()) as ApiPage
    })

    it('says how many pages there are', () => {
      expect(page2.pages).toBe(2)
    })

    it('puts the oldest image on the last page', () => {
      expect(page2.items.map((i) => i.filename)).toEqual(['img-0.png'])
    })
  })

  describe('Scenario: deleting an image nothing uses', () => {
    let world: World
    let rows: number

    beforeAll(async () => {
      world = createWorld()
      const { key } = await upload(world, 'spare.png', png(10, 10))
      await world.post('/media/delete', { key })
      rows = (await world.db.select().from(media).all()).length
    })

    it('removes it from the library', () => {
      expect(rows).toBe(0)
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: deleting an image a broadcast still shows', () => {
    let world: World
    let page: string
    let kept: number
    let apiStatus: number

    beforeAll(async () => {
      world = createWorld()
      const { key, url } = await upload(world, 'hero.png', png(10, 10))
      await aBroadcast(world, { subject: 'Spring news', body: `![hero](${url})` })
      page = await (await world.post('/media/delete', { key })).text()
      apiStatus = (await world.fetch(`/api/media/${key}`, { method: 'DELETE' })).status
      kept = (await world.db.select().from(media).where(eq(media.key, key)).all()).length
    })

    it('refuses and names the broadcast', () => {
      expect(page).toContain('Spring news')
    })

    it('keeps the image', () => {
      expect(kept).toBe(1)
    })

    it('refuses the same delete through the API', () => {
      expect(apiStatus).toBe(409)
    })
  })

  describe('Scenario: deleting an image used as a feature image, knowingly', () => {
    let world: World
    let kept: number

    beforeAll(async () => {
      world = createWorld()
      const { key, url } = await upload(world, 'card.png', png(10, 10))
      const id = await aBroadcast(world)
      await world.db.update(broadcasts).set({ featureImage: url }).where(eq(broadcasts.id, id))
      await world.post('/media/delete', { key, force: '1' })
      kept = (await world.db.select().from(media).where(eq(media.key, key)).all()).length
    })

    it('deletes it when the operator confirms', () => {
      expect(kept).toBe(0)
    })
  })

  describe('Scenario: a file whose header cannot be read', () => {
    it('has no dimensions rather than a guess', () => {
      expect(imageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull()
    })
  })
})
