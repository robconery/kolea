import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { verifyApiKey } from '../api/auth.ts'
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
import { registerSales } from './tools/sales.ts'
import { registerSegments } from './tools/segments.ts'
import { registerSequences } from './tools/sequences.ts'
import { registerStripe } from './tools/stripe.ts'
import { registerTags } from './tools/tags.ts'

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
        // Tells a client this is bearer auth without advertising an OAuth flow
        // we don't run — the operator pastes a key and that's the whole story.
        'WWW-Authenticate': 'Bearer realm="big-mailer"',
      },
    })
  }

  const ctx: Ctx = { env, db, executionCtx, apiKeyId: key.id }

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'big-mailer', version: '1.0.0' })

    registerAudience(server, ctx)
    registerTags(server, ctx)
    registerSegments(server, ctx)
    registerBroadcasts(server, ctx)
    registerSequences(server, ctx)
    registerCampaigns(server, ctx)
    registerForms(server, ctx)
    registerSales(server, ctx)
    registerStripe(server, ctx)
    registerDeliverability(server, ctx)
    registerOps(server, ctx)

    registerResources(server, ctx)
    registerPrompts(server)

    return server
  })

  return await handler.fetch(request, {
    authInfo: { token: '', clientId: `api-key-${key.id}`, scopes: [key.scope] },
  })
}
