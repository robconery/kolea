// Confirming a signup (double opt-in)
//
// gap.md "Double opt-in": a form can require confirmation. Ports Kōlea SPEC
// 14.2 (double opt-in per form, default on; signup creates `pending`, sends a
// transactional confirmation, only the click sets `active` and fires subscribe
// triggers), 14.3 (a form must not become a way to mail-bomb an address), 7.2
// and 1.6 (only the person, from the preference center, returns somebody who
// left). Big Mailer SPEC 1.4 and the 1.6 TODO, 2.1–2.2 (suppression checked at
// send time, a blocked send is a visible row).
//
// The rule underneath all of it: until the click, a stranger typing somebody's
// address into a public form can cause one throttled confirmation and nothing
// else. No tags, no sequence, no reply, no newsletter.
import { beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { unsubscribeAll, unsubscribeBroadcasts } from '../../src/core/consent.ts'
import { createForm, getForm, setFormReply } from '../../src/core/forms.ts'
import {
  activities,
  formConfirmations,
  messages,
  subscriberTags,
  subscribers,
  type Subscriber,
} from '../../src/db/schema.ts'
import { aPerson, aSequence, aTag, enrollmentOf, reload } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

interface Setup {
  world: World
  formId: number
  tagId: number
  formSequence: number
  welcome: number
}

/** A confirming form that tags, starts a series and sends a reply, plus a welcome series. */
async function aConfirmingForm(doubleOptIn = true): Promise<Setup> {
  const world = createWorld()
  const tagId = await aTag(world, 'from-blog')
  const formSequence = (await aSequence(world, { name: 'Toolkit series' })).id
  const welcome = (await aSequence(world, { name: 'Welcome', trigger: 'subscribe' })).id
  const formId = await createForm(world.db, {
    name: 'Toolkit',
    slug: 'toolkit',
    sequenceId: formSequence,
    tagIds: [tagId],
    doubleOptIn,
  })
  await setFormReply(world.db, formId, {
    subject: 'Here is your toolkit',
    bodyJson: null,
    bodyMd: 'Enjoy it.',
  })
  return { world, formId, tagId, formSequence, welcome }
}

async function personByEmail(world: World, email: string): Promise<Subscriber> {
  return (await world.db.select().from(subscribers).where(eq(subscribers.email, email)).get())!
}

async function subjectsTo(world: World, email: string): Promise<string[]> {
  return (await world.outbox()).filter((m) => m.toEmail === email).map((m) => m.subject)
}

/** The confirm path inside the one confirmation mail sent to `email`. */
async function confirmLink(world: World, email: string): Promise<string> {
  const mail = (await world.outbox()).find(
    (m) => m.toEmail === email && m.subject.startsWith('Confirm'),
  )
  const match = /\/f\/toolkit\/confirm\/[a-z0-9]+/.exec(mail?.html ?? '')
  return match?.[0] ?? '(no link)'
}

async function isTagged(world: World, person: Subscriber, tagId: number): Promise<boolean> {
  const row = await world.db
    .select()
    .from(subscriberTags)
    .where(and(eq(subscriberTags.subscriberId, person.id), eq(subscriberTags.tagId, tagId)))
    .get()
  return Boolean(row)
}

describe('Feature: confirming a signup', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a new reader signs up through a form that asks for confirmation', () => {
    let s: Setup
    let person: Subscriber
    let page: string
    let subjects: string[]
    let link: string
    const email = 'new@example.test'

    beforeAll(async () => {
      s = await aConfirmingForm()
      page = await (await s.world.post('/f/toolkit', { email, name: 'Nia' })).text()
      // A minute passes: nothing joined, so nothing is due.
      await s.world.tick()
      person = await personByEmail(s.world, email)
      subjects = await subjectsTo(s.world, email)
      link = await confirmLink(s.world, email)
    })

    it('saves them as pending', () => {
      expect(person.status).toBe('pending')
    })

    it('tells them to check their inbox', () => {
      expect(page).toContain('Check your inbox')
    })

    it('⭐ sends exactly one mail, the confirmation', () => {
      expect(subjects).toEqual(['Confirm your subscription to Rob'])
    })

    it('puts a confirm link in it', () => {
      expect(link).toStartWith('/f/toolkit/confirm/')
    })

    it('⭐ does not tag them yet', async () => {
      expect(await isTagged(s.world, person, s.tagId)).toBe(false)
    })

    it("⭐ does not start the form's sequence yet", async () => {
      expect(await enrollmentOf(s.world, person, s.formSequence)).toBeNull()
    })

    it('⭐ does not start the welcome series yet', async () => {
      expect(await enrollmentOf(s.world, person, s.welcome)).toBeNull()
    })

    it('records the confirmation as a message', async () => {
      const row = await s.world.db
        .select()
        .from(messages)
        .where(and(eq(messages.subscriberId, person.id), eq(messages.kind, 'confirmation')))
        .get()
      expect(row?.status).toBe('sent')
    })

    it('carries no unsubscribe footer, because there is nothing yet to leave', async () => {
      const mail = (await s.world.outbox()).find((m) => m.toEmail === email)
      expect(mail?.html).not.toContain('/p/')
    })
  })

  describe('Scenario: they open the link, then press the button', () => {
    let s: Setup
    let opened: string
    let statusAfterOpening: string
    let person: Subscriber
    let subjects: string[]
    let promoted: number
    const email = 'clicker@example.test'

    beforeAll(async () => {
      s = await aConfirmingForm()
      await s.world.post('/f/toolkit', { email })
      const link = await confirmLink(s.world, email)

      opened = await (await s.world.fetch(link)).text()
      statusAfterOpening = (await personByEmail(s.world, email)).status

      await s.world.post(link, {})
      person = await personByEmail(s.world, email)
      subjects = await subjectsTo(s.world, email)
      promoted = (
        await s.world.db
          .select()
          .from(activities)
          .where(and(eq(activities.subscriberId, person.id), eq(activities.type, 'promoted')))
          .all()
      ).length
    })

    it('shows a button on the page the link opens', () => {
      expect(opened).toContain('Yes, subscribe me')
    })

    it('⭐ changes nothing just by opening the link (mail scanners open links)', () => {
      expect(statusAfterOpening).toBe('pending')
    })

    it('makes them active', () => {
      expect(person.status).toBe('active')
    })

    it('records when they confirmed', () => {
      expect(person.confirmedAt).toBeInstanceOf(Date)
    })

    it("applies the form's tags", async () => {
      expect(await isTagged(s.world, person, s.tagId)).toBe(true)
    })

    it("starts the form's sequence", async () => {
      expect((await enrollmentOf(s.world, person, s.formSequence))?.status).toBe('active')
    })

    it('starts the welcome series', async () => {
      expect((await enrollmentOf(s.world, person, s.welcome))?.status).toBe('active')
    })

    it('sends the reply', () => {
      expect(subjects).toContain('Here is your toolkit')
    })

    it('logs the move from pending to active once', () => {
      expect(promoted).toBe(1)
    })
  })

  describe('Scenario: they press the button twice', () => {
    let replies: number
    let second: string

    beforeAll(async () => {
      const s = await aConfirmingForm()
      const email = 'twice@example.test'
      await s.world.post('/f/toolkit', { email })
      const link = await confirmLink(s.world, email)
      await s.world.post(link, {})
      second = await (await s.world.post(link, {})).text()
      replies = (await subjectsTo(s.world, email)).filter((x) => x === 'Here is your toolkit').length
    })

    it('sends the reply once', () => {
      expect(replies).toBe(1)
    })

    it('says they are already confirmed', () => {
      expect(second).toContain('already confirmed')
    })
  })

  describe('Scenario: a single opt-in form still signs people up on submit', () => {
    let person: Subscriber
    let subjects: string[]

    beforeAll(async () => {
      const s = await aConfirmingForm(false)
      await s.world.post('/f/toolkit', { email: 'single@example.test' })
      person = await personByEmail(s.world, 'single@example.test')
      subjects = await subjectsTo(s.world, 'single@example.test')
    })

    it('makes them active straight away', () => {
      expect(person.status).toBe('active')
    })

    it('sends no confirmation', () => {
      expect(subjects).toEqual(['Here is your toolkit'])
    })
  })

  describe('Scenario: the writer switches confirmation on from the form page', () => {
    let before: boolean | undefined
    let after: boolean | undefined

    beforeAll(async () => {
      const s = await aConfirmingForm(false)
      before = (await getForm(s.world.db, s.formId))?.doubleOptIn
      await s.world.post(`/forms/${s.formId}`, {
        name: 'Toolkit',
        slug: 'toolkit',
        isActive: '1',
        doubleOptIn: '1',
      })
      after = (await getForm(s.world.db, s.formId))?.doubleOptIn
    })

    it('starts off', () => {
      expect(before).toBe(false)
    })

    it('saves it on', () => {
      expect(after).toBe(true)
    })
  })

  describe('Scenario: a brand new form', () => {
    let on: boolean | undefined

    beforeAll(async () => {
      const world = createWorld()
      on = (await getForm(world.db, await createForm(world.db, { name: 'Fresh' })))?.doubleOptIn
    })

    it("asks for confirmation unless told otherwise (Kōlea's default)", () => {
      expect(on).toBe(true)
    })
  })

  // ───────────────────────────────────────────── people already on file

  describe('Scenario: an active subscriber submits a confirming form', () => {
    let s: Setup
    let person: Subscriber
    let subjects: string[]

    beforeAll(async () => {
      s = await aConfirmingForm()
      const existing = await aPerson(s.world, { email: 'regular@example.test' })
      await s.world.post('/f/toolkit', { email: existing.email })
      person = await reload(s.world, existing)
      subjects = await subjectsTo(s.world, existing.email)
    })

    it('⭐ leaves them active', () => {
      expect(person.status).toBe('active')
    })

    it('asks them to confirm, like anyone else', () => {
      expect(subjects).toEqual(['Confirm your subscription to Rob'])
    })

    it('⭐ does not tag them on a stranger’s say-so', async () => {
      expect(await isTagged(s.world, person, s.tagId)).toBe(false)
    })
  })

  describe('Scenario: somebody who left the newsletter signs up again and confirms', () => {
    let s: Setup
    let person: Subscriber
    let page: string

    beforeAll(async () => {
      s = await aConfirmingForm()
      const left = await aPerson(s.world, { email: 'left@example.test' })
      await unsubscribeBroadcasts(s.world.db, left.id)
      await s.world.post('/f/toolkit', { email: left.email })
      page = await (await s.world.post(await confirmLink(s.world, left.email), {})).text()
      person = await reload(s.world, left)
    })

    it('⭐ keeps them off the newsletter (only they can change that, from their preferences)', () => {
      expect(person.status).toBe('unsubscribed')
    })

    it('still gives them what this form promised', async () => {
      expect(await isTagged(s.world, person, s.tagId)).toBe(true)
    })

    it('shows them the way back to the newsletter', () => {
      expect(page).toContain(`/p/${person.unsubToken}`)
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: somebody keeps submitting the same address', () => {
    let s: Setup
    const email = 'victim@example.test'
    let afterDoubleClick: number
    let afterTenMinutes: number
    let afterADay: number
    let openRows: number
    let links: Set<string>

    const backdateConfirmations = async (ms: number) => {
      const rows = await s.world.db
        .select({ id: messages.id, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.kind, 'confirmation'))
        .all()
      for (const r of rows) {
        await s.world.db
          .update(messages)
          .set({ createdAt: new Date(r.createdAt.getTime() - ms) })
          .where(eq(messages.id, r.id))
      }
    }

    beforeAll(async () => {
      s = await aConfirmingForm()
      await s.world.post('/f/toolkit', { email })
      await s.world.post('/f/toolkit', { email })
      afterDoubleClick = (await subjectsTo(s.world, email)).length

      await backdateConfirmations(11 * 60_000)
      await s.world.post('/f/toolkit', { email })
      afterTenMinutes = (await subjectsTo(s.world, email)).length

      for (let i = 0; i < 5; i++) {
        await backdateConfirmations(11 * 60_000)
        await s.world.post('/f/toolkit', { email })
      }
      afterADay = (await subjectsTo(s.world, email)).length

      openRows = (await s.world.db.select().from(formConfirmations).all()).length
      links = new Set(
        (await s.world.outbox()).map((m) => /\/confirm\/([a-z0-9]+)/.exec(m.html)?.[1] ?? ''),
      )
    })

    it('⭐ sends one confirmation for a double submit', () => {
      expect(afterDoubleClick).toBe(1)
    })

    it('sends another once ten minutes have passed', () => {
      expect(afterTenMinutes).toBe(2)
    })

    it('⭐ never sends more than three in a day', () => {
      expect(afterADay).toBe(3)
    })

    it('keeps one open confirmation, not one per submit', () => {
      expect(openRows).toBe(1)
    })

    it('puts the same working link in every copy', () => {
      expect(links.size).toBe(1)
    })
  })

  describe('Scenario: a suppressed address is typed into the form', () => {
    let s: Setup
    let sent: number
    let row: { status: string; suppressedReason: string | null } | undefined

    beforeAll(async () => {
      s = await aConfirmingForm()
      const gone = await aPerson(s.world, { email: 'gone@example.test' })
      await unsubscribeAll(s.world.db, gone.id, gone.email)
      await s.world.post('/f/toolkit', { email: gone.email })
      sent = (await subjectsTo(s.world, gone.email)).length
      row = await s.world.db
        .select({ status: messages.status, suppressedReason: messages.suppressedReason })
        .from(messages)
        .where(eq(messages.kind, 'confirmation'))
        .get()
    })

    it('⭐ sends nothing', () => {
      expect(sent).toBe(0)
    })

    it('records the blocked confirmation where it can be seen', () => {
      expect(row).toEqual({ status: 'suppressed', suppressedReason: 'suppressed' })
    })
  })

  describe('Scenario: the link is used after it expired', () => {
    let s: Setup
    let status: number
    let person: Subscriber

    beforeAll(async () => {
      s = await aConfirmingForm()
      const email = 'late@example.test'
      await s.world.post('/f/toolkit', { email })
      await s.world.db
        .update(formConfirmations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
      status = (await s.world.post(await confirmLink(s.world, email), {})).status
      person = await personByEmail(s.world, email)
    })

    it('says the link has expired', () => {
      expect(status).toBe(410)
    })

    it('leaves them pending', () => {
      expect(person.status).toBe('pending')
    })
  })

  describe('Scenario: somebody guesses a link', () => {
    let status: number

    beforeAll(async () => {
      const s = await aConfirmingForm()
      status = (await s.world.post('/f/toolkit/confirm/notarealtokenatall123', {})).status
    })

    it('finds nothing', () => {
      expect(status).toBe(404)
    })
  })
})
