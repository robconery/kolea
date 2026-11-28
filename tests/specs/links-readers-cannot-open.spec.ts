// SPEC 3.15 — a link readers can't open is caught before the send
//
// Written after a broadcast went to a few hundred people carrying a link to the
// writer's own dev server (http://localhost:5555/courses). Dozens clicked it and
// landed nowhere. Kōlea sends links exactly as written, which stays true: what
// changes is that a link only the writer's machine or network can open is named
// on every road to a send, and needs a separate "yes, I mean it".
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { setAgentSwitches } from '../../src/core/agents.ts'
import { createApiKey } from '../../src/core/api-keys.ts'
import { createBroadcast } from '../../src/core/broadcasts.ts'
import { devLinkReason, devLinks, fixedLinkProblem, linksIn, replaceLink } from '../../src/core/link-safety.ts'
import type { DocNode } from '../../src/db/schema.ts'
import { broadcasts } from '../../src/db/schema.ts'
import { aBroadcast, aPerson, aSequence } from '../support/factories.ts'
import { MCP_SECRET, type ToolReply, agentFor } from '../support/mcp.ts'
import { createWorld, type World } from '../support/world.ts'

const DEV_BODY = 'Start the course: [open it](http://localhost:5555/courses)\n\nOr read [the notes](https://example.com/notes).'

const statusOf = async (w: World, id: number) =>
  (await w.db.select({ s: broadcasts.status }).from(broadcasts).where(eq(broadcasts.id, id)).get())?.s

/** A world where agents may send, so the only thing in the way is the link check. */
async function agentWorld(): Promise<World> {
  const w = createWorld({ MCP_PATH_SECRET: MCP_SECRET })
  await setAgentSwitches(w.db, { allowSend: true })
  return w
}

