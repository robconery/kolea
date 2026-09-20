// STORY-008 — A dead address or a spam complaint stops the mail by itself
// SPEC 2.1, 2.2, 2.6, 2.7, 2.8, 2.10, 5.1, 5.2, 5.3
//
// Two of the three things in this codebase allowed to write a suppression are
// here (the third is the reader's own "unsubscribe from everything"). The rule
// that matters most is the negative one: a SOFT bounce must do nothing at all.
// A transient failure that suppressed an address would quietly shrink the list
// every time a mailbox was full for an afternoon.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { suppressAddress, unsuppressAddress } from '../../src/core/consent.ts'
import { applyProviderEvent } from '../../src/core/events.ts'
import type { Subscriber } from '../../src/db/schema.ts'
import { events, messages, subscribers, suppressions } from '../../src/db/schema.ts'
import { aBroadcast, aPerson, reload } from '../support/factories.ts'
import { signResendWebhook, WEBHOOK_SECRET } from '../support/svix.ts'
import { createWorld, type World } from '../support/world.ts'

/**
 * Put one genuinely sent message in front of the provider events, the way the
 * world always has: somebody was mailed, and then something came back about it.
 */
async function aSentMessageTo(world: World, email: string) {
  const person = await aPerson(world, { email })
  const broadcast = await aBroadcast(world, { subject: 'This week' })
  await startBroadcast(world.env, world.db, broadcast)
  const message = await world.db.select().from(messages).get()
  return { person, message: message! }
}

