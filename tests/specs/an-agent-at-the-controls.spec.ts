// MCP tools that wrap code the app already had: broadcast_resume (behind
// broadcast_resume_preflight, like broadcast_send), broadcast_revise,
// sequence_exit_set / _remove, sequence_template_*, theme_list / _activate,
// post_update, sale_get, subscriber_unsubscribe, health.
// The rules: resume mails nobody twice, revise never sends, an exit is not an
// opt-out, templates make paused sequences, unsubscribe is broadcast-scoped.
//
// Every Scenario here goes through `ALL /mcp/:secret` on `worker.fetch`, with a
// real admin key — the same three gates an agent meets in production.
import { beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { publishPost } from '../../src/core/posts.ts'
import { recordSale } from '../../src/core/sales.ts'
import { enroll } from '../../src/core/sequences.ts'
import {
  broadcasts,
  devOutbox,
  messages,
  sequenceEnrollments,
  sequenceExits,
  sequences,
  sequenceSteps,
  subscribers,
  suppressions,
} from '../../src/db/schema.ts'
import { aBroadcast, aPerson, aSequence, aTag } from '../support/factories.ts'
import { type Agent, MCP_SECRET, type ToolReply, agentFor } from '../support/mcp.ts'
import { createWorld, type World } from '../support/world.ts'

const agentWorld = (send = true): World => {
  const w = createWorld({ MCP_PATH_SECRET: MCP_SECRET })
  // Agent sending is the on-screen switch (core/agents.ts), a row in D1.
  if (send) {
    const sqlite = (w.env.DB as unknown as { sqlite: import('bun:sqlite').Database }).sqlite
    sqlite.run('insert into agent_settings (id, allow_send, allow_sensitive, updated_at) values (1, 1, 0, ?)', [Date.now()])
  }
  return w
}

const statusOf = async (w: World, id: number) =>
  (await w.db.select({ s: broadcasts.status }).from(broadcasts).where(eq(broadcasts.id, id)).get())?.s

const mailsTo = async (w: World, email: string) => (await w.outbox()).filter((m) => m.toEmail === email).length

/** A send cancelled partway: one person has it, one row the provider never took. */
async function aHalfSentBroadcast(w: World): Promise<number> {
  await aPerson(w, { email: 'already@example.test' })
  await aPerson(w, { email: 'stranded@example.test' })
  const id = await aBroadcast(w, { subject: 'Resumable' })
  await startBroadcast(w.env, w.db, id)
  const stranded = await w.db.select().from(messages).where(eq(messages.toEmail, 'stranded@example.test')).get()
  await w.db
    .update(messages)
    .set({ status: 'failed', error: 'broadcast cancelled', providerMessageId: null, providerCalledAt: null })
    .where(eq(messages.id, stranded!.id))
  await w.db.delete(devOutbox).where(eq(devOutbox.toEmail, 'stranded@example.test'))
  await w.db.update(broadcasts).set({ status: 'cancelled' }).where(eq(broadcasts.id, id))
  return id
}

describe('Feature: an agent at the controls', () => {
  // ───────────────────────────────────────────── broadcasts

  describe('Scenario: an agent resumes a send that was cancelled partway', () => {
    let w: World
    let id: number
    let reply: ToolReply

    beforeAll(async () => {
      w = agentWorld()
      id = await aHalfSentBroadcast(w)
      await aPerson(w, { email: 'later@example.test' })
      const agent = await agentFor(w)
      const preflight = await agent.call('broadcast_resume_preflight', { id })
      reply = await agent.call('broadcast_resume', { id, preflight_token: preflight.json?.preflight_token })
      await w.settle()
      await w.tick()
    })

    it('says it resumed', () => {
      expect(reply.json?.resumed).toBe(true)
    })

    it('⭐ does not mail anyone who already had it', async () => {
      expect(await mailsTo(w, 'already@example.test')).toBe(1)
    })

    it('mails the one the provider never took', async () => {
      expect(await mailsTo(w, 'stranded@example.test')).toBe(1)
    })

    it('⭐ does not mail someone who joined after the send started (SPEC 3.5)', async () => {
      expect(await mailsTo(w, 'later@example.test')).toBe(0)
    })

    it('finishes as sent', async () => {
      expect(await statusOf(w, id)).toBe('sent')
    })
  })

  describe('Scenario: an agent revises a broadcast that already went out', () => {
    let w: World
    let id: number
    let reply: ToolReply
    let mailsBefore: number

    beforeAll(async () => {
      w = agentWorld()
      await aPerson(w)
      await aPerson(w)
      id = await aBroadcast(w, { subject: 'Typo in here' })
      await startBroadcast(w.env, w.db, id)
      await w.tick()
      mailsBefore = (await w.outbox()).length
      reply = await (await agentFor(w)).call('broadcast_revise', {
        id,
        subject: 'No typo in here',
        body_markdown: 'The corrected body.',
      })
      await w.settle()
      await w.tick()
    })

    it('saves the correction', async () => {
      const b = await w.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
      expect(b?.subject).toBe('No typo in here')
    })

    it('keeps the copy as it was mailed', async () => {
      const b = await w.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
      expect(b?.originalSubject).toBe('Typo in here')
    })

    it('⭐ mails nobody', async () => {
      expect((await w.outbox()).length).toBe(mailsBefore)
    })

    it('says nothing was sent', () => {
      expect(reply.json?.sent).toBe(0)
    })
  })

  // ───────────────────────────────────────────── sequences

  describe('Scenario: an agent adds an exit to a sequence, then takes it away', () => {
    let w: World
    let afterSet: ToolReply
    let afterRemove: ToolReply
    let exitRows: number

    beforeAll(async () => {
      w = agentWorld()
      const pitch = await aSequence(w, { name: 'The pitch' })
      const onboarding = await aSequence(w, { name: 'Onboarding' })
      const buyer = await aTag(w, 'buyer')
      const agent = await agentFor(w)
      afterSet = await agent.call('sequence_exit_set', {
        id: pitch.id,
        tag_id: buyer,
        then_sequence_id: onboarding.id,
      })
      exitRows = (await w.db.select().from(sequenceExits).where(eq(sequenceExits.sequenceId, pitch.id)).all()).length
      afterRemove = await agent.call('sequence_exit_remove', { id: pitch.id, tag_id: buyer })
    })

    it('records the exit', () => {
      expect(exitRows).toBe(1)
    })

    it('shows where it leads', () => {
      expect(afterSet.json?.flow?.exits?.[0]?.then?.name).toBe('Onboarding')
    })

    it('takes it away again', () => {
      expect(afterRemove.json?.flow?.exits).toEqual([])
    })
  })

  describe('Scenario: an agent builds a sequence from a template', () => {
    let w: World
    let created: ToolReply
    let used: ToolReply
    let sequenceId: number

    beforeAll(async () => {
      w = agentWorld()
      // Somebody on the list, so a sequence that went live by accident would have someone to mail.
      await aPerson(w, { email: 'reader@example.test' })
      const agent = await agentFor(w)
      created = await agent.call('sequence_template_create', {
        name: 'Three day welcome',
        suggested_trigger: 'subscribe',
        steps: [
          { delay_days: 0, label: 'Hello', subject: 'Welcome, [[ name ]]', body_md: '[[ Say hello ]]' },
          { delay_days: 2, label: 'Best of', subject: 'The best of it', body_md: '[[ Three links ]]' },
        ],
      })
      used = await agent.call('sequence_template_use', { slug: created.json?.slug })
      sequenceId = used.json?.id
      await enroll(w.db, sequenceId, (await w.db.select().from(subscribers).get())!.id)
      await w.tick()
    })

    it('stores the template under a slug from its name', () => {
      expect(created.json?.slug).toBe('three-day-welcome')
    })

    it('lists the placeholders still to rewrite', () => {
      expect(created.json?.steps?.[0]?.placeholders).toEqual(['name', 'Say hello'])
    })

    it('copies every mail into the new sequence', async () => {
      const steps = await w.db.select().from(sequenceSteps).where(eq(sequenceSteps.sequenceId, sequenceId)).all()
      expect(steps).toHaveLength(2)
    })

    it('⭐ leaves the new sequence paused', async () => {
      const s = await w.db.select().from(sequences).where(eq(sequences.id, sequenceId)).get()
      expect(s?.isActive).toBe(false)
    })

    it('⭐ enrolls nobody and mails nobody', async () => {
      expect(await w.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: an agent edits, lists and deletes a template', () => {
    let list: ToolReply
    let afterUpdate: ToolReply
    let afterDelete: ToolReply

    beforeAll(async () => {
      const w = agentWorld()
      const agent = await agentFor(w)
      await agent.call('sequence_template_create', { name: 'Draft shape', steps: [{ delay_days: 0 }] })
      afterUpdate = await agent.call('sequence_template_update', {
        slug: 'draft-shape',
        name: 'Renamed shape',
        steps: [{ delay_days: 0 }, { delay_days: 3 }],
      })
      list = await agent.call('sequence_template_list')
      await agent.call('sequence_template_delete', { slug: 'draft-shape' })
      afterDelete = await agent.call('sequence_template_get', { slug: 'draft-shape' })
    })

    it('replaces the template whole', () => {
      expect(afterUpdate.json?.mails).toBe(2)
    })

    it('keeps the slug when the name changes', () => {
      expect(afterUpdate.json?.slug).toBe('draft-shape')
    })

    it('lists it with its span in days', () => {
      expect(list.json?.templates?.find((t: { slug: string }) => t.slug === 'draft-shape')?.spanDays).toBe(3)
    })

    it('deletes it', () => {
      expect(afterDelete.isError).toBe(true)
    })
  })

  // ───────────────────────────────────────────── the site

  describe('Scenario: an agent switches the site’s theme', () => {
    let before: ToolReply
    let switched: ToolReply

    beforeAll(async () => {
      const w = agentWorld()
      const agent = await agentFor(w)
      before = await agent.call('theme_list')
      const night = before.json.find((t: { name: string }) => t.name === 'nightdrive')
      switched = await agent.call('theme_activate', { id: night.id })
    })

    it('shows the default theme live before anything is switched on', () => {
      expect(before.json.find((t: { live: boolean }) => t.live)?.name).toBe('folio')
    })

    it('makes the chosen theme live', () => {
      expect(switched.json?.live).toBe('nightdrive')
    })

    it('leaves exactly one theme live', () => {
      expect(switched.json?.themes.filter((t: { live: boolean }) => t.live)).toHaveLength(1)
    })
  })

  describe('Scenario: an agent changes a live post’s card and topics', () => {
    let reply: ToolReply
    let w: World
    let id: number

    beforeAll(async () => {
      w = agentWorld()
      id = await aBroadcast(w, { subject: 'On plovers' })
      await publishPost(w.db, id)
      reply = await (await agentFor(w)).call('post_update', {
        broadcastId: id,
        slug: 'golden-plovers',
        excerpt: 'Three thousand miles, nonstop.',
        tags: ['Birds'],
      })
    })

    it('changes the slug', () => {
      expect(reply.json?.slug).toBe('golden-plovers')
    })

    it('puts it under its new primary topic', () => {
      expect(reply.json?.url).toEndWith('/birds/golden-plovers')
    })

    it('leaves it published', async () => {
      const b = await w.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
      expect(b?.publishedAt).not.toBeNull()
    })
  })

  describe('Scenario: an agent edits a post that is not up yet', () => {
    let w: World
    let id: number

    beforeAll(async () => {
      w = agentWorld()
      id = await aBroadcast(w, { subject: 'Not yet' })
      await (await agentFor(w)).call('post_update', { broadcastId: id, excerpt: 'Soon.' })
    })

    it('⭐ does not publish it', async () => {
      const b = await w.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
      expect(b?.publishedAt).toBeNull()
    })
  })

  // ───────────────────────────────────────────── money, people, health

  describe('Scenario: an agent looks up one sale', () => {
    let reply: ToolReply

    beforeAll(async () => {
      const w = agentWorld()
      const r = await recordSale(w.db, { email: 'buyer@example.test', amountCents: 4100, externalId: 'ord_1' })
      reply = await (await agentFor(w)).call('sale_get', { id: r.saleId })
    })

    it('shows who bought', () => {
      expect(reply.json?.email).toBe('buyer@example.test')
    })

    it('shows the amount readably', () => {
      expect(reply.json?.amount).toBe('USD 41.00')
    })

    it('keeps the amount in integer cents too', () => {
      expect(reply.json?.amountCents).toBe(4100)
    })
  })

  describe('Scenario: a reader asks by email to stop the newsletter, and an agent records it', () => {
    let w: World
    let personId: number
    let sequenceId: number
    let reply: ToolReply

    beforeAll(async () => {
      w = agentWorld()
      const p = await aPerson(w, { email: 'leaving@example.test' })
      personId = p.id
      sequenceId = (await aSequence(w, { name: 'Course' })).id
      await enroll(w.db, sequenceId, p.id)
      reply = await (await agentFor(w)).call('subscriber_unsubscribe', { email: 'leaving@example.test' })
    })

    it('takes them off the newsletter', async () => {
      const s = await w.db.select().from(subscribers).where(eq(subscribers.id, personId)).get()
      expect(s?.status).toBe('unsubscribed')
    })

    it('⭐ writes no suppression', async () => {
      expect(await w.db.select().from(suppressions).all()).toHaveLength(0)
    })

    it('⭐ leaves their sequence running', async () => {
      const e = await w.db
        .select()
        .from(sequenceEnrollments)
        .where(and(eq(sequenceEnrollments.subscriberId, personId), eq(sequenceEnrollments.sequenceId, sequenceId)))
        .get()
      expect(e?.status).toBe('active')
    })

    it('says what changed', () => {
      expect(reply.json?.outcome).toBe('unsubscribed')
    })
  })

  describe('Scenario: an agent asks whether mail is moving', () => {
    let reply: ToolReply

    beforeAll(async () => {
      const w = agentWorld()
      await aPerson(w)
      await aPerson(w)
      const id = await aBroadcast(w)
      await startBroadcast(w.env, w.db, id)
      const one = await w.db.select().from(messages).get()
      await w.db.update(messages).set({ status: 'failed', error: 'provider said no' }).where(eq(messages.id, one!.id))
      reply = await (await agentFor(w)).call('health')
    })

    it('reaches the database', () => {
      expect(reply.json?.d1Reachable).toBe(true)
    })

    it('names the provider', () => {
      expect(reply.json?.provider?.name).toBe('console')
    })

    it('says the console provider does not send for real', () => {
      expect(reply.json?.provider?.live).toBe(false)
    })

    it('says whether the queue is bound', () => {
      expect(reply.json?.queueBound).toBe(false)
    })

    it('counts failed mail', () => {
      expect(reply.json?.failed).toBe(1)
    })

    it('says when mail last went out', () => {
      expect(reply.json?.lastSentAt).not.toBeNull()
    })

    it('names the failure as a problem', () => {
      expect(reply.json?.problems?.join(' ')).toContain('1 message(s) failed')
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: an agent tries to resume while MCP sending is switched off', () => {
    let w: World
    let id: number
    let reply: ToolReply

    beforeAll(async () => {
      w = agentWorld(false)
      id = await aHalfSentBroadcast(w)
      reply = await (await agentFor(w)).call('broadcast_resume', { id, preflight_token: 'x' })
      await w.settle()
    })

    it('is refused by the send switch', () => {
      expect(reply.text).toContain('switched off')
    })

    it('⭐ sends nothing', async () => {
      expect(await mailsTo(w, 'stranded@example.test')).toBe(0)
    })

    it('stays cancelled', async () => {
      expect(await statusOf(w, id)).toBe('cancelled')
    })
  })

  describe('Scenario: an agent tries to resume without a preflight', () => {
    // The same guard as broadcast_send: a confirm string is not a look.
    let w: World
    let id: number
    let reply: ToolReply

    beforeAll(async () => {
      w = agentWorld()
      id = await aHalfSentBroadcast(w)
      reply = await (await agentFor(w)).call('broadcast_resume', { id, preflight_token: 'made-up' })
      await w.settle()
    })

    it('is refused for want of a preflight', () => {
      expect(reply.text).toContain('broadcast_resume_preflight')
    })

    it('⭐ sends nothing', async () => {
      expect(await mailsTo(w, 'stranded@example.test')).toBe(0)
    })
  })

  describe('Scenario: an agent revises the broadcast after its resume preflight', () => {
    let w: World
    let reply: ToolReply

    beforeAll(async () => {
      w = agentWorld()
      const id = await aHalfSentBroadcast(w)
      const agent = await agentFor(w)
      const preflight = await agent.call('broadcast_resume_preflight', { id })
      await agent.call('broadcast_revise', { id, subject: 'Resumable, corrected' })
      reply = await agent.call('broadcast_resume', { id, preflight_token: preflight.json?.preflight_token })
      await w.settle()
    })

    it('is refused: what was previewed is not what would go', () => {
      expect(reply.text).toContain('content changed')
    })

    it('⭐ sends nothing', async () => {
      expect(await mailsTo(w, 'stranded@example.test')).toBe(0)
    })
  })

  describe('Scenario: an agent tries to resume a send everyone already has', () => {
    let w: World
    let reply: ToolReply
    let mailsBefore: number

    beforeAll(async () => {
      w = agentWorld()
      await aPerson(w)
      const id = await aBroadcast(w)
      await startBroadcast(w.env, w.db, id)
      await w.db.update(broadcasts).set({ status: 'cancelled' }).where(eq(broadcasts.id, id))
      mailsBefore = (await w.outbox()).length
      reply = await (await agentFor(w)).call('broadcast_resume_preflight', { id })
      await w.settle()
    })

    it('is refused', () => {
      expect(reply.text).toContain('already has it')
    })

    it('⭐ sends nothing', async () => {
      expect((await w.outbox()).length).toBe(mailsBefore)
    })
  })

  describe('Scenario: an agent tries to revise a draft', () => {
    let reply: ToolReply

    beforeAll(async () => {
      const w = agentWorld()
      const id = await aBroadcast(w)
      reply = await (await agentFor(w)).call('broadcast_revise', { id, subject: 'Nope' })
    })

    it('is pointed at broadcast_update instead', () => {
      expect(reply.text).toContain('broadcast_update')
    })
  })

  describe('Scenario: an agent tries to make a sequence’s trigger tag its exit too', () => {
    let reply: ToolReply

    beforeAll(async () => {
      const w = agentWorld()
      const vip = await aTag(w, 'vip')
      const s = await aSequence(w, { trigger: 'tag_added', triggerTagId: vip })
      reply = await (await agentFor(w)).call('sequence_exit_set', { id: s.id, tag_id: vip })
    })

    it('is refused, because nobody could ever enter it', () => {
      expect(reply.text).toContain('cannot also end it')
    })
  })

  describe('Scenario: an agent uses a template for a tag sequence without naming the tag', () => {
    let w: World
    let reply: ToolReply

    beforeAll(async () => {
      w = agentWorld()
      const agent = await agentFor(w)
      await agent.call('sequence_template_create', { name: 'Tagged', steps: [{ delay_days: 0 }] })
      reply = await agent.call('sequence_template_use', { slug: 'tagged', trigger: 'tag_added' })
    })

    it('is refused', () => {
      expect(reply.text).toContain('needs a trigger tag')
    })

    it('makes no sequence', async () => {
      expect(await w.db.select().from(sequences).all()).toHaveLength(0)
    })
  })

  describe('Scenario: an agent activates a theme that does not exist', () => {
    let reply: ToolReply
    let liveAfter: string | undefined

    beforeAll(async () => {
      const w = agentWorld()
      const agent = await agentFor(w)
      const list = await agent.call('theme_list')
      const night = list.json.find((t: { name: string }) => t.name === 'nightdrive')
      await agent.call('theme_activate', { id: night.id })
      reply = await agent.call('theme_activate', { id: 9999 })
      liveAfter = (await agent.call('theme_list')).json.find((t: { live: boolean }) => t.live)?.name
    })

    it('is refused', () => {
      expect(reply.isError).toBe(true)
    })

    it('leaves the live theme alone', () => {
      expect(liveAfter).toBe('nightdrive')
    })
  })

  describe('Scenario: an agent unsubscribes somebody whose address bounced', () => {
    let w: World
    let personId: number
    let reply: ToolReply

    beforeAll(async () => {
      w = agentWorld()
      const p = await aPerson(w)
      personId = p.id
      await w.db.update(subscribers).set({ status: 'bounced' }).where(eq(subscribers.id, p.id))
      reply = await (await agentFor(w)).call('subscriber_unsubscribe', { id: p.id })
    })

    it('leaves the bounce on record', async () => {
      const s = await w.db.select().from(subscribers).where(eq(subscribers.id, personId)).get()
      expect(s?.status).toBe('bounced')
    })

    it('says nothing changed', () => {
      expect(reply.json?.outcome).toBe('unchanged')
    })
  })
})
