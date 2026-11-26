// STORY-012 — An interrupted send resumes without mailing anyone twice
// SPEC 3.6, 3.8, 4.1, 4.2, 4.3
//
// Everything here is about the second attempt: the queue redelivering after a
// crash, the cron overlapping itself, a provider 429 sending a batch round
// again. A mailer that is not idempotent is a mailer that double-sends, and
// double-sending is how a list stops trusting you.
//
// The sad half is about the wait before that second attempt. A retry with no
// delay arrives while whatever was wrong is still wrong, so a few bad seconds
// spend the whole retry budget and good mail is written off as failed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { retryDelaySeconds } from '../../src/core/backoff.ts'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { type SendOutcome, sendMessage, sendMessages } from '../../src/core/sending.ts'
import type { Message } from '../../src/db/schema.ts'
import { messages, suppressions } from '../../src/db/schema.ts'
import { ConsoleProvider } from '../../src/providers/console.ts'
import { ResendProvider } from '../../src/providers/resend.ts'
import type { OutgoingEmail, SendResult } from '../../src/providers/types.ts'
import worker from '../../src/worker.tsx'
import type { SendJob } from '../../src/types.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, queueBatchOf, sendBatchOf, trafficOf, type World } from '../support/world.ts'

/** Queue three people a broadcast without sending it yet. */
async function threeQueuedMessages(world: World) {
  await aPerson(world, { email: 'one@example.test' })
  await aPerson(world, { email: 'two@example.test' })
  await aPerson(world, { email: 'three@example.test' })
  const id = await aBroadcast(world, { subject: 'This week' })
  await startBroadcast(world.env, world.db, id)
  return await world.db.select().from(messages).all()
}

/** Queue three people a broadcast and put the rows back as though nothing had gone yet. */
async function threeMessagesStillWaiting(world: World) {
  const queued = await threeQueuedMessages(world)
  await world.db
    .update(messages)
    .set({ status: 'queued', sentAt: null, provider: null, providerMessageId: null })
  return queued
}

/**
 * Have the provider refuse mail while `run` runs.
 *
 * `refuse` answers for each mail: a failure to hand back, or `null` to let the
 * mail through. It may throw, which is a request that never got an answer. This
 * is still the console provider, so nothing here can reach the wire; only what
 * it says back is replaced, which is all a rate limit changes.
 */
async function whileTheProviderRefuses<T>(
  refuse: () => SendResult | null,
  run: () => Promise<T>,
): Promise<T> {
  const real = ConsoleProvider.prototype.sendBatch
  const spy = spyOn(ConsoleProvider.prototype, 'sendBatch').mockImplementation(async function (
    this: ConsoleProvider,
    emails: OutgoingEmail[],
  ) {
    const refusals = emails.map(() => refuse())
    const accepted = await real.call(
      this,
      emails.filter((_, i) => refusals[i] === null),
    )
    return refusals.map((refusal) => refusal ?? accepted.shift()!)
  })
  try {
    return await run()
  } finally {
    spy.mockRestore()
  }
}

/**
 * Redeliver a batch the way the queue does: again after every retry, until
 * nothing is retried or `maxRetries` is spent, which is when the queue would
 * move the message to the dead-letter queue. `beforeEach` runs ahead of every
 * delivery, with its number.
 */
async function deliverUntilSettled(
  world: World,
  ids: number[],
  maxRetries: number,
  beforeEach: (delivery: number) => void = () => {},
) {
  const waits: number[] = []
  for (let attempt = 1; ; attempt++) {
    beforeEach(attempt)
    const { batch, retried, delays } = sendBatchOf(ids, 'big-mailer-send', attempt)
    await worker.queue(batch, world.env)
    if (retried.length === 0) return { waits, deadLettered: false }
    if (attempt > maxRetries) return { waits, deadLettered: true }
    waits.push(Math.min(...delays))
  }
}

/**
 * `max_retries` of every send consumer in the configs this repo ships. Read as
 * text: the template's placeholders make it not quite JSON.
 */
