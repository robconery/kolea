// STORY-020 — The admin console is not on the public internet
// SPEC 8.1, 8.2
//
// The application holds no password: Cloudflare Access terminates identity at
// the edge. That makes the route table itself the security boundary, and this
// Feature is what keeps it honest — a new admin screen mounted above
// `app.use('*', requireOperator)` in `worker.tsx` would be an open admin
// console, and nothing else in the suite would notice.
//
// ⚠️ Every scenario here builds a world WITHOUT `DEV_AUTH_BYPASS`. The default
// world sets it, because the rest of the suite is about what the operator can
// do once they are in.
import { beforeAll, describe, expect, it } from 'bun:test'
import type { Env } from '../../src/types.ts'
import { createApiKey } from '../../src/core/api-keys.ts'
import { aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

/** A Worker deployed the way production is: Access configured, no bypass. */
function guardedWorld(overrides: Partial<Env> = {}): World {
  return createWorld({
    DEV_AUTH_BYPASS: undefined,
    CF_ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
    CF_ACCESS_AUD: 'an-audience-tag',
    ...overrides,
  })
}

describe('Feature: the admin console sits behind Cloudflare Access', () => {
  // ───────────────────────────────────────────── happy path
  //
  // The four public surfaces of SPEC 8.2, each reached with no credentials at
  // all. These have to stay open: a tracking pixel in mail sent two years ago
  // has no way to do an Access login, and a single Allow policy on the
  // hostname would break every one of them permanently.

  describe('Scenario: the preference center, with no credentials', () => {
    let world: World
    let status: number

    beforeAll(async () => {
      world = guardedWorld()
      const reader = await aPerson(world)
      status = (await world.fetch(`/p/${reader.unsubToken}`)).status
    })

    it('is served', () => {
      expect(status).toBe(200)
    })
  })

  describe('Scenario: the tracking pixel, with no credentials', () => {
    let world: World
    let status: number

    beforeAll(async () => {
      world = guardedWorld()
      status = (await world.fetch('/t/open/1.gif')).status
    })

    it('is served', () => {
      expect(status).toBe(200)
    })
  })

  describe('Scenario: the signup endpoint, with no credentials', () => {
    let world: World
    let status: number

    beforeAll(async () => {
      world = guardedWorld()
      status = (await world.post('/subscribe', { email: 'joiner@example.test' })).status
    })

    it('accepts the signup', () => {
      expect(status).toBe(200)
    })
  })

  describe('Scenario: the transactional API, with a valid bearer key', () => {
    // Public to Access, guarded by its own credential. Both halves matter.
    let world: World
    let status: number

    beforeAll(async () => {
      world = guardedWorld()
      const { token } = await createApiKey(world.db, 'the checkout')
      status = (
        await world.fetch('/api/send', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ to: 'buyer@example.test', subject: 'Hi', body: 'There' }),
        })
      ).status
      await world.settle()
    })

    it('is reachable without an Access session', () => {
      expect(status).toBe(202)
    })
  })

  describe('Scenario: the transactional API, with no bearer key', () => {
    let world: World
    let status: number

    beforeAll(async () => {
      world = guardedWorld()
      status = (
        await world.fetch('/api/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status
    })

    it('answers 401 from its own auth, not 403 from Access', () => {
      expect(status).toBe(401)
    })
  })

  // ───────────────────────────────────────────── sad path
  //
  // Everything else. One `it` per screen is deliberate: this list is the thing
  // a reviewer scans when a new route is added.

  describe('Scenario: admin screens reached without an Access token', () => {
    let world: World
    const forbidden = async (path: string) => (await world.fetch(path)).status

    beforeAll(() => {
      world = guardedWorld()
    })

    it('guards the dashboard', async () => {
      expect(await forbidden('/')).toBe(403)
    })

    it('guards the subscriber list', async () => {
      expect(await forbidden('/subscribers')).toBe(403)
    })

    it('guards the broadcast list', async () => {
      expect(await forbidden('/broadcasts')).toBe(403)
    })

    it('guards the composer', async () => {
      expect(await forbidden('/broadcasts/new')).toBe(403)
    })

    it('guards the sequence screens', async () => {
      expect(await forbidden('/sequences')).toBe(403)
    })

    it('guards the tag screens', async () => {
      expect(await forbidden('/tags')).toBe(403)
    })
  })

  describe('Scenario: a fabricated Access header', () => {
    // ⭐ Presence of `Cf-Access-Jwt-Assertion` proves nothing — anybody who can
    // reach the origin can set a header. The signature is what counts.
    let world: World
    let status: number

    beforeAll(async () => {
      world = guardedWorld()
      status = (
        await world.fetch('/', { headers: { 'Cf-Access-Jwt-Assertion': 'made.up.token' } })
      ).status
    })

    it('is refused', () => {
      expect(status).toBe(403)
    })
  })

  describe('Scenario: a Worker deployed with Access not configured', () => {
    // ⭐ It fails closed. A misconfigured deploy locks the operator out, which
    // is the correct direction to fail — the other way is the whole list
    // walking out of an open console.
    let world: World
    let status: number
    let body: string

    beforeAll(async () => {
      world = createWorld({ DEV_AUTH_BYPASS: undefined })
      const response = await world.fetch('/')
      status = response.status
      body = await response.text()
    })

    it('is refused', () => {
      expect(status).toBe(403)
    })

    it('says what is missing, so the operator can fix it', () => {
      expect(body).toContain('Cloudflare Access is not configured')
    })
  })

  describe('Scenario: a crawler asking for robots.txt', () => {
    // Above the gate on purpose: a crawler has no Access session, and the
    // whole point of the file is that it reaches one.
    let world: World
    let body: string

    beforeAll(async () => {
      world = guardedWorld()
      body = await (await world.fetch('/robots.txt')).text()
    })

    it('tells it to go away, rather than returning a login page', () => {
      expect(body).toContain('Disallow: /')
    })
  })

  describe('Scenario: the MCP endpoint with no path secret configured', () => {
    // MCP is off unless deliberately turned on — an unset secret 404s rather
    // than exposing 103 tools ahead of the Access gate.
    let world: World
    let status: number

    beforeAll(async () => {
      world = guardedWorld()
      status = (await world.fetch('/mcp/anything', { method: 'POST', body: '{}' })).status
    })

    it('is not found', () => {
      expect(status).toBe(404)
    })
  })
})