describe('Feature: the provider tells us an address is unreachable', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a hard bounce', () => {
    let world: World
    let person: Subscriber
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      const sent = await aSentMessageTo(world, 'dead@example.test')
      person = sent.person

      await applyProviderEvent(world.db, {
        providerMessageId: sent.message.providerMessageId!,
        type: 'bounce',
        hardBounce: true,
        occurredAt: new Date(),
      })
      after = await reload(world, person)
    })

    it('suppresses the address', async () => {
      const row = await world.db.select().from(suppressions).get()
      expect(row?.email).toBe('dead@example.test')
    })

    it('records the reason as a hard bounce', async () => {
      const row = await world.db.select().from(suppressions).get()
      expect(row?.reason).toBe('hard_bounce')
    })

    it('marks the subscriber bounced', () => {
      expect(after.status).toBe('bounced')
    })

    it('records the bounce against the message', async () => {
      const row = await world.db.select().from(events).where(eq(events.type, 'bounce')).get()
      expect(row).toBeDefined()
    })
  })

  describe('Scenario: a spam complaint', () => {
    let world: World
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      const sent = await aSentMessageTo(world, 'annoyed@example.test')

      await applyProviderEvent(world.db, {
        providerMessageId: sent.message.providerMessageId!,
        type: 'complaint',
        occurredAt: new Date(),
      })
      after = await reload(world, sent.person)
    })

    it('suppresses the address', async () => {
      const row = await world.db.select().from(suppressions).get()
      expect(row?.reason).toBe('complaint')
    })

    it('marks the subscriber complained', () => {
      expect(after.status).toBe('complained')
    })
  })

  describe('Scenario: the operator suppresses an address by hand', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      await suppressAddress(world.db, 'Trouble@Example.test', 'manual')
    })

    it('records it', async () => {
      const row = await world.db.select().from(suppressions).get()
      expect(row?.reason).toBe('manual')
    })

    it('normalizes the address, so it matches at send time', async () => {
      const row = await world.db.select().from(suppressions).get()
      expect(row?.email).toBe('trouble@example.test')
    })
  })

  describe('Scenario: the operator lifts a suppression', () => {
    let world: World
    let person: Subscriber
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      person = await aPerson(world, { email: 'dead@example.test' })
      await world.db
        .update(subscribers)
        .set({ status: 'bounced' })
        .where(eq(subscribers.id, person.id))
      await suppressAddress(world.db, person.email, 'hard_bounce')

      await unsuppressAddress(world.db, person.email)
      after = await reload(world, person)
    })

    it('removes the suppression', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(0)
    })

    it('does not change the subscriber status — SPEC 2.10', () => {
      expect(after.status).toBe('bounced')
    })
  })

  describe('Scenario: a provider webhook arriving at the public endpoint', () => {
    // The deployed entry point (bdd-specs rule 7), signature and all.
    //
    // ⚠️ `RESEND_API_KEY` is set here only because the webhook route refuses to
    // parse without it. `EMAIL_PROVIDER` stays `console`, so nothing in this
    // spec can reach the wire.
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld({
        RESEND_API_KEY: 're_test_key',
        RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
      })
      const sent = await aSentMessageTo(world, 'dead@example.test')

      const signed = await signResendWebhook(
        {
          type: 'email.bounced',
          created_at: new Date().toISOString(),
          data: { email_id: sent.message.providerMessageId, bounce: { type: 'Hard' } },
        },
        WEBHOOK_SECRET,
      )
      response = await world.fetch('/webhooks/resend', {
        method: 'POST',
        headers: signed.headers,
        body: signed.body,
      })
    })

    it('accepts the signed webhook', () => {
      expect(response.status).toBe(200)
    })

    it('applies the event it carried', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: the same provider event delivered twice', () => {
    // SPEC 5.3. Providers replay; the row count must not.
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const sent = await aSentMessageTo(world, 'reader@example.test')
      const event = {
        providerMessageId: sent.message.providerMessageId!,
        type: 'delivered' as const,
        occurredAt: new Date(),
        dedupeKey: 'svix-1:email.delivered',
      }
      await applyProviderEvent(world.db, event)
      await applyProviderEvent(world.db, event)
    })

    it('records one event, not two', async () => {
      const n =
        (await world.db
          .select({ n: count() })
          .from(events)
          .where(eq(events.type, 'delivered'))
          .get())?.n
      expect(n).toBe(1)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a soft bounce', () => {
    // ⭐ The negative rule. A full mailbox is not a dead address.
    let world: World
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      const sent = await aSentMessageTo(world, 'full-mailbox@example.test')

      await applyProviderEvent(world.db, {
        providerMessageId: sent.message.providerMessageId!,
        type: 'bounce',
        hardBounce: false,
        occurredAt: new Date(),
      })
      after = await reload(world, sent.person)
    })

    it('suppresses nothing', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(0)
    })

    it('leaves the subscriber active', () => {
      expect(after.status).toBe('active')
    })

    it('still records the bounce, so it is countable', async () => {
      const n =
        (await world.db.select({ n: count() }).from(events).where(eq(events.type, 'bounce')).get())
          ?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: a webhook whose signature does not verify', () => {
    // SPEC 5.2 — rejected, and rejected loudly.
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld({
        RESEND_API_KEY: 're_test_key',
        RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
      })
      const sent = await aSentMessageTo(world, 'dead@example.test')

      const signed = await signResendWebhook(
        {
          type: 'email.bounced',
          data: { email_id: sent.message.providerMessageId, bounce: { type: 'Hard' } },
        },
        WEBHOOK_SECRET,
      )
      response = await world.fetch('/webhooks/resend', {
        method: 'POST',
        headers: { ...signed.headers, 'svix-signature': 'v1,not-the-right-signature' },
        body: signed.body,
      })
    })

    it('rejects it', () => {
      expect(response.status).toBe(401)
    })

    it('applies nothing from it', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(0)
    })
  })

  describe('Scenario: a webhook from a provider we do not speak', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      response = await world.fetch('/webhooks/mailchimp', { method: 'POST', body: '{}' })
    })

    it('is not found', () => {
      expect(response.status).toBe(404)
    })
  })

  describe('Scenario: an event about a message we never sent', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      await applyProviderEvent(world.db, {
        providerMessageId: 'never-heard-of-it',
        type: 'bounce',
        hardBounce: true,
        occurredAt: new Date(),
      })
    })

    it('suppresses nobody', async () => {
      const n = (await world.db.select({ n: count() }).from(suppressions).get())?.n
      expect(n).toBe(0)
    })
  })
})
