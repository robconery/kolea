// Running a launch in Launch Studio
//
// AI: Launch Studio. The rules: seven steps from describing the offer to
// reviewing how it went, every step reading from the brief; the launch's
// sequence is made PAUSED from a launch template (nothing here sends anything
// itself or takes a sequence live: sequences are made paused, and going live
// is the sequence's own Go live); AI is a helper beside the writer's words,
// budgeted and recorded, never the sender.
//
// Decisions: the launch makes a campaign (the unit of attribution) and its
// review reads that campaign's existing sales, conversions and the sequence's
// step analytics, rather than owning a sales page and a checkout of its own.
//
// ⚠️ The only fake is the model (`AI_PROVIDER=fake`). Mail goes to the console
// provider; the spec proves none was written.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { type LaunchState, transition } from '../../src/core/launches/index.ts'
import { restoreStarterTemplates } from '../../src/core/sequence-templates/index.ts'
import {
  type Launch,
  aiCalls,
  campaigns,
  launches,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  tags,
} from '../../src/db/schema.ts'
import { aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const BRIEF = {
  name: 'Postgres for Busy People',
  offer: 'A six-week course on how Postgres plans and runs a query, for developers who use it every day.',
  priceNote: '$149',
  audience: 'Application developers who never learned what the database is doing.',
  problem: 'Their queries get slow and they do not know why.',
  promise: 'Read a query plan and fix the slow query yourself.',
  story: 'I spent a decade being the person who got paged at three in the morning.',
  objections: 'They think it will be too academic.',
}

const location = (r: Response) => r.headers.get('location') ?? ''

async function launchRow(w: World, id: number): Promise<Launch> {
  return (await w.db.select().from(launches).where(eq(launches.id, id)).get())!
}

describe('Feature: running a launch in Launch Studio', () => {
  describe('Scenario: the operator walks a launch through all seven steps', () => {
    let w: World
    let l: Launch
    const res: Record<string, Response> = {}
    let outlineHtml = ''
    let reviewHtml = ''

    beforeAll(async () => {
      w = createWorld({ AI_PROVIDER: 'fake' })
      // People on the list who must hear nothing from any of this.
      await aPerson(w, { email: 'ana@example.test' })
      await aPerson(w, { email: 'ben@example.test' })
      await restoreStarterTemplates(w.db)

      res.offer = await w.post('/launches', BRIEF)
      res.plan = await w.post('/launches/1/plan', { templateSlug: 'product-launch-formula', startsOn: '2026-12-01' })
      res.campaign = await w.post('/launches/1/campaign', { goal: '5000' })
      res.sequence = await w.post('/launches/1/sequence', { draft: '1' })
      res.outline = await w.post('/launches/1/outline', {})
      outlineHtml = await res.outline.text()
      res.copy = await w.post('/launches/1/copy', { outline: '- The planner is not magic\n- One slow query, fixed live' })
      res.handoff = await w.post('/launches/1/handoff', {})
      res.review = await w.fetch('/launches/1/review')
      reviewHtml = await res.review.text()
      res.close = await w.post('/launches/1/close', {})
      await w.settle()
      l = await launchRow(w, 1)
    })

    it('step 1 saves the brief and moves on to the plan', () => {
      expect(location(res.offer!)).toStartWith('/launches/1/plan')
    })

    it('step 2 takes the launch template and moves on to the campaign', () => {
      expect(location(res.plan!)).toStartWith('/launches/1/campaign')
    })

    it('step 3 opens a campaign and moves on to the sequence', () => {
      expect(location(res.campaign!)).toStartWith('/launches/1/sequence')
    })

    it('step 4 builds the sequence and moves on to the copy', () => {
      expect(location(res.sequence!)).toStartWith('/launches/1/copy')
    })

    it('the AI outline comes back in the copy box for the operator to edit', () => {
      expect(outlineHtml).toContain('A fake answer from a fake model.')
    })

    it('step 5 saves the angle and moves on to the hand-off', () => {
      expect(location(res.copy!)).toStartWith('/launches/1/handoff')
    })

    it('step 6 hands off and moves on to the review', () => {
      expect(location(res.handoff!)).toStartWith('/launches/1/review')
    })

    it('step 7 shows the review', () => {
      expect(reviewHtml).toContain('Net revenue')
    })

    it('the launch ends closed, on the review step', () => {
      expect([l.status, l.step]).toEqual(['closed', 'review'])
    })

    it('the campaign is named for the launch, with its goal', async () => {
      const cp = await w.db.select().from(campaigns).where(eq(campaigns.id, l.campaignId!)).get()
      expect([cp?.name, cp?.goalCents]).toEqual([BRIEF.name, 500_000])
    })

    it('⭐ the sequence exists and is paused', async () => {
      const s = await w.db.select().from(sequences).where(eq(sequences.id, l.sequenceId!)).get()
      expect(s?.isActive).toBe(false)
    })

    it('the sequence counts toward the launch’s campaign', async () => {
      const s = await w.db.select().from(sequences).where(eq(sequences.id, l.sequenceId!)).get()
      expect(s?.campaignId).toBe(l.campaignId)
    })

    it('the sequence has every mail of the template', async () => {
      const steps = await w.db.select().from(sequenceSteps).where(eq(sequenceSteps.sequenceId, l.sequenceId!)).all()
      expect(steps.length).toBe(7)
    })

    it('the sequence starts on the launch’s own tag', async () => {
      const t = await w.db.select().from(tags).where(eq(tags.id, l.triggerTagId!)).get()
      expect(t?.name).toBe('launch-postgres-for-busy-people')
    })

    it('the drafted mails still carry placeholders, so the sequence cannot go live unrewritten', async () => {
      const steps = await w.db.select().from(sequenceSteps).where(eq(sequenceSteps.sequenceId, l.sequenceId!)).all()
      expect(steps.every((s) => s.bodyMd.includes('[['))).toBe(true)
    })

    it('the outline helper was recorded under the launch task', async () => {
      const rows = await w.db.select().from(aiCalls).where(eq(aiCalls.task, 'launch')).all()
      expect(rows.length).toBe(1)
    })

    it('the sequence draft was recorded too', async () => {
      const rows = await w.db.select().from(aiCalls).where(eq(aiCalls.task, 'sequence-plan')).all()
      expect(rows.length).toBe(1)
    })

    it('⭐ nobody is enrolled in the sequence', async () => {
      const rows = await w.db.select().from(sequenceEnrollments).all()
      expect(rows.length).toBe(0)
    })

    it('⭐ the outbox stays empty', async () => {
      expect((await w.outbox()).length).toBe(0)
    })
  })

  describe('Scenario: the operator builds the sequence without AI', () => {
    let w: World
    let built: Response
    let again: Response

    beforeAll(async () => {
      w = createWorld()
      await restoreStarterTemplates(w.db)
      await w.post('/launches', { name: 'Winter sale', offer: 'Everything half price for five days.' })
      await w.post('/launches/1/plan', { templateSlug: 'big-sale' })
      await w.post('/launches/1/campaign', {})
      built = await w.post('/launches/1/sequence', {})
      again = await w.post('/launches/1/sequence', {})
    })

    it('builds it and moves on to the copy', () => {
      expect(location(built)).toStartWith('/launches/1/copy')
    })

    it('a second build is refused', () => {
      expect(decodeURIComponent(location(again))).toContain('already has its sequence')
    })

    it('there is still exactly one sequence', async () => {
      expect((await w.db.select().from(sequences).all()).length).toBe(1)
    })

    it('a manual template needs no trigger tag', async () => {
      expect((await launchRow(w, 1)).triggerTagId).toBeNull()
    })

    it('makes no AI call', async () => {
      expect((await w.db.select().from(aiCalls).all()).length).toBe(0)
    })
  })

  describe('Scenario: the operator tries to skip ahead', () => {
    let w: World
    let peek: Response
    let build: Response

    beforeAll(async () => {
      w = createWorld()
      await restoreStarterTemplates(w.db)
      await w.post('/launches', { name: 'Skipper', offer: 'A thing to sell.' })
      peek = await w.fetch('/launches/1/sequence')
      build = await w.post('/launches/1/sequence', {})
    })

    it('a screen ahead of the plan sends them back to the plan', () => {
      expect(location(peek)).toStartWith('/launches/1/plan')
    })

    it('building a sequence before the campaign is refused', () => {
      expect(decodeURIComponent(location(build))).toContain('Choose a launch template first.')
    })

    it('no sequence was made', async () => {
      expect((await w.db.select().from(sequences).all()).length).toBe(0)
    })

    it('no campaign was made', async () => {
      expect((await w.db.select().from(campaigns).all()).length).toBe(0)
    })
  })

  describe('Scenario: a brief without the offer is refused', () => {
    let w: World
    let r: Response

    beforeAll(async () => {
      w = createWorld()
      r = await w.post('/launches', { name: 'Nameless thing', offer: '  ' })
    })

    it('says what is missing', () => {
      expect(decodeURIComponent(location(r))).toContain('Say what you are selling')
    })

    it('makes no launch', async () => {
      expect((await w.db.select().from(launches).all()).length).toBe(0)
    })
  })

  describe('Scenario: the rules in the transition function', () => {
    const base: LaunchState = {
      step: 'copy',
      status: 'draft',
      offer: 'x',
      templateSlug: 'big-sale',
      campaignId: 1,
      sequenceId: 2,
    }

    it('a closed launch refuses every change', () => {
      expect(transition({ ...base, status: 'closed' }, { kind: 'copy' }).ok).toBe(false)
    })

    it('the template cannot change once the sequence is built', () => {
      expect(transition(base, { kind: 'plan', templateSlug: 'product-launch-formula' }).ok).toBe(false)
    })

    it('the campaign cannot change once the sequence is built', () => {
      expect(transition(base, { kind: 'campaign', campaignId: 9 }).ok).toBe(false)
    })

    it('the review is shut until the launch is handed off', () => {
      expect(transition(base, { kind: 'close' }).ok).toBe(false)
    })

    it('handing off marks it handed off and opens the review', () => {
      expect(transition(base, { kind: 'handoff' })).toEqual({ ok: true, step: 'review', status: 'handed_off' })
    })

    it('revisiting an earlier step never moves the launch backwards', () => {
      expect(transition(base, { kind: 'describe', name: 'A', offer: 'b' })).toEqual({
        ok: true,
        step: 'copy',
        status: 'draft',
      })
    })
  })
})
