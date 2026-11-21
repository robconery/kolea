// gap.md "Custom tracking hostname" — opens and clicks on the sender's own subdomain
// Kōlea SPEC 11.2, 11.3, 11.4, 11.7 · Big Mailer SPEC 5.4, 8.2
//
// Two rules shape every scenario. A tracking URL is baked into mail at send
// time and can never be fixed after delivery, so a host that has ever been used
// keeps answering (Kōlea 11.7) — including `PUBLIC_URL` itself. And a tracking
// host is a public hostname with no Cloudflare Access in front of it, so it
// reaches the two tracking routes and nothing else: an admin path on it is a 404.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import type { DevOutboxItem, Message, Subscriber } from '../../src/db/schema.ts'
import { events, messages } from '../../src/db/schema.ts'
import type { Env } from '../../src/types.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, PUBLIC_URL, type World } from '../support/world.ts'

const LINKS = 'https://links.example.test'

/** One reader, one broadcast with a link in it, sent. */
async function sendOne(world: World): Promise<{ mail: DevOutboxItem; message: Message; reader: Subscriber }> {
  const reader = await aPerson(world, { email: 'reader@example.test' })
  const id = await aBroadcast(world, {
    subject: 'This week',
    body: 'Hello. Read [the post](https://example.com/post).\n\nRob',
  })
  await startBroadcast(world.env, world.db, id)
  const message = (await world.db.select().from(messages).get())!
  return { mail: await world.mailTo('reader@example.test'), message, reader }
}

async function opensOf(world: World, messageId: number): Promise<number> {
  return (
    (
      await world.db
        .select({ n: count() })
        .from(events)
        .where(eq(events.messageId, messageId))
        .get()
    )?.n ?? 0
  )
}

