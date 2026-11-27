// Provider webhooks during a large send
// SPEC 5.2, 5.2a, 5.3, 5.13, 5.14, 4.5a
//
// A broadcast of thousands brings back a few webhooks per mail, all inside the
// minutes the send itself is busiest. Each one has to find its message cheaply,
// and one that cannot be applied right now has to come back later rather than
// be thrown away. A large send once overloaded the database on exactly this:
// every webhook read the whole `messages` table to find one row, and the ones
// the database refused were answered "bad signature", so the provider stopped
// sending them.
//
// ⚠️ `RESEND_API_KEY` is set only because the webhook route refuses to parse
// without it. `EMAIL_PROVIDER` stays `console`; nothing here reaches the wire.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import type { Message } from '../../src/db/schema.ts'
import { events, messages } from '../../src/db/schema.ts'
import { MESSAGE_ID_TAG, ResendProvider } from '../../src/providers/resend.ts'
import type { OutgoingEmail, ProviderEvent } from '../../src/providers/types.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { freshD1, refusingQueries } from '../support/d1.ts'
import { signResendWebhook, WEBHOOK_SECRET } from '../support/svix.ts'
import { createWorld, type World } from '../support/world.ts'

const webhookWorld = () => createWorld({ RESEND_API_KEY: 're_test_key', RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET })

/** Two people mailed one broadcast, through the console provider. */
async function twoSentMessages(world: World): Promise<Message[]> {
  await aPerson(world, { email: 'one@example.test' })
  await aPerson(world, { email: 'two@example.test' })
  await startBroadcast(world.env, world.db, await aBroadcast(world, { subject: 'This week' }))
  return await world.db.select().from(messages).orderBy(messages.id).all()
}

/** Post a signed Resend webhook about `emailId`, carrying `tags` as Resend echoes them. */
async function postWebhook(world: World, emailId: string, tags: unknown, svixId = 'msg_1', type = 'email.delivered') {
  const signed = await signResendWebhook(
    { type, created_at: new Date().toISOString(), data: { email_id: emailId, ...(tags === undefined ? {} : { tags }) } },
    WEBHOOK_SECRET,
    svixId,
  )
  return await world.fetch('/webhooks/resend', { method: 'POST', headers: signed.headers, body: signed.body })
}

const eventsOn = async (world: World, messageId: number) =>
  await world.db.select().from(events).where(eq(events.messageId, messageId)).all()

const reloadMessage = async (world: World, id: number) =>
  (await world.db.select().from(messages).where(eq(messages.id, id)).get())!

/** The Resend adapter reading a webhook body, signature check off. */
async function parsed(data: Record<string, unknown>): Promise<ProviderEvent | undefined> {
  const request = new Request('https://mail.example.test/webhooks/resend', {
    method: 'POST',
    headers: { 'svix-id': 'msg_parse' },
    body: JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(), data }),
  })
  return (await new ResendProvider('re_test_key').parseWebhook(request, undefined))[0]
}

