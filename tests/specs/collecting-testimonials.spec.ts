// gap.md "Testimonials" — a `{{testimonial_link}}` in mail lets a known
// subscriber write one, shown on a `/testimonials` wall once the operator
// approves it, managed in the admin.
// Ported from Kōlea `Kolea.Testimonials`: the reader's own sealed link is the
// proof of address (no address field, no follow-up mail); the ask is marketing,
// so transactional mail cannot carry it; the person owns the permission to
// publish and the operator cannot approve past it; the wall shows nothing a
// stranger may not see; the public form is length-limited and rate-limited.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { renderEmail } from '../../src/core/render.ts'
import { renderPostHtml } from '../../src/core/render-web.ts'
import { enroll } from '../../src/core/sequences.ts'
import { type Subscriber, subscribers, testimonials } from '../../src/db/schema.ts'
import { aPerson, aSequence } from '../support/factories.ts'
import { PUBLIC_URL, createWorld, type World } from '../support/world.ts'

const SITE = 'https://site.example.test'

const siteWorld = () => createWorld({ SITE_URL: SITE, SITE_TITLE: 'Big Machine' })

const write = (w: World, person: Subscriber, fields: Record<string, string>) =>
  w.post(`/p/${person.unsubToken}/testimonial`, fields)

const GOOD = {
  display_name: 'Ada L.',
  body: 'This newsletter taught me more than my degree did.',
  may_publish: '1',
}

const wallHtml = async (w: World) => await (await w.fetch(`${SITE}/testimonials`)).text()

const rowCount = async (w: World) =>
  (await w.db.select({ n: count() }).from(testimonials).get())?.n ?? 0