describe('Feature: tracking on the sender’s own hostname', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a broadcast goes out with TRACKING_HOST set', () => {
    let mail: DevOutboxItem
    let message: Message

    beforeAll(async () => {
      const world = createWorld({ TRACKING_HOST: 'links.example.test' })
      ;({ mail, message } = await sendOne(world))
    })

    it('puts the open pixel on the tracking host', () => {
      expect(mail.html).toContain(`${LINKS}/t/open/${message.id}.gif`)
    })

    it('puts the tracked link on the tracking host', () => {
      expect(mail.html).toContain(`${LINKS}/t/click/${message.id}?u=`)
    })

    it('leaves no tracking URL on the console’s host', () => {
      expect(mail.html).not.toContain(`${PUBLIC_URL}/t/`)
    })

    it('keeps the preference centre on the console’s host', () => {
      expect(mail.html).toContain(`${PUBLIC_URL}/p/`)
    })
  })

  describe('Scenario: the reader’s mail client fetches the pixel from the tracking host', () => {
    let world: World
    let message: Message
    let response: Response

    beforeAll(async () => {
      world = createWorld({ TRACKING_HOST: 'links.example.test' })
      ;({ message } = await sendOne(world))
      response = await world.fetch(`${LINKS}/t/open/${message.id}.gif`)
    })

    it('answers with the image', () => {
      expect(response.headers.get('content-type')).toBe('image/gif')
    })

    it('records the open', async () => {
      expect(await opensOf(world, message.id)).toBe(1)
    })
  })

  describe('Scenario: the reader clicks a link on the tracking host', () => {
    let response: Response

    beforeAll(async () => {
      const world = createWorld({ TRACKING_HOST: 'links.example.test' })
      const { message } = await sendOne(world)
      response = await world.fetch(
        `${LINKS}/t/click/${message.id}?u=${encodeURIComponent('https://example.com/post')}`,
        { redirect: 'manual' },
      )
    })

    it('redirects them', () => {
      expect(response.status).toBe(302)
    })

    it('to where they were going', () => {
      expect(response.headers.get('location')).toBe('https://example.com/post')
    })
  })

  describe('Scenario: mail sent before TRACKING_HOST existed is opened afterwards', () => {
    // ⭐ The trap: links already delivered name PUBLIC_URL's host, forever.
    let world: World
    let message: Message
    let response: Response

    beforeAll(async () => {
      world = createWorld({ TRACKING_HOST: 'links.example.test' })
      ;({ message } = await sendOne(world))
      response = await world.fetch(`${PUBLIC_URL}/t/open/${message.id}.gif`)
    })

    it('still answers the old pixel', () => {
      expect(response.status).toBe(200)
    })

    it('still records the open', async () => {
      expect(await opensOf(world, message.id)).toBe(1)
    })
  })

  describe('Scenario: a host that was used before is moved down the list', () => {
    let world: World
    let mail: DevOutboxItem
    let message: Message
    let oldPixel: Response

    beforeAll(async () => {
      world = createWorld({ TRACKING_HOST: 'go.example.test, links.example.test' })
      ;({ mail, message } = await sendOne(world))
      oldPixel = await world.fetch(`${LINKS}/t/open/${message.id}.gif`)
    })

    it('sends new mail on the first host', () => {
      expect(mail.html).toContain(`https://go.example.test/t/open/${message.id}.gif`)
    })

    it('keeps answering the older one', () => {
      expect(oldPixel.headers.get('content-type')).toBe('image/gif')
    })
  })

  describe('Scenario: TRACKING_HOST is not set', () => {
    let mail: DevOutboxItem
    let message: Message

    beforeAll(async () => {
      const world = createWorld()
      ;({ mail, message } = await sendOne(world))
    })

    it('tracks on PUBLIC_URL, exactly as before', () => {
      expect(mail.html).toContain(`${PUBLIC_URL}/t/open/${message.id}.gif`)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: somebody asks the tracking host for the console', () => {
    // ⭐ No Access in front of this host. Even with the dev bypass on — the
    // most permissive world there is — nothing but tracking answers on it.
    let world: World
    let reader: Subscriber
    const status: Record<string, number> = {}
    const env: Partial<Env> = { TRACKING_HOST: 'links.example.test', MCP_PATH_SECRET: 'sesame' }

    beforeAll(async () => {
      world = createWorld(env)
      ;({ reader } = await sendOne(world))
      for (const path of ['/', '/subscribers', '/broadcasts', '/seed', '/mcp/sesame', `/p/${reader.unsubToken}`, '/robots.txt']) {
        status[path] = (await world.fetch(`${LINKS}${path}`)).status
      }
      status['POST /api/send'] = (
        await world.fetch(`${LINKS}/api/send`, { method: 'POST', body: '{}' })
      ).status
    })

    it('does not serve the dashboard', () => {
      expect(status['/']).toBe(404)
    })

    it('does not serve the subscriber list', () => {
      expect(status['/subscribers']).toBe(404)
    })

    it('does not serve the broadcasts screen', () => {
      expect(status['/broadcasts']).toBe(404)
    })

    it('does not serve the seed tools', () => {
      expect(status['/seed']).toBe(404)
    })

    it('does not serve MCP, even on the right secret', () => {
      expect(status['/mcp/sesame']).toBe(404)
    })

    it('does not serve the preference centre', () => {
      expect(status[`/p/${reader.unsubToken}`]).toBe(404)
    })

    it('does not serve the transactional API', () => {
      expect(status['POST /api/send']).toBe(404)
    })

    it('does not serve the console’s robots.txt', () => {
      expect(status['/robots.txt']).toBe(404)
    })
  })

  describe('Scenario: TRACKING_HOST names the public site’s host', () => {
    // Claiming SITE_URL's host would take the whole blog down to two routes.
    let mail: DevOutboxItem
    let message: Message

    beforeAll(async () => {
      const world = createWorld({
        SITE_URL: 'https://blog.example.test',
        TRACKING_HOST: 'blog.example.test',
      })
      ;({ mail, message } = await sendOne(world))
    })

    it('is ignored, and tracking stays on PUBLIC_URL', () => {
      expect(mail.html).toContain(`${PUBLIC_URL}/t/open/${message.id}.gif`)
    })
  })

  describe('Scenario: a pixel on the tracking host for a message long gone', () => {
    let response: Response

    beforeAll(async () => {
      const world = createWorld({ TRACKING_HOST: 'links.example.test' })
      response = await world.fetch(`${LINKS}/t/open/999999.gif`)
    })

    it('still returns the image', () => {
      expect(response.status).toBe(200)
    })
  })
})