function shippedRetryBudgets(): number[] {
  return ['wrangler.template.jsonc', 'wrangler.jsonc'].flatMap((file) => {
    const text = readFileSync(join(import.meta.dir, '../..', file), 'utf8')
    // The send consumer is the one with somewhere to dead-letter to.
    return [...text.matchAll(/\{[^{}]*"dead_letter_queue"[^{}]*\}/g)].map((block) =>
      Number(/"max_retries":\s*(\d+)/.exec(block[0])?.[1]),
    )
  })
}

/** Answer every call to the provider's API with `response`. Nothing else may be fetched. */
async function whileTheApiAnswers<T>(
  response: (init?: RequestInit) => Response,
  run: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('https://api.resend.com/')) throw new Error(`unexpected request to ${url}`)
    return response(init)
  }) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = real
  }
}

/**
 * The provider's API as its documentation describes idempotency: a key it has
 * seen with the same body gets the first answer and nothing is sent; with a
 * different body it is refused with a 409.
 */
function anApiThatRemembers() {
  const seen = new Map<string, { body: string; answer: unknown }>()
  const keys: string[] = []
  const delivered: string[] = []
  const respond = (init?: RequestInit) => {
    const key = new Headers(init?.headers as Record<string, string>).get('idempotency-key') ?? ''
    const body = String(init?.body)
    keys.push(key)
    const before = seen.get(key)
    if (before) {
      return before.body === body
        ? Response.json(before.answer)
        : Response.json({ name: 'invalid_idempotent_request' }, { status: 409 })
    }
    const emails = JSON.parse(body) as { to: string[] }[]
    const answer = { data: emails.map((_, i) => ({ id: `accepted-${delivered.length + i}` })) }
    delivered.push(...emails.map((email) => email.to[0]!))
    seen.set(key, { body, answer })
    return Response.json(answer)
  }
  return { keys, delivered, respond }
}

