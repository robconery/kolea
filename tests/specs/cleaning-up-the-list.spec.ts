// gap.md "Clean up" — prune groups of people, with a backup, a confirm step and a record
// Ported from Kōlea `Audience.Prune` / `Audience.Pruning` (SPEC 7.10's delete applied
// to many; suppressions kept per SPEC 1.6 / 8.3.4). Big Mailer SPEC 1.2, 2.1.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { planPrune, pruneBackupCsv, runPrune } from '../../src/core/cleanup.ts'
import { canReceiveTransactional, isSuppressed } from '../../src/core/consent.ts'
import { createForm } from '../../src/core/forms.ts'
import { enroll } from '../../src/core/sequences.ts'
import { importCsv, upsertSubscriber } from '../../src/core/subscribers.ts'
import type { Subscriber } from '../../src/db/schema.ts'
import { events, listPrunes, messages, sales, subscribers, suppressions } from '../../src/db/schema.ts'
import { aBroadcast, aPerson, aSequence, makeDue, reload } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const DAY = 86_400_000

async function setStatus(w: World, p: Subscriber, status: Subscriber['status']) {
  await w.db.update(subscribers).set({ status }).where(eq(subscribers.id, p.id))
}

/** Three mails sent a month ago; with `opened`, one of them was opened last week. */
async function mailed(w: World, p: Subscriber, opened = false) {
  const sentAt = new Date(Date.now() - 30 * DAY)
  for (let i = 0; i < 3; i++) {
    const [m] = await w.db
      .insert(messages)
      .values({
        subscriberId: p.id,
        kind: 'transactional',
        toEmail: p.email,
        subject: `Mail ${i}`,
        status: 'sent',
        createdAt: sentAt,
        sentAt,
      })
      .returning()
    if (opened && i === 0) {
      await w.db
        .insert(events)
        .values({ messageId: m!.id, type: 'open', occurredAt: new Date(Date.now() - 7 * DAY) })
    }
  }
}

/** A leaver, unsubscribed and then pruned: only the `pruned` marker is left of them. */
async function aPrunedLeaver(w: World, email: string) {
  const leaver = await aPerson(w, { email })
  await setStatus(w, leaver, 'unsubscribed')
  const plan = await planPrune(w.db, ['unsubscribed'])
  if (!plan.ok) throw new Error(plan.message)
  await runPrune(w.db, plan.prune.id, { confirmCount: plan.prune.total })
}

const statusOf = async (w: World, email: string) =>
  (await w.db.select({ s: subscribers.status }).from(subscribers).where(eq(subscribers.email, email)).get())?.s

const mailsTo = async (w: World, email: string) => (await w.outbox()).filter((m) => m.toEmail === email)

async function exists(w: World, email: string): Promise<boolean> {
  return Boolean(await w.db.select().from(subscribers).where(eq(subscribers.email, email)).get())
}

