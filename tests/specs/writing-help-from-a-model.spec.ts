// Writing help from a language model (OpenRouter)
//
// Three helpers in the composer: subject suggestions, "Clean this up", and a
// first draft of a sequence from a template. None of them can send mail. What
// this Feature guards is the rest of the contract:
//
// - a clean-up never loses an image, a button, a quote or a merge tag;
// - a drafted sequence cannot go live until a person has rewritten every mail;
// - the monthly budget is a hard stop, checked before the model is called;
// - with no key configured, none of it exists.
//
// ⚠️ The only fake is OpenRouter's HTTP endpoint, swapped in on `globalThis.fetch`
// for the length of a scenario. Everything else (routes, core, slop reader,
// markdown round trip, D1) is the production code, driven through `worker.fetch`.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { aiCalls, type DocNode, sequenceSteps, sequences } from '../../src/db/schema.ts'
import { restoreStarterTemplates } from '../../src/core/sequence-templates/index.ts'
import { setSequenceActive } from '../../src/core/sequences.ts'
import { createWorld, type World } from '../support/world.ts'

// ───────────────────────────────────────────── the fake model

interface ModelRequest {
  model: string
  messages: { role: string; content: string }[]
  response_format?: { json_schema?: { name?: string } }
}

interface FakeModel {
  calls: ModelRequest[]
  restore(): void
}

/** Answers OpenRouter requests with `answer(request)`. Anything else goes to the real fetch. */
function fakeOpenRouter(answer: (req: ModelRequest) => string, cost = 0.01): FakeModel {
  const real = globalThis.fetch
  const calls: ModelRequest[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('https://openrouter.ai/')) return real(input, init)
    const req = JSON.parse(String(init?.body)) as ModelRequest
    calls.push(req)
    return Response.json({
      model: req.model,
      choices: [{ message: { content: answer(req) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, cost },
    })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = real) }
}

/** The draft the clean-up sent, pulled back out of the prompt. */
function draftIn(req: ModelRequest): string {
  const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
  return /<draft>\n([\s\S]*)\n<\/draft>/.exec(user)?.[1] ?? ''
}

function aiWorld(extra: Record<string, string> = {}): World {
  return createWorld({ OPENROUTER_KEY: 'sk-or-test', ...extra })
}

function postJson(world: World, path: string, body: unknown): Promise<Response> {
  return world.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const p = (text: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text }] })

const IMAGE: DocNode = {
  type: 'image',
  attrs: { src: 'https://mail.example.test/m/cat.png', alt: 'a cat', title: null },
}
const BUTTON: DocNode = {
  type: 'emailButton',
  attrs: { href: 'https://shop.example.test/course', label: 'Get the course', color: '#1f6f5c' },
}
const GREETING: DocNode = {
  type: 'paragraph',
  content: [{ type: 'text', text: 'Hey ' }, { type: 'mergeTag', attrs: { field: 'first_name' } }, { type: 'text', text: ',' }],
}
const SLOPPY = "Here's the thing — this course will unlock your potential and elevate your journey."

const SLOPPY_DOC: DocNode = {
  type: 'doc',
  content: [GREETING, p(SLOPPY), IMAGE, p('I recorded the last video on Tuesday, in my kitchen, at 5am.'), BUTTON],
}

