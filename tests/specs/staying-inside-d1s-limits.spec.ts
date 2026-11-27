// Platform limits (ARCHITECTURE "Platform limits"): D1 runs at most 1,000
// queries per Worker invocation and binds at most 100 parameters per statement.
// SPEC 3.6–3.8 (a send is resumable and never doubles), 6.5 (a sequence step
// is never lost). Webhook attempts are counted and backed off the same way.
//
// Nothing here is a feature. It is the list on a big day: a sequence with a
// hundred and fifty people due at 3am, a broadcast to eight thousand in the
// same minute, a Logs search, a members screen, an import that narrows many
// people at once. Each used to be fine at ten rows and a 500 at a hundred and
// fifty. The test D1 (`support/d1.ts`) refuses a 101st bound parameter and
// counts statements, so these fail here the way they would in production.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { searchLog } from '../../src/core/event-log.ts'
import { writePage } from '../../src/core/importers/writer.ts'
import { listMembers } from '../../src/core/members.ts'
import { sendMessages } from '../../src/core/sending.ts'
import { updateSequence } from '../../src/core/sequences.ts'
import { setTimeZone } from '../../src/core/site-settings.ts'
import { MAX_ATTEMPTS, createWebhookEndpoint, deliverDueWebhooks } from '../../src/core/webhooks.ts'
import {
  broadcasts,
  messages,
  sequenceEnrollments,
  subscribers,
  syncRuns,
  webhookDeliveries,
  webhookEndpoints,
} from '../../src/db/schema.ts'
import { fakeTransportFor } from '../../src/providers/webhooks.ts'
import type { Env, SendJob } from '../../src/types.ts'
import type { ImportedSubscriber } from '../../src/providers/importers/types.ts'
import { type FakeD1Database, queryCount, resetQueryCount } from '../support/d1.ts'
import { aBroadcast, aPerson, aSequence } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const sqlite = (w: World) => (w.env.DB as unknown as FakeD1Database).sqlite
const H = (h: number) => h * 60

/** `n` active people, written straight into SQLite (not through D1, so not counted). */
function bulkPeople(w: World, n: number, prefix = 'p') {
  sqlite(w).run(
    `with recursive k(i) as (select 1 union all select i + 1 from k where i < ${n})
     insert into subscribers (email, status, unsub_token, created_at)
     select '${prefix}' || i || '@bulk.test', 'active', '${prefix}tok' || i, 0 from k`,
  )
}

/** Enroll the first `n` bulk people in a sequence's first step, due an hour before `at`. */
function bulkEnroll(w: World, seqId: number, stepId: number, n: number, at: Date) {
  sqlite(w).run(
    `insert into sequence_enrollments (sequence_id, subscriber_id, next_step_id, status, next_run_at, enrolled_at)
     select ${seqId}, id, ${stepId}, 'active', ${at.getTime() - 3_600_000}, 0
     from subscribers where email like '%@bulk.test' order by id limit ${n}`,
  )
}

/** A queue binding that only records what it was handed. */
function recordingQueue(): { queue: Queue<SendJob>; jobs: number[] } {
  const jobs: number[] = []
  const queue = {
    async send(body: SendJob) {
      jobs.push(body.messageId)
    },
    async sendBatch(batch: Iterable<{ body: SendJob }>) {
      for (const m of batch) jobs.push(m.body.messageId)
    },
  } as unknown as Queue<SendJob>
  return { queue, jobs }
}