describe('Feature: provider webhooks during a large send', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: every mail goes out carrying its own message id', () => {
    // The adapter on its own against a canned answer. No request leaves the process.
    let sent: { tags?: { name: string; value: string }[] }[]

    beforeAll(async () => {
      const real = globalThis.fetch
      let body = ''
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body)
        return Response.json({ data: [{ id: 'resend-uuid-1' }] })
      }) as typeof fetch
      try {
        const email: OutgoingEmail = {
          ref: 42,
          messageId: 42,
          to: 'one@example.test',
          fromEmail: 'mara@example.test',
          fromName: 'Mara',
          subject: 'This week',
          html: '<p>Hi</p>',
          text: 'Hi',
        }
        await new ResendProvider('re_test_key').sendBatch([email])
      } finally {
        globalThis.fetch = real
      }
      sent = JSON.parse(body)
    })

    it('tags it with the message id, in the characters the provider allows', () => {
      expect(sent[0]?.tags).toEqual([{ name: MESSAGE_ID_TAG, value: '42' }])
    })
  })

  describe('Scenario: the provider echoes the tag back in either shape', () => {
    let asMap: ProviderEvent | undefined
    let asList: ProviderEvent | undefined
    let notANumber: ProviderEvent | undefined
    let absent: ProviderEvent | undefined

    beforeAll(async () => {
      asMap = await parsed({ email_id: 'resend-uuid-1', tags: { [MESSAGE_ID_TAG]: '42', category: 'news' } })
      asList = await parsed({ email_id: 'resend-uuid-1', tags: [{ name: MESSAGE_ID_TAG, value: '42' }] })
      notANumber = await parsed({ email_id: 'resend-uuid-1', tags: { [MESSAGE_ID_TAG]: '42; drop table' } })
      absent = await parsed({ email_id: 'resend-uuid-1' })
    })

    it('reads it from a map of name to value', () => {
      expect(asMap?.messageId).toBe(42)
    })

    it('reads it from a list of names and values', () => {
      expect(asList?.messageId).toBe(42)
    })

    it('ignores a value that is not a whole number', () => {
      expect(notANumber?.messageId).toBeUndefined()
    })

    it('still reads a webhook that carries no tags', () => {
      expect(absent?.providerMessageId).toBe('resend-uuid-1')
    })
  })

  describe('Scenario: a webhook naming its own message', () => {
    let world: World
    let sent: Message[]
    let response: Response

    beforeAll(async () => {
      world = webhookWorld()
      sent = await twoSentMessages(world)
      const target = sent[1]!
      response = await postWebhook(world, target.providerMessageId!, { [MESSAGE_ID_TAG]: String(target.id) })
    })

    it('accepts it', () => {
      expect(response.status).toBe(200)
    })

    it('records the event against that message', async () => {
      expect((await eventsOn(world, sent[1]!.id)).map((e) => e.type)).toEqual(['delivered'])
    })
  })

  describe('Scenario: finding the message never reads the whole table', () => {
    // SPEC 5.13. The query plans the lookups actually get, from the real schema.
    let byProviderId: string
    let byOurId: string

    beforeAll(async () => {
      const world = webhookWorld()
      const sqlite = (world.env.DB as unknown as { sqlite: import('bun:sqlite').Database }).sqlite
      const plan = (sql: string) =>
        (sqlite.query(`explain query plan ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(' / ')
      byProviderId = plan('select * from messages where provider_message_id = ?')
      byOurId = plan('select * from messages where id = ?')
    })

    it('looks the provider’s id up by its index', () => {
      expect(byProviderId).toBe('SEARCH messages USING INDEX messages_provider_message_id_idx (provider_message_id=?)')
    })

    it('looks our own id up by primary key', () => {
      expect(byOurId).toContain('USING INTEGER PRIMARY KEY')
    })
  })

  describe('Scenario: the index already made by hand on an install', () => {
    // The migration must be a no-op where an operator already created the
    // index under the same name, rather than failing the deploy.
    let failure: unknown = null

    beforeAll(() => {
      const dir = join(import.meta.dir, '../../migrations')
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
      const statementsOf = (file: string) =>
        readFileSync(join(dir, file), 'utf8')
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean)
      const adding = files.find((f) => statementsOf(f).some((s) => s.includes('messages_provider_message_id_idx')))!
      const sqlite = (freshD1() as unknown as { sqlite: import('bun:sqlite').Database }).sqlite
      for (const file of files.filter((f) => f < adding)) for (const s of statementsOf(file)) sqlite.run(s)
      sqlite.run('CREATE INDEX messages_provider_message_id_idx ON messages (provider_message_id)')
      try {
        for (const s of statementsOf(adding)) sqlite.run(s)
      } catch (err) {
        failure = err
      }
    })

    it('applies cleanly over it', () => {
      expect(failure).toBeNull()
    })
  })

  describe('Scenario: a webhook for mail whose record never landed', () => {
    // ⭐ The provider took the mail and the write that should have said so was
    // lost. The row still says `queued`, with no provider id, so the provider's
    // id alone could never find it. Our own id in the tag can, and the event is
    // proof the mail went: the row is completed from it, and nothing is sent.
    let world: World
    let row: Message
    let mailsBefore: number
    let after: Message

    beforeAll(async () => {
      world = webhookWorld()
      row = (await twoSentMessages(world))[0]!
      await world.db
        .update(messages)
        .set({ status: 'queued', provider: null, providerMessageId: null, sentAt: null, providerCalledAt: new Date() })
        .where(eq(messages.id, row.id))
      mailsBefore = (await world.outbox()).length
      await postWebhook(world, 'resend-uuid-lost', { [MESSAGE_ID_TAG]: String(row.id) })
      after = await reloadMessage(world, row.id)
    })

    it('marks the message sent', () => {
      expect(after.status).toBe('sent')
    })

    it('records the provider’s id on it', () => {
      expect(after.providerMessageId).toBe('resend-uuid-lost')
    })

    it('records the event against it', async () => {
      expect((await eventsOn(world, row.id)).map((e) => e.type)).toEqual(['delivered'])
    })

    it('sends nothing  ⭐', async () => {
      expect((await world.outbox()).length).toBe(mailsBefore)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a tag naming somebody else’s message', () => {
    // A forged body, or a mix-up. The tag is a hint: the row it names is not the
    // mail the provider is talking about, so it is not touched, and the event
    // goes where the provider's own id says.
    let world: World
    let sent: Message[]

    beforeAll(async () => {
      world = webhookWorld()
      sent = await twoSentMessages(world)
      await postWebhook(world, sent[0]!.providerMessageId!, { [MESSAGE_ID_TAG]: String(sent[1]!.id) })
    })

    it('records the event against the mail the provider named', async () => {
      expect((await eventsOn(world, sent[0]!.id)).map((e) => e.type)).toEqual(['delivered'])
    })

    it('leaves the message the tag named alone', async () => {
      expect(await eventsOn(world, sent[1]!.id)).toHaveLength(0)
    })
  })

  describe('Scenario: a tag naming mail the provider was never asked for', () => {
    // A queued row that never reached the provider has no provider id either,
    // but no webhook can be about it. A guessed number must not complete it.
    let world: World
    let row: Message
    let after: Message

    beforeAll(async () => {
      world = webhookWorld()
      row = (await twoSentMessages(world))[0]!
      await world.db
        .update(messages)
        .set({ status: 'queued', provider: null, providerMessageId: null, sentAt: null, providerCalledAt: null })
        .where(eq(messages.id, row.id))
      await postWebhook(world, 'resend-uuid-guess', { [MESSAGE_ID_TAG]: String(row.id) }, 'msg_1', 'email.complained')
      after = await reloadMessage(world, row.id)
    })

    it('leaves it queued', () => {
      expect(after.status).toBe('queued')
    })

    it('writes no provider id onto it', () => {
      expect(after.providerMessageId).toBeNull()
    })

    it('records nothing against it', async () => {
      expect(await eventsOn(world, row.id)).toHaveLength(0)
    })
  })

  describe('Scenario: the database refusing while a genuine webhook is applied', () => {
    // SPEC 5.2a. The signature checked out; only the database said no. A 401
    // would tell the provider the webhook was forged, and it would stop
    // delivering a real bounce. A 503 brings it back.
    let world: World
    let refused: Response
    let replayed: Response
    let rows: number

    beforeAll(async () => {
      world = webhookWorld()
      const sent = await twoSentMessages(world)
      const healthy = world.env.DB
      world.env.DB = refusingQueries(healthy, /from "messages"/i, 1)
      refused = await postWebhook(world, sent[0]!.providerMessageId!, undefined, 'msg_retry')
      world.env.DB = healthy
      replayed = await postWebhook(world, sent[0]!.providerMessageId!, undefined, 'msg_retry')
      rows = (await eventsOn(world, sent[0]!.id)).length
    })

    it('answers 503, so the provider delivers it again', () => {
      expect(refused.status).toBe(503)
    })

    it('says when to come back', () => {
      expect(refused.headers.get('retry-after')).toBe('60')
    })

    it('takes the redelivery', () => {
      expect(replayed.status).toBe(200)
    })

    it('records the event once', () => {
      expect(rows).toBe(1)
    })
  })

  describe('Scenario: a webhook with a bad signature, while the database is fine', () => {
    // The other half of SPEC 5.2a: a forgery is still refused as one.
    let response: Response

    beforeAll(async () => {
      const world = webhookWorld()
      const sent = await twoSentMessages(world)
      const signed = await signResendWebhook(
        { type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: sent[0]!.providerMessageId } },
        `whsec_${btoa('somebody-elses-secret-32-bytes!!')}`,
      )
      response = await world.fetch('/webhooks/resend', { method: 'POST', headers: signed.headers, body: signed.body })
    })

    it('refuses it as unauthorized', () => {
      expect(response.status).toBe(401)
    })
  })
})
