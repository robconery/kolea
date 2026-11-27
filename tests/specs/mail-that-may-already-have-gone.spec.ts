// Held mail, released later (fix): mail that may already have gone,
// or that the provider took and then refused, is never resent in bulk.
// House rules 1 and 2: nobody gets it twice, and nothing is silently dropped.
// Unknown outcomes are not retried blind, and a provider refusal is a visible
// failure.
//
// A dropped connection after the request may have reached Mailgun, and a 2xx
// with no id may well be sending: both are stored `outcome unknown`. A
// `rejected` or a permanent non-bounce failure flips a `sent` message to
// `failed`. All of them land under "check before sending" on Undelivered, with
// a one-message send-again behind a tick, and no bulk path claims them.
import { beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { createForm, failedReplies, setFormReply } from '../../src/core/forms.ts'
import { undeliveredMail, type UndeliveredReport } from '../../src/core/undelivered.ts'
import type { Message, Subscriber } from '../../src/db/schema.ts'
import { devOutbox, messages } from '../../src/db/schema.ts'
import { type Fetch, MailgunProvider } from '../../src/providers/mailgun.ts'
import type { OutgoingEmail, SendResult } from '../../src/providers/types.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { MAILGUN_SIGNING_KEY, mailgunEvent, signMailgunWebhook } from '../support/mailgun.ts'
import { createWorld, type World } from '../support/world.ts'

const anEmail: OutgoingEmail = {
  ref: 1,
  messageId: 1,
  to: 'reader@example.test',
  fromEmail: 'news@mg.example.test',
  fromName: 'Writer',
  subject: 'This week',
  html: '<p>Hi</p>',
  text: 'Hi',
}

const mailgunAnswering = (answer: () => Response): MailgunProvider => {
  const fetch: Fetch = async () => answer()
  return new MailgunProvider({ apiKey: 'k', domain: 'mg.example.test', fetch })
}

const UNKNOWN = 'outcome unknown: mailgun connection dropped, not retried (Error: connection reset)'

async function messageFor(w: World, person: Subscriber): Promise<Message> {
  return (await w.db.select().from(messages).where(eq(messages.subscriberId, person.id)).get())!
}

/** The console provider sent it; then rewrite the row as a failure of this shape. */
async function failAs(w: World, person: Subscriber, set: Partial<Message>) {
  const row = await messageFor(w, person)
  await w.db
    .update(messages)
    .set({ status: 'failed', provider: null, providerMessageId: null, sentAt: null, ...set })
    .where(eq(messages.id, row.id))
  await w.db.delete(devOutbox).where(eq(devOutbox.toEmail, person.email))
  return row
}

const mailsTo = async (w: World, email: string) => (await w.outbox()).filter((m) => m.toEmail === email).length
const statusOf = async (w: World, id: number) =>
  (await w.db.select({ s: messages.status }).from(messages).where(eq(messages.id, id)).get())?.s

describe('Feature: mail that may already have gone is checked before it is sent again', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the line drops after the request left', () => {
    let result: SendResult

    beforeAll(async () => {
      result = await mailgunAnswering(() => {
        throw new Error('connection reset')
      }).send(anEmail)
    })

    it('⭐ is stored as an unknown outcome, not a plain failure', () => {
      expect(result.ok === false && result.error.startsWith('outcome unknown')).toBe(true)
    })

    it('is flagged for the send path', () => {
      expect(result.ok === false && result.outcomeUnknown).toBe(true)
    })
  })

  describe('Scenario: Mailgun says 200 but gives no id', () => {
    let result: SendResult

    beforeAll(async () => {
      result = await mailgunAnswering(() => new Response('{}', { status: 200 })).send(anEmail)
    })

    it('⭐ is stored as an unknown outcome', () => {
      expect(result.ok === false && result.error.startsWith('outcome unknown')).toBe(true)
    })
  })

  describe('Scenario: one copy of a broadcast failed plainly and one may have gone', () => {
    let w: World
    let plain: Message
    let unknown: Message
    let page: string
    let flash: string

    beforeAll(async () => {
      w = createWorld()
      const ada = await aPerson(w, { email: 'ada@example.test' })
      const bob = await aPerson(w, { email: 'bob@example.test' })
      const id = await aBroadcast(w, { subject: 'This week in Ruby' })
      await startBroadcast(w.env, w.db, id)
      plain = await failAs(w, ada, { error: 'mailgun 503: try later' })
      unknown = await failAs(w, bob, { error: UNKNOWN })

      page = await (await w.fetch('/undelivered')).text()
      const res = await w.post('/undelivered/send-again', { kind: 'broadcast', id: String(id), confirm: 'send-again' })
      flash = decodeURIComponent(res.headers.get('location') ?? '')
      await w.settle()
    })

    it('lists the uncertain one under "check before sending"', () => {
      expect(page).toContain('Check before sending')
    })

    it('says what happened to it', () => {
      expect(page).toContain('outcome unknown')
    })

    it('queues only the plain failure', () => {
      expect(flash).toContain('Queued 1')
    })

    it('delivers the plain failure', async () => {
      expect(await mailsTo(w, 'ada@example.test')).toBe(1)
    })

    it('⭐ does not resend the one that may have gone', async () => {
      expect(await mailsTo(w, 'bob@example.test')).toBe(0)
    })

    it('leaves it failed and visible', async () => {
      expect(await statusOf(w, unknown.id)).toBe('failed')
    })

    it('records the plain one as sent', async () => {
      expect(await statusOf(w, plain.id)).toBe('sent')
    })
  })

  describe('Scenario: the operator checks the provider and sends the uncertain one', () => {
    let w: World
    let unknown: Message
    let unticked: string | undefined

    beforeAll(async () => {
      w = createWorld()
      const bob = await aPerson(w, { email: 'bob@example.test' })
      const id = await aBroadcast(w)
      await startBroadcast(w.env, w.db, id)
      unknown = await failAs(w, bob, { error: UNKNOWN })

      await w.post('/undelivered/send-again', { kind: 'message', id: String(unknown.id), confirm: 'send-again' })
      await w.settle()
      unticked = await statusOf(w, unknown.id)
      await w.post('/undelivered/send-again', {
        kind: 'message',
        id: String(unknown.id),
        confirm: 'send-again',
        checked: 'yes',
      })
      await w.settle()
    })

    it('sends nothing without the tick', () => {
      expect(unticked).toBe('failed')
    })

    it('sends it once with the tick', async () => {
      expect(await mailsTo(w, 'bob@example.test')).toBe(1)
    })
  })

  describe('Scenario: Mailgun took the mail, then rejected it', () => {
    let w: World
    let msg: Message
    let report: UndeliveredReport
    let status: string | undefined

    beforeAll(async () => {
      w = createWorld({ MAILGUN_WEBHOOK_SIGNING_KEY: MAILGUN_SIGNING_KEY })
      const ada = await aPerson(w, { email: 'ada@example.test' })
      const id = await aBroadcast(w)
      await startBroadcast(w.env, w.db, id)
      msg = await messageFor(w, ada)
      const signed = await signMailgunWebhook(mailgunEvent(msg.providerMessageId!, 'rejected', { reason: 'policy' }))
      await w.fetch('/webhooks/mailgun', { method: 'POST', headers: signed.headers, body: signed.body })
      status = await statusOf(w, msg.id)
      report = await undeliveredMail(w.db)
    })

    it('⭐ stops reading sent', () => {
      expect(status).toBe('failed')
    })

    it('lists it to check before sending', () => {
      expect(report.checkFirst.map((m) => m.id)).toEqual([msg.id])
    })

    it('says the provider refused it', () => {
      expect(report.checkFirst[0]?.error).toContain('refused by the provider')
    })

    it('is not offered in bulk', () => {
      expect(report.total).toBe(0)
    })
  })

  describe('Scenario: Mailgun gave up on the mail for good, not a dead mailbox', () => {
    let w: World
    let status: string | undefined

    beforeAll(async () => {
      w = createWorld({ MAILGUN_WEBHOOK_SIGNING_KEY: MAILGUN_SIGNING_KEY })
      const ada = await aPerson(w, { email: 'ada@example.test' })
      const id = await aBroadcast(w)
      await startBroadcast(w.env, w.db, id)
      const msg = await messageFor(w, ada)
      const signed = await signMailgunWebhook(
        mailgunEvent(msg.providerMessageId!, 'failed', { severity: 'permanent', reason: 'suppress-unsubscribe' }),
      )
      await w.fetch('/webhooks/mailgun', { method: 'POST', headers: signed.headers, body: signed.body })
      status = await statusOf(w, msg.id)
    })

    it('marks the message failed', () => {
      expect(status).toBe('failed')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a temporary failure', () => {
    // Mailgun keeps trying. Nothing is known to be lost yet.
    let status: string | undefined

    beforeAll(async () => {
      const w = createWorld({ MAILGUN_WEBHOOK_SIGNING_KEY: MAILGUN_SIGNING_KEY })
      const ada = await aPerson(w, { email: 'ada@example.test' })
      const id = await aBroadcast(w)
      await startBroadcast(w.env, w.db, id)
      const msg = await messageFor(w, ada)
      const signed = await signMailgunWebhook(
        mailgunEvent(msg.providerMessageId!, 'failed', { severity: 'temporary', reason: 'generic' }),
      )
      await w.fetch('/webhooks/mailgun', { method: 'POST', headers: signed.headers, body: signed.body })
      status = await statusOf(w, msg.id)
    })

    it('leaves the message sent', () => {
      expect(status).toBe('sent')
    })
  })

  describe('Scenario: asking to send uncertain mail in bulk', () => {
    let w: World
    let flash: string

    beforeAll(async () => {
      w = createWorld()
      const bob = await aPerson(w, { email: 'bob@example.test' })
      const id = await aBroadcast(w)
      await startBroadcast(w.env, w.db, id)
      await failAs(w, bob, { error: UNKNOWN })
      const res = await w.post('/undelivered/send-again', {
        kind: 'broadcast',
        id: String(id),
        confirm: 'send-again',
        checked: 'yes',
      })
      flash = decodeURIComponent(res.headers.get('location') ?? '')
      await w.settle()
    })

    it('is refused', () => {
      expect(flash).toContain('one message at a time')
    })

    it('⭐ sends nothing', async () => {
      expect(await mailsTo(w, 'bob@example.test')).toBe(0)
    })
  })

  describe('Scenario: a form reply that may have gone', () => {
    let people: string[]

    beforeAll(async () => {
      const w = createWorld()
      const formId = await createForm(w.db, { name: 'Toolkit', doubleOptIn: false })
      await setFormReply(w.db, formId, { subject: 'Your toolkit', bodyJson: null, bodyMd: 'Here.' })
      await w.post('/f/toolkit', { email: 'maybe@example.test' })
      await w.settle()
      await w.db
        .update(messages)
        .set({ status: 'failed', error: UNKNOWN, providerMessageId: null })
        .where(and(eq(messages.kind, 'form'), eq(messages.toEmail, 'maybe@example.test')))
      people = (await failedReplies(w.db, formId)).map((r) => r.email)
    })

    it('⭐ is not offered for a resend', () => {
      expect(people).toEqual([])
    })
  })
})
