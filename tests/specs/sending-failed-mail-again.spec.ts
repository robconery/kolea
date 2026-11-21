// gap.md "Held mail, released later" — mail that failed is never silently
// dropped: it is listed, and it can be sent again once what stopped it is fixed.
// kolea-pro CLAUDE.md mail rule 2; kolea-pro SPEC 1.7, 1.17, 10.2.2, 10.3.2
// (Kolea.Pipeline.HeldMail). Big Mailer's own SPEC 3.8 (no double send).
import { setAgentSwitches } from '../../src/core/agents.ts'
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { cancelBroadcast, startBroadcast } from '../../src/core/broadcasts.ts'
import { createApiKey } from '../../src/core/api-keys.ts'
import { sendAgain, undeliveredMail, type UndeliveredReport } from '../../src/core/undelivered.ts'
import type { Subscriber } from '../../src/db/schema.ts'
import { messages, subscribers } from '../../src/db/schema.ts'
import type { SendJob } from '../../src/types.ts'
import worker from '../../src/worker.tsx'
import { aBroadcast, aPerson, aSequence } from '../support/factories.ts'
import { createWorld, sendBatchOf, type World } from '../support/world.ts'

/** A send queue that records what it was handed, so a spec can deliver it through `worker.queue`. */
function recordingQueue(): { queue: Queue<SendJob>; take: () => number[] } {
  let held: number[] = []
  const queue = {
    send: async (body: SendJob) => {
      held.push(body.messageId)
    },
    sendBatch: async (batch: { body: SendJob }[]) => {
      held.push(...batch.map((m) => m.body.messageId))
    },
  } as unknown as Queue<SendJob>
  return {
    queue,
    take: () => {
      const out = held
      held = []
      return out
    },
  }
}

/** Run one batch through the deployed queue consumer (or its dead-letter twin). */
async function deliver(w: World, ids: number[], queue = 'big-mailer-send') {
  await worker.queue(sendBatchOf(ids, queue).batch, w.env)
}

async function messageFor(w: World, person: Subscriber) {
  return (await w.db.select().from(messages).where(eq(messages.subscriberId, person.id)).get())!
}

