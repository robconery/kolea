// Review fixes on the parity branch: security findings from the branch review.
// - Cross-site form posts to the console are refused (CSRF on cookie auth).
// - db_query never reads credentials or tokens, and read-only grants get none of it.
// - An uploaded theme's files are never served on the console's origin.
// - The admin's own /webhooks/:id screens are not swallowed by the provider route.
import { beforeAll, describe, expect, it } from 'bun:test'
import { agentFor, MCP_SECRET, type ToolReply } from '../support/mcp.ts'
import { createWorld, type World } from '../support/world.ts'

describe('Feature: the console refuses what it should', () => {
  describe('Scenario: another site tries to post a form to the console', () => {
    let world: World
    let crossSite: Response
    let sameSite: Response

    beforeAll(async () => {
      world = createWorld()
      const body = new URLSearchParams({ switch: 'send', value: 'on' })
      crossSite = await world.fetch('/settings/agents/switches', {
        method: 'POST',
        body,
        headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      })
      sameSite = await world.fetch('/settings/agents/switches', {
        method: 'POST',
        body: new URLSearchParams({ switch: 'send', value: 'off' }),
        headers: { 'sec-fetch-site': 'same-origin' },
      })
    })

    it('⭐ refuses the cross-site post', () => {
      expect(crossSite.status).toBe(403)
    })

    it('lets the console post to itself', () => {
      expect(sameSite.status).not.toBe(403)
    })
  })

  describe('Scenario: an agent asks db_query for secrets', () => {
    let world: World
    let secrets: ToolReply
    let tokens: ToolReply
    let ordinary: ToolReply

    beforeAll(async () => {
      world = createWorld({ MCP_PATH_SECRET: MCP_SECRET })
      const agent = await agentFor(world)
      secrets = await agent.call('db_query', { sql: 'select secret from webhook_endpoints' })
      tokens = await agent.call('db_query', { sql: 'select email, unsub_token from subscribers' })
      ordinary = await agent.call('db_query', { sql: 'select count(*) as n from subscribers' })
    })

    it('⭐ refuses webhook signing secrets', () => {
      expect(secrets.isError).toBe(true)
    })

    it('⭐ refuses preference-center tokens', () => {
      expect(tokens.isError).toBe(true)
    })

    it('still answers an ordinary question', () => {
      expect(ordinary.isError).toBe(false)
    })
  })

  describe('Scenario: someone opens an uploaded theme file on the console host', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      await world.env.MEDIA.put('themes/3/assets/logo.svg', '<svg><script>alert(1)</script></svg>', {
        httpMetadata: { contentType: 'image/svg+xml' },
      })
      response = await world.fetch('/media/themes/3/assets/logo.svg')
    })

    it('⭐ is not served there', () => {
      expect(response.status).toBe(404)
    })
  })

  describe('Scenario: the operator edits a webhook endpoint', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      await world.post('/webhooks', { url: 'https://hooks.example.com/in', events: 'subscribed' })
      response = await world.post('/webhooks/1', { url: 'https://hooks.example.com/in2', events: 'subscribed' })
    })

    it('reaches the admin screen, not the provider route', () => {
      expect(response.status).toBe(303)
    })
  })
})
