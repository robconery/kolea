// Resend failed form replies: a form reply that
// failed to send can be sent again from the form's screen and over MCP
// (`form_resend_replies`).
// The rules: one resend per
// person, only to people still on the list, never to anyone whose reply has
// since gone, through the same send path and consent check as the first try.
// House rules 1 and 2: nobody gets it twice, and a failed mail always has a
// visible way to be sent.
import { beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { createForm, setFormReply } from '../../src/core/forms.ts'
import { sendPreview } from '../../src/core/sending.ts'
import { devOutbox, type Message, messages, subscribers, suppressions } from '../../src/db/schema.ts'
import { aPerson } from '../support/factories.ts'
import { MCP_SECRET, type ToolReply, agentFor } from '../support/mcp.ts'
import { createWorld, type World } from '../support/world.ts'

const formWorld = (send = true): World => {
  const w = createWorld({ MCP_PATH_SECRET: MCP_SECRET })
  // Agent sending is the on-screen switch (core/agents.ts), a row in D1.
  if (send) {
    const sqlite = (w.env.DB as unknown as { sqlite: import('bun:sqlite').Database }).sqlite
    sqlite.run('insert into agent_settings (id, allow_send, allow_sensitive, updated_at) values (1, 1, 0, ?)', [Date.now()])
  }
  return w
}

/** A form whose reply hands over the toolkit. */
async function aToolkitForm(w: World): Promise<number> {
  const id = await createForm(w.db, { name: 'Toolkit', doubleOptIn: false })
  await setFormReply(w.db, id, { subject: "Here's the toolkit", bodyJson: null, bodyMd: 'Here it is, as promised.' })
  return id
}

/**
 * Somebody submits the form and their reply fails at the provider: the row ends
 * `failed` and nothing reached them. What the queue's dead-letter handler, or a
 * provider refusal, leaves behind.
 */
async function aFailedReply(w: World, email: string): Promise<Message> {
  await w.post('/f/toolkit', { email })
  await w.settle()
  const row = (await w.db
    .select()
    .from(messages)
    .where(and(eq(messages.kind, 'form'), eq(messages.toEmail, email)))
    .get())!
  await w.db
    .update(messages)
    .set({ status: 'failed', error: 'provider said 503', provider: null, providerMessageId: null, sentAt: null })
    .where(eq(messages.id, row.id))
  await w.db.delete(devOutbox).where(eq(devOutbox.toEmail, email))
  return row
}

const mailsTo = async (w: World, email: string) => (await w.outbox()).filter((m) => m.toEmail === email).length
const statusOf = async (w: World, id: number) =>
  (await w.db.select({ s: messages.status }).from(messages).where(eq(messages.id, id)).get())?.s

describe('Feature: sending a failed form reply again', () => {
  describe('Scenario: the operator sees the failure and sends it', () => {
    let w: World
    let formId: number
    let failed: Message
    let page: string
    let res: Response

    beforeAll(async () => {
      w = formWorld()
      formId = await aToolkitForm(w)
      failed = await aFailedReply(w, 'missed@example.test')
      page = await (await w.fetch(`/forms/${formId}`)).text()
      res = await w.post(`/forms/${formId}/resend-replies`, { confirm: 'resend' })
      await w.settle()
    })

    it('shows the person on the form’s screen', () => {
      expect(page).toContain('missed@example.test')
    })

    it('shows why it failed', () => {
      expect(page).toContain('provider said 503')
    })

    it('offers to send it', () => {
      expect(page).toContain('/resend-replies')
    })

    it('delivers the reply', async () => {
      expect(await mailsTo(w, 'missed@example.test')).toBe(1)
    })

    it('is the reply they asked for', async () => {
      const mail = await w.mailTo('missed@example.test')
      expect(mail.subject).toBe("Here's the toolkit")
    })

    it('marks the same row sent rather than making a new one', async () => {
      expect(await statusOf(w, failed.id)).toBe('sent')
    })

    it('says so', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('missed@example.test')
    })
  })

  describe('Scenario: the button is pressed twice', () => {
    let w: World

    beforeAll(async () => {
      w = formWorld()
      const formId = await aToolkitForm(w)
      await aFailedReply(w, 'twice@example.test')
      await w.post(`/forms/${formId}/resend-replies`, { confirm: 'resend' })
      await w.settle()
      await w.post(`/forms/${formId}/resend-replies`, { confirm: 'resend' })
      await w.settle()
    })

    it('⭐ sends it once', async () => {
      expect(await mailsTo(w, 'twice@example.test')).toBe(1)
    })
  })

  describe('Scenario: an agent lists the failures, then sends them', () => {
    let w: World
    let listed: ToolReply
    let mailsAfterListing: number
    let sent: ToolReply

    beforeAll(async () => {
      w = formWorld()
      const formId = await aToolkitForm(w)
      await aFailedReply(w, 'one@example.test')
      await aFailedReply(w, 'two@example.test')
      const agent = await agentFor(w)
      listed = await agent.call('form_resend_replies', { id: formId })
      await w.settle()
      mailsAfterListing = (await w.outbox()).length
      sent = await agent.call('form_resend_replies', {
        id: formId,
        send: true,
        preflight_token: listed.json?.preflight_token,
      })
      await w.settle()
    })

    it('lists who would get it', () => {
      expect(listed.json?.wouldSend).toBe(2)
    })

    it('⭐ sends nothing when only asked to list', () => {
      expect(mailsAfterListing).toBe(0)
    })

    it('says how many it sent', () => {
      expect(sent.json?.queued).toBe(2)
    })

    it('delivers to the first', async () => {
      expect(await mailsTo(w, 'one@example.test')).toBe(1)
    })

    it('delivers to the second', async () => {
      expect(await mailsTo(w, 'two@example.test')).toBe(1)
    })
  })

  // ───────────────────────────────────────────── who is left out

  describe('Scenario: their reply failed one day and went the next', () => {
    let w: World

    beforeAll(async () => {
      w = formWorld()
      const formId = await aToolkitForm(w)
      const failed = await aFailedReply(w, 'resubmitted@example.test')
      // The failure was yesterday; today's submission got through.
      await w.db
        .update(messages)
        .set({ idempotencyKey: failed.idempotencyKey!.replace(/\d{4}-\d{2}-\d{2}$/, '2026-01-01') })
        .where(eq(messages.id, failed.id))
      await w.post('/f/toolkit', { email: 'resubmitted@example.test' })
      await w.settle()
      await w.post(`/forms/${formId}/resend-replies`, { confirm: 'resend' })
      await w.settle()
    })

    it('⭐ is not sent a second copy', async () => {
      expect(await mailsTo(w, 'resubmitted@example.test')).toBe(1)
    })
  })

  describe('Scenario: they left the list after their reply failed', () => {
    let w: World
    let reply: ToolReply

    beforeAll(async () => {
      w = formWorld()
      const formId = await aToolkitForm(w)
      const failed = await aFailedReply(w, 'gone@example.test')
      await w.db.update(subscribers).set({ status: 'unsubscribed' }).where(eq(subscribers.id, failed.subscriberId))
      reply = await (await agentFor(w)).call('form_resend_replies', { id: formId })
      await w.post(`/forms/${formId}/resend-replies`, { confirm: 'resend' })
      await w.settle()
    })

    it('⭐ is not mailed', async () => {
      expect(await mailsTo(w, 'gone@example.test')).toBe(0)
    })

    it('is not counted', () => {
      expect(reply.json?.wouldSend).toBe(0)
    })
  })

  describe('Scenario: their address was suppressed after a complaint', () => {
    let w: World
    let failed: Message

    beforeAll(async () => {
      w = formWorld()
      const formId = await aToolkitForm(w)
      failed = await aFailedReply(w, 'complained@example.test')
      // Suppressed by address, with the subscriber row still `active`: only the
      // send path's own consent check stands between them and the resend.
      await w.db
        .insert(suppressions)
        .values({ email: 'complained@example.test', reason: 'complaint', createdAt: new Date() })
      await w.post(`/forms/${formId}/resend-replies`, { confirm: 'resend' })
      await w.settle()
    })

    it('⭐ consent is checked again, and they are not mailed', async () => {
      expect(await mailsTo(w, 'complained@example.test')).toBe(0)
    })

    it('records why on the row', async () => {
      expect(await statusOf(w, failed.id)).toBe('suppressed')
    })
  })

  describe('Scenario: a test send to the operator failed', () => {
    let reply: ToolReply

    beforeAll(async () => {
      const w = formWorld()
      const formId = await aToolkitForm(w)
      await aPerson(w, { email: 'mara@example.test' })
      const preview = await sendPreview(
        w.env,
        w.db,
        { kind: 'form', formId, subject: 'Test', body: { json: null, md: 'Test' }, hasFile: false },
        'mara@example.test',
      )
      if (preview.ok) {
        await w.db.update(messages).set({ status: 'failed', providerMessageId: null }).where(eq(messages.id, preview.messageId))
      }
      reply = await (await agentFor(w)).call('form_resend_replies', { id: formId })
    })

    it('is not somebody’s missing reply', () => {
      expect(reply.json?.wouldSend).toBe(0)
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: a resend posted without the button', () => {
    let w: World

    beforeAll(async () => {
      w = formWorld()
      const formId = await aToolkitForm(w)
      await aFailedReply(w, 'stray@example.test')
      await w.post(`/forms/${formId}/resend-replies`, {})
      await w.settle()
    })

    it('⭐ sends nothing', async () => {
      expect(await mailsTo(w, 'stray@example.test')).toBe(0)
    })
  })

  describe('Scenario: an agent asks to send without listing first', () => {
    // The same guard as every other MCP send: no preflight token, no mail.
    let w: World
    let reply: ToolReply

    beforeAll(async () => {
      w = formWorld()
      const formId = await aToolkitForm(w)
      await aFailedReply(w, 'blind@example.test')
      reply = await (await agentFor(w)).call('form_resend_replies', { id: formId, send: true })
      await w.settle()
    })

    it('is refused for want of a preflight token', () => {
      expect(reply.text).toContain('no preflight token')
    })

    it('⭐ sends nothing', async () => {
      expect(await mailsTo(w, 'blind@example.test')).toBe(0)
    })
  })

  describe('Scenario: another reply fails between the listing and the send', () => {
    let w: World
    let reply: ToolReply

    beforeAll(async () => {
      w = formWorld()
      const formId = await aToolkitForm(w)
      await aFailedReply(w, 'first@example.test')
      const agent = await agentFor(w)
      const listed = await agent.call('form_resend_replies', { id: formId })
      await aFailedReply(w, 'second@example.test')
      reply = await agent.call('form_resend_replies', {
        id: formId,
        send: true,
        preflight_token: listed.json?.preflight_token,
      })
      await w.settle()
    })

    it('is refused: the set is not the one that was listed', () => {
      expect(reply.isError).toBe(true)
    })

    it('⭐ sends nothing', async () => {
      expect((await w.outbox()).length).toBe(0)
    })
  })

  describe('Scenario: an agent asks to send while MCP sending is switched off', () => {
    let w: World
    let reply: ToolReply

    beforeAll(async () => {
      w = formWorld(false)
      const formId = await aToolkitForm(w)
      await aFailedReply(w, 'held@example.test')
      reply = await (await agentFor(w)).call('form_resend_replies', { id: formId, send: true })
      await w.settle()
    })

    it('is refused', () => {
      expect(reply.isError).toBe(true)
    })

    it('⭐ sends nothing', async () => {
      expect(await mailsTo(w, 'held@example.test')).toBe(0)
    })
  })
})