describe('Feature: collecting testimonials', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a sequence step asks for a testimonial', () => {
    let world: World
    let person: Subscriber
    let html: string

    beforeAll(async () => {
      world = createWorld()
      person = await aPerson(world, { email: 'ada@example.test' })
      const series = await aSequence(world, {
        steps: [{ subject: 'A favour', body: 'Would you write a line? {{testimonial_link}}' }],
      })
      await enroll(world.db, series.id, person.id)
      await world.tick()
      html = (await world.mailTo('ada@example.test')).html
    })

    it("puts the reader's own link in the mail", () => {
      expect(html).toContain(`${PUBLIC_URL}/p/${person.unsubToken}/testimonial`)
    })
  })

  describe('Scenario: a reader writes one through their link and the operator approves it', () => {
    let world: World
    let person: Subscriber
    let page: Response
    let submitted: Response
    let before: string
    let after: string

    beforeAll(async () => {
      world = siteWorld()
      person = await aPerson(world, { email: 'ada@example.test', name: 'Ada Lovelace' })
      page = await world.fetch(`/p/${person.unsubToken}/testimonial`)
      submitted = await write(world, person, {
        ...GOOD,
        body: 'Five stars. <script>alert(1)</script>',
      })
      before = await wallHtml(world)
      const id = (await world.db.select().from(testimonials).get())!.id
      await world.post(`/testimonials/${id}/approve`, {})
      after = await wallHtml(world)
      await world.settle()
    })

    it('opens the form from the link', () => {
      expect(page.status).toBe(200)
    })

    it('accepts what they wrote', () => {
      expect(submitted.status).toBe(200)
    })

    it('keeps it off the wall until approved', () => {
      expect(before).not.toContain('Five stars')
    })

    it('shows it on the wall once approved', () => {
      expect(after).toContain('Five stars')
    })

    it('escapes what they wrote', () => {
      expect(after).not.toContain('<script>alert(1)</script>')
    })

    it('never shows their address on the wall', () => {
      expect(after).not.toContain('ada@example.test')
    })

    it('sends nobody any mail for it', async () => {
      expect((await world.outbox()).length).toBe(0)
    })
  })

  describe('Scenario: the operator hides, then deletes, an approved testimonial', () => {
    let world: World
    let hidden: string
    let left: number

    beforeAll(async () => {
      world = siteWorld()
      const person = await aPerson(world)
      await write(world, person, GOOD)
      const id = (await world.db.select().from(testimonials).get())!.id
      await world.post(`/testimonials/${id}/approve`, {})
      await world.post(`/testimonials/${id}/hide`, {})
      hidden = await wallHtml(world)
      await world.post(`/testimonials/${id}/delete`, {})
      left = await rowCount(world)
    })

    it('takes a hidden one off the wall', () => {
      expect(hidden).not.toContain('taught me more')
    })

    it('deletes it', () => {
      expect(left).toBe(0)
    })
  })

  // ───────────────────────────────────────────── surfaces that must not leak

  describe('Scenario: a receipt carries the tag', () => {
    let rendered: { html: string; text: string }

    beforeAll(() => {
      rendered = renderEmail(
        { md: 'Thanks for buying. {{testimonial_link}}' },
        {
          publicUrl: PUBLIC_URL,
          messageId: 1,
          unsubToken: 'secret-token',
          scope: { kind: 'broadcast' },
          scopeLabel: 'the newsletter',
          subscriber: { email: 'ada@example.test', name: null },
          trackOpens: false,
          trackClicks: false,
          showFooter: false,
        },
      )
    })

    it('resolves to nothing in transactional mail', () => {
      expect(rendered.html).not.toContain('/testimonial')
    })
  })

  describe('Scenario: a published post carries the tag', () => {
    let fromMarkdown: string
    let fromDoc: string

    beforeAll(() => {
      fromMarkdown = renderPostHtml({ md: '[Write one]({{testimonial_link}})' })
      fromDoc = renderPostHtml({
        md: '',
        json: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Write one',
                  marks: [{ type: 'link', attrs: { href: '{{testimonial_link}}' } }],
                },
              ],
            },
          ],
        },
      })
    })

    it('points a markdown link at the public wall', () => {
      expect(fromMarkdown).toContain('href="/testimonials"')
    })

    it('points a document link at the public wall', () => {
      expect(fromDoc).toContain('href="/testimonials"')
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: the writer did not allow publishing', () => {
    let world: World
    let approve: Response
    let wall: string

    beforeAll(async () => {
      world = siteWorld()
      const person = await aPerson(world)
      await write(world, person, { display_name: 'Private', body: 'Just for you, thank you so much.' })
      const id = (await world.db.select().from(testimonials).get())!.id
      approve = await world.post(`/testimonials/${id}/approve`, {})
      wall = await wallHtml(world)
    })

    it('refuses the approval', () => {
      expect(approve.headers.get('location')).toContain('kind=warn')
    })

    it('keeps it off the wall', () => {
      expect(wall).not.toContain('Just for you')
    })
  })

  describe('Scenario: one reader submits again and again', () => {
    let world: World
    let fourth: Response

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world)
      for (let i = 0; i < 3; i++) await write(world, person, GOOD)
      fourth = await write(world, person, GOOD)
    })

    it('turns the fourth one in a day away', () => {
      expect(fourth.status).toBe(429)
    })

    it('keeps three', async () => {
      expect(await rowCount(world)).toBe(3)
    })
  })

  describe('Scenario: input outside the limits', () => {
    let world: World
    let tooLong: Response
    let noName: Response

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world)
      tooLong = await write(world, person, { ...GOOD, body: 'x'.repeat(2001) })
      noName = await write(world, person, { ...GOOD, display_name: '   ' })
    })

    it('refuses a body over the limit', () => {
      expect(tooLong.status).toBe(400)
    })

    it('refuses an empty name', () => {
      expect(noName.status).toBe(400)
    })

    it('stores neither', async () => {
      expect(await rowCount(world)).toBe(0)
    })
  })

  describe('Scenario: a link nobody holds', () => {
    let res: Response

    beforeAll(async () => {
      res = await createWorld().post('/p/not-a-real-token/testimonial', GOOD)
    })

    it('is not found', () => {
      expect(res.status).toBe(404)
    })
  })

  describe('Scenario: a post from another site', () => {
    let world: World
    let res: Response

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world)
      res = await world.fetch(`/p/${person.unsubToken}/testimonial`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example',
        },
        body: new URLSearchParams(GOOD),
      })
    })

    it('is refused', () => {
      expect(res.status).toBe(403)
    })

    it('stores nothing', async () => {
      expect(await rowCount(world)).toBe(0)
    })
  })

  describe('Scenario: a testimonial from somebody who is later forgotten', () => {
    let world: World
    let left: number

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world)
      await write(world, person, GOOD)
      await world.db.delete(subscribers).where(eq(subscribers.id, person.id))
      left = await rowCount(world)
    })

    it('goes with them', () => {
      expect(left).toBe(0)
    })
  })
})
