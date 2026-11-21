// gap.md "Mailgun adapter" — Mailgun as the sending provider, and its webhook
// SPEC 2.1, 2.2, 2.6, 5.1, 5.2, 5.3 (Kōlea SPEC 10.1.5, 10.2.1, 11.1, 8.3.4)
//
// The adapter is a port: nothing here reaches Mailgun. Sending is driven through
// an injected fake `fetch`, which records what would have gone on the wire. The
// webhook is driven through `worker.fetch` with payloads signed the way Mailgun
// signs them (`tests/support/mailgun.ts`), so the signature check is the real one.
//
// The rule that matters most is the one Resend's spec already guards: a hard
// bounce or a complaint suppresses, a soft bounce changes nothing, and a webhook
// that does not verify applies nothing.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import type { Message, Subscriber } from '../../src/db/schema.ts'
import { events, messages, suppressions } from '../../src/db/schema.ts'
import { type Fetch, MailgunProvider } from '../../src/providers/mailgun.ts'
import type { OutgoingEmail, SendResult } from '../../src/providers/types.ts'
import { aBroadcast, aPerson, reload } from '../support/factories.ts'
import { MAILGUN_SIGNING_KEY, mailgunEvent, signMailgunWebhook } from '../support/mailgun.ts'
import { createWorld, type World } from '../support/world.ts'

const anEmail: OutgoingEmail = {
  ref: 42,
  to: 'reader@example.test',
  fromEmail: 'news@mg.example.test',
  fromName: 'The "Writer"',
  subject: 'This week',
  html: '<p>Hello</p>',
  text: 'Hello',
  listUnsubscribeUrl: 'https://mail.example.test/u/abc',
}

interface Call {
  url: string
  init: RequestInit
}

/** A `fetch` that answers every call with `answer` and remembers what it was asked. */
function fakeFetch(answer: () => Response | Promise<Response>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return await answer()
    },
  }
}

const accepted = () =>
  new Response(JSON.stringify({ id: '<20261120.abc@mg.example.test>', message: 'Queued.' }), {
    status: 200,
  })

/** The world's console provider sent it; Mailgun would have reported on it by this id. */
async function aSentMessageTo(world: World, email: string) {
  const person = await aPerson(world, { email })
  const broadcast = await aBroadcast(world, { subject: 'This week' })
  await startBroadcast(world.env, world.db, broadcast)
  const message = (await world.db.select().from(messages).get()) as Message
  return { person, message }
}

/** A world that reads Mailgun webhooks. `EMAIL_PROVIDER` stays `console`. */
function aMailgunWorld() {
  return createWorld({ MAILGUN_WEBHOOK_SIGNING_KEY: MAILGUN_SIGNING_KEY })
}

async function postMailgun(world: World, signed: { body: string; headers: Record<string, string> }) {
  return await world.fetch('/webhooks/mailgun', {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
  })
}

async function suppressionCount(world: World) {
  return (await world.db.select({ n: count() }).from(suppressions).get())?.n
}

