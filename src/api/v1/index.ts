import { Hono } from 'hono'
import * as z from 'zod/v4'
import { RATE_LIMIT_PER_MINUTE } from '../../core/api-keys.ts'
import { audienceRoutes } from './audience.ts'
import { CATALOG, type CatalogEntry, MAX_PER_PAGE, type V1, problem, requireKey } from './kit.ts'
import { mailRoutes } from './mail.ts'
import { siteRoutes } from './site.ts'

/**
 * `/api/v1` — the REST API.
 *
 * Mounted ahead of `requireOperator` in `worker.tsx`: a program has no Access
 * session, and the bearer key is the whole credential. `/api/*` already has a
 * Cloudflare Access **Bypass** policy (it is how `/api/send` works), so nothing
 * changes at the edge. Every mutating call is audited by the `auditWrites('key')`
 * middleware mounted on `/api/v1/*` in `worker.tsx`, refusals included.
 *
 * `GET /api/v1/openapi.json` is public: it holds no data.
 */
import { agentSendAllowed, agentSendRefusal } from '../../core/agents.ts'
import { getDb } from '../../db/index.ts'

export const apiV1 = new Hono<V1>()

apiV1.get('/api/v1/openapi.json', (c) => c.json(openApiDocument(`${c.env.PUBLIC_URL}/api/v1`)))

apiV1.use('/api/v1/*', requireKey())

// ⭐ The agent send switch covers every key, not just MCP. MCP authenticates
// with the same admin keys, so a switch that only MCP read would be bypassed by
// an agent calling these endpoints instead. Preflight still applies on top.
const SENDS = /^\/api\/v1\/(broadcasts\/\d+\/(send|schedule|resume)|sequences\/\d+\/activate)$/
apiV1.use('/api/v1/*', async (c, next) => {
  if (c.req.method === 'POST' && SENDS.test(c.req.path)) {
    if (!(await agentSendAllowed(c.env, getDb(c.env)))) {
      return problem(c, 403, 'sending_off', agentSendRefusal(c.env))
    }
  }
  return next()
})

audienceRoutes(apiV1)
mailRoutes(apiV1)
siteRoutes(apiV1)

apiV1.all('/api/v1/*', (c) => problem(c, 404, 'not_found', 'No such endpoint. See /api/v1/openapi.json.'))

// ───────────────────────────────────────────────── OpenAPI 3.1

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        field: { type: 'string' },
      },
      required: ['code', 'message'],
    },
  },
  required: ['error'],
}

const errorResponse = { description: 'A refusal, naming the problem', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >
  return rest
}

function operation(e: CatalogEntry) {
  const pathParams = [...e.path.matchAll(/:([a-z_]+)/g)].map((m) => ({
    name: m[1]!,
    in: 'path',
    required: true,
    schema: /id$/.test(m[1]!) ? { type: 'integer', minimum: 1 } : { type: 'string' },
  }))

  const queryParams = e.query
    ? Object.entries((jsonSchema(e.query).properties ?? {}) as Record<string, Record<string, unknown>>).map(
        ([name, schema]) => ({
          name,
          in: 'query',
          required: ((jsonSchema(e.query!).required as string[] | undefined) ?? []).includes(name),
          schema,
        }),
      )
    : []

  return {
    operationId: `${e.method}${e.path.replace(/[/:]+([a-z_])/g, (_, ch: string) => ch.toUpperCase()).replace(/[^A-Za-z]/g, '')}`,
    summary: e.summary,
    tags: [e.tag],
    'x-key-scope': e.scope,
    parameters: [...pathParams, ...queryParams],
    ...(e.body
      ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(e.body) } } } }
      : {}),
    responses: {
      [String(e.status)]: { description: 'Success; the result is under `data`.' },
      default: errorResponse,
    },
  }
}

/** Generated from the endpoint catalog, so the document cannot drift from the routes. */
export function openApiDocument(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const e of CATALOG) {
    const path = e.path.replace(/:([a-z_]+)/g, '{$1}')
    paths[path] ??= {}
    paths[path]![e.method] = operation(e)
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Kōlea API',
      version: '1',
      description: [
        'Bearer keys with a scope: `read` reads (GET only), `admin` does everything, and `send` reaches only POST /api/send, outside this API.',
        'Success is `{ "data": ... }`; lists add `page`, `per_page` (at most ' + MAX_PER_PAGE + ') and `has_more`.',
        'Every refusal is `{ "error": { "code", "message", "field"? } }`.',
        `Each key may make ${RATE_LIMIT_PER_MINUTE} requests a minute; over that is a 429 with Retry-After.`,
        'Money is integer cents. Sending a broadcast and activating a sequence each need the single-use token their preflight endpoint returns.',
      ].join(' '),
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: { Error: ERROR_SCHEMA },
    },
    paths,
  }
}