describe('Feature: a big day stays inside D1’s limits', () => {
  // ───────────────────────────────────────────── the minutely tick

  describe('Scenario: 150 people come due at 3am on a sequence that sends 08:00–18:00', () => {
    let world: World
    let moved: number

    beforeAll(async () => {
      world = createWorld()
      await setTimeZone(world.db, 'Pacific/Honolulu')
      const seq = await aSequence(world, { steps: [{ subject: 'In hours' }] })
      const r = await updateSequence(world.db, seq.id, { sendWindow: { start: H(8), end: H(18) } })
      if (!r.ok) throw new Error(r.reason)
      bulkPeople(world, 150)
      const at = new Date('2031-06-10T13:00:00Z') // 03:00 HST
      bulkEnroll(world, seq.id, seq.stepIds[0]!, 150, at)
      // A tick takes at most 120 enrollments; the next minute takes the rest.
      await world.tick(at)
      await world.tick(new Date(at.getTime() + 60_000))
      const rows = await world.db
        .select({ id: sequenceEnrollments.id })
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.nextRunAt, new Date('2031-06-10T18:00:00Z')))
        .all()
      moved = rows.length
    })

    it('⭐ moves every one of them to the window’s opening', () => {
      expect(moved).toBe(150)
    })
  })

  describe('Scenario: the sequence tick fails in a minute a broadcast is due', () => {
    let world: World
    let broadcastStatus: string | undefined
    let run: typeof syncRuns.$inferSelect | undefined
    let logged: string[]

    beforeAll(async () => {
      world = createWorld()
      const seq = await aSequence(world, { steps: [{ subject: 'Step one' }] })
      const person = await aPerson(world, { email: 'drip@example.test' })
      sqlite(world).run(
        `insert into sequence_enrollments (sequence_id, subscriber_id, next_step_id, status, next_run_at, enrolled_at)
         values (${seq.id}, ${person.id}, ${seq.stepIds[0]}, 'active', 0, 0)`,
      )
      // Any write to an enrollment now fails, so the tick dies partway through.
      sqlite(world).run(
        `create trigger boom before update on sequence_enrollments begin select raise(abort, 'disk on fire'); end`,
      )
      const id = await aBroadcast(world, { subject: 'The news' })
      await world.db
        .update(broadcasts)
        .set({ status: 'scheduled', scheduledAt: new Date(Date.now() - 60_000) })
        .where(eq(broadcasts.id, id))
      await world.tick()
      broadcastStatus = (await world.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get())?.status
      run = await world.db.select().from(syncRuns).where(eq(syncRuns.kind, 'sequence_tick')).get()
      const page = await searchLog(world.db, { category: 'sequences' })
      logged = page.ok ? page.page.events.map((e) => e.type) : []
    })

    it('⭐ still sends the broadcast', () => {
      expect(broadcastStatus).toBe('sent')
    })

    it('records the failure as a row', () => {
      expect(run?.status).toBe('failed')
    })

    it('keeps the reason on the row', () => {
      expect(run?.notes.join(' ')).toContain('disk on fire')
    })

    it('shows it in the Logs under Sequences', () => {
      expect(logged).toContain('sequence.tick_failed')
    })
  })

  describe('Scenario: 150 due enrollments and an 8,000-person broadcast in the same minute', () => {
    let world: World
    let queries: number
    let broadcastRows: number
    let sequenceRows: number

    beforeAll(async () => {
      const { queue } = recordingQueue()
      world = createWorld({ SEND_QUEUE: queue } as Partial<Env>)
      const seq = await aSequence(world, { steps: [{ subject: 'Drip' }] })
      bulkPeople(world, 8000)
      const now = new Date()
      bulkEnroll(world, seq.id, seq.stepIds[0]!, 150, now)
      const id = await aBroadcast(world, { subject: 'Big send' })
      await world.db
        .update(broadcasts)
        .set({ status: 'scheduled', scheduledAt: new Date(now.getTime() - 60_000) })
        .where(eq(broadcasts.id, id))
      resetQueryCount(world.env.DB)
      await world.tick(now)
      queries = queryCount(world.env.DB)
      broadcastRows = (await world.db.select({ id: messages.id }).from(messages).where(eq(messages.kind, 'broadcast')).all()).length
      sequenceRows = (await world.db.select({ id: messages.id }).from(messages).where(eq(messages.kind, 'sequence')).all()).length
    })

    it('⭐ runs fewer than 1,000 queries in the one invocation', () => {
      expect(queries).toBeLessThan(1000)
    })

    it('still pushes the broadcast along', () => {
      expect(broadcastRows).toBeGreaterThan(0)
    })

    it('still advances the sequence', () => {
      expect(sequenceRows).toBeGreaterThan(0)
    })
  })

  describe('Scenario: 300 due enrollments on a quiet minute, with a webhook waiting', () => {
    let queries: number

    beforeAll(async () => {
      const { queue } = recordingQueue()
      const world = createWorld({ SEND_QUEUE: queue } as Partial<Env>)
      const seq = await aSequence(world, { steps: [{ subject: 'Drip' }] })
      bulkPeople(world, 300)
      const now = new Date()
      bulkEnroll(world, seq.id, seq.stepIds[0]!, 300, now)
      const ep = await createWebhookEndpoint(world.db, { url: 'https://hooks.example.com/k', events: ['subscribed'] })
      if (!ep.ok) throw new Error(ep.reason)
      await world.db.insert(webhookDeliveries).values({
        endpointId: ep.endpoint.id,
        event: 'subscribed',
        eventId: 'evt_q',
        payload: {},
        occurredAt: now,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(now.getTime() - 1000),
        createdAt: now,
      })
      resetQueryCount(world.env.DB)
      await world.tick(now)
      queries = queryCount(world.env.DB)
    })

    it('⭐ runs fewer than 1,000 queries in the one invocation', () => {
      expect(queries).toBeLessThan(1000)
    })
  })

  // ───────────────────────────────────────────── an interrupted broadcast page

  describe('Scenario: a broadcast page died after writing its rows and before handing them over', () => {
    let world: World
    let mailed: number
    let status: string | undefined

    beforeAll(async () => {
      world = createWorld()
      const people = [
        await aPerson(world, { email: 'one@example.test' }),
        await aPerson(world, { email: 'two@example.test' }),
        await aPerson(world, { email: 'three@example.test' }),
      ]
      const id = await aBroadcast(world, { subject: 'Stranded' })
      const top = people[2]!.id
      await world.db
        .update(broadcasts)
        .set({ status: 'sending', startedAt: new Date(), audienceUpperId: top, cursorSubscriberId: top })
        .where(eq(broadcasts.id, id))
      const old = new Date(Date.now() - 20 * 60_000)
      await world.db.insert(messages).values(
        people.map((p) => ({
          subscriberId: p.id,
          kind: 'broadcast' as const,
          broadcastId: id,
          toEmail: p.email,
          subject: 'Stranded',
          status: 'queued' as const,
          idempotencyKey: `broadcast:${id}:${p.id}`,
          createdAt: old,
        })),
      )
      await world.tick()
      await world.tick() // a second pass must not send anything twice
      mailed = (await world.outbox()).length
      status = (await world.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get())?.status
    })

    it('⭐ sends the stranded mail', async () => {
      expect((await world.mailTo('two@example.test')).subject).toBe('Stranded')
    })

    it('sends each of them once', () => {
      expect(mailed).toBe(3)
    })

    it('finishes the broadcast, so the next one is not blocked behind it', () => {
      expect(status).toBe('sent')
    })
  })

  /**
   * A broadcast whose walk is over, with three rows still `queued` in the state
   * a consumer left them in. Returns what two ticks then did.
   */
  async function afterTwoTicksWith(row: {
    error?: string
    claimedMinutesAgo?: number
    /** When the provider was asked for these (`provider_called_at`), if it was. */
    askedMinutesAgo?: number
    createdMinutesAgo: number
  }) {
    const world = createWorld()
    const people = [
      await aPerson(world, { email: 'one@example.test' }),
      await aPerson(world, { email: 'two@example.test' }),
      await aPerson(world, { email: 'three@example.test' }),
    ]
    const id = await aBroadcast(world, { subject: 'Left behind' })
    const top = people[2]!.id
    await world.db
      .update(broadcasts)
      .set({ status: 'sending', startedAt: new Date(), audienceUpperId: top, cursorSubscriberId: top })
      .where(eq(broadcasts.id, id))
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)
    await world.db.insert(messages).values(
      people.map((p) => ({
        subscriberId: p.id,
        kind: 'broadcast' as const,
        broadcastId: id,
        toEmail: p.email,
        subject: 'Left behind',
        status: 'queued' as const,
        idempotencyKey: `broadcast:${id}:${p.id}`,
        error: row.error ?? null,
        claimedAt: row.claimedMinutesAgo === undefined ? null : minutesAgo(row.claimedMinutesAgo),
        providerCalledAt: row.askedMinutesAgo === undefined ? null : minutesAgo(row.askedMinutesAgo),
        createdAt: minutesAgo(row.createdMinutesAgo),
      })),
    )
    await world.tick()
    await world.tick()
    return {
      mailed: (await world.outbox()).length,
      status: (await world.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get())?.status,
      rows: await world.db.select().from(messages).where(eq(messages.broadcastId, id)).all(),
    }
  }

  describe('Scenario: a batch threw, and the retry that should have finished it never came', () => {
    // A thrown batch writes its error on the rows and goes back on the queue.
    // If that retry is lost (the dead-letter queue ran out of attempts while
    // the database was down), the rows sit `queued` with an error for good.
    let after: Awaited<ReturnType<typeof afterTwoTicksWith>>

    beforeAll(async () => {
      after = await afterTwoTicksWith({
        error: 'send attempt threw: database unavailable',
        createdMinutesAgo: 3 * 60,
      })
    })

    it('⭐ sends the mail, each once', () => {
      expect(after.mailed).toBe(3)
    })

    it('finishes the broadcast, so the next one is not blocked behind it', () => {
      expect(after.status).toBe('sent')
    })
  })

  describe('Scenario: a batch threw a few minutes ago and its retry is still on the queue', () => {
    let after: Awaited<ReturnType<typeof afterTwoTicksWith>>

    beforeAll(async () => {
      after = await afterTwoTicksWith({
        error: 'send attempt threw: connection lost',
        createdMinutesAgo: 20,
      })
    })

    it('leaves the rows to that retry', () => {
      expect(after.mailed).toBe(0)
    })

    it('keeps the broadcast open for it', () => {
      expect(after.status).toBe('sending')
    })
  })

  describe('Scenario: the provider took the mail and the record of it is still on the queue', () => {
    // The rows say `queued` with a claim that has run out. Handing them over
    // again now would be a second copy; the record-only job is what finishes them.
    let after: Awaited<ReturnType<typeof afterTwoTicksWith>>

    beforeAll(async () => {
      after = await afterTwoTicksWith({ claimedMinutesAgo: 15, createdMinutesAgo: 20 })
    })

    it('⭐ sends nothing', () => {
      expect(after.mailed).toBe(0)
    })

    it('keeps the broadcast open for the record', () => {
      expect(after.status).toBe('sending')
    })
  })

  describe('Scenario: a consumer died holding its rows and nothing ever came back for them', () => {
    let after: Awaited<ReturnType<typeof afterTwoTicksWith>>

    beforeAll(async () => {
      after = await afterTwoTicksWith({ claimedMinutesAgo: 170, createdMinutesAgo: 3 * 60 })
    })

    it('sends the mail, each once', () => {
      expect(after.mailed).toBe(3)
    })

    it('finishes the broadcast', () => {
      expect(after.status).toBe('sent')
    })
  })

  describe('Scenario: the provider was asked hours ago and no answer was ever recorded', () => {
    // ⭐ SPEC 3.11, 4.8. The consumer died after the provider took the mail, or
    // the result and its record-only job were both lost. The claim ran out long
    // ago, which is exactly what a consumer that died *before* sending looks
    // like; `provider_called_at` is the difference. Nothing sends these again,
    // and nothing leaves them `queued` either: they go to the operator.
    let after: Awaited<ReturnType<typeof afterTwoTicksWith>>

    beforeAll(async () => {
      after = await afterTwoTicksWith({ claimedMinutesAgo: 170, askedMinutesAgo: 170, createdMinutesAgo: 3 * 60 })
    })

    it('⭐ sends nobody a second copy', () => {
      expect(after.mailed).toBe(0)
    })

    it('marks every one failed as mail that may have gone', () => {
      expect(after.rows.filter((r) => r.status === 'failed' && r.error?.startsWith('outcome unknown'))).toHaveLength(3)
    })

    it('finishes the broadcast, so the next one is not blocked behind it', () => {
      expect(after.status).toBe('sent')
    })
  })

  describe('Scenario: the provider was asked half an hour ago and its record may still be coming', () => {
    let after: Awaited<ReturnType<typeof afterTwoTicksWith>>

    beforeAll(async () => {
      after = await afterTwoTicksWith({ claimedMinutesAgo: 30, askedMinutesAgo: 30, createdMinutesAgo: 40 })
    })

    it('sends nothing', () => {
      expect(after.mailed).toBe(0)
    })

    it('leaves the rows queued for their record', () => {
      expect(after.rows.filter((r) => r.status === 'queued')).toHaveLength(3)
    })

    it('keeps the broadcast open for it', () => {
      expect(after.status).toBe('sending')
    })
  })

  describe('Scenario: the questions every page of a send asks, at the size of a real list', () => {
    // A few thousand people, so the planner has a real choice to make. Each of
    // these is asked per page of a broadcast or per reader on the preference
    // center, and each once read a whole table to answer.
    let tagged: string
    let enrollments: string
    let queuedLeft: string

    beforeAll(() => {
      const world = createWorld()
      bulkPeople(world, 3000)
      const db = sqlite(world)
      db.run(`insert into tags (slug, name, created_at) values ('t1', 'T1', 0), ('t2', 'T2', 0)`)
      db.run(`insert into subscriber_tags (subscriber_id, tag_id, tagged_at) select id, 1 + id % 2, 0 from subscribers`)
      db.run('analyze')
      const plan = (sql: string) =>
        (db.query(`explain query plan ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(' / ')
      tagged = plan('select subscriber_id from subscriber_tags where tag_id in (1, 2)')
      enrollments = plan('select sequence_id, status from sequence_enrollments where subscriber_id = 7')
      queuedLeft = plan(`select count(*) from messages where broadcast_id = 1 and status = 'queued'`)
    })

    it('finds the people carrying a tag by index', () => {
      expect(tagged).toContain('USING COVERING INDEX subscriber_tags_tag_idx')
    })

    it('finds one person’s series by index', () => {
      expect(enrollments).toContain('USING INDEX sequence_enrollments_subscriber_idx')
    })

    it('counts what a broadcast still has queued from the index alone', () => {
      expect(queuedLeft).toContain('USING COVERING INDEX messages_broadcast_status_idx')
    })
  })

  describe('Scenario: the same queued message reaches two consumers at once', () => {
    let mailed: number

    beforeAll(async () => {
      const world = createWorld()
      const person = await aPerson(world, { email: 'once@example.test' })
      const id = await aBroadcast(world, { subject: 'Only once' })
      await world.db.update(broadcasts).set({ status: 'sending' }).where(eq(broadcasts.id, id))
      const [row] = await world.db
        .insert(messages)
        .values({
          subscriberId: person.id,
          kind: 'broadcast',
          broadcastId: id,
          toEmail: person.email,
          subject: 'Only once',
          status: 'queued',
          idempotencyKey: `broadcast:${id}:${person.id}`,
          createdAt: new Date(),
        })
        .returning({ id: messages.id })
      await Promise.all([sendMessages(world.env, world.db, [row!.id]), sendMessages(world.env, world.db, [row!.id])])
      mailed = (await world.outbox()).length
    })

    it('⭐ sends it once', () => {
      expect(mailed).toBe(1)
    })
  })

  // ───────────────────────────────────────────── screens

  describe('Scenario: the operator filters the Logs to Subscribers', () => {
    let response: Response

    beforeAll(async () => {
      const world = createWorld()
      await aPerson(world, { email: 'logged@example.test' })
      response = await world.fetch('/logs?category=subscribers')
    })

    it('⭐ shows the page', () => {
      expect(response.status).toBe(200)
    })
  })

  describe('Scenario: 150 people have signed in on the site', () => {
    let response: Response
    let listed: number

    beforeAll(async () => {
      const world = createWorld()
      bulkPeople(world, 150)
      sqlite(world).run(
        `insert into member_sessions (subscriber_id, token_hash, created_at, expires_at, last_seen_at)
         select id, 'hash' || id, 0, 9999999999999, 0 from subscribers`,
      )
      response = await world.fetch('/members')
      listed = (await listMembers(world.db)).length
    })

    it('⭐ shows the Members page', () => {
      expect(response.status).toBe(200)
    })

    it('lists all of them', () => {
      expect(listed).toBe(150)
    })
  })

  // ───────────────────────────────────────────── imports

  describe('Scenario: an import says 150 people here have unsubscribed there', () => {
    let narrowed: number

    beforeAll(async () => {
      const world = createWorld()
      bulkPeople(world, 150)
      const records: ImportedSubscriber[] = Array.from({ length: 150 }, (_, i) => ({
        kind: 'subscriber',
        email: `p${i + 1}@bulk.test`,
        status: 'unsubscribed',
        rawStatus: 'unsubscribed',
        suppression: null,
        name: null,
        subscribedAt: null,
        unsubscribedAt: null,
        confirmedAt: null,
        attributes: {},
        tags: [],
      }))
      await writePage(world.db, { runId: 1, source: 'kit', label: 'Kit', now: Date.now() }, records)
      narrowed = (
        await world.db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.status, 'unsubscribed')).all()
      ).length
    })

    it('⭐ narrows every one of them', () => {
      expect(narrowed).toBe(150)
    })
  })

  // ───────────────────────────────────────────── outbound webhooks

  describe('Scenario: the receiver answers but writing down the answer fails', () => {
    let row: typeof webhookDeliveries.$inferSelect | undefined
    let now: Date

    beforeAll(async () => {
      const world = createWorld()
      const ep = await createWebhookEndpoint(world.db, { url: 'https://hooks.example.com/k', events: ['subscribed'] })
      if (!ep.ok) throw new Error(ep.reason)
      now = new Date()
      await world.db.insert(webhookDeliveries).values({
        endpointId: ep.endpoint.id,
        event: 'subscribed',
        eventId: 'evt_1',
        payload: {},
        occurredAt: now,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(now.getTime() - 1000),
        createdAt: now,
      })
      fakeTransportFor(world.env).respond(() => ({ ok: true, status: 500, body: 'nope' }))
      sqlite(world).run(
        `create trigger boom before update of last_status_code on webhook_deliveries
         begin select raise(abort, 'write failed'); end`,
      )
      await deliverDueWebhooks(world.env, world.db, { now })
      row = await world.db.select().from(webhookDeliveries).get()
    })

    it('⭐ still counts the attempt', () => {
      expect(row?.attempts).toBe(1)
    })

    it('still backs off before the next one', () => {
      expect(row?.nextAttemptAt?.getTime()).toBeGreaterThan(now.getTime())
    })
  })

  describe('Scenario: two deliveries to one endpoint give up in the same pass', () => {
    let failures: number | undefined

    beforeAll(async () => {
      const world = createWorld()
      const ep = await createWebhookEndpoint(world.db, { url: 'https://hooks.example.com/k', events: ['subscribed'] })
      if (!ep.ok) throw new Error(ep.reason)
      const now = new Date()
      await world.db.insert(webhookDeliveries).values(
        ['evt_a', 'evt_b'].map((eventId) => ({
          endpointId: ep.endpoint.id,
          event: 'subscribed' as const,
          eventId,
          payload: {},
          occurredAt: now,
          status: 'pending' as const,
          attempts: MAX_ATTEMPTS - 1,
          nextAttemptAt: new Date(now.getTime() - 1000),
          createdAt: now,
        })),
      )
      fakeTransportFor(world.env).respond(() => ({ ok: true, status: 500, body: 'down' }))
      await deliverDueWebhooks(world.env, world.db, { now })
      failures = (await world.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, ep.endpoint.id)).get())
        ?.consecutiveFailures
    })

    it('⭐ counts both failures', () => {
      expect(failures).toBe(2)
    })
  })

  describe('Scenario: a pass with no query budget left', () => {
    let posted: number

    beforeAll(async () => {
      const world = createWorld()
      const ep = await createWebhookEndpoint(world.db, { url: 'https://hooks.example.com/k', events: ['subscribed'] })
      if (!ep.ok) throw new Error(ep.reason)
      const now = new Date()
      await world.db.insert(webhookDeliveries).values({
        endpointId: ep.endpoint.id,
        event: 'subscribed',
        eventId: 'evt_z',
        payload: {},
        occurredAt: now,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(now.getTime() - 1000),
        createdAt: now,
      })
      await deliverDueWebhooks(world.env, world.db, { now, limit: 0 })
      posted = fakeTransportFor(world.env).requests.length
    })

    it('starts no delivery', () => {
      expect(posted).toBe(0)
    })
  })
})
