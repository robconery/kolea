// gap.md "MCP by URL with OAuth" — add the mailer to Claude by pasting a URL
// and approving it; no key to copy.
// Ports Kōlea SPEC 20.3 (MCP authorization: discovery, RFC 7591 registration,
// code + PKCE S256, operator approval, read-only by default) and the read-only
// agent default from Kōlea's "agent keys read-only by default".
//
// Every scenario drives `worker.fetch`: the flow *is* an HTTP contract that a
// client we don't control (Claude) walks on its own. The operator's approval
// goes through the real consent page; the default world's DEV auth bypass
// stands in for Cloudflare Access, and one scenario proves the page is behind
// Access when the bypass is off.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createApiKey } from '../../src/core/api-keys.ts'
import { pkceChallenge } from '../../src/core/oauth.ts'
import { mcpCalls, oauthCodes, oauthGrants, oauthTokens } from '../../src/db/schema.ts'
import { createWorld, PUBLIC_URL, type World } from '../support/world.ts'

const REDIRECT = 'https://claude.example.test/api/mcp/auth_callback'

interface Client {
  client_id: string
}

interface Tokens {
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string
  token_type: string
}

async function register(world: World, body: unknown) {
  return await world.fetch('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function aClient(world: World, name = 'Claude'): Promise<Client> {
  return (await (await register(world, { client_name: name, redirect_uris: [REDIRECT] })).json()) as Client
}

async function pkce() {
  const verifier = `${crypto.randomUUID()}-${crypto.randomUUID()}`
  return { verifier, challenge: await pkceChallenge(verifier) }
}

function authorizeFields(client: Client, challenge: string, extra: Record<string, string> = {}) {
  return {
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz-state',
    resource: `${PUBLIC_URL}/mcp`,
    ...extra,
  }
}

/** The operator presses Connect (optionally ticking "allow changes"). Returns the redirect. */
async function operatorApproves(world: World, client: Client, challenge: string, allowChanges = false) {
  const res = await world.post('/oauth/authorize', {
    ...authorizeFields(client, challenge),
    decision: 'approve',
    ...(allowChanges ? { allow_changes: 'on' } : {}),
  })
  return new URL(res.headers.get('location') ?? 'about:blank')
}

async function token(world: World, form: Record<string, string>) {
  return await world.post('/oauth/token', form)
}

async function redeem(world: World, client: Client, code: string, verifier: string) {
  return await token(world, {
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
  })
}

/** The whole dance, as Claude does it. Returns the tokens. */
async function connect(world: World, allowChanges = false) {
  const client = await aClient(world)
  const { verifier, challenge } = await pkce()
  const back = await operatorApproves(world, client, challenge, allowChanges)
  const res = await redeem(world, client, back.searchParams.get('code') ?? '', verifier)
  return { client, tokens: (await res.json()) as Tokens }
}

/** One MCP tool call on `/mcp` with a bearer token. Returns status and the JSON-RPC result. */
async function callTool(world: World, accessToken: string | null, name: string, args: unknown = {}) {
  const res = await world.fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const text = await res.text()
  const data = /^data: (.*)$/m.exec(text)?.[1]
  const result = data ? (JSON.parse(data).result as { isError?: boolean; content: { text: string }[] }) : null
  return { status: res.status, headers: res.headers, result }
}

describe('Feature: adding the mailer to Claude by pasting a URL', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: Claude is handed the URL and finds where to sign in', () => {
    let unauthorized: { status: number; headers: Headers }
    let resource: { resource: string; authorization_servers: string[] }
    let server: Record<string, unknown>

    beforeAll(async () => {
      const world = createWorld()
      unauthorized = await callTool(world, null, 'tag_list')
      const metadataUrl = /resource_metadata="([^"]+)"/.exec(
        unauthorized.headers.get('www-authenticate') ?? '',
      )?.[1]
      resource = (await (await world.fetch(metadataUrl ?? '/nowhere')).json()) as typeof resource
      server = (await (
        await world.fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)
      ).json()) as Record<string, unknown>
    })

    it('answers /mcp without a token with a 401', () => {
      expect(unauthorized.status).toBe(401)
    })

    it('points the 401 at the protected resource metadata', () => {
      expect(unauthorized.headers.get('www-authenticate')).toContain(
        `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
      )
    })

    it('names /mcp as the protected resource', () => {
      expect(resource.resource).toBe(`${PUBLIC_URL}/mcp`)
    })

    it('names itself as the authorization server', () => {
      expect(resource.authorization_servers).toEqual([PUBLIC_URL])
    })

    it('offers dynamic client registration', () => {
      expect(server.registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`)
    })

    it('supports only PKCE S256', () => {
      expect(server.code_challenge_methods_supported).toEqual(['S256'])
    })

    it('offers refresh tokens', () => {
      expect(server.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    })

    it('offers revocation', () => {
      expect(server.revocation_endpoint).toBe(`${PUBLIC_URL}/oauth/revoke`)
    })
  })

  describe('Scenario: the operator approves Claude, and Claude uses the mailer', () => {
    let world: World
    let registered: Response
    let consentPage: string
    let back: URL
    let exchanged: Response
    let tokens: Tokens
    let call: Awaited<ReturnType<typeof callTool>>
    let connectedApps: string

    beforeAll(async () => {
      world = createWorld()
      registered = await register(world, { client_name: 'Claude', redirect_uris: [REDIRECT] })
      const client = (await registered.clone().json()) as Client
      const { verifier, challenge } = await pkce()

      const query = new URLSearchParams(authorizeFields(client, challenge, { scope: 'mcp:read' }))
      consentPage = await (await world.fetch(`/oauth/authorize?${query}`)).text()

      back = await operatorApproves(world, client, challenge)
      exchanged = await redeem(world, client, back.searchParams.get('code') ?? '', verifier)
      tokens = (await exchanged.clone().json()) as Tokens
      call = await callTool(world, tokens.access_token, 'tag_list')
      connectedApps = await (await world.fetch('/connected-apps')).text()
    })

    it('registers the client', () => {
      expect(registered.status).toBe(201)
    })

    it('shows the operator the app’s name', () => {
      expect(consentPage).toContain('Connect Claude?')
    })

    it('shows the operator where the code will go', () => {
      expect(consentPage).toContain(REDIRECT)
    })

    it('leaves "allow changes" unticked', () => {
      expect(consentPage).not.toMatch(/name="allow_changes"[^>]*checked/)
    })

    it('sends the browser back to the registered redirect URI', () => {
      expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
    })

    it('hands the state back unchanged', () => {
      expect(back.searchParams.get('state')).toBe('xyz-state')
    })

    it('names the issuer on the way back (RFC 9207)', () => {
      expect(back.searchParams.get('iss')).toBe(PUBLIC_URL)
    })

    it('exchanges the code and verifier for tokens', () => {
      expect(exchanged.status).toBe(200)
    })

    it('marks the token response uncacheable', () => {
      expect(exchanged.headers.get('cache-control')).toBe('no-store')
    })

    it('issues a short-lived access token', () => {
      expect(tokens.expires_in).toBe(3600)
    })

    it('issues a refresh token', () => {
      expect(tokens.refresh_token.length).toBeGreaterThan(40)
    })

    it('grants read-only scope by default', () => {
      expect(tokens.scope).toBe('mcp:read')
    })

    it('stores only a hash of the access token', async () => {
      const rows = await world.db.select().from(oauthTokens).all()
      expect(rows.some((r) => r.tokenHash === tokens.access_token)).toBe(false)
    })

    it('lets Claude call a tool on /mcp', () => {
      expect(call.result?.isError).toBeUndefined()
    })

    it('records the call against the connection', async () => {
      const row = await world.db.select().from(mcpCalls).where(eq(mcpCalls.tool, 'tag_list')).get()
      expect(row?.oauthGrantId).toBeNumber()
    })

    it('stamps when the connection was last used', async () => {
      const grant = await world.db.select().from(oauthGrants).get()
      expect(grant?.lastUsedAt).toBeInstanceOf(Date)
    })

    it('lists Claude on Connected apps', () => {
      expect(connectedApps).toContain('Read only')
    })
  })

  describe('Scenario: a read-only connection reaches for a tool that changes things', () => {
    let call: Awaited<ReturnType<typeof callTool>>
    let audited: string | undefined

    beforeAll(async () => {
      const world = createWorld()
      const { tokens } = await connect(world)
      call = await callTool(world, tokens.access_token, 'tag_create', { name: 'vip' })
      audited = (await world.db.select().from(mcpCalls).where(eq(mcpCalls.tool, 'tag_create')).get())
        ?.outcome
    })

    it('is refused', () => {
      expect(call.result?.content[0]?.text).toContain('read-only')
    })

    it('is audited as denied', () => {
      expect(audited).toBe('denied')
    })
  })

  describe('Scenario: the operator ticks "allow changes"', () => {
    let tokens: Tokens
    let call: Awaited<ReturnType<typeof callTool>>

    beforeAll(async () => {
      const world = createWorld()
      ;({ tokens } = await connect(world, true))
      call = await callTool(world, tokens.access_token, 'tag_create', { name: 'vip' })
    })

    it('grants write scope', () => {
      expect(tokens.scope).toBe('mcp:read mcp:write')
    })

    it('lets Claude make a change', () => {
      expect(call.result?.isError).toBeUndefined()
    })
  })

  describe('Scenario: Claude refreshes its access token', () => {
    let refreshed: Response
    let first: Tokens
    let fresh: Tokens
    let newWorks: number

    beforeAll(async () => {
      const world = createWorld()
      const { client, tokens } = await connect(world)
      first = tokens
      refreshed = await token(world, {
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
      })
      fresh = (await refreshed.clone().json()) as Tokens
      newWorks = (await callTool(world, fresh.access_token, 'tag_list')).status
    })

    it('issues a new pair', () => {
      expect(refreshed.status).toBe(200)
    })

    it('rotates the refresh token', () => {
      expect(fresh.refresh_token).not.toBe(first.refresh_token)
    })

    it('makes the new access token work', () => {
      expect(newWorks).toBe(200)
    })
  })

  describe('Scenario: the operator says no', () => {
    let back: URL

    beforeAll(async () => {
      const world = createWorld()
      const client = await aClient(world)
      const { challenge } = await pkce()
      const res = await world.post('/oauth/authorize', { ...authorizeFields(client, challenge), decision: 'deny' })
      back = new URL(res.headers.get('location') ?? 'about:blank')
    })

    it('tells the app access was denied', () => {
      expect(back.searchParams.get('error')).toBe('access_denied')
    })
  })

  describe('Scenario: a native client registers a loopback redirect', () => {
    let status: number

    beforeAll(async () => {
      const world = createWorld()
      status = (await register(world, { client_name: 'CLI', redirect_uris: ['http://127.0.0.1:33418/callback'] }))
        .status
    })

    it('is accepted', () => {
      expect(status).toBe(201)
    })
  })

  describe('Scenario: the existing path-secret door with an admin key', () => {
    let call: Awaited<ReturnType<typeof callTool>>

    beforeAll(async () => {
      const world = createWorld({ MCP_PATH_SECRET: 'a-long-path-secret' })
      const { token: key } = await createApiKey(world.db, 'agent', 'admin')
      const res = await world.fetch('/mcp/a-long-path-secret', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'tag_create', arguments: { name: 'still-works' } },
        }),
      })
      const data = /^data: (.*)$/m.exec(await res.text())?.[1]
      call = { status: res.status, headers: res.headers, result: data ? JSON.parse(data).result : null }
    })

    it('keeps working unchanged, changes included', () => {
      expect(call.result?.content[0]?.text).toContain('"id"')
    })
  })

  // ───────────────────────────────────────────── a stolen or mangled code

  describe('Scenario: a token request with the wrong PKCE verifier', () => {
    let res: Response
    let body: { error: string }

    beforeAll(async () => {
      const world = createWorld()
      const client = await aClient(world)
      const { challenge } = await pkce()
      const other = await pkce()
      const back = await operatorApproves(world, client, challenge)
      res = await redeem(world, client, back.searchParams.get('code') ?? '', other.verifier)
      body = (await res.clone().json()) as { error: string }
    })

    it('is refused', () => {
      expect(res.status).toBe(400)
    })

    it('says invalid_grant and nothing more specific', () => {
      expect(body.error).toBe('invalid_grant')
    })
  })

  describe('Scenario: a code redeemed twice', () => {
    let second: { error: string }
    let firstTokenAfter: number

    beforeAll(async () => {
      const world = createWorld()
      const client = await aClient(world)
      const { verifier, challenge } = await pkce()
      const code = (await operatorApproves(world, client, challenge)).searchParams.get('code') ?? ''
      const first = (await (await redeem(world, client, code, verifier)).json()) as Tokens
      second = (await (await redeem(world, client, code, verifier)).json()) as { error: string }
      firstTokenAfter = (await callTool(world, first.access_token, 'tag_list')).status
    })

    it('is refused the second time', () => {
      expect(second.error).toBe('invalid_grant')
    })

    it('⭐ revokes what the first redemption issued', () => {
      expect(firstTokenAfter).toBe(401)
    })
  })

  describe('Scenario: a code redeemed by a different client', () => {
    let body: { error: string }

    beforeAll(async () => {
      const world = createWorld()
      const client = await aClient(world)
      const thief = await aClient(world, 'Not Claude')
      const { verifier, challenge } = await pkce()
      const code = (await operatorApproves(world, client, challenge)).searchParams.get('code') ?? ''
      body = (await (await redeem(world, thief, code, verifier)).json()) as { error: string }
    })

    it('is refused', () => {
      expect(body.error).toBe('invalid_grant')
    })
  })

  describe('Scenario: a code redeemed after its two minutes', () => {
    let body: { error: string }

    beforeAll(async () => {
      const world = createWorld()
      const client = await aClient(world)
      const { verifier, challenge } = await pkce()
      const code = (await operatorApproves(world, client, challenge)).searchParams.get('code') ?? ''
      await world.db.update(oauthCodes).set({ expiresAt: new Date(Date.now() - 1000) })
      body = (await (await redeem(world, client, code, verifier)).json()) as { error: string }
    })

    it('is refused', () => {
      expect(body.error).toBe('invalid_grant')
    })
  })

  describe('Scenario: an old refresh token comes back after rotation', () => {
    let replay: { error: string }
    let newestAfter: number

    beforeAll(async () => {
      const world = createWorld()
      const { client, tokens } = await connect(world)
      const form = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token }
      const fresh = (await (await token(world, form)).json()) as Tokens
      replay = (await (await token(world, form)).json()) as { error: string }
      newestAfter = (await callTool(world, fresh.access_token, 'tag_list')).status
    })

    it('is refused', () => {
      expect(replay.error).toBe('invalid_grant')
    })

    it('⭐ ends the whole connection, newest token included', () => {
      expect(newestAfter).toBe(401)
    })
  })

  describe('Scenario: an access token past its hour', () => {
    let status: number

    beforeAll(async () => {
      const world = createWorld()
      const { tokens } = await connect(world)
      await world.db
        .update(oauthTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(oauthTokens.kind, 'access'))
      status = (await callTool(world, tokens.access_token, 'tag_list')).status
    })

    it('is refused', () => {
      expect(status).toBe(401)
    })
  })

  // ───────────────────────────────────────────── revoking

  describe('Scenario: the operator disconnects the app on Connected apps', () => {
    let afterAccess: Awaited<ReturnType<typeof callTool>>
    let afterRefresh: { error: string }
    let page: string

    beforeAll(async () => {
      const world = createWorld()
      const { client, tokens } = await connect(world)
      const grant = await world.db.select().from(oauthGrants).get()
      await world.post(`/connected-apps/${grant?.id}/revoke`, {})
      afterAccess = await callTool(world, tokens.access_token, 'tag_list')
      afterRefresh = (await (
        await token(world, {
          grant_type: 'refresh_token',
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
        })
      ).json()) as { error: string }
      page = await (await world.fetch('/connected-apps')).text()
    })

    it('makes the access token 401', () => {
      expect(afterAccess.status).toBe(401)
    })

    it('says why in the challenge', () => {
      expect(afterAccess.headers.get('www-authenticate')).toContain('error="invalid_token"')
    })

    it('makes the refresh token useless', () => {
      expect(afterRefresh.error).toBe('invalid_grant')
    })

    it('shows it as disconnected', () => {
      expect(page).toContain('Disconnected')
    })
  })

  describe('Scenario: the app revokes its own refresh token (RFC 7009)', () => {
    let status: number
    let after: number

    beforeAll(async () => {
      const world = createWorld()
      const { client, tokens } = await connect(world)
      status = (
        await world.post('/oauth/revoke', {
          token: tokens.refresh_token,
          token_type_hint: 'refresh_token',
          client_id: client.client_id,
        })
      ).status
      after = (await callTool(world, tokens.access_token, 'tag_list')).status
    })

    it('answers 200', () => {
      expect(status).toBe(200)
    })

    it('ends the connection', () => {
      expect(after).toBe(401)
    })
  })

  // ───────────────────────────────────────────── refusing bad requests

  describe('Scenario: registering a plain-http redirect to somewhere else', () => {
    let body: { error: string }

    beforeAll(async () => {
      const world = createWorld()
      body = (await (await register(world, { redirect_uris: ['http://evil.example.test/cb'] })).json()) as {
        error: string
      }
    })

    it('is refused as an invalid redirect URI', () => {
      expect(body.error).toBe('invalid_redirect_uri')
    })
  })

  describe('Scenario: registering a redirect with a fragment', () => {
    let status: number

    beforeAll(async () => {
      const world = createWorld()
      status = (await register(world, { redirect_uris: ['https://app.example.test/cb#frag'] })).status
    })

    it('is refused', () => {
      expect(status).toBe(400)
    })
  })

  describe('Scenario: registering a custom-scheme redirect', () => {
    let status: number

    beforeAll(async () => {
      const world = createWorld()
      status = (await register(world, { redirect_uris: ['myapp://callback'] })).status
    })

    it('is refused', () => {
      expect(status).toBe(400)
    })
  })

  describe('Scenario: an authorization request for a redirect URI the client never registered', () => {
    let res: Response

    beforeAll(async () => {
      const world = createWorld()
      const client = await aClient(world)
      const { challenge } = await pkce()
      const query = new URLSearchParams(
        authorizeFields(client, challenge, { redirect_uri: 'https://evil.example.test/cb' }),
      )
      res = await world.fetch(`/oauth/authorize?${query}`)
    })

    it('is shown as an error page, never redirected to', () => {
      expect(res.status).toBe(400)
    })
  })

  describe('Scenario: an authorization request without PKCE', () => {
    let back: URL

    beforeAll(async () => {
      const world = createWorld()
      const client = await aClient(world)
      const fields: Record<string, string> = authorizeFields(client, 'x')
      delete fields.code_challenge
      delete fields.code_challenge_method
      const res = await world.fetch(`/oauth/authorize?${new URLSearchParams(fields)}`)
      back = new URL(res.headers.get('location') ?? 'about:blank')
    })

    it('goes back to the app with invalid_request', () => {
      expect(back.searchParams.get('error')).toBe('invalid_request')
    })
  })

  describe('Scenario: an approval posted from another site', () => {
    let status: number
    let codes: number

    beforeAll(async () => {
      const world = createWorld()
      const client = await aClient(world)
      const { challenge } = await pkce()
      status = (
        await world.fetch('/oauth/authorize', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example.test' },
          body: new URLSearchParams({ ...authorizeFields(client, challenge), decision: 'approve' }),
        })
      ).status
      codes = (await world.db.select().from(oauthCodes).all()).length
    })

    it('is refused', () => {
      expect(status).toBe(403)
    })

    it('mints no code', () => {
      expect(codes).toBe(0)
    })
  })

  describe('Scenario: production, with Cloudflare Access on and no bypass', () => {
    let consent: number
    let connectedApps: number
    let metadata: number
    let tokenEndpoint: number
    let mcp: number

    beforeAll(async () => {
      const world = createWorld({
        DEV_AUTH_BYPASS: undefined,
        CF_ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
        CF_ACCESS_AUD: 'an-audience-tag',
      })
      const client = await aClient(world)
      const { challenge } = await pkce()
      consent = (await world.fetch(`/oauth/authorize?${new URLSearchParams(authorizeFields(client, challenge))}`))
        .status
      connectedApps = (await world.fetch('/connected-apps')).status
      metadata = (await world.fetch('/.well-known/oauth-authorization-server')).status
      tokenEndpoint = (await token(world, { grant_type: 'authorization_code', client_id: client.client_id })).status
      mcp = (await callTool(world, null, 'tag_list')).status
    })

    it('⭐ keeps the consent page behind Access', () => {
      expect(consent).toBe(403)
    })

    it('keeps Connected apps behind Access', () => {
      expect(connectedApps).toBe(403)
    })

    it('serves discovery without Access', () => {
      expect(metadata).toBe(200)
    })

    it('answers the token endpoint from its own rules, not Access', () => {
      expect(tokenEndpoint).toBe(400)
    })

    it('answers /mcp with its own 401, not 403 from Access', () => {
      expect(mcp).toBe(401)
    })
  })
})