describe('Feature: writing help from a model', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the writer cleans up a sloppy draft with an image and a button in it', () => {
    let world: World
    let model: FakeModel
    let answer: { ok: boolean; doc?: DocNode; before?: number; after?: number }

    beforeAll(async () => {
      world = aiWorld()
      model = fakeOpenRouter((req) =>
        draftIn(req).replace(SLOPPY, 'This course teaches you how Postgres plans a query.'),
      )
      answer = await (await postJson(world, '/ai/cleanup', { doc: SLOPPY_DOC })).json()
    })
    afterAll(() => model.restore())

    it('answers with a rewritten draft', () => {
      expect(answer.ok).toBe(true)
    })

    it('⭐ gives the image back exactly as it went in', () => {
      expect(answer.doc?.content?.find((n) => n.type === 'image')).toEqual(IMAGE)
    })

    it('⭐ gives the button back exactly as it went in', () => {
      expect(answer.doc?.content?.find((n) => n.type === 'emailButton')).toEqual(BUTTON)
    })

    it('keeps the merge tag a merge tag', () => {
      expect(answer.doc?.content?.[0]?.content?.some((n) => n.type === 'mergeTag')).toBe(true)
    })

    it('keeps the blocks in their order', () => {
      expect(answer.doc?.content?.map((n) => n.type)).toEqual([
        'paragraph',
        'paragraph',
        'image',
        'paragraph',
        'emailButton',
      ])
    })

    it('reports that the slop score fell', () => {
      expect(answer.after!).toBeLessThan(answer.before!)
    })

    it('uses the clean-up model', () => {
      expect(model.calls[0]?.model).toBe('anthropic/claude-opus-5.5')
    })

    it('hands the model the house style', () => {
      expect(model.calls[0]?.messages[0]?.content).toContain('Rule zero: say what you mean')
    })

    it("tells the model this draft's own problems", () => {
      expect(model.calls[0]?.messages[1]?.content).toContain("Here's the thing")
    })

    it('records what the call cost', async () => {
      const rows = await world.db.select().from(aiCalls).all()
      expect(rows.map((r) => [r.task, r.costUsd, r.ok])).toEqual([['cleanup', 0.01, true]])
    })
  })

  describe('Scenario: the model slips an em-dash back in', () => {
    let world: World
    let model: FakeModel
    let answer: { ok: boolean; doc?: DocNode }

    beforeAll(async () => {
      world = aiWorld()
      model = fakeOpenRouter((req) => draftIn(req).replace(SLOPPY, 'The course is short — six videos.'))
      answer = await (await postJson(world, '/ai/cleanup', { doc: SLOPPY_DOC })).json()
    })
    afterAll(() => model.restore())

    it('takes it out before the writer sees it', () => {
      expect(JSON.stringify(answer.doc)).not.toContain('—')
    })
  })

  describe('Scenario: the writer asks for subject lines', () => {
    let world: World
    let model: FakeModel
    let answer: { ok: boolean; ideas?: { subject: string }[] }

    beforeAll(async () => {
      world = aiWorld()
      model = fakeOpenRouter(() =>
        JSON.stringify({
          ideas: [
            { subject: 'Unlock your potential with Postgres', angle: 'the promise' },
            { subject: 'The $1,100 AWS bill', angle: 'the most specific detail' },
            { subject: '"Why my query took nine seconds."', angle: 'the question it answers' },
          ],
        }),
      )
      const body = {
        type: 'doc',
        content: [
          p(
            'Last month AWS sent me a bill for $1,100 and I nearly fell off my chair. It turned out one query was scanning the whole orders table every time somebody opened the dashboard, and it took nine seconds.',
          ),
        ],
      }
      answer = await (await postJson(world, '/ai/subjects', { doc: body, subject: '' })).json()
    })
    afterAll(() => model.restore())

    it('offers the honest, specific ones', () => {
      expect(answer.ideas?.map((i) => i.subject)).toContain('The $1,100 AWS bill')
    })

    it('drops a suggestion the slop reader flags', () => {
      expect(answer.ideas?.map((i) => i.subject)).not.toContain('Unlock your potential with Postgres')
    })

    it('strips the quotes and full stop a model wraps a subject in', () => {
      expect(answer.ideas?.map((i) => i.subject)).toContain('Why my query took nine seconds')
    })

    it('uses the subject model', () => {
      expect(model.calls[0]?.model).toBe('anthropic/claude-sonnet-5')
    })
  })

  describe('Scenario: the writer drafts a sequence from a template with a pitch', () => {
    let world: World
    let model: FakeModel
    let steps: { subject: string; bodyMd: string }[]
    let activation: { ok: boolean }
    let stepCount: number

    beforeAll(async () => {
      world = aiWorld()
      await restoreStarterTemplates(world.db)
      model = fakeOpenRouter((req) => {
        if (req.response_format?.json_schema?.name === 'sequence_plan') {
          return JSON.stringify({
            story: 'A developer who hated SQL learns to love it.',
            mails: Array.from({ length: 12 }, (_, i) => ({ plan: `Part ${i + 1} of the story.` })),
          })
        }
        return JSON.stringify({
          subject: 'The day SQL — finally — made sense',
          body: 'Hey {{first_name}},\n\nThis is how it started. [[ link to the course ]]',
        })
      })
      await world.post('/sequences/templates/soap-opera/use', {
        name: 'SQL story',
        description: '',
        trigger: 'manual',
        triggerTagId: '',
        brief:
          'I sell a $49 course on SQL for developers who learned an ORM first and never touched the database. My name is Rob. I used to hate SQL and now I love it.',
        draft: '1',
      })
      const seq = await world.db.select().from(sequences).where(eq(sequences.name, 'SQL story')).get()
      steps = await world.db
        .select({ subject: sequenceSteps.subject, bodyMd: sequenceSteps.bodyMd })
        .from(sequenceSteps)
        .where(eq(sequenceSteps.sequenceId, seq!.id))
        .orderBy(asc(sequenceSteps.position))
        .all()
      stepCount = steps.length
      activation = await setSequenceActive(world.db, seq!.id, true)
    })
    afterAll(() => model.restore())

    it('drafts every mail', () => {
      expect(steps.every((s) => s.bodyMd.includes('This is how it started.'))).toBe(true)
    })

    it('opens every mail with a note to rewrite it', () => {
      expect(steps.every((s) => s.bodyMd.startsWith('[[ AI draft. Rewrite this in your own words'))).toBe(true)
    })

    it('keeps em-dashes out of the subjects', () => {
      expect(steps.some((s) => s.subject.includes('—'))).toBe(false)
    })

    it('⭐ will not go live until a person has rewritten every mail', () => {
      expect(activation.ok).toBe(false)
    })

    it('plans once and writes each mail separately', () => {
      expect(model.calls.length).toBe(stepCount + 1)
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: the model drops the image from the draft', () => {
    let world: World
    let model: FakeModel
    let answer: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = aiWorld()
      model = fakeOpenRouter(() => 'Hey {{first_name}},\n\nThis course teaches Postgres.')
      answer = await (await postJson(world, '/ai/cleanup', { doc: SLOPPY_DOC })).json()
    })
    afterAll(() => model.restore())

    it('⭐ changes nothing, and says why', () => {
      expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining('dropped') })
    })
  })

  describe("Scenario: this month's budget is already spent", () => {
    let world: World
    let model: FakeModel
    let answer: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = aiWorld({ AI_MONTHLY_BUDGET_USD: '1' })
      await world.db.insert(aiCalls).values({
        task: 'cleanup',
        model: 'anthropic/claude-opus-5.5',
        costUsd: 1.25,
        ok: true,
        createdAt: new Date(),
      })
      model = fakeOpenRouter(() => 'unused')
      answer = await (await postJson(world, '/ai/cleanup', { doc: SLOPPY_DOC })).json()
    })
    afterAll(() => model.restore())

    it('refuses', () => {
      expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining('budget') })
    })

    it('⭐ never calls the model', () => {
      expect(model.calls.length).toBe(0)
    })
  })

  describe('Scenario: a cross-site form tries to post to the AI endpoints', () => {
    let status: number

    beforeAll(async () => {
      const world = aiWorld()
      status = (await world.post('/ai/cleanup', { doc: '{}' })).status
    })

    it('is refused for not being JSON', () => {
      expect(status).toBe(415)
    })
  })

  describe('Scenario: no OpenRouter key is configured', () => {
    let world: World
    let status: number
    let composer: string
    let template: string

    beforeAll(async () => {
      world = createWorld()
      await restoreStarterTemplates(world.db)
      status = (await postJson(world, '/ai/subjects', { doc: SLOPPY_DOC })).status
      composer = await (await world.fetch('/broadcasts/new')).text()
      template = await (await world.fetch('/sequences/templates/soap-opera')).text()
    })

    it('has no AI endpoints', () => {
      expect(status).toBe(404)
    })

    it('shows no AI buttons in the composer', () => {
      expect(composer).not.toContain('data-ai=')
    })

    it('shows no pitch box or draft button on a template', () => {
      expect(template).not.toContain('name="brief"')
    })
  })

  describe('Scenario: the key is set but blank', () => {
    let status: number
    let composer: string

    beforeAll(async () => {
      const world = createWorld({ OPENROUTER_KEY: '   ' })
      status = (await postJson(world, '/ai/subjects', { doc: SLOPPY_DOC })).status
      composer = await (await world.fetch('/broadcasts/new')).text()
    })

    it('counts as off: no AI endpoints', () => {
      expect(status).toBe(404)
    })

    it('counts as off: no AI buttons', () => {
      expect(composer).not.toContain('data-ai=')
    })
  })

  describe('Scenario: a key is configured', () => {
    let composer: string
    let template: string

    beforeAll(async () => {
      const world = aiWorld()
      await restoreStarterTemplates(world.db)
      composer = await (await world.fetch('/broadcasts/new')).text()
      template = await (await world.fetch('/sequences/templates/soap-opera')).text()
    })

    it('turns the AI buttons on in the composer', () => {
      expect(composer).toContain('data-ai="1"')
    })

    it('shows the pitch box on a template', () => {
      expect(template).toContain('name="brief"')
    })
  })
})
