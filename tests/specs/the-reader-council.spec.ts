// The reader council: three readers and an editor review a draft before it goes out
//
// gap.md, "AI": Reader council and review desk. Ports Kōlea's `Kolea.Council`,
// `Kolea.Council.Audience`, `Kolea.Council.Review` and `Kolea.AI.Council`
// (Kōlea's SPEC has no numbered clause for the council; the modules are the
// reference): the audience is four fixed dials and nothing about subscribers,
// the draft is fenced as data, every quote the council gives is checked
// against the draft, every string is cleaned, the call is budget-checked and
// recorded, and the review is kept so it can be reread.
//
// Big Mailer differences, on purpose: every review is kept as its own row
// (Kōlea keeps only the latest), and Kōlea's "Claude fixes the note" tracked
// changes are not ported: notes can be dismissed and reopened, and the writer
// edits the draft themselves.
//
// ⚠️ The only fakes are OpenRouter's HTTP endpoint on `globalThis.fetch`, and
// `AI_PROVIDER=fake` where named. Nothing reaches the network.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { aiCalls, broadcasts, councilReviews } from '../../src/db/schema.ts'
import { aBroadcast, aPerson, aSequence } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

// ───────────────────────────────────────────── the fake model

interface ModelRequest {
  model: string
  messages: { role: string; content: string }[]
}

function fakeOpenRouter(answer: () => string): { calls: ModelRequest[]; restore(): void } {
  const real = globalThis.fetch
  const calls: ModelRequest[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('https://openrouter.ai/')) throw new Error(`unexpected network call to ${url}`)
    const req = JSON.parse(String(init?.body)) as ModelRequest
    calls.push(req)
    return Response.json({
      model: req.model,
      choices: [{ message: { content: answer() }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.02 },
    })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = real) }
}

const LOST = 'the planner picks a sequential scan'
const HOOK = 'in my kitchen, at five in the morning'

const DRAFT = [
  `I recorded the last video of the course on Tuesday, ${HOOK}, because that is the only time the house is quiet enough.`,
  `It covers how Postgres plans a query, why ${LOST} when you expected an index, and what an index really costs you on every single write you make to that table.`,
  'Most people learn this the hard way. They add an index for every column that shows up in a where clause, and then they wonder why inserts crawl and the disk fills up overnight.',
  'I did exactly that on my first real job, on a table of shipping events that took forty writes a second, and I watched the replication lag climb all afternoon while my lead stood behind me.',
  'So the course starts there, with that afternoon, and walks through reading a plan line by line until the numbers stop being noise and start telling you what the database is actually doing for you.',
  'If you have ever stared at EXPLAIN output and nodded without understanding it, this one is for you, and I think you will like the last lesson most of all.',
].join('\n\n')

const REVIEW = {
  fan: {
    name: 'Maya',
    who: 'Backend developer, reads every issue',
    reaction: 'I love the kitchen detail. <script>alert(1)</script> You lose me a little in the middle.',
    hooked: HOOK,
    lost: '',
    feels: 'love',
  },
  skeptic: {
    name: 'Dan',
    who: 'DBA for fifteen years',
    reaction: 'I stopped believing you when the index advice turned generic.',
    hooked: '',
    lost: LOST,
    feels: 'shrug',
  },
  middle: {
    name: 'Priya',
    who: 'Subscribed last year',
    reaction: 'I skimmed after the second paragraph.',
    hooked: '',
    lost: 'a sentence that is nowhere in the draft at all',
    feels: 'shrug',
  },
  split: 'safe',
  verdict: 'This is a course announcement wearing a story. Lead with the replication lag afternoon.',
  push: [{ idea: 'The replication lag afternoon', why: 'It is the only part only you could write.' }],
  cut: [{ idea: 'The closing pitch', why: 'It summarises what the reader just read.' }],
  voice: [{ quote: 'Most people learn this the hard way', sounds: 'everyone', note: 'This line is in every newsletter.' }],
  direct: ['The opening clears its throat for a sentence before the point.'],
}

async function longBroadcast(w: World): Promise<number> {
  return await aBroadcast(w, { subject: 'The last video', body: DRAFT })
}

function aiWorld(extra: Record<string, string> = {}): World {
  return createWorld({ OPENROUTER_KEY: 'sk-or-test', ...extra })
}