/** One MCP tool call through the deployed endpoint; the raw response text. */
async function mcp(w: World, token: string, name: string, args: unknown): Promise<string> {
  const res = await w.fetch('/mcp/secret-path', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  return await res.text()
}

const mailsTo = async (w: World, email: string) => (await w.outbox()).filter((m) => m.toEmail === email).length

describe('Feature: sending failed mail again', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the queue gave up on one reader of a broadcast, and the operator sends it again', () => {
    let world: World
    let ada: Subscriber
    let grace: Subscriber
    let page: string
    let flash: string
    let again: string
    let enqueued: number[]
    let finalStatus: string | undefined

    beforeAll(async () => {
      const q = recordingQueue()
      world = createWorld({ SEND_QUEUE: q.queue })
      ada = await aPerson(world, { email: 'ada@example.test' })
      grace = await aPerson(world, { email: 'grace@example.test' })
      const id = await aBroadcast(world, { subject: 'This week in Ruby' })
      await startBroadcast(world.env, world.db, id)
      q.take()

      // Grace's copy goes; Ada's exhausts its retries and lands in the DLQ.
      await deliver(world, [(await messageFor(world, grace)).id])
      await deliver(world, [(await messageFor(world, ada)).id], 'big-mailer-dlq')

      page = await (await world.fetch('/undelivered')).text()
      const res = await world.post('/undelivered/send-again', {
        kind: 'broadcast',
        id: String(id),
        confirm: 'send-again',
      })
      flash = decodeURIComponent(res.headers.get('location') ?? '')
      enqueued = q.take()
      await deliver(world, enqueued)
      finalStatus = (await messageFor(world, ada)).status

      const second = await world.post('/undelivered/send-again', {
        kind: 'broadcast',
        id: String(id),
        confirm: 'send-again',
      })
      again = decodeURIComponent(second.headers.get('location') ?? '')
    })

    it('lists the broadcast on the Undelivered screen', () => {
      expect(page).toContain('This week in Ruby')
    })

    it('offers to send the one failed message again', () => {
      expect(page).toContain('Send again')
    })

    it('says the queue gave up', () => {
      expect(page).toContain('gave up after exhausting queue retries')
    })

    it('tells the operator how many were queued', () => {
      expect(flash).toContain('Queued 1')
    })

    it('puts only the failed message back on the queue', async () => {
      expect(enqueued).toEqual([(await messageFor(world, ada)).id])
    })

    it('delivers it through the normal send path', async () => {
      expect(await mailsTo(world, 'ada@example.test')).toBe(1)
    })

    it('records it as sent', () => {
      expect(finalStatus).toBe('sent')
    })

    it('⭐ does not mail the reader who already had it', async () => {
      expect(await mailsTo(world, 'grace@example.test')).toBe(1)
    })

    it('finds nothing left to send on a second click', () => {
      expect(again).toContain('Nothing left to send')
    })
  })

  describe('Scenario: a failed sequence step and a failed receipt', () => {
    let world: World
    let report: UndeliveredReport

    beforeAll(async () => {
      world = createWorld()
      const ada = await aPerson(world, { email: 'ada@example.test' })
      const seq = await aSequence(world, { name: 'Onboarding', steps: [{ subject: 'Welcome aboard' }] })
      const failed = { status: 'failed' as const, error: 'provider refused: 422', createdAt: new Date() }
      await world.db.insert(messages).values([
        { ...failed, subscriberId: ada.id, kind: 'sequence', sequenceStepId: seq.stepIds[0], toEmail: ada.email, subject: 'Welcome aboard' },
        { ...failed, subscriberId: ada.id, kind: 'transactional', toEmail: ada.email, subject: 'Your receipt', bodyMd: 'Thanks.' },
      ])
      report = await undeliveredMail(world.db)
    })

    it('groups the sequence mail under its step', () => {
      expect(report.groups.some((g) => g.target.kind === 'step' && g.label.includes('Onboarding'))).toBe(true)
    })

    it('lists the receipt on its own', () => {
      expect(report.groups.some((g) => g.target.kind === 'message' && g.source === 'transactional')).toBe(true)
    })

    it('counts both', () => {
      expect(report.total).toBe(2)
    })
  })

  describe('Scenario: sending a failed sequence step again', () => {
    let world: World
    let result: { ok: boolean; requeued: number }

    beforeAll(async () => {
      world = createWorld()
      const ada = await aPerson(world, { email: 'ada@example.test' })
      const seq = await aSequence(world, { steps: [{ subject: 'Welcome aboard' }] })
      await world.db.insert(messages).values({
        subscriberId: ada.id,
        kind: 'sequence',
        sequenceStepId: seq.stepIds[0],
        toEmail: ada.email,
        subject: 'Welcome aboard',
        status: 'failed',
        error: 'provider refused: 422',
        createdAt: new Date(),
      })
      result = await sendAgain(world.env, world.db, { kind: 'step', id: seq.stepIds[0]! })
    })

    it('queues it', () => {
      expect(result.requeued).toBe(1)
    })

    it('delivers it', async () => {
      expect(await mailsTo(world, 'ada@example.test')).toBe(1)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: the reader unsubscribed after their copy failed', () => {
    // ⭐ Consent is checked again immediately before the provider call, as for
    // any send. A failure is not a licence to mail somebody who has left.
    let world: World
    let status: string | undefined

    beforeAll(async () => {
      const q = recordingQueue()
      world = createWorld({ SEND_QUEUE: q.queue })
      const ada = await aPerson(world, { email: 'ada@example.test' })
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id)
      await deliver(world, q.take(), 'big-mailer-dlq')

      await world.db.update(subscribers).set({ status: 'unsubscribed' }).where(eq(subscribers.id, ada.id))
      await sendAgain(world.env, world.db, { kind: 'broadcast', id })
      await deliver(world, q.take())
      status = (await messageFor(world, ada)).status
    })

    it('does not mail them', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('records the message as suppressed', () => {
      expect(status).toBe('suppressed')
    })
  })

  describe('Scenario: mail that already went', () => {
    let world: World
    let result: { requeued: number }

    beforeAll(async () => {
      world = createWorld()
      const ada = await aPerson(world, { email: 'ada@example.test' })
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id)
      result = await sendAgain(world.env, world.db, { kind: 'message', id: (await messageFor(world, ada)).id })
    })

    it('is never claimed', () => {
      expect(result.requeued).toBe(0)
    })

    it('⭐ is not sent twice', async () => {
      expect(await mailsTo(world, 'ada@example.test')).toBe(1)
    })
  })

  describe('Scenario: a broadcast the operator cancelled', () => {
    // A cancel is a stop, not a failure. Resume is the way back.
    let world: World
    let report: UndeliveredReport
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      const q = recordingQueue()
      world = createWorld({ SEND_QUEUE: q.queue })
      await aPerson(world)
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id)
      await cancelBroadcast(world.db, id)
      report = await undeliveredMail(world.db)
      result = await sendAgain(world.env, world.db, { kind: 'broadcast', id })
    })

    it('is not listed as undelivered', () => {
      expect(report.total).toBe(0)
    })

    it('refuses to send it again', () => {
      expect(result.ok).toBe(false)
    })

    it('points at resume instead', () => {
      expect(result.reason).toContain('resume')
    })
  })

  describe('Scenario: a send-again request without the confirmation', () => {
    let world: World
    let status: string | undefined

    beforeAll(async () => {
      const q = recordingQueue()
      world = createWorld({ SEND_QUEUE: q.queue })
      const ada = await aPerson(world)
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id)
      await deliver(world, q.take(), 'big-mailer-dlq')
      await world.post('/undelivered/send-again', { kind: 'broadcast', id: String(id) })
      status = (await messageFor(world, ada)).status
    })

    it('sends nothing', () => {
      expect(status).toBe('failed')
    })
  })

  describe('Scenario: mail the console provider rendered instead of sending', () => {
    // Told apart by `messages.provider = 'console'`, counted so it is never
    // invisible, and deliberately not offered: the console provider is also
    // the development default, and nothing on the row says which it was.
    let world: World
    let page: string

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world)
      const id = await aBroadcast(world)
      await startBroadcast(world.env, world.db, id)
      page = await (await world.fetch('/undelivered')).text()
    })

    it('says how many were rendered to the Outbox', () => {
      expect(page).toContain('1 messages were rendered to the')
    })

    it('does not offer to send them', () => {
      expect(page).not.toContain('Send again')
    })
  })

  describe('Scenario: an agent previews failed mail, then sends it again', () => {
    // The MCP path wraps the same core call behind the house guards: the send
    // switch, and a single-use preflight token bound to the exact failed rows.
    let world: World
    let preflight: string
    let sent: string
    let replay: string

    beforeAll(async () => {
      world = createWorld({ MCP_PATH_SECRET: 'secret-path' })
      await setAgentSwitches(world.db, { allowSend: true })
      const { token } = await createApiKey(world.db, 'agent', 'admin')
      const ada = await aPerson(world, { email: 'ada@example.test' })
      await world.db.insert(messages).values({
        subscriberId: ada.id,
        kind: 'transactional',
        toEmail: ada.email,
        subject: 'Your receipt',
        bodyMd: 'Thanks.',
        status: 'failed',
        error: 'provider refused: 422',
        createdAt: new Date(),
      })
      const target = { kind: 'message', id: (await messageFor(world, ada)).id }

      preflight = await mcp(world, token, 'undelivered_preflight', { target })
      const minted = /"preflight_token":\s*"([^"]+)"/.exec(preflight.replaceAll('\\"', '"'))?.[1] ?? ''
      sent = await mcp(world, token, 'undelivered_send_again', { target, preflight_token: minted })
      replay = await mcp(world, token, 'undelivered_send_again', { target, preflight_token: minted })
    })

    it('mints a preflight token', () => {
      expect(preflight).toContain('preflight_token')
    })

    it('sends it again with the token', () => {
      expect(sent).toContain('requeued')
    })

    it('delivers it once', async () => {
      expect(await mailsTo(world, 'ada@example.test')).toBe(1)
    })

    it('refuses the same token twice', () => {
      expect(replay).toContain('already used')
    })
  })

  describe('Scenario: an agent asks to send failed mail again while MCP sending is off', () => {
    let world: World
    let body: string

    beforeAll(async () => {
      world = createWorld({ MCP_PATH_SECRET: 'secret-path' })
      const { token } = await createApiKey(world.db, 'agent', 'admin')
      body = await mcp(world, token, 'undelivered_send_again', {
        target: { kind: 'broadcast', id: 1 },
        preflight_token: 'x',
      })
    })

    it('is refused by the send switch', () => {
      expect(body).toContain('Sending via MCP is switched off')
    })
  })
})