/** A database that refuses its next `times` batch writes. Everything else works. */
function refusingBatches(db: D1Database, times: number): D1Database {
  let left = times
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          if (left-- > 0) throw new Error('database unavailable')
          return target.batch(statements)
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** A queue that keeps what it is handed, so a spec can deliver it when it likes. */
function aQueueThatHolds() {
  const held: { body: SendJob; delaySeconds: number }[] = []
  const binding = {
    async sendBatch(batch: Iterable<{ body: SendJob }>, options?: { delaySeconds?: number }) {
      for (const message of batch) held.push({ body: message.body, delaySeconds: options?.delaySeconds ?? 0 })
    },
  } as unknown as Queue<SendJob>
  return { held, binding }
}

/** Watch what the provider is handed, request by request, and let it through. */
async function watchingTheProvider<T>(run: () => Promise<T>): Promise<{ requests: OutgoingEmail[][] }> {
  const requests: OutgoingEmail[][] = []
  const real = ConsoleProvider.prototype.sendBatch
  const spy = spyOn(ConsoleProvider.prototype, 'sendBatch').mockImplementation(async function (
    this: ConsoleProvider,
    emails: OutgoingEmail[],
  ) {
    requests.push(emails)
    return await real.call(this, emails)
  })
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
  return { requests }
}

const A_MAIL: OutgoingEmail = {
  ref: 1,
  to: 'one@example.test',
  fromEmail: 'sender@example.test',
  fromName: 'Sender',
  subject: 'This week',
  html: '<p>Hello</p>',
  text: 'Hello',
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

  describe('Scenario: a message that gives up after the provider kept refusing it', () => {
    // SPEC 4.2: failed "with the error recorded". The give-up is the fact; what
    // the last attempt wrote is the only record of why, and it must survive.
    let row: Message | undefined

    beforeAll(async () => {
      const world = createWorld()
      const queued = await threeMessagesStillWaiting(world)
      await world.db
        .update(messages)
        .set({ error: 'provider 429: rate limit exceeded' })
        .where(eq(messages.id, queued[0]!.id))

      const { batch } = sendBatchOf([queued[0]!.id], 'big-mailer-send-dlq')
      await worker.queue(batch, world.env)
      row = await world.db.select().from(messages).where(eq(messages.id, queued[0]!.id)).get()
    })

    it('marks the message failed', () => {
      expect(row?.status).toBe('failed')
    })

    it('says that we gave up', () => {
      expect(row?.error).toContain('exhausting queue retries')
    })

    it('keeps what the provider said  ⭐', () => {
      expect(row?.error).toContain('provider 429: rate limit exceeded')
    })
  })

  describe('Scenario: the provider asks for a pause', () => {
    // A 429 fails the whole batch the same way. Retried at once it meets the
    // same closed window, and the retries are gone before the window reopens.
    let world: World
    let queued: Message[]
    let acked: number[]
    let retried: number[]
    let delays: number[]

    beforeAll(async () => {
      world = createWorld()
      queued = await threeMessagesStillWaiting(world)
      const sent = sendBatchOf(queued.map((m) => m.id))
      acked = sent.acked
      retried = sent.retried
      delays = sent.delays

      await whileTheProviderRefuses(
        () => ({
          ok: false,
          error: 'provider 429: rate limit exceeded',
          retryable: true,
          retryAfterSeconds: 40,
        }),
        () => worker.queue(sent.batch, world.env),
      )
    })

    it('retries every message', () => {
      expect(retried).toHaveLength(3)
    })

    it('acks none of them', () => {
      expect(acked).toHaveLength(0)
    })

    it('waits at least as long as the provider asked  ⭐', () => {
      expect(Math.min(...delays)).toBeGreaterThanOrEqual(40)
    })

    it('brings the batch back together, as one request', () => {
      expect(new Set(delays).size).toBe(1)
    })

    it('leaves the messages queued for the next attempt', async () => {
      const rows = await world.db.select().from(messages).where(eq(messages.status, 'queued')).all()
      expect(rows).toHaveLength(3)
    })

    it('writes the provider’s reason on the row', async () => {
      const row = await world.db.select().from(messages).where(eq(messages.id, queued[0]!.id)).get()
      expect(row?.error).toBe('provider 429: rate limit exceeded')
    })
  })

  describe('Scenario: a failure that does not say when to come back', () => {
    let firstWait: number
    let sixthWait: number
    let fiftiethWait: number

    beforeAll(async () => {
      const world = createWorld()
      const queued = await threeMessagesStillWaiting(world)
      const waitAfter = async (attempt: number) => {
        const sent = sendBatchOf([queued[0]!.id], 'big-mailer-send', attempt)
        await worker.queue(sent.batch, world.env)
        return sent.delays[0]!
      }

      await whileTheProviderRefuses(
        () => ({ ok: false, error: 'provider 503: unavailable', retryable: true }),
        async () => {
          firstWait = await waitAfter(1)
          sixthWait = await waitAfter(6)
          fiftiethWait = await waitAfter(50)
        },
      )
    })

    it('still waits before the second attempt', () => {
      expect(firstWait).toBeGreaterThanOrEqual(7)
    })

    it('waits longer the more often it has failed', () => {
      expect(sixthWait).toBeGreaterThan(firstWait * 4)
    })

    it('never waits more than five minutes on its own account', () => {
      expect(fiftiethWait).toBeLessThanOrEqual(300)
    })
  })

  describe('Scenario: a rate limit that outlasts three retries', () => {
    // Three immediate retries used to be the whole budget, spent inside a
    // second. Here the provider refuses six deliveries in a row and then relents.
    let world: World
    let outcome: { waits: number[]; deadLettered: boolean }
    let mails: number

    beforeAll(async () => {
      world = createWorld()
      const queued = await threeMessagesStillWaiting(world)
      const before = (await world.outbox()).length

      let refusing = true
      await whileTheProviderRefuses(
        () =>
          refusing
            ? { ok: false, error: 'provider 429: rate limit exceeded', retryable: true, retryAfterSeconds: 1 }
            : null,
        async () => {
          outcome = await deliverUntilSettled(
            world,
            queued.map((m) => m.id),
            Math.min(...shippedRetryBudgets()),
            (delivery) => {
              refusing = delivery <= 6
            },
          )
        },
      )
      mails = (await world.outbox()).length - before
    })

    it('is not dead-lettered  ⭐', () => {
      expect(outcome.deadLettered).toBe(false)
    })

    it('waits before every one of the six retries', () => {
      expect(outcome.waits.filter((seconds) => seconds >= 7)).toHaveLength(6)
    })

    it('sends everyone their mail once the provider relents', async () => {
      const rows = await world.db.select().from(messages).where(eq(messages.status, 'sent')).all()
      expect(rows).toHaveLength(3)
    })

    it('sends each of them exactly one', () => {
      expect(mails).toBe(3)
    })
  })

  describe('Scenario: the retry budget as shipped', () => {
    // The wait is in the code and the number of retries is in the config, and
    // only together do they say how long a message is given. Jitter at its
    // least generous, for every send consumer in both configs.
    const leastPatience = Math.min(
      ...shippedRetryBudgets().map((retries) => {
        let seconds = 0
        for (let attempt = 1; attempt <= retries; attempt++) {
          seconds += retryDelaySeconds(attempt, { jitter: 0 })
        }
        return seconds
      }),
    )

    it('covers both environments in both config files', () => {
      expect(shippedRetryBudgets()).toHaveLength(4)
    })

    it('gives a message at least twenty minutes before giving up', () => {
      expect(leastPatience).toBeGreaterThanOrEqual(20 * 60)
    })
  })

  describe('Scenario: a batch the consumer could not work at all', () => {
    // Not a refusal: the attempt blew up under the batch (the database, the
    // network). It used to leave no trace, and retry on the spot.
    let world: World
    let retried: number[]
    let delays: number[]

    beforeAll(async () => {
      world = createWorld()
      const queued = await threeMessagesStillWaiting(world)
      const sent = sendBatchOf(queued.map((m) => m.id))
      retried = sent.retried
      delays = sent.delays

      await whileTheProviderRefuses(
        () => {
          throw new Error('connection lost')
        },
        () => worker.queue(sent.batch, world.env),
      )
    })

    it('retries every message', () => {
      expect(retried).toHaveLength(3)
    })

    it('waits before trying again', () => {
      expect(Math.min(...delays)).toBeGreaterThanOrEqual(7)
    })

    it('leaves the messages queued', async () => {
      const rows = await world.db.select().from(messages).where(eq(messages.status, 'queued')).all()
      expect(rows).toHaveLength(3)
    })

    it('writes down what went wrong, so a later give-up can say why', async () => {
      const row = await world.db.select().from(messages).get()
      expect(row?.error).toBe('send attempt threw: connection lost')
    })
  })

  describe('Scenario: the database going away under the consumer', () => {
    // Every query refused, on both queues. The send queue has retries left to
    // spend; the dead-letter queue has nothing behind it, so a give-up it
    // cannot write must come back too, or the row stays `queued` for good.
    let send: ReturnType<typeof sendBatchOf>
    let dead: ReturnType<typeof sendBatchOf>
    let stillQueued: number

    beforeAll(async () => {
      const world = createWorld()
      const ids = (await threeMessagesStillWaiting(world)).map((m) => m.id)
      const down = {
        ...world.env,
        DB: {
          prepare() {
            throw new Error('database unavailable')
          },
        } as unknown as D1Database,
      }

      send = sendBatchOf(ids)
      await worker.queue(send.batch, down)
      dead = sendBatchOf(ids, 'big-mailer-send-dlq')
      await worker.queue(dead.batch, down)

      stillQueued = (await world.db.select().from(messages).where(eq(messages.status, 'queued')).all())
        .length
    })

    it('retries the whole send batch', () => {
      expect(send.retried).toHaveLength(3)
    })

    it('waits before retrying it', () => {
      expect(Math.min(...send.delays)).toBeGreaterThanOrEqual(7)
    })

    it('retries the give-ups too, rather than dropping them  ⭐', () => {
      expect(dead.retried).toHaveLength(3)
    })

    it('waits before those as well', () => {
      expect(Math.min(...dead.delays)).toBeGreaterThanOrEqual(7)
    })

    it('acks no give-up it could not write down', () => {
      expect(dead.acked).toHaveLength(0)
    })

    it('leaves every row as it was', () => {
      expect(stillQueued).toBe(3)
    })
  })

  describe('Scenario: recording what the provider said', () => {
    // One write for the whole batch. Row by row it was a round trip each, and
    // the gap between "the provider has it" and "the row says so" was that wide.
    let tripsForThree: number
    let tripsForOne: number
    let batchWrites: number
    let giveUpTrips: number

    beforeAll(async () => {
      const tripsToWork = async (take: number, queue?: string) => {
        const world = createWorld()
        const ids = (await threeMessagesStillWaiting(world)).map((m) => m.id).slice(0, take)
        const before = { ...trafficOf(world.env) }
        await worker.queue(sendBatchOf(ids, queue).batch, world.env)
        const after = trafficOf(world.env)
        return { trips: after.roundTrips - before.roundTrips, batches: after.batches - before.batches }
      }

      const three = await tripsToWork(3)
      tripsForThree = three.trips
      batchWrites = three.batches
      tripsForOne = (await tripsToWork(1)).trips
      giveUpTrips = (await tripsToWork(3, 'big-mailer-send-dlq')).trips
    })

    it('writes every result in a single batch', () => {
      expect(batchWrites).toBe(1)
    })

    it('makes no more trips to the database for three messages than for one', () => {
      expect(tripsForThree).toBe(tripsForOne)
    })

    it('writes a batch of give-ups in one trip too', () => {
      expect(giveUpTrips).toBe(1)
    })
  })

  describe('Scenario: the database refusing the write after the provider took the mail', () => {
    // ⭐ The dangerous moment: the mail has gone and the rows still say `queued`.
    // Sending again would be everyone's second copy. The acceptance is kept on
    // the queue instead and written when the database will take it.
    let first: ReturnType<typeof sendBatchOf>
    let held: { body: SendJob; delaySeconds: number }[]
    let queuedAfterFirst: number
    let rows: Message[]
    let mails: number

    beforeAll(async () => {
      const world = createWorld()
      const ids = (await threeMessagesStillWaiting(world)).map((m) => m.id)
      const before = (await world.outbox()).length
      const queue = aQueueThatHolds()
      const env = { ...world.env, SEND_QUEUE: queue.binding, DB: refusingBatches(world.env.DB, 1) }

      first = sendBatchOf(ids)
      await worker.queue(first.batch, env)
      held = [...queue.held]
      queuedAfterFirst = (
        await world.db.select().from(messages).where(eq(messages.status, 'queued')).all()
      ).length

      // The queue delivers what it was handed, and then, as queues do, the
      // original messages once more for good measure.
      await worker.queue(queueBatchOf(held.map((job) => job.body)).batch, env)
      await worker.queue(sendBatchOf(ids, 'big-mailer-send', 2).batch, env)

      rows = await world.db.select().from(messages).all()
      mails = (await world.outbox()).length - before
    })

    it('does not put the mail up to be sent again  ⭐', () => {
      expect(first.retried).toHaveLength(0)
    })

    it('acks the messages: their sending is done', () => {
      expect(first.acked).toHaveLength(3)
    })

    it('leaves the rows queued, because nothing could be written', () => {
      expect(queuedAfterFirst).toBe(3)
    })

    it('hands the queue one record-only job per accepted mail', () => {
      expect(held.filter((job) => job.body.accepted)).toHaveLength(3)
    })

    it('gives the database a moment before that job runs', () => {
      expect(Math.min(...held.map((job) => job.delaySeconds))).toBeGreaterThanOrEqual(7)
    })

    it('ends with every row sent', () => {
      expect(rows.filter((row) => row.status === 'sent')).toHaveLength(3)
    })

    it('records the provider’s id from the one real send', () => {
      expect(rows.map((row) => row.providerMessageId)).toEqual(rows.map((row) => `console-${row.id}`))
    })

    it('leaves no error behind on a row that went', () => {
      expect(rows.filter((row) => row.error !== null)).toHaveLength(0)
    })

    it('has sent each person exactly one mail  ⭐', () => {
      expect(mails).toBe(3)
    })
  })

  describe('Scenario: a record-only job the database still will not take', () => {
    let waiting: ReturnType<typeof queueBatchOf>
    let dead: ReturnType<typeof queueBatchOf>
    let row: Message | undefined
    let mails: number

    beforeAll(async () => {
      const world = createWorld()
      const queued = await threeMessagesStillWaiting(world)
      const before = (await world.outbox()).length
      const job: SendJob = {
        messageId: queued[0]!.id,
        accepted: { provider: 'console', providerMessageId: 'accepted-earlier', sentAt: 1_700_000_000_000 },
      }

      waiting = queueBatchOf([job])
      await worker.queue(waiting.batch, { ...world.env, DB: refusingBatches(world.env.DB, 1) })

      // Out of retries, it arrives on the dead-letter queue. It is still a
      // send that happened.
      dead = queueBatchOf([job], 'big-mailer-send-dlq')
      await worker.queue(dead.batch, world.env)

      row = await world.db.select().from(messages).where(eq(messages.id, job.messageId)).get()
      mails = (await world.outbox()).length - before
    })

    it('waits and tries the write again', () => {
      expect(waiting.delays[0]).toBeGreaterThanOrEqual(7)
    })

    it('is marked sent even from the dead-letter queue, never failed  ⭐', () => {
      expect(row?.status).toBe('sent')
    })

    it('carries the id the provider gave at the time', () => {
      expect(row?.providerMessageId).toBe('accepted-earlier')
    })

    it('sends nothing', () => {
      expect(mails).toBe(0)
    })
  })

  describe('Scenario: that write refused, with no queue to keep the acceptance on', () => {
    // The last resort. The messages go round again, and whether anyone gets a
    // second copy is now up to the provider recognising the request. Our part
    // is to make it the same request: same messages, same order, same bytes.
    let first: ReturnType<typeof sendBatchOf>
    let requests: OutgoingEmail[][]
    let sent: number

    beforeAll(async () => {
      const world = createWorld()
      const ids = (await threeMessagesStillWaiting(world)).map((m) => m.id)
      const env = { ...world.env, DB: refusingBatches(world.env.DB, 1) }

      first = sendBatchOf(ids)
      const watched = await watchingTheProvider(async () => {
        await worker.queue(first.batch, env)
        // Redelivered, and in a different order.
        await worker.queue(sendBatchOf([...ids].reverse(), 'big-mailer-send', 2).batch, env)
      })
      requests = watched.requests
      sent = (await world.db.select().from(messages).where(eq(messages.status, 'sent')).all()).length
    })

    it('retries every message, having nowhere else to keep the fact', () => {
      expect(first.retried).toHaveLength(3)
    })

    it('waits before it does', () => {
      expect(Math.min(...first.delays)).toBeGreaterThanOrEqual(7)
    })

    it('asks the provider for exactly the same thing the second time  ⭐', () => {
      expect(requests[1]).toEqual(requests[0]!)
    })

    it('ends with every row sent', () => {
      expect(sent).toBe(3)
    })
  })

  describe('Scenario: the provider’s API being asked the same thing twice', () => {
    // The adapter against an API that dedupes the way the provider documents.
    // No request leaves the process.
    const TWO = [A_MAIL, { ...A_MAIL, ref: 2, to: 'two@example.test' }]
    let api: ReturnType<typeof anApiThatRemembers>
    let firstAnswer: SendResult[]
    let secondAnswer: SendResult[]
    let deliveredAfterRepeat: number
    let deliveredAfterRegrouping: number
    let inFlight: SendResult[]
    let mismatch: SendResult[]

    beforeAll(async () => {
      const provider = new ResendProvider('re_not_a_real_key')
      api = anApiThatRemembers()
      await whileTheApiAnswers(api.respond, async () => {
        firstAnswer = await provider.sendBatch(TWO)
        secondAnswer = await provider.sendBatch(TWO)
        deliveredAfterRepeat = api.delivered.length
        // The same first message, but batched on its own this time…
        await provider.sendBatch([A_MAIL])
        deliveredAfterRegrouping = api.delivered.length
        // …and a different message that happens to read exactly the same.
        await provider.sendBatch([{ ...A_MAIL, ref: 3 }])
      })

      const refusal = (name: string) => () => Response.json({ name }, { status: 409 })
      inFlight = await whileTheApiAnswers(refusal('concurrent_idempotent_requests'), () =>
        provider.sendBatch([A_MAIL]),
      )
      mismatch = await whileTheApiAnswers(refusal('invalid_idempotent_request'), () =>
        provider.sendBatch([A_MAIL]),
      )
    })

    it('sends a key with the batch', () => {
      expect(api.keys[0]).toMatch(/^batch\/[0-9a-f]{64}$/)
    })

    it('sends the same key when the same messages are sent again  ⭐', () => {
      expect(api.keys[1]).toBe(api.keys[0]!)
    })

    it('so the provider delivers them once', () => {
      expect(deliveredAfterRepeat).toBe(2)
    })

    it('and gets the first answer back, ids and all', () => {
      expect(secondAnswer).toEqual(firstAnswer)
    })

    // Known limit, recorded on purpose: one key covers one request. The same
    // message in a differently composed batch is a new request to the provider,
    // and it goes out again. Only a key per message could tell.
    it('cannot recognise a message that comes back in a different batch', () => {
      expect(deliveredAfterRegrouping).toBe(3)
    })

    it('gives two messages that read the same a key each', () => {
      expect(api.keys[3]).not.toBe(api.keys[2]!)
    })

    it('treats "the same request is still in flight" as worth another try', () => {
      expect(inFlight[0]).toMatchObject({ ok: false, retryable: true })
    })

    it('treats a key reused with a different payload as final', () => {
      expect(mismatch[0]).toMatchObject({ ok: false, retryable: false })
    })
  })

  describe('Scenario: the provider’s API answering 429', () => {
    // The adapter on its own, against a canned answer. No request leaves the
    // process: every fetch is answered here, and any other address throws.
    let withRetryAfter: SendResult[]
    let withResetOnly: SendResult[]
    let withNeither: SendResult[]

    beforeAll(async () => {
      const provider = new ResendProvider('re_not_a_real_key')
      const refusal = (headers: Record<string, string>) => () =>
        Response.json({ name: 'rate_limit_exceeded', message: 'Too many requests.' }, { status: 429, headers })

      withRetryAfter = await whileTheApiAnswers(
        refusal({ 'retry-after': '3', 'ratelimit-reset': '1' }),
        () => provider.sendBatch([A_MAIL, { ...A_MAIL, ref: 2, to: 'two@example.test' }]),
      )
      withResetOnly = await whileTheApiAnswers(refusal({ 'ratelimit-reset': '2' }), () =>
        provider.sendBatch([A_MAIL]),
      )
      withNeither = await whileTheApiAnswers(refusal({}), () => provider.sendBatch([A_MAIL]))
    })

    it('fails every mail in the batch the same way', () => {
      expect(withRetryAfter.map((r) => r.ok)).toEqual([false, false])
    })

    it('calls the failure worth retrying', () => {
      expect(withRetryAfter[0]).toMatchObject({ retryable: true })
    })

    it('passes on how long the provider said to wait', () => {
      expect(withRetryAfter[0]).toMatchObject({ retryAfterSeconds: 3 })
    })

    it('reads the rate-limit window when there is no retry-after', () => {
      expect(withResetOnly[0]).toMatchObject({ retryAfterSeconds: 2 })
    })

    it('names no wait when the provider named none', () => {
      expect(withNeither[0]).not.toHaveProperty('retryAfterSeconds')
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
