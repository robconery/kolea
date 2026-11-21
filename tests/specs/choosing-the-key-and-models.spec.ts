// Choosing which key pays for the writing helpers, and which model each uses
//
// gap.md, "AI": Key and model choices. Ports Kōlea SPEC 26.2.1 (the key and
// the monthly budget), 26.2.2 (no usable key, no AI), 26.2.4 (models per task
// are configuration, checked against an allowlist), 26.5.1 to 26.5.2 (one
// ledger row per call, the budget checked before every call) and
// `Kolea.AI.Provider` / `Kolea.AI.Setting` (route to the provider whose key
// pays; a stored key is encrypted and only its hint is ever shown again).
//
// Big Mailer differences, on purpose: a single operator, so "bring your own
// key" is a choice of payer rather than a per-account bypass, and the budget
// counts every call whoever answers (Anthropic and OpenAI calls are estimated
// from list prices, since they report tokens and not money).
//
// ⚠️ The only fake is the providers' HTTP endpoints, swapped in on
// `globalThis.fetch` for a scenario, and `AI_PROVIDER=fake` where named.
// Nothing reaches the network.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { aiCalls, aiKeys, type DocNode } from '../../src/db/schema.ts'
import { createWorld, type World } from '../support/world.ts'

// ───────────────────────────────────────────── the fake providers

interface Seen {
  url: string
  headers: Record<string, string>
  body: { model?: string; system?: string; max_completion_tokens?: number }
}

const SUBJECTS = JSON.stringify({
  ideas: [{ subject: 'I recorded the last video in my kitchen', angle: 'the specific detail' }],
})

/** Answers OpenRouter, Anthropic and OpenAI each in its own shape. Anything else throws. */
function fakeProviders(): { seen: Seen[]; restore(): void } {
  const real = globalThis.fetch
  const seen: Seen[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body = JSON.parse(String(init?.body ?? '{}'))
    seen.push({ url, headers, body })
    if (url.startsWith('https://api.anthropic.com/')) {
      return Response.json({
        type: 'message',
        content: [{ type: 'text', text: SUBJECTS }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 200 },
      })
    }
    if (url.startsWith('https://api.openai.com/') || url.startsWith('https://openrouter.ai/')) {
      return Response.json({
        model: body.model,
        choices: [{ message: { content: SUBJECTS }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.01 },
      })
    }
    throw new Error(`unexpected network call to ${url}`)
  }) as typeof fetch
  return { seen, restore: () => (globalThis.fetch = real) }
}

const SECRET = 'a-long-random-secret-for-the-spec-only'
const ANTHROPIC_KEY = 'sk-ant-api03-SPECSPECSPECSPECSPEC-wxyz'
const OPENAI_KEY = 'sk-proj-SPECSPECSPECSPECSPECSPEC-6789'

const p = (text: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const DOC: DocNode = {
  type: 'doc',
  content: [
    p('I recorded the last video of the course on Tuesday, in my kitchen, at five in the morning.'),
    p('It covers how Postgres plans a query, why the planner picks a sequential scan, and what an index really costs you on every write.'),
  ],
}

function suggest(world: World): Promise<Response> {
  return world.fetch('/ai/subjects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc: DOC }),
  })
}

function flashOf(res: Response): string {
  return decodeURIComponent(new URL(res.headers.get('location') ?? '/', 'https://x').searchParams.get('flash') ?? '')
}

