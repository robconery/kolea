// gap.md "Audit trail" — every change by a person, key or agent is recorded,
// refusals included.
// Ported from Kōlea SPEC 4.7 (every state-changing action by a user, API key or
// MCP call writes an audit row: actor, action, target, time, and for refusals
// the reason) and 20.3 (MCP calls audited with outcome ok / error / denied).
//
// Console writes and API-key writes are recorded by one middleware
// (`web/audit.ts`); agent calls were already in `mcp_calls`. The Logs page
// reads both. Every scenario drives `worker.fetch`.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { desc } from 'drizzle-orm'
import { createApiKey } from '../../src/core/api-keys.ts'
import { summarize } from '../../src/core/audit.ts'
import type { AuditEntry } from '../../src/db/schema.ts'
import { auditEntries } from '../../src/db/schema.ts'
import { aBroadcast, aTag } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const TEAM = 'audit-spec.cloudflareaccess.com'
const AUD = 'audit-spec-aud'
const MCP_SECRET = 'audit-spec-secret'

// ───────────────────────────────────────────── a real, signed Access token

const b64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

let realFetch: typeof fetch

/**
 * Signs an Access JWT for `email` and serves the matching JWKS, so the console
 * runs its real verification (`web/auth.ts`) and the audit row carries the
 * identity Access vouched for — not a header anyone could set.
 */
async function accessTokenFor(email: string): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = { ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey), kid: 'k1' }
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === `https://${TEAM}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } })
    }
    return await realFetch(input)
  }) as typeof fetch

  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1' }))
  const body = b64url(
    JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email }),
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`)),
  )
  return `${head}.${body}.${b64url(sig)}`
}

function form(token: string | null, fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(token ? { 'cf-access-jwt-assertion': token } : {}),
    },
    body: new URLSearchParams(fields),
  }
}

function json(token: string | null, payload: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  }
}

async function trail(world: World): Promise<AuditEntry[]> {
  return await world.db.select().from(auditEntries).orderBy(desc(auditEntries.id)).all()
}

