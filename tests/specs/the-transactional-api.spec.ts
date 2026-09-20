// STORY-019 — Let my other apps send mail through Kōlea
// SPEC 7.1–7.7, 2.1, 9.3
//
// Every scenario drives `POST /api/send` itself — this Feature *is* an HTTP
// contract, and another application depends on it. A spec that called the
// handler's internals would test something no caller can reach.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { createApiKey, revokeApiKey } from '../../src/core/api-keys.ts'
import { unsubscribeAll } from '../../src/core/consent.ts'
import type { ApiKey, Subscriber } from '../../src/db/schema.ts'
import { apiKeys, messages, sequenceEnrollments, subscribers, suppressions } from '../../src/db/schema.ts'
import { aPerson, aSequence } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

interface SendPayload {
  to?: string
  subject?: string
  body?: string
  name?: string
  idempotency_key?: string
}

/** POST /api/send, the way a consuming app would. */
async function send(world: World, token: string | null, payload: SendPayload | string) {
  return await world.fetch('/api/send', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

const A_RECEIPT = {
  to: 'buyer@example.test',
  subject: 'Your order',
  body: 'Thanks — here is your download.',
}

describe('Feature: another application sends mail through Kōlea', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a well-formed request with a live key', () => {
    let world: World
    let response: Response
    let payload: { id: number; status: string }
    let key: ApiKey | undefined

    beforeAll(async () => {
      world = createWorld()
      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, A_RECEIPT)
      payload = await response.json()
      key = await world.db.select().from(apiKeys).get()
    })

    it('accepts it', () => {
      expect(response.status).toBe(202)
    })

    it('hands back the message id, so the caller can follow it up', () => {
      expect(payload.id).toBeGreaterThan(0)
    })

    it('reports it as queued — it does not block on the provider (SPEC 7.5)', () => {
      expect(payload.status).toBe('queued')
    })

    it('records the key was used', () => {
      expect(key?.lastUsedAt).not.toBeNull()
    })

    it('records the message as transactional', async () => {
      const row = await world.db.select().from(messages).get()
      expect(row?.kind).toBe('transactional')
    })

    it('mails it once the background work settles', async () => {
      await world.settle()
      expect(await world.outbox()).toHaveLength(1)
    })

    it('sends what it was asked to send', async () => {
      const mail = await world.mailTo('buyer@example.test')
      expect(mail.subject).toBe('Your order')
    })
  })

  describe('Scenario: a recipient who is not on the list', () => {
    let world: World
    let created: Subscriber | undefined

    beforeAll(async () => {
      world = createWorld()
      // A live welcome series, to prove the recipient is not marketed to.
      await aSequence(world, { trigger: 'subscribe', steps: [{ subject: 'Welcome!' }] })
      const { token } = await createApiKey(world.db, 'the checkout')
      await send(world, token, { ...A_RECEIPT, name: 'A Buyer' })
      await world.settle()
      created = await world.db
        .select()
        .from(subscribers)
        .where(eq(subscribers.email, 'buyer@example.test'))
        .get()
    })

    it('creates them, so the send is attributable', () => {
      expect(created).toBeDefined()
    })

    it('records them as pending, not as a subscriber  ⭐', () => {
      expect(created?.status).toBe('pending')
    })

    it('records where they came from', () => {
      expect(created?.source).toBe('transactional')
    })

    it('does not enroll them in the welcome series  ⭐', async () => {
      const n = (await world.db.select({ n: count() }).from(sequenceEnrollments).get())?.n
      expect(n).toBe(0)
    })

    it('sends them the receipt and nothing else', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: the same idempotency key twice', () => {
    let world: World
    let first: { id: number }
    let second: { id: number; idempotent?: boolean }
    let secondResponse: Response

    beforeAll(async () => {
      world = createWorld()
      const { token } = await createApiKey(world.db, 'the checkout')
      const payload = { ...A_RECEIPT, idempotency_key: 'order-1234' }

      first = await (await send(world, token, payload)).json()
      await world.settle()
      secondResponse = await send(world, token, payload)
      second = await secondResponse.json()
      await world.settle()
    })

    it('answers the replay', () => {
      expect(secondResponse.status).toBe(200)
    })

    it('returns the original message', () => {
      expect(second.id).toBe(first.id)
    })

    it('says so plainly', () => {
      expect(second.idempotent).toBe(true)
    })

    it('sends nothing a second time  ⭐', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: a reader who unsubscribed from everything, and then buys something', () => {
    // ⭐ Receipts are not marketing. An unsubscribe must not stop somebody
    // getting the download they paid for — only a dead address or a spam
    // complaint does that (ARCHITECTURE → Consent).
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world, { email: 'buyer@example.test' })
      await unsubscribeAll(world.db, reader.id, reader.email)

      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, A_RECEIPT)
      await world.settle()
    })

    it('accepts it', () => {
      expect(response.status).toBe(202)
    })

    it('delivers it', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: an admin-scoped key used for a send', () => {
    // `admin` satisfies a `send` requirement; the reverse never holds.
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const { token } = await createApiKey(world.db, 'my own key', 'admin')
      response = await send(world, token, A_RECEIPT)
      await world.settle()
    })

    it('is accepted', () => {
      expect(response.status).toBe(202)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: no credentials at all', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      response = await send(world, null, A_RECEIPT)
      await world.settle()
    })

    it('is rejected as unauthorized, not as forbidden by Access', () => {
      expect(response.status).toBe(401)
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('records no message', async () => {
      const n = (await world.db.select({ n: count() }).from(messages).get())?.n
      expect(n).toBe(0)
    })
  })

  describe('Scenario: a token nobody ever minted', () => {
    let world: World
    let response: Response
    let body: { error?: string }

    beforeAll(async () => {
      world = createWorld()
      await createApiKey(world.db, 'the real one')
      response = await send(world, 'not-a-real-token', A_RECEIPT)
      body = await response.json()
      await world.settle()
    })

    it('is rejected', () => {
      expect(response.status).toBe(401)
    })

    it('says nothing about which part was wrong', () => {
      // Distinguishing "unknown" from "revoked" out loud tells an attacker
      // which guesses were close.
      expect(body.error).toBe('invalid token')
    })
  })

  describe('Scenario: a key that has been revoked', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const { id, token } = await createApiKey(world.db, 'the old checkout')
      await revokeApiKey(world.db, id)
      response = await send(world, token, A_RECEIPT)
      await world.settle()
    })

    it('is rejected', () => {
      expect(response.status).toBe(401)
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: a request with no recipient', () => {
    let world: World
    let response: Response
    let body: { error: string }

    beforeAll(async () => {
      world = createWorld()
      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, { subject: 'Your order', body: 'Thanks' })
      body = await response.json()
    })

    it('is rejected', () => {
      expect(response.status).toBe(400)
    })

    it('names the field that is wrong (SPEC 7.6)', () => {
      expect(body.error).toContain('`to`')
    })
  })

  describe('Scenario: a recipient that is not an address', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, { ...A_RECEIPT, to: 'nope' })
    })

    it('is rejected', () => {
      expect(response.status).toBe(400)
    })
  })

  describe('Scenario: a request with no subject', () => {
    let world: World
    let body: { error: string }

    beforeAll(async () => {
      world = createWorld()
      const { token } = await createApiKey(world.db, 'the checkout')
      body = await (
        await send(world, token, { to: 'buyer@example.test', body: 'Thanks' })
      ).json()
    })

    it('names the subject', () => {
      expect(body.error).toContain('`subject`')
    })
  })

  describe('Scenario: a request with no body', () => {
    let world: World
    let body: { error: string }

    beforeAll(async () => {
      world = createWorld()
      const { token } = await createApiKey(world.db, 'the checkout')
      body = await (
        await send(world, token, { to: 'buyer@example.test', subject: 'Your order' })
      ).json()
    })

    it('names the body', () => {
      expect(body.error).toContain('`body`')
    })
  })

  describe('Scenario: a payload that is not JSON at all', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, 'to=buyer@example.test&subject=hi')
    })

    it('is rejected', () => {
      expect(response.status).toBe(400)
    })
  })

  describe('Scenario: a recipient whose address hard-bounced', () => {
    // ⭐ SPEC 2.1 / 7.4. The one case where a receipt is stopped: the mailbox
    // is gone, so sending is pure reputation damage.
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'buyer@example.test' })
      await world.db
        .insert(suppressions)
        .values({ email: 'buyer@example.test', reason: 'hard_bounce', createdAt: new Date() })

      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, A_RECEIPT)
      await world.settle()
    })

    it('still accepts the request — the caller did nothing wrong', () => {
      expect(response.status).toBe(202)
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('records the block against the message', async () => {
      const row = await world.db.select().from(messages).get()
      expect(row?.status).toBe('suppressed')
    })

    it('says which suppression stopped it', async () => {
      const row = await world.db.select().from(messages).get()
      expect(row?.suppressedReason).toBe('hard_bounce')
    })
  })

  describe('Scenario: revoking a key that is already revoked', () => {
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      const { id } = await createApiKey(world.db, 'the checkout')
      await revokeApiKey(world.db, id)
      result = await revokeApiKey(world.db, id)
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })

    it('says it was already revoked', () => {
      expect(result.reason).toBe('already revoked')
    })
  })

  describe('Scenario: the key itself, at rest', () => {
    // Only the hash is stored, so a leaked database still cannot post as you.
    let world: World
    let token: string
    let stored: ApiKey | undefined

    beforeAll(async () => {
      world = createWorld()
      ;({ token } = await createApiKey(world.db, 'the checkout'))
      stored = await world.db.select().from(apiKeys).get()
    })

    it('is not stored in the clear', () => {
      expect(stored?.tokenHash).not.toBe(token)
    })

    it('is stored as a SHA-256 digest', () => {
      expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    })
  })
})