describe('Feature: the reader council', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the operator asks the council about a broadcast draft', () => {
    let world: World
    let net: ReturnType<typeof fakeOpenRouter>
    let id: number
    let convened: Response
    let rows: (typeof councilReviews.$inferSelect)[]
    let calls: (typeof aiCalls.$inferSelect)[]
    let deskHtml: string
    let system: string
    let user: string
    let bodyAfter: string | undefined

    beforeAll(async () => {
      world = aiWorld()
      net = fakeOpenRouter(() => JSON.stringify(REVIEW))
      await aPerson(world, { email: 'reader.one@example.test' })
      id = await longBroadcast(world)
      await world.post('/council/audience', {
        back: `/broadcasts/${id}/council`,
        field: 'developers',
        expertise: 'expert',
        purpose: 'learn',
        attention: 'skims',
      })
      convened = await world.fetch(`/broadcasts/${id}/council`, { method: 'POST' })
      rows = await world.db.select().from(councilReviews).all()
      calls = await world.db.select().from(aiCalls).all()
      deskHtml = await (await world.fetch(convened.headers.get('location') ?? '/')).text()
      system = net.calls[0]?.messages.find((m) => m.role === 'system')?.content ?? ''
      user = net.calls[0]?.messages.find((m) => m.role === 'user')?.content ?? ''
      bodyAfter = (await world.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get())?.bodyMd
    })
    afterAll(() => net.restore())

    it('⭐ opens the review desk for the new review', () => {
      expect(convened.headers.get('location')).toBe(`/broadcasts/${id}/council?review=${rows[0]?.id}`)
    })

    it('keeps the review as a finished row', () => {
      expect(rows[0]?.status).toBe('done')
    })

    it('keeps the draft it read with the review', () => {
      expect(rows[0]?.draftText).toBe(DRAFT)
    })

    it('keeps the audience it was convened with', () => {
      expect(rows[0]?.audience.field).toBe('developers')
    })

    it('records the call in ai_calls under the council', () => {
      expect(calls.map((c) => c.task)).toEqual(['council'])
    })

    it("keeps the call's cost on the review", () => {
      expect(rows[0]?.costUsd).toBe(0.02)
    })

    it('⭐ describes the audience in its own words, from the dials', () => {
      expect(system).toContain("This writer's readers are software developers.")
    })

    it('⭐ sends no subscriber data to the model', () => {
      expect(`${system}${user}`).not.toContain('reader.one@example.test')
    })

    it("sends the operator's draft, fenced as data", () => {
      expect(user).toContain(`<draft>\n${DRAFT}\n</draft>`)
    })

    it('⭐ blanks a quote the draft does not hold', () => {
      const review = rows[0]?.review as { readers: { stance: string; lost: string }[] }
      expect(review.readers.find((r) => r.stance === 'middle')?.lost).toBe('')
    })

    it('⭐ escapes what the model wrote', () => {
      expect(deskHtml).not.toContain('<script>alert(1)</script>')
    })

    it('shows the escaped text rather than dropping it', () => {
      expect(deskHtml).toContain('&lt;script&gt;')
    })

    it('⭐ anchors a note to its passage in the draft', () => {
      expect(deskHtml).toContain('id="q-skeptic-lost"')
    })

    it('lists that note in the margin, linked to the passage', () => {
      expect(deskHtml).toContain('href="#q-skeptic-lost"')
    })

    it('marks the passage that hooked a reader', () => {
      expect(deskHtml).toContain('id="q-fan-hooked"')
    })

    it('shows the verdict', () => {
      expect(deskHtml).toContain('Lead with the replication lag afternoon.')
    })

    it('leaves the draft exactly as it was', () => {
      expect(bodyAfter).toBe(DRAFT)
    })

    it('sends no mail', async () => {
      expect((await world.outbox()).length).toBe(0)
    })
  })

  describe('Scenario: the operator dismisses a note, rereads, and opens it again', () => {
    let world: World
    let net: ReturnType<typeof fakeOpenRouter>
    let afterDismiss: string
    let afterReopen: string
    let resolved: Record<string, string> | undefined

    beforeAll(async () => {
      world = aiWorld()
      net = fakeOpenRouter(() => JSON.stringify(REVIEW))
      const id = await longBroadcast(world)
      await world.fetch(`/broadcasts/${id}/council`, { method: 'POST' })
      const row = (await world.db.select().from(councilReviews).all())[0]!
      await world.post(`/council/${row.id}/notes/skeptic-lost`, { dismiss: '1' })
      resolved = (await world.db.select().from(councilReviews).get())?.resolved
      afterDismiss = await (await world.fetch(`/broadcasts/${id}/council`)).text()
      await world.post(`/council/${row.id}/notes/skeptic-lost`, { dismiss: '0' })
      afterReopen = await (await world.fetch(`/broadcasts/${id}/council`)).text()
    })
    afterAll(() => net.restore())

    it('remembers the dismissal on the review row', () => {
      expect(resolved?.['skeptic-lost']).toBe('dismissed')
    })

    it('takes the dismissed note off the passage', () => {
      expect(afterDismiss).not.toContain('id="q-skeptic-lost"')
    })

    it('marks the passage again when the note is reopened', () => {
      expect(afterReopen).toContain('id="q-skeptic-lost"')
    })
  })

  describe('Scenario: "Ask the council" in the sequence-step editor, on the local fake model', () => {
    let world: World
    let editorHtml: string
    let saved: Response
    let convened: Response
    let row: typeof councilReviews.$inferSelect | undefined
    let seqId: number
    let stepId: number

    beforeAll(async () => {
      world = createWorld({ AI_PROVIDER: 'fake' })
      const seq = await aSequence(world, { steps: [{ subject: 'Welcome', body: DRAFT }], active: false })
      seqId = seq.id
      stepId = seq.stepIds[0]!
      editorHtml = await (await world.fetch(`/sequences/${seqId}/steps/${stepId}`)).text()
      saved = await world.post(`/sequences/${seqId}/steps/${stepId}`, {
        subject: 'Welcome',
        body: DRAFT,
        council: '1',
      })
      convened = await world.fetch(`/sequences/${seqId}/steps/${stepId}/council`, { method: 'POST' })
      row = await world.db.select().from(councilReviews).get()
    })

    it('shows the button in the editor', () => {
      expect(editorHtml).toContain('data-test="ask-council"')
    })

    it('⭐ saves the step and opens the review desk', () => {
      expect(saved.headers.get('location')).toBe(`/sequences/${seqId}/steps/${stepId}/council`)
    })

    it('files the review under the step', () => {
      expect(row?.sequenceStepId).toBe(stepId)
    })

    it('finishes the review', () => {
      expect(row?.status).toBe('done')
    })

    it('opens the desk on it', () => {
      expect(convened.headers.get('location')).toBe(`/sequences/${seqId}/steps/${stepId}/council?review=${row?.id}`)
    })
  })

  // ───────────────────────────────────────────── refusals

  describe("Scenario: this month's budget is used up", () => {
    let world: World
    let net: ReturnType<typeof fakeOpenRouter>
    let res: Response

    beforeAll(async () => {
      world = aiWorld({ AI_MONTHLY_BUDGET_USD: '1' })
      net = fakeOpenRouter(() => JSON.stringify(REVIEW))
      await world.db.insert(aiCalls).values({ task: 'cleanup', model: 'x/y', costUsd: 5, ok: true, createdAt: new Date() })
      const id = await longBroadcast(world)
      res = await world.fetch(`/broadcasts/${id}/council`, { method: 'POST' })
    })
    afterAll(() => net.restore())

    it('⭐ says the budget is used up', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain("This month's AI budget is used up")
    })

    it('never calls the model', () => {
      expect(net.calls.length).toBe(0)
    })

    it('leaves no review row', async () => {
      expect((await world.db.select().from(councilReviews).all()).length).toBe(0)
    })
  })

  describe('Scenario: AI is not set up', () => {
    let world: World
    let res: Response
    let desk: string
    let editor: string

    beforeAll(async () => {
      world = createWorld()
      const id = await longBroadcast(world)
      res = await world.fetch(`/broadcasts/${id}/council`, { method: 'POST' })
      desk = await (await world.fetch(`/broadcasts/${id}/council`)).text()
      editor = await (await world.fetch(`/broadcasts/${id}`)).text()
    })

    it('says AI is not set up', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('AI is not set up')
    })

    it('leaves no review row', async () => {
      expect((await world.db.select().from(councilReviews).all()).length).toBe(0)
    })

    it('says so on the desk', () => {
      expect(desk).toContain('data-test="council-off"')
    })

    it('shows no council button in the editor', () => {
      expect(editor).not.toContain('data-test="ask-council"')
    })
  })

  describe('Scenario: the draft is too short to review', () => {
    let world: World
    let net: ReturnType<typeof fakeOpenRouter>
    let res: Response

    beforeAll(async () => {
      world = aiWorld()
      net = fakeOpenRouter(() => JSON.stringify(REVIEW))
      const id = await aBroadcast(world, { body: 'Short and sweet.' })
      res = await world.fetch(`/broadcasts/${id}/council`, { method: 'POST' })
    })
    afterAll(() => net.restore())

    it('says it needs more words', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('120 words or more')
    })

    it('never calls the model', () => {
      expect(net.calls.length).toBe(0)
    })
  })

  describe('Scenario: the model answers with nothing usable', () => {
    let world: World
    let net: ReturnType<typeof fakeOpenRouter>
    let row: typeof councilReviews.$inferSelect | undefined
    let desk: string
    let calls: number

    beforeAll(async () => {
      world = aiWorld()
      net = fakeOpenRouter(() => JSON.stringify({ verdict: 'Fine.', direct: [] }))
      const id = await longBroadcast(world)
      await world.fetch(`/broadcasts/${id}/council`, { method: 'POST' })
      row = await world.db.select().from(councilReviews).get()
      desk = await (await world.fetch(`/broadcasts/${id}/council`)).text()
      calls = (await world.db.select().from(aiCalls).all()).length
    })
    afterAll(() => net.restore())

    it('⭐ marks the review failed, never done', () => {
      expect(row?.status).toBe('failed')
    })

    it('says why on the desk', () => {
      expect(desk).toContain('data-test="council-failed"')
    })

    it('shows no review as if it had finished', () => {
      expect(desk).not.toContain('data-test="council-review"')
    })

    it('still records the call it paid for', () => {
      expect(calls).toBe(1)
    })
  })

  describe('Scenario: another site tries to spend the budget', () => {
    let res: Response

    beforeAll(async () => {
      const world = aiWorld()
      const id = await longBroadcast(world)
      res = await world.fetch(`/broadcasts/${id}/council`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })
    })

    it('refuses the cross-site post', () => {
      expect(res.status).toBe(403)
    })
  })
})
