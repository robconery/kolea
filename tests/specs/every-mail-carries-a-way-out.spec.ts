// STORY-013 — Every mail carries a way out that fits its scope
// SPEC 2a.1–2a.3, 3.9, 6.9, 7.4
//
// The footer is where scoped consent becomes visible to the only person who
// matters. A sequence email that offers "unsubscribe" without saying *from
// what* is how the ESP this replaces loses people from everything at once.
import { beforeAll, describe, expect, it } from 'bun:test'
import { createApiKey } from '../../src/core/api-keys.ts'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { enroll, tickSequences } from '../../src/core/sequences.ts'
import type { DevOutboxItem, Subscriber } from '../../src/db/schema.ts'
import { aBroadcast, aPerson, aSequence, makeDue } from '../support/factories.ts'
import { createWorld, PUBLIC_URL, type World } from '../support/world.ts'

describe('Feature: the unsubscribe a mail offers matches the mail', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a broadcast', () => {
    let world: World
    let reader: Subscriber
    let other: Subscriber
    let mail: DevOutboxItem
    let otherMail: DevOutboxItem

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test', name: 'A Reader' })
      other = await aPerson(world, { email: 'other@example.test' })
      const id = await aBroadcast(world, { subject: 'This week' })
      await startBroadcast(world.env, world.db, id)

      mail = await world.mailTo('reader@example.test')
      otherMail = await world.mailTo('other@example.test')
    })

    it('carries a preference link built on the reader’s own token', () => {
      expect(mail.html).toContain(`${PUBLIC_URL}/p/${reader.unsubToken}`)
    })

    it('gives a different reader a different link', () => {
      expect(otherMail.html).toContain(`/p/${other.unsubToken}`)
    })

    it('says the link is for the newsletter', () => {
      expect(mail.html).toContain('Unsubscribe from the newsletter')
    })

    it('names what they subscribed to', () => {
      expect(mail.html).toContain('the newsletter')
    })

    it('offers the full preference centre as well', () => {
      expect(mail.html).toContain('Manage all your preferences')
    })

    it('carries the scope in the link, so the page knows where they came from', () => {
      expect(mail.html).toContain('scope=broadcast')
    })

    it('carries the message id, so an unsubscribe can be charged to this mail', () => {
      expect(mail.html).toContain('&m=')
    })

    it('puts the same escape hatch in the plaintext part', () => {
      expect(mail.text).toContain(`/p/${reader.unsubToken}`)
    })

    it('tracks opens on marketing mail', () => {
      expect(mail.html).toContain('/t/open/')
    })
  })

  describe('Scenario: a sequence step', () => {
    let world: World
    let reader: Subscriber
    let series: { id: number }
    let mail: DevOutboxItem

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test' })
      series = await aSequence(world, {
        name: 'The Ruby course',
        steps: [{ subject: 'Lesson one' }],
      })
      await enroll(world.db, series.id, reader.id)
      await makeDue(world, reader, series.id)
      await tickSequences(world.env, world.db)

      mail = await world.mailTo('reader@example.test')
    })

    it('scopes the link to that sequence  ⭐', () => {
      expect(mail.html).toContain(`scope=sequence%3A${series.id}`)
    })

    it('offers the narrow action', () => {
      expect(mail.html).toContain('Stop just this series')
    })

    it('names the series, so the reader knows what they are leaving', () => {
      expect(mail.html).toContain('The Ruby course')
    })

    it('says why they are getting it', () => {
      expect(mail.html).toContain('because you joined')
    })

    it('does not offer to unsubscribe them from the newsletter', () => {
      expect(mail.html).not.toContain('Unsubscribe from the newsletter')
    })

    it('spells the same thing out in plaintext', () => {
      expect(mail.text).toContain('stop just this series without leaving anything else')
    })
  })

  describe('Scenario: a transactional message', () => {
    // The deployed entry point (bdd-specs rule 7): `POST /api/send`. A receipt
    // is not marketing, so offering to unsubscribe from it is nonsense — and
    // tracking somebody's download email is worse than nonsense.
    let world: World
    let mail: DevOutboxItem

    beforeAll(async () => {
      world = createWorld()
      const { token } = await createApiKey(world.db, 'checkout')
      await world.fetch('/api/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          to: 'buyer@example.test',
          subject: 'Your download',
          body: 'Here is the thing you bought.',
        }),
      })
      await world.settle()
      mail = await world.mailTo('buyer@example.test')
    })

    it('carries no preference link  ⭐', () => {
      expect(mail.html).not.toContain('/p/')
    })

    it('carries no unsubscribe wording at all', () => {
      expect(mail.html.toLowerCase()).not.toContain('unsubscribe')
    })

    it('is not open-tracked', () => {
      expect(mail.html).not.toContain('/t/open/')
    })

    it('still says what it came to say', () => {
      expect(mail.html).toContain('Here is the thing you bought.')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: click tracking, and the one link it must never touch', () => {
    // A tracked unsubscribe link is a redirect that can fail. The one link in
    // the mail that must always work is the one that stops the mail.
    let world: World
    let reader: Subscriber
    let mail: DevOutboxItem

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'reader@example.test' })
      const id = await aBroadcast(world, {
        subject: 'This week',
        body: 'Read [the post](https://example.com/post) today.',
      })
      await startBroadcast(world.env, world.db, id)
      mail = await world.mailTo('reader@example.test')
    })

    it('rewrites ordinary links through the tracker', () => {
      expect(mail.html).toContain('/t/click/')
    })

    it('leaves the preference link alone  ⭐', () => {
      expect(mail.html).not.toContain(`/t/click/1?u=${encodeURIComponent(`${PUBLIC_URL}/p/`)}`)
    })

    it('keeps the preference link directly clickable', () => {
      expect(mail.html).toContain(`href="${PUBLIC_URL}/p/${reader.unsubToken}`)
    })
  })
})