describe('Feature: Mailgun is the provider', () => {
  // ───────────────────────────────────────────── happy path: sending

  describe('Scenario: one mail goes to Mailgun', () => {
    let result: SendResult
    let call: Call
    let form: URLSearchParams

    beforeAll(async () => {
      const fake = fakeFetch(accepted)
      const provider = new MailgunProvider({
        apiKey: 'key-test',
        domain: 'mg.example.test',
        fetch: fake.fetch,
      })
      result = await provider.send(anEmail)
      call = fake.calls[0]!
      form = new URLSearchParams(String(call.init.body))
    })

    it('posts to the domain’s messages endpoint in the US region by default', () => {
      expect(call.url).toBe('https://api.mailgun.net/v3/mg.example.test/messages')
    })

    it('authenticates with the API key as basic auth', () => {
      expect(new Headers(call.init.headers).get('Authorization')).toBe(`Basic ${btoa('api:key-test')}`)
    })

    it('sends the body form-encoded', () => {
      expect(new Headers(call.init.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded')
    })

    it('addresses it to the one reader', () => {
      expect(form.getAll('to')).toEqual(['reader@example.test'])
    })

    it('quotes the sender’s name without the quotes it carried', () => {
      expect(form.get('from')).toBe('"The Writer" <news@mg.example.test>')
    })

    it('switches Mailgun’s own tracking off — ours does the counting', () => {
      expect([form.get('o:tracking'), form.get('o:tracking-opens'), form.get('o:tracking-clicks')]).toEqual([
        'no',
        'no',
        'no',
      ])
    })

    it('⭐ carries the scoped one-click unsubscribe — SPEC 2.6', () => {
      expect(form.get('h:List-Unsubscribe')).toBe('<https://mail.example.test/u/abc>')
    })

    it('⭐ carries the RFC 8058 one-click marker', () => {
      expect(form.get('h:List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click')
    })

    it('returns Mailgun’s id without its angle brackets, the way its events name it', () => {
      expect(result).toEqual({ ok: true, providerMessageId: '20261120.abc@mg.example.test' })
    })
  })

  describe('Scenario: an EU account', () => {
    let url: string

    beforeAll(async () => {
      const fake = fakeFetch(accepted)
      await new MailgunProvider({
        apiKey: 'key-test',
        domain: 'mg.example.test',
        region: 'eu',
        fetch: fake.fetch,
      }).send(anEmail)
      url = fake.calls[0]!.url
    })

    it('posts to the EU API', () => {
      expect(url).toBe('https://api.eu.mailgun.net/v3/mg.example.test/messages')
    })
  })

  describe('Scenario: a batch of mail', () => {
    // Every mail is rendered for its one reader, so a batch is one call each,
    // a few at a time, results in input order.
    let results: SendResult[]
    let calls: Call[]

    beforeAll(async () => {
      let n = 0
      const fake = fakeFetch(() => {
        n += 1
        return new Response(JSON.stringify({ id: `<m${n}@mg.example.test>` }), { status: 200 })
      })
      const emails = Array.from({ length: 20 }, (_, i) => ({ ...anEmail, ref: i, to: `r${i}@example.test` }))
      results = await new MailgunProvider({
        apiKey: 'key-test',
        domain: 'mg.example.test',
        fetch: fake.fetch,
      }).sendBatch(emails)
      calls = fake.calls
    })

    it('makes one call per mail', () => {
      expect(calls.length).toBe(20)
    })

    it('returns one result per mail', () => {
      expect(results.filter((r) => r.ok).length).toBe(20)
    })
  })

  // ───────────────────────────────────────────── happy path: the webhook

  describe('Scenario: Mailgun reports a dead mailbox', () => {
    let world: World
    let response: Response
    let after: Subscriber

    beforeAll(async () => {
      world = aMailgunWorld()
      const sent = await aSentMessageTo(world, 'dead@example.test')
      response = await postMailgun(
        world,
        await signMailgunWebhook(
          mailgunEvent(sent.message.providerMessageId!, 'failed', {
            severity: 'permanent',
            reason: 'bounce',
            'delivery-status': { code: 550, message: 'No such user' },
          }),
        ),
      )
      after = await reload(world, sent.person)
    })

    it('accepts the signed webhook', () => {
      expect(response.status).toBe(200)
    })

    it('⭐ suppresses the address — SPEC 2.1', async () => {
      const row = await world.db.select().from(suppressions).get()
      expect(row?.reason).toBe('hard_bounce')
    })

    it('marks the person bounced', () => {
      expect(after.status).toBe('bounced')
    })
  })

  describe('Scenario: Mailgun reports a spam complaint', () => {
    let world: World

    beforeAll(async () => {
      world = aMailgunWorld()
      const sent = await aSentMessageTo(world, 'angry@example.test')
      await postMailgun(
        world,
        await signMailgunWebhook(mailgunEvent(sent.message.providerMessageId!, 'complained')),
      )
    })

    it('⭐ suppresses the address — SPEC 2.2', async () => {
      const row = await world.db.select().from(suppressions).get()
      expect(row?.reason).toBe('complaint')
    })
  })

  describe('Scenario: Mailgun reports a delivery', () => {
    let world: World

    beforeAll(async () => {
      world = aMailgunWorld()
      const sent = await aSentMessageTo(world, 'reader@example.test')
      await postMailgun(
        world,
        await signMailgunWebhook(mailgunEvent(sent.message.providerMessageId!, 'delivered')),
      )
    })

    it('records the delivery against the message — SPEC 5.1', async () => {
      const n = (await world.db.select({ n: count() }).from(events).where(eq(events.type, 'delivered')).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: the reader unsubscribed through Mailgun', () => {
    // Mailgun refuses that address from now on. Leaving them `active` would mean
    // every later send failing quietly at the provider.
    let world: World
    let after: Subscriber

    beforeAll(async () => {
      world = aMailgunWorld()
      const sent = await aSentMessageTo(world, 'leaving@example.test')
      await postMailgun(
        world,
        await signMailgunWebhook(mailgunEvent(sent.message.providerMessageId!, 'unsubscribed')),
      )
      after = await reload(world, sent.person)
    })

    it('takes them off everything', async () => {
      const row = await world.db.select().from(suppressions).get()
      expect(row?.reason).toBe('unsubscribed_all')
    })

    it('marks them unsubscribed', () => {
      expect(after.status).toBe('unsubscribed')
    })

    it('charges the unsubscribe to the mail', async () => {
      const n = (await world.db.select({ n: count() }).from(events).where(eq(events.type, 'unsubscribe')).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: Mailgun posts the same event twice', () => {
    // SPEC 5.3 — deduplicated on Mailgun's own event id.
    let world: World
    let second: Response

    beforeAll(async () => {
      world = aMailgunWorld()
      const sent = await aSentMessageTo(world, 'reader@example.test')
      const event = mailgunEvent(sent.message.providerMessageId!, 'delivered')
      await postMailgun(world, await signMailgunWebhook(event))
      second = await postMailgun(world, await signMailgunWebhook(event))
    })

    it('accepts the replay', () => {
      expect(second.status).toBe(200)
    })

    it('records one event, not two', async () => {
      const n = (await world.db.select({ n: count() }).from(events).where(eq(events.type, 'delivered')).get())?.n
      expect(n).toBe(1)
    })
  })

  // ───────────────────────────────────────────── sad path: sending

  describe('Scenario: Mailgun is rate limiting', () => {
    let result: SendResult

    beforeAll(async () => {
      const fake = fakeFetch(() => new Response('slow down', { status: 429 }))
      result = await new MailgunProvider({ apiKey: 'k', domain: 'mg.example.test', fetch: fake.fetch }).send(
        anEmail,
      )
    })

    it('fails retryably, so the mail goes back on the queue', () => {
      expect(result.ok === false && result.retryable).toBe(true)
    })
  })

  describe('Scenario: Mailgun refuses the mail', () => {
    let result: SendResult

    beforeAll(async () => {
      const fake = fakeFetch(() => new Response('{"message":"bad from"}', { status: 400 }))
      result = await new MailgunProvider({ apiKey: 'k', domain: 'mg.example.test', fetch: fake.fetch }).send(
        anEmail,
      )
    })

    it('fails for good, with Mailgun’s words kept', () => {
      expect(result).toEqual({ ok: false, error: 'mailgun 400: {"message":"bad from"}', retryable: false })
    })
  })

  describe('Scenario: the line drops mid-send', () => {
    // ⭐ It may have reached Mailgun. Re-queueing could mail the reader twice.
    let result: SendResult

    beforeAll(async () => {
      const fake = fakeFetch(() => {
        throw new Error('connection reset')
      })
      result = await new MailgunProvider({ apiKey: 'k', domain: 'mg.example.test', fetch: fake.fetch }).send(
        anEmail,
      )
    })

    it('fails visibly instead of retrying blind', () => {
      expect(result.ok === false && result.retryable).toBe(false)
    })
  })

  // ───────────────────────────────────────────── sad path: the webhook

  describe('Scenario: a temporary failure', () => {
    // ⭐ A full mailbox is not a dead address.
    let world: World
    let after: Subscriber

    beforeAll(async () => {
      world = aMailgunWorld()
      const sent = await aSentMessageTo(world, 'full@example.test')
      await postMailgun(
        world,
        await signMailgunWebhook(
          mailgunEvent(sent.message.providerMessageId!, 'failed', {
            severity: 'temporary',
            reason: 'generic',
            'delivery-status': { code: 452, message: 'Mailbox full' },
          }),
        ),
      )
      after = await reload(world, sent.person)
    })

    it('suppresses nothing', async () => {
      expect(await suppressionCount(world)).toBe(0)
    })

    it('leaves the person active', () => {
      expect(after.status).toBe('active')
    })

    it('still records a bounce, so it is countable', async () => {
      const n = (await world.db.select({ n: count() }).from(events).where(eq(events.type, 'bounce')).get())?.n
      expect(n).toBe(1)
    })
  })

  describe('Scenario: a permanent failure that is not the mailbox', () => {
    // An ESP block says nothing lasting about the address (Kōlea 8.3.4).
    let world: World

    beforeAll(async () => {
      world = aMailgunWorld()
      const sent = await aSentMessageTo(world, 'blocked@example.test')
      await postMailgun(
        world,
        await signMailgunWebhook(
          mailgunEvent(sent.message.providerMessageId!, 'failed', { severity: 'permanent', reason: 'espblock' }),
        ),
      )
    })

    it('suppresses nothing', async () => {
      expect(await suppressionCount(world)).toBe(0)
    })
  })

  describe('Scenario: a webhook whose signature does not verify', () => {
    // SPEC 5.2 — rejected with the status Mailgun reads as "do not send again".
    let world: World
    let response: Response

    beforeAll(async () => {
      world = aMailgunWorld()
      const sent = await aSentMessageTo(world, 'dead@example.test')
      const signed = await signMailgunWebhook(
        mailgunEvent(sent.message.providerMessageId!, 'complained'),
        'somebody-elses-key',
      )
      response = await postMailgun(world, signed)
    })

    it('rejects it', () => {
      expect(response.status).toBe(406)
    })

    it('⭐ applies nothing from it', async () => {
      expect(await suppressionCount(world)).toBe(0)
    })
  })

  describe('Scenario: a webhook with no signature at all', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = aMailgunWorld()
      const sent = await aSentMessageTo(world, 'dead@example.test')
      response = await postMailgun(world, {
        body: JSON.stringify({ 'event-data': mailgunEvent(sent.message.providerMessageId!, 'complained') }),
        headers: { 'content-type': 'application/json' },
      })
    })

    it('rejects it', () => {
      expect(response.status).toBe(406)
    })

    it('says why', async () => {
      expect(((await response.json()) as { error: string }).error).toContain('no signature')
    })
  })

  describe('Scenario: a correctly signed webhook from two days ago', () => {
    // A captured payload replayed later is refused on its age.
    let world: World
    let response: Response

    beforeAll(async () => {
      world = aMailgunWorld()
      const sent = await aSentMessageTo(world, 'dead@example.test')
      response = await postMailgun(
        world,
        await signMailgunWebhook(mailgunEvent(sent.message.providerMessageId!, 'complained'), MAILGUN_SIGNING_KEY, {
          timestamp: Math.floor(Date.now() / 1000) - 2 * 86_400,
        }),
      )
    })

    it('rejects it', () => {
      expect(response.status).toBe(406)
    })

    it('applies nothing from it', async () => {
      expect(await suppressionCount(world)).toBe(0)
    })
  })

  describe('Scenario: the signing key was never set', () => {
    // Fails closed, and with a status Mailgun retries, so nothing is lost
    // while the key is missing.
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const sent = await aSentMessageTo(world, 'dead@example.test')
      response = await postMailgun(
        world,
        await signMailgunWebhook(mailgunEvent(sent.message.providerMessageId!, 'complained')),
      )
    })

    it('refuses to read it', () => {
      expect(response.status).toBe(503)
    })

    it('applies nothing from it', async () => {
      expect(await suppressionCount(world)).toBe(0)
    })
  })
})
