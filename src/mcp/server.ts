import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { verifyApiKey } from '../api/auth.ts'
import { resourceMetadataUrl, verifyAccessToken } from '../core/oauth.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import type { Ctx } from './kit.ts'
import { registerPrompts } from './prompts.ts'
import { registerResources } from './resources.ts'
import { registerAudience } from './tools/audience.ts'
import { registerBroadcasts } from './tools/broadcasts.ts'
import { registerCampaigns } from './tools/campaigns.ts'
import { registerDeliverability } from './tools/deliverability.ts'
import { registerForms } from './tools/forms.ts'
import { registerOps } from './tools/ops.ts'
import { registerPosts } from './tools/posts.ts'
import { registerSite } from './tools/site.ts'
import { registerSales } from './tools/sales.ts'
import { registerSegments } from './tools/segments.ts'
import { registerSequences } from './tools/sequences.ts'
import { registerStripe } from './tools/stripe.ts'
import { registerTags } from './tools/tags.ts'
import { registerTransactional } from './tools/transactional.ts'

/**
 * Constant-time string compare.
 *
 * The path secret is checked on every request from anywhere on the internet;
 * `===` leaks how long a shared prefix was. Lengths are compared first and the
 * loop always runs to the end of the expected value.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Serve one MCP request.
 *
 * Three gates, cheapest first: the obfuscated path, then the bearer key, then
 * the per-tool guards. A wrong path secret gets a 404 rather than a 403 —
 * a URL nobody guessed should look like nothing is there.
 *
 * A fresh `McpServer` is built per request. That is the SDK's stateless model
 * anyway (the factory runs per request), and it is what lets tool handlers
 * close over `env` and the caller's key without any session state.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
  pathSecret: string,
): Promise<Response> {
  const expected = env.MCP_PATH_SECRET ?? ''
  if (!expected || !safeEqual(pathSecret, expected)) {
    return new Response('Not found', { status: 404 })
  }

  const db = getDb(env)
  const key = await verifyApiKey(db, request.headers.get('Authorization') ?? undefined, 'admin')
  if (!key) {
    return new Response(JSON.stringify({ error: 'invalid token' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        // Plain bearer auth, no OAuth discovery: this door takes a pasted admin
        // key and nothing else. The OAuth door is `/mcp` (`handleOAuthMcp`).
        'WWW-Authenticate': 'Bearer realm="kolea"',
      },
    })
  }

  const ctx: Ctx = { env, db, executionCtx, apiKeyId: key.id, oauthGrantId: null, readOnly: false }
  return await serve(request, ctx, { token: '', clientId: `api-key-${key.id}`, scopes: [key.scope] })
}

/**
 * Serve one MCP request on `/mcp`, authenticated by an OAuth access token —
 * the "paste a URL into Claude" door (see `core/oauth.ts`).
 *
 * No path secret here: the URL is meant to be pasted, and a token only exists
 * because the operator approved the app behind Cloudflare Access. A 401 carries
 * `WWW-Authenticate` naming the protected resource metadata (RFC 9728 §5.1),
 * which is how a client discovers where to sign in without being told.
 *
 * Past the token, the tools are the same tools with the same guards as an admin
 * key — send switch, preflight, confirm — plus the read-only gate in `kit.ts`
 * unless the operator ticked "allow changes".
 */
export async function handleOAuthMcp(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
): Promise<Response> {
  const origin = new URL(request.url).origin
  const db = getDb(env)
  const header = request.headers.get('Authorization') ?? undefined
  const caller = await verifyAccessToken(db, header)
  if (!caller) {
    const presented = Boolean(header?.startsWith('Bearer '))
    const challenge =
      `Bearer resource_metadata="${resourceMetadataUrl(origin)}", scope="mcp:read"` +
      (presented
        ? ', error="invalid_token", error_description="the access token is invalid, expired or revoked"'
        : '')
    return new Response(JSON.stringify({ error: presented ? 'invalid_token' : 'unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': challenge,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'WWW-Authenticate',
      },
    })
  }

  const ctx: Ctx = {
    env,
    db,
    executionCtx,
    apiKeyId: null,
    oauthGrantId: caller.grantId,
    readOnly: caller.access !== 'write',
  }
  return await serve(request, ctx, {
    token: '',
    clientId: `oauth-grant-${caller.grantId}`,
    scopes: caller.access === 'write' ? ['mcp:read', 'mcp:write'] : ['mcp:read'],
  })
}

/** Build the per-request server and hand it the request. Shared by both doors. */
async function serve(
  request: Request,
  ctx: Ctx,
  authInfo: { token: string; clientId: string; scopes: string[] },
): Promise<Response> {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'kolea', version: '1.0.0' })

    registerAudience(server, ctx)
    registerTags(server, ctx)
    registerSegments(server, ctx)
    registerBroadcasts(server, ctx)
    registerSequences(server, ctx)
    registerCampaigns(server, ctx)
    registerForms(server, ctx)
    registerPosts(server, ctx)
    registerSite(server, ctx)
    registerSales(server, ctx)
    registerTransactional(server, ctx)
    registerStripe(server, ctx)
    registerDeliverability(server, ctx)
    registerOps(server, ctx)

    registerResources(server, ctx)
    registerPrompts(server)

    return server
  })

  return await handler.fetch(request, { authInfo })
}