describe('Feature: catching links readers cannot open', () => {
  // ───────────────────────────────────────────── the rule itself

  describe('Scenario: addresses that only exist on the writer’s side', () => {
    const flagged = [
      'http://localhost:5555/courses',
      'http://app.localhost/',
      'http://127.0.0.1:8787/x',
      'http://127.4.5.6/',
      'http://0.0.0.0:3000/',
      'http://[::1]:8080/',
      'http://printer.local/',
      'https://shop.test/checkout',
      'https://api.internal/v1',
      'https://www.example/',
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.20/',
      'http://devbox:3000/',
      'file:///Users/someone/notes.html',
      'javascript:alert(1)',
      'ftp://files.example.com/a.zip',
      'localhost:5555/courses',
    ]
    for (const url of flagged) {
      it(`flags ${url}`, () => {
        expect(devLinkReason(url)).not.toBeNull()
      })
    }
  })

  describe('Scenario: addresses anyone can open', () => {
    const fine = [
      'https://example.com/notes',
      'http://example.org',
      'https://172.32.0.1/',
      'https://192.169.0.1/',
      'https://8.8.8.8/',
      'https://sub.example.co.uk/path?q=1',
      'mailto:ada@example.com',
      'tel:+15555550100',
      '/relative/path',
      '#section',
      '{{testimonial_link}}',
    ]
    for (const url of fine) {
      it(`passes ${url}`, () => {
        expect(devLinkReason(url)).toBeNull()
      })
    }
  })

  describe('Scenario: the reason is written for a person', () => {
    it('says a localhost link only opens on your own computer', () => {
      expect(devLinkReason('http://localhost:5555/courses')).toBe('only opens on your own computer')
    })

    it('says a private address only opens inside a private network', () => {
      expect(devLinkReason('http://192.168.1.20/')).toBe('only opens inside a private network')
    })

    it('names the scheme of a link that is not a web link', () => {
      expect(devLinkReason('file:///tmp/a.html')).toBe('is not a web link (file:)')
    })
  })

  describe('Scenario: finding links in the editor’s document', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Read ', marks: [] },
            { type: 'text', text: 'this', marks: [{ type: 'link', attrs: { href: 'http://localhost:5555/a' } }] },
          ],
        },
        { type: 'emailButton', attrs: { href: 'https://example.com/buy' }, content: [{ type: 'text', text: 'Buy' }] },
        { type: 'image', attrs: { src: 'https://example.com/i.png', href: 'http://192.168.0.2/' } },
      ],
    }

    it('finds a text link, a button and a linked image, in order', () => {
      expect(linksIn({ json: doc })).toEqual(['http://localhost:5555/a', 'https://example.com/buy', 'http://192.168.0.2/'])
    })

    it('lists only the ones readers cannot open', () => {
      expect(devLinks({ json: doc }).map((l) => l.url)).toEqual(['http://localhost:5555/a', 'http://192.168.0.2/'])
    })
  })

  describe('Scenario: finding links in markdown', () => {
    const md = [
      '[a](http://localhost:1/a) and ![pic](http://localhost:1/pic.png)',
      '<http://127.0.0.1/auto>',
      '<a href="http://10.0.0.1/html">x</a>',
      'bare http://shop.test/bare.',
      '[ref]: http://printer.local/ref',
    ].join('\n')

    it('finds inline, autolink, HTML, bare and reference links, and skips images', () => {
      expect(linksIn({ json: null, md }).sort()).toEqual(
        [
          'http://localhost:1/a',
          'http://printer.local/ref',
          'http://127.0.0.1/auto',
          'http://10.0.0.1/html',
          'http://shop.test/bare',
        ].sort(),
      )
    })
  })

  describe('Scenario: swapping one link for another', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }] },
            { type: 'text', text: 'ab', marks: [{ type: 'link', attrs: { href: 'https://example.com/a/b' } }] },
          ],
        },
      ],
    }
    const md = '[a](https://example.com/a) [ab](https://example.com/a/b)'
    const out = replaceLink({ json: doc, md }, 'https://example.com/a', 'https://example.com/fixed')

    it('replaces the exact link in the document and the markdown', () => {
      expect(out.replaced).toBe(2)
    })

    it('leaves a longer link that starts the same way alone in the document', () => {
      expect(linksIn({ json: out.json })).toEqual(['https://example.com/fixed', 'https://example.com/a/b'])
    })

    it('leaves a longer link that starts the same way alone in the markdown', () => {
      expect(out.md).toBe('[a](https://example.com/fixed) [ab](https://example.com/a/b)')
    })

    it('never edits the document it was given', () => {
      expect(linksIn({ json: doc })[0]).toBe('https://example.com/a')
    })
  })

  describe('Scenario: what a corrected link must be', () => {
    it('accepts an https link', () => {
      expect(fixedLinkProblem('https://example.com/courses')).toBeNull()
    })

    it('refuses a link that is itself a dev link', () => {
      expect(fixedLinkProblem('http://localhost:5556/courses')).toContain('only opens on your own computer')
    })

    it('refuses a link that is not http or https', () => {
      expect(fixedLinkProblem('mailto:ada@example.com')).toContain('https://')
    })

    it('refuses something that is not a full link', () => {
      expect(fixedLinkProblem('example.com/courses')).toContain('not a full link')
    })
  })

  // ───────────────────────────────────────────── the confirmation screen

  describe('Scenario: the confirmation screen for a broadcast with a dev link', () => {
    let html: string

    beforeAll(async () => {
      const w = createWorld()
      await aPerson(w)
      const id = await aBroadcast(w, { body: DEV_BODY })
      html = await (await w.fetch(`/broadcasts/${id}/send`)).text()
    })

    it('warns that a link won’t open for readers', () => {
      expect(html).toContain('This link won’t open for readers.')
    })

    it('names the link', () => {
      expect(html).toContain('http://localhost:5555/courses')
    })

    it('says why', () => {
      expect(html).toContain('only opens on your own computer')
    })

    it('does not list the link that works', () => {
      expect(html).not.toContain('https://example.com/notes</span>')
    })

    it('asks for a separate yes before the send button works', () => {
      expect(html).toContain('Send anyway, these links are intended')
    })

    it('makes that box required', () => {
      expect(html).toMatch(/name="dev_links_ok"[^>]*required/)
    })
  })

  describe('Scenario: the confirmation screen for a broadcast without one', () => {
    let html: string

    beforeAll(async () => {
      const w = createWorld()
      await aPerson(w)
      const id = await aBroadcast(w, { body: 'Read [the notes](https://example.com/notes).' })
      html = await (await w.fetch(`/broadcasts/${id}/send`)).text()
    })

    it('shows no link warning', () => {
      expect(html).not.toContain('won’t open for readers')
    })

    it('asks for nothing extra', () => {
      expect(html).not.toContain('dev_links_ok')
    })
  })

  describe('Scenario: sending with the box ticked', () => {
    let w: World
    let id: number

    beforeAll(async () => {
      w = createWorld()
      await aPerson(w)
      id = await aBroadcast(w, { body: DEV_BODY })
      await w.post(`/broadcasts/${id}/send`, { confirm: 'send', expected: '1', dev_links_ok: '1' })
    })

    it('sends it', async () => {
      expect(await w.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: sending a broadcast without dev links is unchanged', () => {
    let w: World

    beforeAll(async () => {
      w = createWorld()
      await aPerson(w)
      const id = await aBroadcast(w, { body: 'Read [the notes](https://example.com/notes).' })
      await w.post(`/broadcasts/${id}/send`, { confirm: 'send', expected: '1' })
    })

    it('sends it without the box', async () => {
      expect(await w.outbox()).toHaveLength(1)
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: sending without ticking the box', () => {
    let w: World
    let id: number
    let res: Response

    beforeAll(async () => {
      w = createWorld()
      await aPerson(w)
      id = await aBroadcast(w, { body: DEV_BODY })
      res = await w.post(`/broadcasts/${id}/send`, { confirm: 'send', expected: '1' })
    })

    it('⭐ sends nothing', async () => {
      expect(await w.outbox()).toHaveLength(0)
    })

    it('leaves it a draft', async () => {
      expect(await statusOf(w, id)).toBe('draft')
    })

    it('goes back to the confirmation screen, which shows the warning again', () => {
      expect(res.headers.get('location')).toStartWith(`/broadcasts/${id}/send?flash=`)
    })
  })

  describe('Scenario: an agent sends a broadcast with a dev link', () => {
    let w: World
    let id: number
    let preflight: ToolReply
    let reply: ToolReply

    beforeAll(async () => {
      w = await agentWorld()
      await aPerson(w)
      id = await aBroadcast(w, { body: DEV_BODY })
      const agent = await agentFor(w)
      preflight = await agent.call('broadcast_preflight', { id })
      reply = await agent.call('broadcast_send', { id, preflight_token: preflight.json.preflight_token })
    })

    it('the preflight lists the link', () => {
      expect(preflight.json.devLinks[0].url).toBe('http://localhost:5555/courses')
    })

    it('the preflight warns the send will be refused', () => {
      expect(preflight.json.warnings.join(' ')).toContain('Will be refused')
    })

    it('the send is refused', () => {
      expect(reply.isError).toBe(true)
    })

    it('the refusal names the link and the override', () => {
      expect(reply.text).toContain('allow_dev_links')
    })

    it('⭐ sends nothing', async () => {
      expect(await w.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: an agent says the links are intended', () => {
    let w: World

    beforeAll(async () => {
      w = await agentWorld()
      await aPerson(w)
      const id = await aBroadcast(w, { body: DEV_BODY })
      const agent = await agentFor(w)
      const preflight = await agent.call('broadcast_preflight', { id })
      // The refusal comes before the token is spent, so the same token still works.
      await agent.call('broadcast_send', { id, preflight_token: preflight.json.preflight_token })
      await agent.call('broadcast_send', {
        id,
        preflight_token: preflight.json.preflight_token,
        allow_dev_links: true,
      })
    })

    it('sends it', async () => {
      expect(await w.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: an agent schedules a broadcast with a dev link', () => {
    let w: World
    let id: number
    let reply: ToolReply

    beforeAll(async () => {
      w = await agentWorld()
      await aPerson(w)
      id = await aBroadcast(w, { body: DEV_BODY })
      const at = new Date(Date.now() + 86_400_000).toISOString()
      reply = await (await agentFor(w)).call('broadcast_schedule', { id, at })
    })

    it('is refused', () => {
      expect(reply.text).toContain('allow_dev_links')
    })

    it('leaves it a draft', async () => {
      expect(await statusOf(w, id)).toBe('draft')
    })
  })

  describe('Scenario: the REST API sends a broadcast with a dev link', () => {
    let w: World
    let status: number
    let code: string

    beforeAll(async () => {
      w = await agentWorld()
      await aPerson(w)
      const id = await aBroadcast(w, { body: DEV_BODY })
      const { token } = await createApiKey(w.db, 'Spec', 'admin')
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      const pre = (await (await w.fetch(`/api/v1/broadcasts/${id}/preflight`, { method: 'POST', headers })).json()) as {
        data: { preflight_token: string }
      }
      const res = await w.fetch(`/api/v1/broadcasts/${id}/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ preflight_token: pre.data.preflight_token }),
      })
      status = res.status
      code = ((await res.json()) as { error: { code: string } }).error.code
    })

    it('answers 422', () => {
      expect(status).toBe(422)
    })

    it('says why in the error code', () => {
      expect(code).toBe('dev_links')
    })

    it('⭐ sends nothing', async () => {
      expect(await w.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: a broadcast built from the editor’s document', () => {
    let html: string

    beforeAll(async () => {
      const w = createWorld()
      await aPerson(w)
      const id = await createBroadcast(w.db, {
        subject: 'From the editor',
        bodyMd: '',
        bodyJson: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'here', marks: [{ type: 'link', attrs: { href: 'http://10.1.2.3/x' } }] }],
            },
          ],
        },
      })
      html = await (await w.fetch(`/broadcasts/${id}/send`)).text()
    })

    it('is caught the same way', () => {
      expect(html).toContain('http://10.1.2.3/x')
    })
  })

  describe('Scenario: saving a sequence step with a dev link', () => {
    let res: Response

    beforeAll(async () => {
      const w = createWorld()
      const seq = await aSequence(w, { active: false })
      const stepId = seq.stepIds[0]!
      res = await w.post(`/sequences/${seq.id}/steps/${stepId}`, { subject: 'Day one', body: DEV_BODY })
    })

    it('saves and warns, naming the link', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('http://localhost:5555/courses')
    })
  })
})