describe('Feature: choosing the key and the models', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the operator pays with their own Anthropic key and picks Haiku for subjects', () => {
    let world: World
    let net: ReturnType<typeof fakeProviders>
    let answer: { ok: boolean }
    let row: typeof aiCalls.$inferSelect | undefined

    beforeAll(async () => {
      world = createWorld({ AI_KEY_ENCRYPTION_SECRET: SECRET })
      net = fakeProviders()
      await world.post('/settings/ai/keys', { provider: 'anthropic', key: ANTHROPIC_KEY })
      await world.post('/settings/ai/payer', { payer: 'anthropic' })
      await world.post('/settings/ai/models', { task: 'subject', model: 'anthropic/claude-haiku-4.5' })
      answer = await (await suggest(world)).json()
      row = (await world.db.select().from(aiCalls).all())[0]
    })
    afterAll(() => net.restore())

    it('turns AI on with no OPENROUTER_KEY at all', () => {
      expect(answer.ok).toBe(true)
    })

    it("⭐ sends the call to Anthropic's own API", () => {
      expect(net.seen[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    })

    it('sends it on the saved key', () => {
      expect(net.seen[0]?.headers['x-api-key']).toBe(ANTHROPIC_KEY)
    })

    it("names the chosen model by Anthropic's own id", () => {
      expect(net.seen[0]?.body.model).toBe('claude-haiku-4-5')
    })

    it('puts the system prompt where Anthropic reads it', () => {
      expect(net.seen[0]?.body.system).toContain('subject lines')
    })

    it('files the ledger row under Anthropic', () => {
      expect(row?.provider).toBe('anthropic')
    })

    it('⭐ records an estimated cost from the list price, since Anthropic reports none', () => {
      expect(row?.costUsd).toBeCloseTo((1000 * 1 + 200 * 5) / 1_000_000, 9)
    })

    it('says the cost is an estimate', () => {
      expect(row?.costEstimated).toBe(true)
    })
  })

  describe('Scenario: the operator pays with their own OpenAI key', () => {
    let world: World
    let net: ReturnType<typeof fakeProviders>

    beforeAll(async () => {
      world = createWorld({ AI_KEY_ENCRYPTION_SECRET: SECRET })
      net = fakeProviders()
      await world.post('/settings/ai/keys', { provider: 'openai', key: OPENAI_KEY })
      await world.post('/settings/ai/payer', { payer: 'openai' })
      await suggest(world)
    })
    afterAll(() => net.restore())

    it("sends the call to OpenAI's own API", () => {
      expect(net.seen[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
    })

    it('sends it on the saved key', () => {
      expect(net.seen[0]?.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`)
    })

    it("uses OpenAI's default subject model, by OpenAI's own id", () => {
      expect(net.seen[0]?.body.model).toBe('gpt-5-mini')
    })

    it('caps the answer the way OpenAI asks', () => {
      expect(net.seen[0]?.body.max_completion_tokens).toBe(1200)
    })
  })

  describe('Scenario: a saved key is never shown again', () => {
    let page: string
    let stored: string

    beforeAll(async () => {
      const world = createWorld({ AI_KEY_ENCRYPTION_SECRET: SECRET })
      await world.post('/settings/ai/keys', { provider: 'anthropic', key: ANTHROPIC_KEY })
      page = await (await world.fetch('/settings/ai')).text()
      stored = (await world.db.select().from(aiKeys).all())[0]?.ciphertext ?? ''
    })

    it('⭐ the screen does not contain the key', () => {
      expect(page.includes(ANTHROPIC_KEY)).toBe(false)
    })

    it('the screen shows its last four characters', () => {
      expect(page).toContain('•••• wxyz')
    })

    it('⭐ the database holds ciphertext, not the key', () => {
      expect(stored.includes('SPECSPEC')).toBe(false)
    })
  })

  describe('Scenario: AI_PROVIDER=fake answers every helper with no key and no network', () => {
    let net: ReturnType<typeof fakeProviders>
    let answer: { ok: boolean }

    beforeAll(async () => {
      const world = createWorld({ AI_PROVIDER: 'fake' })
      net = fakeProviders()
      answer = await (await suggest(world)).json()
    })
    afterAll(() => net.restore())

    it('answers', () => {
      expect(answer.ok).toBe(true)
    })

    it('makes no network call', () => {
      expect(net.seen.length).toBe(0)
    })
  })

  describe('Scenario: removing the key that pays hands the bill back to the install', () => {
    let flash: string
    let page: string

    beforeAll(async () => {
      const world = createWorld({ AI_KEY_ENCRYPTION_SECRET: SECRET, OPENROUTER_KEY: 'sk-or-install' })
      await world.post('/settings/ai/keys', { provider: 'anthropic', key: ANTHROPIC_KEY })
      await world.post('/settings/ai/payer', { payer: 'anthropic' })
      flash = flashOf(await world.post('/settings/ai/keys/anthropic/delete', {}))
      page = await (await world.fetch('/settings/ai')).text()
    })

    it('says who pays now', () => {
      expect(flash).toContain("install's OpenRouter key pays again")
    })

    it('the screen shows the install key paying', () => {
      expect(page).toContain('value="env" checked=""')
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: there is no AI_KEY_ENCRYPTION_SECRET', () => {
    let flash: string
    let page: string
    let rows: number

    beforeAll(async () => {
      const world = createWorld()
      flash = flashOf(await world.post('/settings/ai/keys', { provider: 'anthropic', key: ANTHROPIC_KEY }))
      page = await (await world.fetch('/settings/ai')).text()
      rows = (await world.db.select().from(aiKeys).all()).length
    })

    it('⭐ refuses to store the key', () => {
      expect(rows).toBe(0)
    })

    it('says why', () => {
      expect(flash).toContain('AI_KEY_ENCRYPTION_SECRET')
    })

    it('says so on the screen before anyone tries', () => {
      expect(page).toContain('Keys cannot be saved here yet.')
    })
  })

  describe('Scenario: something that is not an Anthropic key is pasted as one', () => {
    let flash: string

    beforeAll(async () => {
      const world = createWorld({ AI_KEY_ENCRYPTION_SECRET: SECRET })
      flash = flashOf(await world.post('/settings/ai/keys', { provider: 'anthropic', key: OPENAI_KEY }))
    })

    it('is refused', () => {
      expect(flash).toContain('does not look like an Anthropic key')
    })
  })

  describe('Scenario: a model the paying key cannot serve is chosen', () => {
    let flash: string

    beforeAll(async () => {
      const world = createWorld({ AI_KEY_ENCRYPTION_SECRET: SECRET })
      await world.post('/settings/ai/keys', { provider: 'anthropic', key: ANTHROPIC_KEY })
      await world.post('/settings/ai/payer', { payer: 'anthropic' })
      flash = flashOf(await world.post('/settings/ai/models', { task: 'subject', model: 'openai/gpt-5' }))
    })

    it('is refused', () => {
      expect(flash).toContain('cannot use that model')
    })
  })

  describe('Scenario: the encryption secret changes after a key was saved', () => {
    let status: number
    let page: string

    beforeAll(async () => {
      const world = createWorld({ AI_KEY_ENCRYPTION_SECRET: SECRET, OPENROUTER_KEY: 'sk-or-install' })
      await world.post('/settings/ai/keys', { provider: 'anthropic', key: ANTHROPIC_KEY })
      await world.post('/settings/ai/payer', { payer: 'anthropic' })
      world.env.AI_KEY_ENCRYPTION_SECRET = 'a-different-secret-entirely'
      status = (await suggest(world)).status
      page = await (await world.fetch('/settings/ai')).text()
    })

    it('⭐ turns AI off rather than quietly paying with the install key', () => {
      expect(status).toBe(404)
    })

    it('tells the operator to paste the key again', () => {
      expect(page).toContain('Paste it again.')
    })
  })

  describe('Scenario: the budget is spent on estimated Anthropic calls', () => {
    let net: ReturnType<typeof fakeProviders>
    let second: { ok: boolean; reason?: string }

    beforeAll(async () => {
      // One Sonnet 5 call is estimated at $0.004, over a $0.003 budget.
      const world = createWorld({ AI_KEY_ENCRYPTION_SECRET: SECRET, AI_MONTHLY_BUDGET_USD: '0.003' })
      net = fakeProviders()
      await world.post('/settings/ai/keys', { provider: 'anthropic', key: ANTHROPIC_KEY })
      await world.post('/settings/ai/payer', { payer: 'anthropic' })
      await suggest(world)
      second = await (await suggest(world)).json()
    })
    afterAll(() => net.restore())

    it('⭐ refuses the next call', () => {
      expect(second).toMatchObject({ ok: false, reason: expect.stringContaining('budget') })
    })

    it('refuses it before calling the model', () => {
      expect(net.seen.length).toBe(1)
    })
  })

  describe('Scenario: another site posts a key to the settings screen', () => {
    let status: number
    let rows: number

    beforeAll(async () => {
      const world = createWorld({ AI_KEY_ENCRYPTION_SECRET: SECRET })
      status = (
        await world.fetch('/settings/ai/keys', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
          body: new URLSearchParams({ provider: 'openrouter', key: 'sk-or-v1-attackerattackerattacker' }),
        })
      ).status
      rows = (await world.db.select().from(aiKeys).all()).length
    })

    it('is refused', () => {
      expect(status).toBe(403)
    })

    it('stores nothing', () => {
      expect(rows).toBe(0)
    })
  })
})
