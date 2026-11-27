// Icons on the pages a reader sees
//
// On a live install the console's hostname is behind the operator's login, and
// `/favicon.ico` is a file on that hostname. A reader on the preference centre
// has no session, so their browser was sent to a login page instead of an icon.
// Those pages take the icons from under `/media/`, which is open to everyone.
import { beforeAll, describe, expect, it } from 'bun:test'
import type { Subscriber } from '../../src/db/schema.ts'
import { aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Static assets as Cloudflare would serve them: the three icons, and one file that is not an icon. */
function assets(asked: string[]): Fetcher {
  return {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
      asked.push(path)
      if (['/favicon.ico', '/favicon.png', '/apple-touch-icon.png', '/logo.png'].includes(path)) {
        return new Response(PNG, { headers: { 'content-type': path.endsWith('.ico') ? 'image/x-icon' : 'image/png' } })
      }
      return new Response('not found', { status: 404 })
    },
  } as unknown as Fetcher
}

describe('Feature: icons on the pages a reader sees', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a reader opens their preference centre', () => {
    let world: World
    let reader: Subscriber
    let page: string

    beforeAll(async () => {
      world = createWorld({ ASSETS: assets([]) })
      reader = await aPerson(world, { email: 'reader@example.test' })
      page = await (await world.fetch(`/p/${reader.unsubToken}`)).text()
    })

    it('links the icon from under /media/, which needs no login', () => {
      expect(page).toContain('href="/media/_icons/favicon.ico"')
    })

    it('links the touch icon from there too', () => {
      expect(page).toContain('href="/media/_icons/apple-touch-icon.png"')
    })

    it('does not link the path that sits behind the login', () => {
      expect(page).not.toContain('href="/favicon.ico"')
    })
  })

  describe('Scenario: a browser asks for one of those icons', () => {
    let world: World
    let asked: string[]
    let icon: Response

    beforeAll(async () => {
      asked = []
      world = createWorld({ ASSETS: assets(asked) })
      icon = await world.fetch('/media/_icons/favicon.png')
    })

    it('gets the file', () => {
      expect(icon.status).toBe(200)
    })

    it('gets it as an image', () => {
      expect(icon.headers.get('content-type')).toBe('image/png')
    })

    it('is told the type must not be guessed', () => {
      expect(icon.headers.get('x-content-type-options')).toBe('nosniff')
    })

    it('is served the static file of that name', () => {
      expect(asked).toEqual(['/favicon.png'])
    })
  })

  describe('Scenario: the operator opens the console', () => {
    let page: string

    beforeAll(async () => {
      const world = createWorld({ ASSETS: assets([]) })
      page = await (await world.fetch('/')).text()
    })

    it('keeps the plain icon path, because the operator is signed in', () => {
      expect(page).toContain('href="/favicon.ico"')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: asking that path for a file that is not an icon', () => {
    let world: World
    let asked: string[]
    let answer: Response

    beforeAll(async () => {
      asked = []
      world = createWorld({ ASSETS: assets(asked) })
      answer = await world.fetch('/media/_icons/logo.png')
    })

    it('is refused', () => {
      expect(answer.status).toBe(404)
    })

    it('never reaches the static files', () => {
      expect(asked).toEqual([])
    })
  })

  describe('Scenario: an icon missing from the install', () => {
    let answer: Response

    beforeAll(async () => {
      // The default world has no static files at all.
      const world = createWorld()
      answer = await world.fetch('/media/_icons/favicon.ico')
    })

    it('is a plain not-found, not an error', () => {
      expect(answer.status).toBe(404)
    })
  })
})
