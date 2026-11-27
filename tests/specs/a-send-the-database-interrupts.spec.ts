// A send the database interrupts leaves nobody waiting and nobody mailed twice
// SPEC 3.11, 3.13, 3.14, 4.5a, 4.8, 4.9
//
// A large broadcast is when the database is busiest, and an overloaded D1
// refuses queries at any point in a send: between writing a page of people and
// queuing them, half-way through the pages the Send button drives, after the
// provider took a batch and before the result is written. Each of those used
// to leave people `queued` with nothing coming for them, or show the operator
// an error for a send that was in fact under way.
//
// Two rules, in this order. Nobody ever gets the same mail twice: a message the
// provider may have is never sent again by anything automatic. And nobody is
// left silently waiting: what can be sent safely is, and what cannot goes to
// the operator as mail that may have gone.
import { beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { launchBroadcast, type LaunchResult } from '../../src/core/broadcasts.ts'
import type { Message } from '../../src/db/schema.ts'
import { broadcasts, messages } from '../../src/db/schema.ts'
import { ConsoleProvider } from '../../src/providers/console.ts'
import { ResendProvider } from '../../src/providers/resend.ts'
import type { OutgoingEmail, SendResult } from '../../src/providers/types.ts'
import type { SendJob } from '../../src/types.ts'
import worker from '../../src/worker.tsx'
import { refusingQueries } from '../support/d1.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, sendBatchOf, type World } from '../support/world.ts'

/** Three people on the list and a draft to send them. */
async function threePeopleAndADraft(world: World): Promise<number> {
  await aPerson(world, { email: 'one@example.test' })
  await aPerson(world, { email: 'two@example.test' })
  await aPerson(world, { email: 'three@example.test' })
  return await aBroadcast(world, { subject: 'This week' })
}

/** A queue that refuses its first `refusals` hand-overs, then keeps what it is given. */
function aQueueThatFailsFirst(refusals = 1) {
  let left = refusals
  const held: number[] = []
  const binding = {
    async sendBatch(batch: Iterable<{ body: SendJob }>) {
      if (left-- > 0) throw new Error('queue unavailable')
      for (const message of batch) held.push(message.body.messageId)
    },
  } as unknown as Queue<SendJob>
  return { held, binding }
}

const broadcastOf = async (world: World, id: number) =>
  (await world.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get())!

const mailsTo = async (world: World, email: string) => (await world.outbox()).filter((m) => m.toEmail === email).length

const flashOf = (res: Response) => decodeURIComponent(new URL(res.headers.get('location') ?? '/', 'https://x.test').searchParams.get('flash') ?? '')

const A_MAIL: OutgoingEmail = {
  ref: 1,
  messageId: 1,
  to: 'one@example.test',
  fromEmail: 'mara@example.test',
  fromName: 'Mara',
  subject: 'This week',
  html: '<p>Hi</p>',
  text: 'Hi',
}

/**
 * Answer the provider's API with `answers` in turn (a function throws, which is
 * a request that got no answer). Records each request's idempotency key and
 * how many emails the API actually took. Nothing leaves the process.
 */
async function whileTheApiAnswers(answers: (() => Response)[], run: () => Promise<SendResult[]>) {
  const real = globalThis.fetch
  const keys: string[] = []
  let call = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    keys.push(new Headers(init?.headers as Record<string, string>).get('idempotency-key') ?? '')
    const answer = answers[Math.min(call++, answers.length - 1)]!
    return answer()
  }) as typeof fetch
  try {
    return { results: await run(), keys }
  } finally {
    globalThis.fetch = real
  }
}

const noAnswer = () => {
  throw new TypeError('Network connection lost.')
}

