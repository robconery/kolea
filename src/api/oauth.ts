import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import {
  authorizationServerMetadata,
  exchangeToken,
  protectedResourceMetadata,
  registerClient,
  registrationResponse,
  revokeToken,
} from '../core/oauth.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'

/**
 * The public half of "add the mailer to Claude by URL" (rules: `core/oauth.ts`).
 *
 * Discovery, registration, the token endpoint and revocation. Mounted ahead of
 * `requireOperator` because the callers are MCP clients, not a browser with an
 * Access session — and each carries its own proof (a PKCE verifier, a refresh
 * token) or holds no data at all. ⚠️ Production needs a Cloudflare Access
 * **Bypass** for every path here.
 *
 * `/oauth/authorize` is deliberately *not* here: it is the operator's consent
 * page and lives behind Access in `web/admin-connect.tsx`.
 *
 * No cookie is read or set on any of these, so CSRF does not apply and CORS can
 * be `*` — a browser-based MCP client has to be able to reach them.
 */
export const oauthApi = new Hono<{ Bindings: Env }>()

const origin = (c: Context) => new URL(c.req.url).origin

const open = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'],
  exposeHeaders: ['WWW-Authenticate'],
  maxAge: 86400,
})
oauthApi.use('/.well-known/oauth-protected-resource', open)
oauthApi.use('/.well-known/oauth-protected-resource/*', open)
oauthApi.use('/.well-known/oauth-authorization-server', open)
oauthApi.use('/.well-known/oauth-authorization-server/*', open)
oauthApi.use('/oauth/register', open)
oauthApi.use('/oauth/token', open)
oauthApi.use('/oauth/revoke', open)
// `/mcp` itself is served in `worker.tsx`; this only answers its preflight and
// lets a browser client read the 401's `WWW-Authenticate`. Bearer, no cookies.
oauthApi.use('/mcp', open)

// RFC 9728: the metadata for `/mcp` is at the well-known prefix + `/mcp`; the
// bare one is served too because some clients look there first.
oauthApi.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata(origin(c))))
oauthApi.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata(origin(c))))

// RFC 8414. The issuer has no path, so the `/mcp`-suffixed form some clients
// try (treating the resource as the issuer) answers the same document.
oauthApi.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(origin(c))))
oauthApi.get('/.well-known/oauth-authorization-server/mcp', (c) =>
  c.json(authorizationServerMetadata(origin(c))),
)

/** RFC 7591 dynamic client registration. JSON in, JSON out. */
oauthApi.post('/oauth/register', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_client_metadata', error_description: 'body must be JSON' }, 400)
  }
  const result = await registerClient(getDb(c.env), body)
  if (!result.ok) return c.json({ error: result.error, error_description: result.description }, 400)
  return c.json(registrationResponse(result.client), 201)
})

/**
 * Form-encoded per OAuth; JSON accepted too, because some clients send it and
 * refusing them protects nothing. A public client may also put its `client_id`
 * in a Basic header instead of the body.
 */
async function formParams(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? ''
  let params: Record<string, unknown> = {}
  try {
    if (type.includes('application/json')) {
      const body = await c.req.json()
      params = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    } else {
      params = (await c.req.parseBody()) as Record<string, unknown>
    }
  } catch {
    params = {}
  }

  const basic = /^Basic\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]
  if (basic && params.client_id === undefined) {
    try {
      const user = atob(basic).split(':')[0]
      if (user) params.client_id = decodeURIComponent(user)
    } catch {
      /* a malformed header is the same as none */
    }
  }
  return params
}

/** Tokens must never be cached by anything between here and the client. */
function noStore(c: Context) {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
}

oauthApi.post('/oauth/token', async (c) => {
  noStore(c)
  const result = await exchangeToken(getDb(c.env), await formParams(c), origin(c))
  if (result.ok) return c.json(result.body)
  if (result.status === 401) c.header('WWW-Authenticate', 'Basic realm="kolea"')
  return c.json(
    { error: result.error, ...(result.description ? { error_description: result.description } : {}) },
    result.status,
  )
})

/** RFC 7009: always 200, whether or not the token existed. */
oauthApi.post('/oauth/revoke', async (c) => {
  noStore(c)
  await revokeToken(getDb(c.env), await formParams(c))
  return c.body(null, 200)
})
