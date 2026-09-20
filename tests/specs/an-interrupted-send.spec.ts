// STORY-012 — An interrupted send resumes without mailing anyone twice
// SPEC 3.6, 3.8, 4.1, 4.2, 4.3
//
// Everything here is about the second attempt: the queue redelivering after a
// crash, the cron overlapping itself, a provider 429 sending a batch round
// again. A mailer that is not idempotent is a mailer that double-sends, and
// double-sending is how a list stops trusting you.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { type SendOutcome, sendMessage, sendMessages } from '../../src/core/sending.ts'
import type { Message } from '../../src/db/schema.ts'
import { messages, suppressions } from '../../src/db/schema.ts'
import worker from '../../src/worker.tsx'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, sendBatchOf, type World } from '../support/world.ts'

/** Queue three people a broadcast without sending it yet. */
async function threeQueuedMessages(world: World) {
  await aPerson(world, { email: 'one@example.test' })
  await aPerson(world, { email: 'two@example.test' })
  await aPerson(world, { email: 'three@example.test' })
  const id = await aBroadcast(world, { subject: 'This week' })
  await startBroadcast(world.env, world.db, id)
  return await world.db.select().from(messages).all()
}

describe('Feature: a send that has to be attempted twice', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a message that has already gone out', () => {
    let world: World
    let sent: Message
    let replay: SendOutcome
    let mailsAfterwards: number

    beforeAll(async () => {
      world = createWorld()
      await threeQueuedMessages(world)
      sent = (await world.db.select().from(messages).get())!
      const before = (await world.outbox()).length

      replay = await sendMessage(world.env, world.db, sent.id)
      mailsAfterwards = (await world.outbox()).length - before
    })

    it('records the provider that sent it', () => {
      expect(sent.provider).toBe('console')
    })

    it('records the provider’s own id for it', () => {
      expect(sent.providerMessageId).toBe(`console-${sent.id}`)
    })

    it('records when it went', () => {
      expect(sent.sentAt).not.toBeNull()
    })

    it('skips the replay', () => {
      expect(replay.status).toBe('skipped')
    })

    it('hands the provider nothing the second time', () => {
      expect(mailsAfterwards).toBe(0)
    })
  })

  describe('Scenario: a batch where one recipient may no longer be mailed', () => {
    // SPEC 4.1 — one failure never blocks the rest of its batch. And SPEC 2.1:
    // consent is re-checked here, immediately before the provider call, not
    // when the message was materialized minutes ago.
    let world: World
    let outcomes: Map<number, SendOutcome>
    let queued: Message[]

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'one@example.test' })
      await aPerson(world, { email: 'two@example.test' })
      const blocked = await aPerson(world, { email: 'three@example.test' })

      const id = await aBroadcast(world)
      // Materialize the recipients while everyone is still eligible…
      await startBroadcast(world.env, world.db, id)
      queued = await world.db.select().from(messages).all()

      // …then withdraw consent, and re-send the whole batch.
      await world.db
        .update(messages)
        .set({ status: 'queued', sentAt: null, provider: null, providerMessageId: null })
        .where(eq(messages.status, 'sent'))
      await world.db
        .insert(suppressions)
        .values({ email: blocked.email, reason: 'unsubscribed_all', createdAt: new Date() })

      outcomes = await sendMessages(
        world.env,
        world.db,
        queued.map((m) => m.id),
      )
    })

    it('sends the first', () => {
      expect(outcomes.get(queued[0]!.id)?.status).toBe('sent')
    })

    it('sends the second', () => {
      expect(outcomes.get(queued[1]!.id)?.status).toBe('sent')
    })

    it('blocks the third', () => {
      expect(outcomes.get(queued[2]!.id)?.status).toBe('suppressed')
    })

    it('records the block on the row rather than dropping it', async () => {
      const row = await world.db
        .select()
        .from(messages)
        .where(eq(messages.id, queued[2]!.id))
        .get()
      expect(row?.status).toBe('suppressed')
    })

    it('says why it was blocked', async () => {
      const row = await world.db
        .select()
        .from(messages)
        .where(eq(messages.id, queued[2]!.id))
        .get()
      expect(row?.suppressedReason).toBe('suppressed')
    })
  })

  describe('Scenario: the queue consumer working a batch', () => {
    // The deployed entry point (bdd-specs rule 7): `worker.queue`.
    let world: World
    let acked: number[]
    let retried: number[]

    beforeAll(async () => {
      world = createWorld()
      const queued = await threeQueuedMessages(world)
      // Put them back on the queue as though the send had not happened yet.
      await world.db
        .update(messages)
        .set({ status: 'queued', sentAt: null, provider: null, providerMessageId: null })
      const { batch, acked: a, retried: r } = sendBatchOf(queued.map((m) => m.id))
      acked = a
      retried = r
      await worker.queue(batch, world.env)
    })

    it('acks every message it handled', () => {
      expect(acked).toHaveLength(3)
    })

    it('retries none of them', () => {
      expect(retried).toHaveLength(0)
    })

    it('marks them sent', async () => {
      const n =
        (await world.db
          .select({ n: count() })
          .from(messages)
          .where(eq(messages.status, 'sent'))
          .get())?.n
      expect(n).toBe(3)
    })
  })

  describe('Scenario: the queue redelivering a message that already went', () => {
    let world: World
    let acked: number[]
    let mailsAfterwards: number

    beforeAll(async () => {
      world = createWorld()
      const queued = await threeQueuedMessages(world)
      const before = (await world.outbox()).length

      const { batch, acked: a } = sendBatchOf(queued.map((m) => m.id))
      acked = a
      await worker.queue(batch, world.env)
      mailsAfterwards = (await world.outbox()).length - before
    })

    it('acks them, so the queue stops trying', () => {
      expect(acked).toHaveLength(3)
    })

    it('sends nothing again  ⭐', () => {
      expect(mailsAfterwards).toBe(0)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a message that reaches the dead-letter queue', () => {
    // SPEC 4.2. The DLQ has no send path at all — its whole job is to turn a
    // give-up into a row, because Workers logs are gone within the week
    // (invariant 7).
    let world: World
    let acked: number[]
    let row: Message | undefined
    let mailsAfterwards: number

    beforeAll(async () => {
      world = createWorld()
      const queued = await threeQueuedMessages(world)
      await world.db.update(messages).set({ status: 'queued', sentAt: null })
      const before = (await world.outbox()).length

      const { batch, acked: a } = sendBatchOf([queued[0]!.id], 'big-mailer-send-dlq')
      acked = a
      await worker.queue(batch, world.env)

      row = await world.db.select().from(messages).where(eq(messages.id, queued[0]!.id)).get()
      mailsAfterwards = (await world.outbox()).length - before
    })

    it('sends nothing — the dead-letter queue has no send path  ⭐', () => {
      expect(mailsAfterwards).toBe(0)
    })

    it('marks the message failed', () => {
      expect(row?.status).toBe('failed')
    })

    it('records that we gave up, and why', () => {
      expect(row?.error).toContain('exhausting queue retries')
    })

    it('acks it, because there is nowhere further for it to go', () => {
      expect(acked).toHaveLength(1)
    })
  })

  describe('Scenario: sending a message whose subscriber has been deleted', () => {
    let world: World
    let outcome: SendOutcome

    beforeAll(async () => {
      world = createWorld()
      const queued = await threeQueuedMessages(world)
      await world.db.update(messages).set({ status: 'queued' })
      // The FK is ON DELETE CASCADE, so deleting the person takes the message
      // with them — the surviving case is a message id that no longer resolves.
      outcome = await sendMessage(world.env, world.db, queued[0]!.id + 10_000)
    })

    it('skips it rather than throwing', () => {
      expect(outcome.status).toBe('skipped')
    })
  })
})