describe('Feature: a send the database interrupts', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a page died between writing its people and queuing them', () => {
    // SPEC 3.13. The page wrote three rows and the hand-over to the queue
    // failed. The cursor stays put, so the next pass walks the same page, finds
    // the rows already there, and hands them over itself.
    let world: World
    let id: number
    let launched: LaunchResult
    let cursorAfterFailure: number
    let held: number[]

    beforeAll(async () => {
      world = createWorld()
      id = await threePeopleAndADraft(world)
      const queue = aQueueThatFailsFirst()
      world.env.SEND_QUEUE = queue.binding
      held = queue.held

      launched = await launchBroadcast(world.env, world.db, id)
      cursorAfterFailure = (await broadcastOf(world, id)).cursorSubscriberId

      await world.tick()
      // The queue delivers what it now holds.
      await worker.queue(sendBatchOf([...held]).batch, world.env)
      await world.tick()
    })

    it('tells the caller the send stopped part-way', () => {
      expect(launched).toMatchObject({ ok: true, interrupted: 'queue unavailable' })
    })

    it('does not move past the page it could not queue', () => {
      expect(cursorAfterFailure).toBe(0)
    })

    it('hands every one of them to the queue on the next pass  ⭐', async () => {
      expect(held).toHaveLength(3)
    })

    it('mails each of them exactly once', async () => {
      expect([
        await mailsTo(world, 'one@example.test'),
        await mailsTo(world, 'two@example.test'),
        await mailsTo(world, 'three@example.test'),
      ]).toEqual([1, 1, 1])
    })

    it('finishes the broadcast', async () => {
      expect((await broadcastOf(world, id)).status).toBe('sent')
    })
  })

  describe('Scenario: the operator presses Send while the database is refusing', () => {
    // SPEC 3.14. The send started, and the first page's writes were refused.
    // The operator is told it is under way, not shown an error that invites a
    // second press, and the minutely run carries it on.
    let world: World
    let id: number
    let res: Response
    let statusAfterPress: string

    beforeAll(async () => {
      world = createWorld()
      id = await threePeopleAndADraft(world)
      const healthy = world.env.DB
      world.env.DB = refusingQueries(healthy, /insert into "messages"/i, 1)
      res = await world.post(`/broadcasts/${id}/send`, { confirm: 'send', expected: '3' })
      world.env.DB = healthy
      statusAfterPress = (await broadcastOf(world, id)).status
      await world.tick()
    })

    it('answers with the broadcast page, not an error', () => {
      expect(res.status).toBe(302)
    })

    it('says the send is under way and carries on by itself', () => {
      expect(flashOf(res)).toContain('the send carries on by itself within a minute')
    })

    it('leaves the broadcast sending', () => {
      expect(statusAfterPress).toBe('sending')
    })

    it('mails everyone once the next minute comes round', async () => {
      expect((await world.outbox()).length).toBe(3)
    })

    it('finishes the broadcast', async () => {
      expect((await broadcastOf(world, id)).status).toBe('sent')
    })
  })

  describe('Scenario: every message the provider is handed is marked as asked first', () => {
    // SPEC 4.5a. The mark is what tells "the provider may have this" from "a
    // consumer died before sending", once a claim has run out.
    let rows: Message[]

    beforeAll(async () => {
      const world = createWorld()
      const id = await threePeopleAndADraft(world)
      await launchBroadcast(world.env, world.db, id)
      rows = await world.db.select().from(messages).all()
    })

    it('marks each sent message with when the provider was asked', () => {
      expect(rows.filter((r) => r.status === 'sent' && r.providerCalledAt !== null)).toHaveLength(3)
    })
  })

  describe('Scenario: the provider’s API gives no answer, once', () => {
    // SPEC 4.9. The one retry that is safe: the identical request, under the
    // identical key, straight away. If the first reached the provider, it
    // answers the second with the first answer and sends nothing again.
    let results: SendResult[]
    let keys: string[]

    beforeAll(async () => {
      const provider = new ResendProvider('re_not_a_real_key', { retryDelayMs: 0 })
      ;({ results, keys } = await whileTheApiAnswers(
        [noAnswer, () => Response.json({ data: [{ id: 'resend-uuid-1' }] })],
        () => provider.sendBatch([A_MAIL]),
      ))
    })

    it('asks a second time', () => {
      expect(keys).toHaveLength(2)
    })

    it('asks under the same key  ⭐', () => {
      expect(keys[1]).toBe(keys[0]!)
    })

    it('takes the answer it got', () => {
      expect(results[0]).toEqual({ ok: true, providerMessageId: 'resend-uuid-1' })
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: the provider’s API gives no answer, twice', () => {
    // It may have the mail. Never thrown (a throw means "nothing went" to the
    // caller) and never retried: the operator checks the provider.
    let results: SendResult[]
    let keys: string[]

    beforeAll(async () => {
      const provider = new ResendProvider('re_not_a_real_key', { retryDelayMs: 0 })
      ;({ results, keys } = await whileTheApiAnswers([noAnswer], () => provider.sendBatch([A_MAIL])))
    })

    it('stops after the second try', () => {
      expect(keys).toHaveLength(2)
    })

    it('reports mail that may have gone, never to be retried  ⭐', () => {
      expect(results[0]).toMatchObject({ ok: false, retryable: false, outcomeUnknown: true })
    })
  })

  describe('Scenario: the provider’s API answers success but names no id for one mail', () => {
    let results: SendResult[]

    beforeAll(async () => {
      const provider = new ResendProvider('re_not_a_real_key', { retryDelayMs: 0 })
      ;({ results } = await whileTheApiAnswers([() => Response.json({ data: [{ id: 'resend-uuid-1' }, {}] })], () =>
        provider.sendBatch([A_MAIL, { ...A_MAIL, ref: 2, messageId: 2, to: 'two@example.test' }]),
      ))
    })

    it('reports that one as mail that may have gone', () => {
      expect(results[1]).toMatchObject({ ok: false, retryable: false, outcomeUnknown: true })
    })
  })

  describe('Scenario: a consumer died after the provider took the mail, and its claim ran out', () => {
    // ⭐ SPEC 4.8. The row says `queued` behind a claim that expired long ago,
    // which used to be free for the taking. The provider was asked for it, so
    // the queue redelivering the job sends nothing and waits for the record.
    let world: World
    let redelivered: ReturnType<typeof sendBatchOf>
    let mailsBefore: number

    beforeAll(async () => {
      world = createWorld()
      const id = await threePeopleAndADraft(world)
      await launchBroadcast(world.env, world.db, id)
      const longAgo = new Date(Date.now() - 15 * 60_000)
      await world.db
        .update(messages)
        .set({ status: 'queued', provider: null, providerMessageId: null, sentAt: null, claimedAt: longAgo, providerCalledAt: longAgo })
      mailsBefore = (await world.outbox()).length
      const ids = (await world.db.select().from(messages).all()).map((m) => m.id)
      redelivered = sendBatchOf(ids, 'kolea-send', 2)
      await worker.queue(redelivered.batch, world.env)
    })

    it('sends nobody a second copy  ⭐', async () => {
      expect((await world.outbox()).length).toBe(mailsBefore)
    })

    it('asks the queue to bring the jobs back, in case the record lands', () => {
      expect(redelivered.retried).toHaveLength(3)
    })
  })

  describe('Scenario: a refusal worth retrying gives the provider mark back', () => {
    // The provider said "not taken", so asking it again is safe, and the retry
    // must be able to claim the row.
    let rows: Message[]

    beforeAll(async () => {
      const world = createWorld()
      const id = await threePeopleAndADraft(world)
      const spy = spyOn(ConsoleProvider.prototype, 'sendBatch').mockImplementation(async (emails: OutgoingEmail[]) =>
        emails.map(() => ({ ok: false, error: 'provider 429: slow down', retryable: true })),
      )
      try {
        await launchBroadcast(world.env, world.db, id)
      } finally {
        spy.mockRestore()
      }
      rows = await world.db.select().from(messages).all()
    })

    it('leaves each row queued with no mark', () => {
      expect(rows.filter((r) => r.status === 'queued' && r.providerCalledAt === null)).toHaveLength(3)
    })
  })

  describe('Scenario: the database refuses the very first write of a send', () => {
    // Nothing could be confirmed. The operator is told exactly that, and that
    // nothing went out from this press.
    let world: World
    let id: number
    let res: Response

    beforeAll(async () => {
      world = createWorld()
      id = await threePeopleAndADraft(world)
      const healthy = world.env.DB
      world.env.DB = refusingQueries(healthy, /^update "broadcasts" set "status"/i, 1)
      res = await world.post(`/broadcasts/${id}/send`, { confirm: 'send', expected: '3' })
      world.env.DB = healthy
    })

    it('answers with the broadcast page, not an error', () => {
      expect(res.status).toBe(302)
    })

    it('says it could not confirm the send started, and that nothing went out', () => {
      expect(flashOf(res)).toContain('Nothing went out from this click')
    })

    it('leaves it a draft', async () => {
      expect((await broadcastOf(world, id)).status).toBe('draft')
    })
  })

  describe('Scenario: the minutely run meets a page the database refuses', () => {
    // The rest of the minute (domain checks, outbound webhooks, imports) must
    // not be taken down with it, and the page comes round again next minute.
    let world: World
    let id: number
    let failure: unknown = null

    beforeAll(async () => {
      world = createWorld()
      id = await threePeopleAndADraft(world)
      await world.db.update(broadcasts).set({ status: 'scheduled', scheduledAt: new Date(Date.now() - 1000) }).where(eq(broadcasts.id, id))
      const healthy = world.env.DB
      world.env.DB = refusingQueries(healthy, /insert into "messages"/i, 1)
      try {
        await world.tick()
      } catch (err) {
        failure = err
      }
      world.env.DB = healthy
      await world.tick()
    })

    it('finishes the minute without throwing', () => {
      expect(failure).toBeNull()
    })

    it('sends the page the next minute', async () => {
      expect((await world.outbox()).length).toBe(3)
    })
  })
})
