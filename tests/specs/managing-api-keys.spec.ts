// gap.md "API key screen" — create and revoke keys in the admin
// SPEC 7.7, 8.3. Ported from Kōlea SPEC 20.1 (the `send` / `read` / `admin`
// scopes, `send` the default) and 20.3 (MCP takes an `admin` key).
//
// The operator makes keys on Agents & keys (`/settings/agents`), sees each
// one's scope, creation, last use and revocation, and revokes them there. The
// raw token is shown once, in the response to the create, and only its hash is
// stored. A revoked key stops working on its very next request, on
// `/api/send` and on MCP alike.
//
// Decision: `read` reaches only the REST API's GETs (`/api/v1`, see
// the-rest-api.spec.ts): not `/api/send`, not `/api/sales`, and not MCP, which
// stays `admin`-only rather than filtering tools by scope.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { createApiKey } from '../../src/core/api-keys.ts'
import { sha256 } from '../../src/core/ids.ts'
import { type ApiKey, apiKeys } from '../../src/db/schema.ts'
import { MCP_SECRET, callTool } from '../support/mcp.ts'
import { createWorld, type World } from '../support/world.ts'

const A_RECEIPT = { to: 'buyer@example.test', subject: 'Your order', body: 'Here it is.' }

function keysWorld(): World {
  return createWorld({ MCP_PATH_SECRET: MCP_SECRET })
}

/** Create a key on the screen; hand back the page and the token it showed. */
async function makeKeyOnScreen(world: World, form: Record<string, string>) {
  const response = await world.post('/settings/agents/keys', form)
  const html = await response.text()
  const token = /<pre class="mono code" data-token="">([^<]+)<\/pre>/.exec(html)?.[1] ?? ''
  return { response, html, token }
}

async function send(world: World, token: string) {
  return await world.fetch('/api/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(A_RECEIPT),
  })
}

async function keyNamed(world: World, name: string): Promise<ApiKey | undefined> {
  return await world.db.select().from(apiKeys).where(eq(apiKeys.name, name)).get()
}

