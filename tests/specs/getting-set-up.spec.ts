// Getting set up: the first-run checklist
// In-app onboarding
// First-run onboarding: a visible, resumable checklist; a derived state for
// each step; onboarding never sends mail. Facts win over decisions; only the
// site can be declined; a "later" keeps the step offered. The welcome sequence
// is a starter template, made paused. The From name and address stay
// environment variables; the step shows them and says how to change them.
//
// Driven through `worker.fetch` for the dashboard, the page and every action.
// ⭐ The outbox is read at the end of the completion scenario: making the
// welcome and the first broadcast, then a person joining and the tick running,
// must put nothing in it.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { checklist, type Facts } from '../../src/core/onboarding.ts'
import { createForm } from '../../src/core/forms.ts'
import { saveSiteSettings } from '../../src/core/site-settings.ts'
import { broadcasts, onboardingSteps, sendingDomains, sequenceEnrollments, sequences } from '../../src/db/schema.ts'
import { aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

/** The state the checklist shows for a step, read off the rendered row. */
function stateOf(html: string, step: string): string | undefined {
  return html.match(new RegExp(`data-step="${step}" data-state="([a-z]+)"`))?.[1]
}

async function page(w: World, path = '/onboarding'): Promise<string> {
  return await (await w.fetch(path)).text()
}

async function aDomain(w: World, name: string, status: 'pending' | 'verified' | 'failed') {
  const now = new Date()
  await w.db.insert(sendingDomains).values({ name, status, provider: 'console', createdAt: now, updatedAt: now })
}

describe('Feature: getting set up', () => {
  describe('Scenario: a fresh install opens the dashboard', () => {
    let dashboard: string

    beforeAll(async () => {
      const w = createWorld()
      dashboard = await page(w, '/')
    })

    it('shows the checklist', () => {
      expect(dashboard).toContain('id="onboarding"')
    })

    it('ticks the sender, which the environment already sets', () => {
      expect(stateOf(dashboard, 'sender')).toBe('done')
    })

    it('leaves the domain to do', () => {
      expect(stateOf(dashboard, 'domain')).toBe('todo')
    })

    it('leaves the site to do', () => {
      expect(stateOf(dashboard, 'site')).toBe('todo')
    })

    it('leaves the audience to do', () => {
      expect(stateOf(dashboard, 'audience')).toBe('todo')
    })

    it('leaves the welcome sequence to do', () => {
      expect(stateOf(dashboard, 'welcome')).toBe('todo')
    })

    it('leaves the first broadcast to do', () => {
      expect(stateOf(dashboard, 'broadcast')).toBe('todo')
    })

    it('links the domain step to the screen that owns it', () => {
      expect(dashboard).toContain('href="/domains"')
    })
  })

  describe('Scenario: the operator works through every step', () => {
    let w: World
    let html: string
    let dashboard: string
    let welcomeRes: Response
    let broadcastRes: Response

    beforeAll(async () => {
      w = createWorld()
      await aDomain(w, 'news.example.test', 'verified')
      await saveSiteSettings(w.db, { title: 'Field Notes' })
      await createForm(w.db, { name: 'Newsletter' })
      welcomeRes = await w.post('/onboarding/welcome', { template: 'newsletter-welcome' })
      broadcastRes = await w.post('/onboarding/broadcast', { subject: 'Hello, and what to expect' })
      // Somebody joins and the minutely tick runs: a paused welcome must not catch them.
      await aPerson(w, { email: 'reader@example.test' })
      await w.tick()
      html = await page(w)
      dashboard = await page(w, '/')
    })

    it('ticks the domain once it verifies', () => {
      expect(stateOf(html, 'domain')).toBe('done')
    })

    it('ticks the site once it has a title', () => {
      expect(stateOf(html, 'site')).toBe('done')
    })

    it('ticks the audience by its form', () => {
      expect(html).toContain('by a form')
    })

    it('ticks the welcome sequence', () => {
      expect(stateOf(html, 'welcome')).toBe('done')
    })

    it('ticks the first broadcast', () => {
      expect(stateOf(html, 'broadcast')).toBe('done')
    })

    it('lands the operator on the new sequence', () => {
      expect(welcomeRes.headers.get('location')).toMatch(/^\/sequences\/\d+/)
    })

    it('lands the operator in the composer', () => {
      expect(broadcastRes.headers.get('location')).toMatch(/^\/broadcasts\/\d+/)
    })

    it('⭐ makes the welcome sequence paused', async () => {
      const seq = await w.db.select().from(sequences).get()
      expect(seq?.isActive).toBe(false)
    })

    it('makes the welcome start on subscribe', async () => {
      const seq = await w.db.select().from(sequences).get()
      expect(seq?.trigger).toBe('subscribe')
    })

    it('⭐ enrolls nobody who joins while it is paused', async () => {
      expect(await w.db.select().from(sequenceEnrollments).all()).toHaveLength(0)
    })

    it('⭐ leaves the first broadcast a draft', async () => {
      const b = await w.db.select().from(broadcasts).get()
      expect(b?.status).toBe('draft')
    })

    it('⭐ schedules nothing', async () => {
      const b = await w.db.select().from(broadcasts).get()
      expect(b?.scheduledAt ?? null).toBeNull()
    })

    it('⭐ sends no mail', async () => {
      expect(await w.outbox()).toHaveLength(0)
    })

    it('stops offering the checklist on the dashboard', () => {
      expect(dashboard).not.toContain('id="onboarding"')
    })
  })

  describe('Scenario: the operator dismisses the checklist', () => {
    let w: World
    let dashboard: string
    let onboardingPage: string
    let restored: string

    beforeAll(async () => {
      w = createWorld()
      await w.post('/onboarding/dismiss', { from: '/' })
      dashboard = await page(w, '/')
      onboardingPage = await page(w)
      await w.post('/onboarding/show', {})
      restored = await page(w, '/')
    })

    it('hides it from the dashboard', () => {
      expect(dashboard).not.toContain('id="onboarding"')
    })

    it('keeps it at /onboarding', () => {
      expect(onboardingPage).toContain('id="onboarding"')
    })

    it('can bring it back', () => {
      expect(restored).toContain('id="onboarding"')
    })
  })

  describe('Scenario: the operator puts a step off for later', () => {
    let w: World
    let skipped: string
    let afterDomain: string

    beforeAll(async () => {
      w = createWorld()
      await w.post('/onboarding/domain/skip', { from: '/' })
      skipped = await page(w, '/')
      await aDomain(w, 'news.example.test', 'pending')
      afterDomain = await page(w)
    })

    it('shows the step as later', () => {
      expect(stateOf(skipped, 'domain')).toBe('skipped')
    })

    it('keeps offering the checklist', () => {
      expect(skipped).toContain('id="onboarding"')
    })

    it('lets the real state win once a domain is added', () => {
      expect(stateOf(afterDomain, 'domain')).toBe('waiting')
    })
  })

  describe('Scenario: the operator does not want a public site', () => {
    let html: string

    beforeAll(async () => {
      const w = createWorld()
      await w.post('/onboarding/site/decline', { from: '/onboarding' })
      html = await page(w)
    })

    it('settles the site step as declined', () => {
      expect(stateOf(html, 'site')).toBe('declined')
    })
  })

  describe('Scenario: the checklist reads the facts', () => {
    const none: Facts = {
      fromName: 'Mara',
      fromEmail: 'mara@example.test',
      domain: 'none',
      siteFilled: false,
      audience: null,
      welcome: false,
      broadcast: false,
    }

    it('counts an import as the audience when there is no form', () => {
      expect(checklist({ ...none, audience: 'import' }, {})[3]).toEqual({
        id: 'audience',
        state: 'done',
        choice: 'import',
      })
    })

    it('treats a failed domain as waiting, not done', () => {
      expect(checklist({ ...none, domain: 'failed' }, {})[1]?.state).toBe('waiting')
    })

    it('lets a filled site win over an earlier decline', () => {
      expect(checklist({ ...none, siteFilled: true }, { site: 'declined' })[2]?.state).toBe('done')
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: the From address is still the placeholder', () => {
    let html: string

    beforeAll(async () => {
      const w = createWorld({ FROM_EMAIL: 'mara@example.com' })
      html = await page(w)
    })

    it('leaves the sender step to do', () => {
      expect(stateOf(html, 'sender')).toBe('todo')
    })

    it('says how to change it', () => {
      expect(html).toContain('env.production.vars')
    })
  })

  describe('Scenario: declining a step that cannot be declined', () => {
    let w: World
    let res: Response

    beforeAll(async () => {
      w = createWorld()
      res = await w.post('/onboarding/domain/decline', { from: '/onboarding' })
    })

    it('says so', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('only the public site')
    })

    it('records nothing', async () => {
      expect(await w.db.select().from(onboardingSteps).where(eq(onboardingSteps.step, 'domain')).all()).toHaveLength(0)
    })
  })

  describe('Scenario: asking for a welcome that is not on offer', () => {
    let w: World
    let res: Response

    beforeAll(async () => {
      w = createWorld()
      res = await w.post('/onboarding/welcome', { template: 'win-back' })
    })

    it('sends the operator back with a reason', () => {
      expect(res.headers.get('location')).toContain('kind=warn')
    })

    it('makes no sequence', async () => {
      expect(await w.db.select().from(sequences).all()).toHaveLength(0)
    })
  })

  describe('Scenario: a first broadcast with no subject', () => {
    let w: World

    beforeAll(async () => {
      w = createWorld()
      await w.post('/onboarding/broadcast', { subject: '   ' })
    })

    it('makes no broadcast', async () => {
      expect(await w.db.select().from(broadcasts).all()).toHaveLength(0)
    })
  })
})