describe('Feature: the audit trail', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the operator creates a tag in the console', () => {
    let world: World
    let row: AuditEntry | undefined

    beforeAll(async () => {
      world = createWorld({ DEV_AUTH_BYPASS: 'false', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD })
      const token = await accessTokenFor('rob@example.test')
      await world.fetch('/tags', form(token, { name: 'Ruby', password: 'hunter2' }))
      row = (await trail(world))[0]
    })

    afterAll(() => {
      globalThis.fetch = realFetch
    })

    it('records it as the operator', () => {
      expect(row?.actorKind).toBe('operator')
    })

    it('names the operator by the email Access verified', () => {
      expect(row?.actorId).toBe('rob@example.test')
    })

    it('says what was done', () => {
      expect(row?.action).toBe('POST /tags')
    })

    it('records that it went through', () => {
      expect(row?.outcome).toBe('ok')
    })

    it('keeps the allowlisted field, and nothing that looks like a secret', () => {
      expect(row?.summary).toEqual({ name: 'Ruby' })
    })
  })

  describe('Scenario: an application sends mail with its key', () => {
    let row: AuditEntry | undefined
    let keyId: number

    beforeAll(async () => {
      const world = createWorld()
      const key = await createApiKey(world.db, 'the checkout')
      keyId = key.id
      await world.fetch(
        '/api/send',
        json(key.token, { to: 'buyer@example.test', subject: 'Your order', body: 'A secret download link' }),
      )
      row = (await trail(world))[0]
    })

    it('records it as the key', () => {
      expect(row?.actorKind).toBe('key')
    })

    it('records which key', () => {
      expect(row?.apiKeyId).toBe(keyId)
    })

    it('records that it went through', () => {
      expect(row?.outcome).toBe('ok')
    })

    it('keeps the subject but not the body', () => {
      expect(row?.summary).toEqual({ subject: 'Your order' })
    })
  })

  describe('Scenario: reading a page', () => {
    let rows: AuditEntry[]

    beforeAll(async () => {
      const world = createWorld()
      await world.fetch('/tags')
      rows = await trail(world)
    })

    it('is not a change, so it is not recorded', () => {
      expect(rows).toHaveLength(0)
    })
  })

  describe('Scenario: the operator reads the audit trail on the Logs page', () => {
    let html: string

    beforeAll(async () => {
      const world = createWorld({ MCP_PATH_SECRET: MCP_SECRET })
      await world.fetch('/tags', form(null, { name: 'Ruby' }))
      const { token } = await createApiKey(world.db, 'my agent', 'admin')
      // Read to the end: the MCP response streams, and the call runs as it is read.
      const res = await world.fetch(`/mcp/${MCP_SECRET}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tag_list', arguments: {} } }),
      })
      await res.text()
      html = await (await world.fetch('/logs?category=audit')).text()
    })

    it('shows the console change', () => {
      expect(html).toContain('The operator: POST /tags')
    })

    it('folds in what the agent did', () => {
      expect(html).toMatch(/Agent \(key (&quot;|")my agent(&quot;|")\) called tag_list/)
    })
  })

  // ───────────────────────────────────────────── refusals are recorded too

  describe('Scenario: the console refuses a rename', () => {
    let row: AuditEntry | undefined
    let tagId: number

    beforeAll(async () => {
      const world = createWorld()
      tagId = await aTag(world, 'Ruby')
      await world.fetch(`/tags/${tagId}/rename`, form(null, { name: '' }))
      row = (await trail(world))[0]
    })

    it('records it as refused', () => {
      expect(row?.outcome).toBe('denied')
    })

    it('says why, in the words the operator saw', () => {
      expect(row?.detail?.length ?? 0).toBeGreaterThan(0)
    })

    it('says what it was refused on', () => {
      expect(row?.target).toBe(`tags/${tagId}`)
    })
  })

  describe('Scenario: a broadcast send that was never confirmed', () => {
    let row: AuditEntry | undefined

    beforeAll(async () => {
      const world = createWorld()
      const id = await aBroadcast(world, { subject: 'Launch' })
      await world.fetch(`/broadcasts/${id}/send`, form(null, {}))
      row = (await trail(world))[0]
    })

    it('records the refusal, though the response was a plain redirect', () => {
      expect(row?.outcome).toBe('denied')
    })

    it('says why', () => {
      expect(row?.detail).toContain('not confirmed')
    })
  })

  describe('Scenario: someone calls the API with a bad token', () => {
    let row: AuditEntry | undefined

    beforeAll(async () => {
      const world = createWorld()
      await world.fetch('/api/send', json('not-a-real-token', { to: 'x@example.test', subject: 's', body: 'b' }))
      row = (await trail(world))[0]
    })

    it('records it as refused', () => {
      expect(row?.outcome).toBe('denied')
    })

    it('records the reason the caller was given', () => {
      expect(row?.detail).toBe('invalid token')
    })

    it('names no key, because none matched', () => {
      expect(row?.apiKeyId).toBeNull()
    })

    it('never stores the token it was handed', () => {
      expect(JSON.stringify(row)).not.toContain('not-a-real-token')
    })
  })

  describe('Scenario: a key records a sale with no email', () => {
    let row: AuditEntry | undefined

    beforeAll(async () => {
      const world = createWorld()
      const key = await createApiKey(world.db, 'store')
      await world.fetch('/api/sales', json(key.token, { amount_cents: 100 }))
      row = (await trail(world))[0]
    })

    it('records it as refused, with the reason', () => {
      expect(row?.detail).toContain('email')
    })
  })

  describe('Scenario: a body full of credentials', () => {
    let summary: Record<string, string>

    beforeAll(() => {
      summary = summarize({ name: 'x', token: 't', api_key: 'k', password: 'p', secret: 's', body: 'long' })
    })

    it('keeps only the allowlisted fields', () => {
      expect(summary).toEqual({ name: 'x' })
    })
  })
})