describe('Feature: the operator makes and revokes API keys in the admin', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: Rob makes a key for his checkout', () => {
    let world: World
    let response: Response
    let html: string
    let token: string
    let row: ApiKey | undefined
    let sendStatus: number
    let laterPage: string

    beforeAll(async () => {
      world = keysWorld()
      ;({ response, html, token } = await makeKeyOnScreen(world, { name: 'Checkout webhook' }))
      row = await keyNamed(world, 'Checkout webhook')
      sendStatus = (await send(world, token)).status
      await world.settle()
      laterPage = await (await world.fetch('/settings/agents')).text()
    })

    it('shows the new key on the page that answers the create', () => {
      expect(response.status).toBe(200)
    })

    it('shows the raw token', () => {
      expect(token.length).toBeGreaterThan(20)
    })

    it('tells him it is shown only once', () => {
      expect(html).toContain('shown this once')
    })

    it('keeps the page out of every cache', () => {
      expect(response.headers.get('cache-control')).toBe('no-store')
    })

    it('stores the hash of the token', async () => {
      expect(row?.tokenHash).toBe(await sha256(token))
    })

    it('never stores the token itself', () => {
      expect(row?.tokenHash).not.toBe(token)
    })

    it("defaults to the 'send' scope", () => {
      expect(row?.scope).toBe('send')
    })

    it('works on the transactional endpoint straight away', () => {
      expect(sendStatus).toBe(202)
    })

    it('never shows the token again', () => {
      expect(laterPage).not.toContain(token)
    })
  })

  describe('Scenario: the key list says what each key is and when it was used', () => {
    let world: World
    let page: string
    let usedAt: Date | null | undefined

    beforeAll(async () => {
      world = keysWorld()
      const { token } = await createApiKey(world.db, 'The used one')
      await createApiKey(world.db, 'The agent', 'admin')
      await send(world, token)
      await world.settle()
      usedAt = (await keyNamed(world, 'The used one'))?.lastUsedAt
      page = await (await world.fetch('/settings/agents')).text()
    })

    it('lists every key by name', () => {
      expect(page.includes('The used one') && page.includes('The agent')).toBe(true)
    })

    it('shows the scope', () => {
      expect(page).toContain('<td class="mono">admin</td>')
    })

    it('stamps the last use when a key is used (SPEC 7.7)', () => {
      expect(usedAt).toBeInstanceOf(Date)
    })

    it('says "never" for a key nobody has used', () => {
      expect(page).toContain('never')
    })

    it('marks live keys live', () => {
      expect(page).toContain('<span class="pill ok">live</span>')
    })
  })

  describe('Scenario: Rob revokes a key on the screen', () => {
    let world: World
    let response: Response
    let row: ApiKey | undefined
    let sendStatus: number
    let mcpStatus: number
    let page: string

    beforeAll(async () => {
      world = keysWorld()
      const checkout = await createApiKey(world.db, 'Old checkout')
      const agent = await createApiKey(world.db, 'Old agent', 'admin')
      // Both work first, so the refusals below are the revocation's doing.
      await send(world, checkout.token)
      await callTool(world, agent.token, 'health')

      response = await world.post(`/settings/agents/keys/${checkout.id}/revoke`, {})
      await world.post(`/settings/agents/keys/${agent.id}/revoke`, {})
      row = await keyNamed(world, 'Old checkout')
      sendStatus = (await send(world, checkout.token)).status
      mcpStatus = (await callTool(world, agent.token, 'health')).status
      await world.settle()
      page = await (await world.fetch('/settings/agents')).text()
    })

    it('goes back to the key list', () => {
      expect(response.headers.get('location')).toStartWith('/settings/agents')
    })

    it('stamps the key revoked', () => {
      expect(row?.revokedAt).toBeInstanceOf(Date)
    })

    it('keeps the row, so the audit log still resolves', () => {
      expect(row?.id).toBeGreaterThan(0)
    })

    it('⭐ refuses the revoked key on /api/send immediately', () => {
      expect(sendStatus).toBe(401)
    })

    it('⭐ refuses a revoked admin key on MCP immediately', () => {
      expect(mcpStatus).toBe(401)
    })

    it('shows the key as revoked', () => {
      expect(page).toContain('pill bad">revoked')
    })
  })

  describe('Scenario: an admin key reaches MCP', () => {
    let world: World
    let call: Awaited<ReturnType<typeof callTool>>

    beforeAll(async () => {
      world = keysWorld()
      const { token } = await makeKeyOnScreen(world, { name: 'Claude', scope: 'admin' })
      call = await callTool(world, token, 'health')
    })

    it('gets an answer from a tool', () => {
      expect(call.result?.isError).toBeUndefined()
    })
  })

  describe('Scenario: an agent mints a read key over MCP', () => {
    let world: World
    let row: ApiKey | undefined

    beforeAll(async () => {
      world = keysWorld()
      const { token } = await createApiKey(world.db, 'Claude', 'admin')
      // Minting is a sensitive change (the-agent-switches.spec.ts).
      await world.post('/settings/agents/switches', { switch: 'sensitive', value: 'on' })
      await callTool(world, token, 'apikey_create', { name: 'Reporting', scope: 'read' })
      row = await keyNamed(world, 'Reporting')
    })

    it("stores it with the 'read' scope", () => {
      expect(row?.scope).toBe('read')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a read key tries to send and to reach MCP', () => {
    let world: World
    let sendStatus: number
    let salesStatus: number
    let mcpStatus: number

    beforeAll(async () => {
      world = keysWorld()
      const { token } = await makeKeyOnScreen(world, { name: 'Reporting', scope: 'read' })
      sendStatus = (await send(world, token)).status
      salesStatus = (
        await world.fetch('/api/sales', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ email: 'buyer@example.test', amount_cents: 100 }),
        })
      ).status
      mcpStatus = (await callTool(world, token, 'health')).status
      await world.settle()
    })

    it('⭐ cannot send transactional mail', () => {
      expect(sendStatus).toBe(401)
    })

    it('cannot record a sale', () => {
      expect(salesStatus).toBe(401)
    })

    it('⭐ cannot reach MCP', () => {
      expect(mcpStatus).toBe(401)
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: a send key tries to reach MCP', () => {
    let world: World
    let mcpStatus: number

    beforeAll(async () => {
      world = keysWorld()
      const { token } = await createApiKey(world.db, 'Checkout')
      mcpStatus = (await callTool(world, token, 'health')).status
    })

    it('is refused at the door', () => {
      expect(mcpStatus).toBe(401)
    })
  })

  describe('Scenario: a key with no name', () => {
    let world: World
    let response: Response
    let keys: number | undefined

    beforeAll(async () => {
      world = keysWorld()
      response = await world.post('/settings/agents/keys', { name: '   ', scope: 'send' })
      keys = (await world.db.select({ n: count() }).from(apiKeys).get())?.n
    })

    it('goes back with a warning', () => {
      expect(response.headers.get('location')).toContain('kind=warn')
    })

    it('makes no key', () => {
      expect(keys).toBe(0)
    })
  })

  describe('Scenario: a scope that does not exist', () => {
    let world: World
    let keys: number | undefined

    beforeAll(async () => {
      world = keysWorld()
      await world.post('/settings/agents/keys', { name: 'Sneaky', scope: 'root' })
      keys = (await world.db.select({ n: count() }).from(apiKeys).get())?.n
    })

    it('is refused rather than read as some other scope', () => {
      expect(keys).toBe(0)
    })
  })

  describe('Scenario: revoking a key twice', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = keysWorld()
      const { id } = await createApiKey(world.db, 'Gone')
      await world.post(`/settings/agents/keys/${id}/revoke`, {})
      response = await world.post(`/settings/agents/keys/${id}/revoke`, {})
    })

    it('says it was already revoked', () => {
      expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('already revoked')
    })
  })

  describe('Scenario: somebody without an Access session opens the key screen', () => {
    let world: World
    let status: number

    beforeAll(async () => {
      world = createWorld({
        DEV_AUTH_BYPASS: undefined,
        CF_ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
        CF_ACCESS_AUD: 'an-audience-tag',
      })
      status = (await world.fetch('/settings/agents')).status
    })

    it('is turned away', () => {
      expect(status).toBe(403)
    })
  })
})