describe('Feature: cleaning up the list', () => {
  describe('Scenario: the operator prunes everyone who left, bounced, never opened or never confirmed', () => {
    let world: World
    let screen: string
    let backup: string
    let wrongCount: string
    let pruneId: number

    beforeAll(async () => {
      world = createWorld()
      const leaver = await aPerson(world, { email: 'leaver@example.test' })
      await setStatus(world, leaver, 'unsubscribed')
      const bouncer = await aPerson(world, { email: 'bouncer@example.test' })
      await setStatus(world, bouncer, 'bounced')
      const silent = await aPerson(world, { email: 'silent@example.test' })
      await mailed(world, silent)
      const reader = await aPerson(world, { email: 'reader@example.test' })
      await mailed(world, reader, true)
      const pending = await aPerson(world, { email: 'pending@example.test', status: 'pending' })
      await world.db
        .update(subscribers)
        .set({ createdAt: new Date(Date.now() - 40 * DAY) })
        .where(eq(subscribers.id, pending.id))
      const buyer = await aPerson(world, { email: 'buyer@example.test' })
      await setStatus(world, buyer, 'unsubscribed')
      await world.db.insert(sales).values({
        subscriberId: buyer.id,
        amountCents: 4900,
        externalId: 'ch_1',
        occurredAt: new Date(),
        createdAt: new Date(),
      } as typeof sales.$inferInsert)

      screen = await (await world.fetch('/subscribers/clean-up')).text()
      const planned = await world.fetch('/subscribers/clean-up', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'group=never_engaged&group=unsubscribed&group=bounced&group=unconfirmed&days=180',
      })
      pruneId = Number(planned.headers.get('location')!.split('/').pop())
      backup = await (await world.fetch(`/subscribers/clean-up/${pruneId}/backup.csv`)).text()
      await world.post(`/subscribers/clean-up/${pruneId}/run`, { confirm: '3' })
      wrongCount = (await exists(world, 'leaver@example.test')) ? 'kept' : 'deleted'
      await world.post(`/subscribers/clean-up/${pruneId}/run`, { confirm: '4' })
    })

    it('shows the count for each group before anything happens', () => {
      expect(screen).toContain('Bounced or complained')
    })

    it('puts exactly the planned people in the backup', () => {
      const emails = backup.trim().split('\r\n').slice(1).map((l) => l.split(',')[0]).sort()
      expect(emails).toEqual([
        'bouncer@example.test',
        'leaver@example.test',
        'pending@example.test',
        'silent@example.test',
      ])
    })

    it('refuses to delete when the typed count is wrong', () => {
      expect(wrongCount).toBe('kept')
    })

    it('deletes the person who left', async () => {
      expect(await exists(world, 'leaver@example.test')).toBe(false)
    })

    it('deletes the person who never opened', async () => {
      expect(await exists(world, 'silent@example.test')).toBe(false)
    })

    it('deletes the person who never confirmed', async () => {
      expect(await exists(world, 'pending@example.test')).toBe(false)
    })

    it('keeps the person who opened recently', async () => {
      expect(await exists(world, 'reader@example.test')).toBe(true)
    })

    it('⭐ keeps the buyer, whatever their status', async () => {
      expect(await exists(world, 'buyer@example.test')).toBe(true)
    })

    it('⭐ leaves the person who left suppressed', async () => {
      expect(await isSuppressed(world.db, 'leaver@example.test')).toBe(true)
    })

    it('⭐ keeps the bounce as a hard-bounce suppression, so receipts stay blocked too', async () => {
      const row = await world.db.select().from(suppressions).where(eq(suppressions.email, 'bouncer@example.test')).get()
      expect(row?.reason).toBe('hard_bounce')
    })

    it('does not suppress the person who never opened: they never said no', async () => {
      expect(await isSuppressed(world.db, 'silent@example.test')).toBe(false)
    })

    it('records the clean-up as a finished row', async () => {
      const row = await world.db.select().from(listPrunes).where(eq(listPrunes.id, pruneId)).get()
      expect(row?.status).toBe('done')
    })

    it('records how many it deleted', async () => {
      const row = await world.db.select().from(listPrunes).where(eq(listPrunes.id, pruneId)).get()
      expect(row?.deleted).toBe(4)
    })

    it('records that the backup was downloaded', async () => {
      const row = await world.db.select().from(listPrunes).where(eq(listPrunes.id, pruneId)).get()
      expect(row?.backedUpAt).not.toBeNull()
    })
  })

  describe('Scenario: somebody pruned after unsubscribing turns up in a later import', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const leaver = await aPerson(world, { email: 'gone@example.test' })
      await setStatus(world, leaver, 'unsubscribed')
      const plan = await planPrune(world.db, ['unsubscribed'])
      if (plan.ok) await runPrune(world.db, plan.prune.id, { confirmCount: plan.prune.total })
      await importCsv(world.db, 'email\ngone@example.test')
    })

    it('⭐ is still suppressed, so no broadcast reaches them', async () => {
      expect(await isSuppressed(world.db, 'gone@example.test')).toBe(true)
    })
  })

  describe('Scenario: a pruned leaver turns up in a later import', () => {
    // ⭐ The import must not bring them back to the newsletter they left.
    let world: World

    beforeAll(async () => {
      world = createWorld()
      await aPrunedLeaver(world, 'gone@example.test')
      await importCsv(world.db, 'email,name\ngone@example.test,Gone')
    })

    it('⭐ comes back unsubscribed', async () => {
      expect(await statusOf(world, 'gone@example.test')).toBe('unsubscribed')
    })
  })

  describe('Scenario: a pruned leaver is added back and joins a series', () => {
    // ⭐ The marker is only the newsletter choice they made. A sequence they
    // join is a different scope (invariant 2).
    let world: World

    beforeAll(async () => {
      world = createWorld()
      await aPrunedLeaver(world, 'gone@example.test')
      const { id } = await upsertSubscriber(world.db, { email: 'gone@example.test', triggerSubscribeSequences: false })
      const seq = await aSequence(world, { steps: [{ subject: 'Lesson one' }] })
      await enroll(world.db, seq.id, id!)
      const person = (await world.db.select().from(subscribers).where(eq(subscribers.id, id!)).get())!
      await makeDue(world, person, seq.id)
      await world.tick()
    })

    it('⭐ gets the sequence mail', async () => {
      expect((await mailsTo(world, 'gone@example.test')).map((m) => m.subject)).toEqual(['Lesson one'])
    })
  })

  describe('Scenario: a pruned leaver is added back by the operator and a broadcast goes out', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      await aPrunedLeaver(world, 'gone@example.test')
      await upsertSubscriber(world.db, { email: 'gone@example.test', triggerSubscribeSequences: false })
      const b = await aBroadcast(world)
      await startBroadcast(world.env, world.db, b)
    })

    it('⭐ still keeps the newsletter from them', async () => {
      expect(await mailsTo(world, 'gone@example.test')).toHaveLength(0)
    })
  })

  describe('Scenario: a pruned leaver buys something', () => {
    let blocked: boolean

    beforeAll(async () => {
      const world = createWorld()
      await aPrunedLeaver(world, 'gone@example.test')
      blocked = (await canReceiveTransactional(world.db, 'gone@example.test')).blocked
    })

    it('still gets their receipt', () => {
      expect(blocked).toBe(false)
    })
  })

  describe('Scenario: a pruned leaver signs up again through a confirming form', () => {
    let world: World
    let confirmations: number
    let markerAfterClick: boolean
    let broadcastMails: number

    beforeAll(async () => {
      world = createWorld()
      await aPrunedLeaver(world, 'back@example.test')
      await createForm(world.db, { name: 'Join', slug: 'join', doubleOptIn: true })
      await world.post('/f/join', { email: 'back@example.test' })
      const mail = (await mailsTo(world, 'back@example.test')).find((m) => m.subject.startsWith('Confirm'))
      confirmations = mail ? 1 : 0
      const link = /\/f\/join\/confirm\/[a-z0-9]+/.exec(mail?.html ?? '')?.[0] ?? '/nowhere'
      await world.post(link, {})
      markerAfterClick = await isSuppressed(world.db, 'back@example.test')
      const b = await aBroadcast(world, { subject: 'Welcome back issue' })
      await startBroadcast(world.env, world.db, b)
      broadcastMails = (await mailsTo(world, 'back@example.test')).filter((m) => m.subject === 'Welcome back issue').length
    })

    it('sends them the confirmation', () => {
      expect(confirmations).toBe(1)
    })

    it('clears the marker once they click', () => {
      expect(markerAfterClick).toBe(false)
    })

    it('puts them back on the newsletter', () => {
      expect(broadcastMails).toBe(1)
    })
  })

  describe('Scenario: a pruned leaver signs up again through a plain form', () => {
    let world: World
    let marker: boolean

    beforeAll(async () => {
      world = createWorld()
      await aPrunedLeaver(world, 'back@example.test')
      await createForm(world.db, { name: 'Join', slug: 'join', doubleOptIn: false })
      await world.post('/f/join', { email: 'back@example.test' })
      marker = await isSuppressed(world.db, 'back@example.test')
    })

    it('clears the marker', () => {
      expect(marker).toBe(false)
    })
  })

  describe('Scenario: the operator restores a clean-up from its backup', () => {
    // ⭐ The backup says it can be imported back. It must come back as it was,
    // never more subscribed: an unconfirmed person is still unconfirmed.
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const unconfirmed = await aPerson(world, { email: 'maybe@example.test' })
      await world.db
        .update(subscribers)
        .set({ status: 'pending', createdAt: new Date(Date.now() - 40 * DAY) })
        .where(eq(subscribers.id, unconfirmed.id))
      const leaver = await aPerson(world, { email: 'left@example.test' })
      await setStatus(world, leaver, 'unsubscribed')
      const plan = await planPrune(world.db, ['unconfirmed', 'unsubscribed'])
      if (!plan.ok) throw new Error(plan.message)
      const backup = await pruneBackupCsv(world.db, plan.prune)
      await runPrune(world.db, plan.prune.id, { confirmCount: plan.prune.total })
      await importCsv(world.db, backup)
    })

    it('⭐ brings the unconfirmed person back pending', async () => {
      expect(await statusOf(world, 'maybe@example.test')).toBe('pending')
    })

    it('⭐ brings the leaver back unsubscribed', async () => {
      expect(await statusOf(world, 'left@example.test')).toBe('unsubscribed')
    })
  })

  describe('Scenario: an import whose status column says somebody already here left', () => {
    let world: World
    let ada: Subscriber
    let grace: Subscriber

    beforeAll(async () => {
      world = createWorld()
      ada = await aPerson(world, { email: 'ada@example.test' })
      grace = await aPerson(world, { email: 'grace@example.test' })
      await setStatus(world, grace, 'unsubscribed')
      await importCsv(world.db, 'email,status\nada@example.test,unsubscribed\ngrace@example.test,active')
    })

    it('narrows the active person', async () => {
      expect((await reload(world, ada)).status).toBe('unsubscribed')
    })

    it('⭐ never makes anybody active', async () => {
      expect((await reload(world, grace)).status).toBe('unsubscribed')
    })
  })

  describe('Scenario: a big clean-up runs over several presses', () => {
    let world: World
    let afterFirst: string
    let afterSecond: string
    let left: number

    beforeAll(async () => {
      world = createWorld()
      for (let i = 0; i < 5; i++) {
        const p = await aPerson(world, { email: `old-${i}@example.test` })
        await setStatus(world, p, 'bounced')
      }
      const plan = await planPrune(world.db, ['bounced'])
      if (!plan.ok) throw new Error(plan.message)
      const first = await runPrune(world.db, plan.prune.id, { confirmCount: 5, pageSize: 2, pages: 1 })
      afterFirst = first.ok ? first.prune.status : 'error'
      const second = await runPrune(world.db, plan.prune.id, { pageSize: 2, pages: 5 })
      afterSecond = second.ok ? second.prune.status : 'error'
      left = (await world.db.select().from(subscribers).all()).length
    })

    it('stays running after the first page', () => {
      expect(afterFirst).toBe('running')
    })

    it('finishes when Continue reaches the end', () => {
      expect(afterSecond).toBe('done')
    })

    it('deletes everyone it planned', () => {
      expect(left).toBe(0)
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: someone in the plan gets mail queued before the delete', () => {
    let world: World

    beforeAll(async () => {
      world = createWorld()
      const p = await aPerson(world, { email: 'queued@example.test' })
      await setStatus(world, p, 'unsubscribed')
      const plan = await planPrune(world.db, ['unsubscribed'])
      if (!plan.ok) throw new Error(plan.message)
      await world.db.insert(messages).values({
        subscriberId: p.id,
        kind: 'transactional',
        toEmail: p.email,
        subject: 'Your receipt',
        createdAt: new Date(),
      })
      await runPrune(world.db, plan.prune.id, { confirmCount: 1 })
    })

    it('skips them instead of deleting them', async () => {
      expect(await exists(world, 'queued@example.test')).toBe(true)
    })
  })

  describe('Scenario: planning with no group picked', () => {
    it('is refused', async () => {
      const world = createWorld()
      const plan = await planPrune(world.db, [])
      expect(plan.ok).toBe(false)
    })
  })
})
