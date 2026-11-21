import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import * as z from 'zod/v4'
import { type KeyScope, scopeSatisfies, takeRateSlot } from '../../core/api-keys.ts'
import { type Db, getDb } from '../../db/index.ts'
import type { ApiKey } from '../../db/schema.ts'
import type { Env } from '../../types.ts'
import { liveApiKey, touchApiKey } from '../auth.ts'

/**
 * The REST API's plumbing (`/api/v1`). HTTP shape only: every
 * rule an endpoint reaches is a core function's. What lives here is the door —
 * the key, its rate, its scope — and the two envelopes every answer comes in:
 *
 * - success: `{ "data": ... }`, lists adding `page`, `per_page`, `has_more`;
 * - refusal: `{ "error": { "code", "message", "field"? } }`, one shape for all.
 *
 * Endpoints are declared with `endpoint()`, which also files them in `CATALOG`,
 * so the OpenAPI document is generated from the routes and cannot drift.
 */

export type V1 = { Bindings: Env; Variables: { apiKey: ApiKey } }
export type V1Context = Context<V1>

export interface ErrorBody {
  error: { code: string; message: string; field?: string }
}

/** The one refusal shape. `field` names the input at fault when there is one. */
export function problem(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  field?: string,
): Response {
  const body: ErrorBody = { error: { code, message, ...(field ? { field } : {}) } }
  return c.json(body, status)
}

export const notFound = (c: Context, what: string) =>
  problem(c, 404, 'not_found', `No ${what} with that id.`)

/** A core `{ ok: false, reason }`, as a 422 (or 409 for a state conflict). */
export function refused(
  c: Context,
  r: { reason?: string; field?: string },
  status: ContentfulStatusCode = 422,
): Response {
  const reason = r.reason ?? 'refused'
  if (/^no such /i.test(reason)) return problem(c, 404, 'not_found', reason)
  return problem(c, status, status === 409 ? 'conflict' : 'refused', reason, r.field)
}

export function data(c: Context, value: unknown, status: ContentfulStatusCode = 200): Response {
  return c.json({ data: value }, status)
}

// ───────────────────────────────────────────────── paging

/**
 * Page-numbered paging: `page` from 1,
 * `per_page` up to 200 (default 50). Lists fetch one row more than they show,
 * which answers "is there a next page?" without a count query — every list
 * stays at a handful of D1 queries however large the table.
 */
export const MAX_PER_PAGE = 200

export const pageQuery = {
  page: z.coerce.number().int().min(1).max(100_000).optional().describe('Page number, from 1'),
  per_page: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PER_PAGE)
    .optional()
    .describe(`Page size (default 50, at most ${MAX_PER_PAGE})`),
}

export interface Paging {
  page: number
  perPage: number
  offset: number
  /** Rows to fetch: one more than the page shows. */
  fetch: number
}

export function paging(q: { page?: number; per_page?: number }): Paging {
  const page = q.page ?? 1
  const perPage = q.per_page ?? 50
  return { page, perPage, offset: (page - 1) * perPage, fetch: perPage + 1 }
}

/** Rows fetched with `paging().fetch` (or a whole in-memory list), as one page. */
export function paged<T>(c: Context, rows: T[], p: Paging, alreadySliced = false): Response {
  const window = alreadySliced ? rows : rows.slice(0, p.perPage + 1)
  return c.json({
    data: window.slice(0, p.perPage),
    page: p.page,
    per_page: p.perPage,
    has_more: window.length > p.perPage,
  })
}

/** Page a list that is small enough to hold whole (tags, forms, sequences). */
export function pageOf<T>(all: T[], p: Paging): T[] {
  return all.slice(p.offset, p.offset + p.perPage + 1)
}

// ───────────────────────────────────────────────── the door

/** A key's own scope decides: GET reads (`read` or `admin`); every write needs `admin`. */
export function scopeFor(method: string): KeyScope {
  return method === 'GET' || method === 'HEAD' ? 'read' : 'admin'
}

/**
 * Bearer key, then rate, then scope, in that order. 401 for no usable key
 * (missing, unknown and revoked alike — saying which tells a guesser how close
 * they were), 429 with `Retry-After` over 120 requests a minute, 403 for a real
 * key whose scope does not reach the method. A `send` key reaches nothing here:
 * `send` is "POST /api/send and nothing else", and that endpoint is outside v1.
 */
export function requireKey(): MiddlewareHandler<V1> {
  return async (c, next) => {
    const db = getDb(c.env)
    const key = await liveApiKey(db, c.req.header('Authorization'))
    if (!key) {
      return problem(c, 401, 'unauthorized', 'A valid API key is required: Authorization: Bearer <key>.')
    }

    const slot = await takeRateSlot(db, key.id)
    if (!slot.ok) {
      c.header('Retry-After', String(slot.retryAfter))
      return problem(c, 429, 'rate_limited', 'Too many requests for this key. Wait and try again.')
    }

    const needed = scopeFor(c.req.method.toUpperCase())
    if (!scopeSatisfies(key.scope, needed)) {
      return problem(
        c,
        403,
        'forbidden',
        `This key's scope is ${key.scope}. Reads need a read or admin key; changes need an admin key.`,
      )
    }

    await touchApiKey(db, key.id)
    c.set('apiKey', key)
    await next()
  }
}

// ───────────────────────────────────────────────── endpoints

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete'
type AnyObject = z.ZodObject<z.ZodRawShape>

export interface EndpointSpec<Q extends AnyObject | undefined, B extends AnyObject | undefined> {
  method: Method
  /** Hono-style, under `/api/v1`: `/subscribers/:id`. */
  path: string
  /** One sentence for the OpenAPI document. */
  summary: string
  tag: string
  query?: Q
  body?: B
  /** The success status (default 200). */
  status?: number
}

/** What the OpenAPI document is built from. */
export interface CatalogEntry {
  method: Method
  path: string
  summary: string
  tag: string
  scope: KeyScope
  status: number
  query?: AnyObject
  body?: AnyObject
}

export const CATALOG: CatalogEntry[] = []

type Out<S> = S extends AnyObject ? z.output<S> : Record<string, never>

export interface Call<Q, B> {
  c: V1Context
  db: Db
  env: Env
  query: Q
  body: B
  /** A numeric path parameter; `id` by default. Validated before the handler runs. */
  id: number
  param: (name: string) => string
}

/** Strict positive integer ids in paths; anything else is a 404, not a crash. */
const ID = /^[1-9]\d{0,15}$/

/**
 * Declare one endpoint. Query and body are parsed with zod against an
 * allowlist: unknown fields are dropped,
 * sizes are capped in the schemas, and the first problem is answered as a 422
 * naming the field. A body that is not JSON is a 400.
 */
export function endpoint<Q extends AnyObject | undefined, B extends AnyObject | undefined>(
  router: Hono<V1>,
  spec: EndpointSpec<Q, B>,
  handler: (call: Call<Out<Q>, Out<B>>) => Promise<Response>,
): void {
  CATALOG.push({
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    tag: spec.tag,
    scope: scopeFor(spec.method.toUpperCase()),
    status: spec.status ?? 200,
    ...(spec.query ? { query: spec.query } : {}),
    ...(spec.body ? { body: spec.body } : {}),
  })

  const numericParams = [...spec.path.matchAll(/:([a-z_]*id)\b/g)].map((m) => m[1]!)

  router.on(spec.method.toUpperCase(), `/api/v1${spec.path}`, async (c) => {
    for (const name of numericParams) {
      if (!ID.test(c.req.param(name) ?? '')) return problem(c, 404, 'not_found', `No such ${name}.`, name)
    }

    let query: unknown = {}
    if (spec.query) {
      const parsed = spec.query.safeParse(c.req.query())
      if (!parsed.success) return invalid(c, parsed.error)
      query = parsed.data
    }

    let body: unknown = {}
    if (spec.body) {
      let raw: unknown
      try {
        const text = await c.req.text()
        raw = text.trim() ? JSON.parse(text) : {}
      } catch {
        return problem(c, 400, 'bad_request', 'The body must be JSON.')
      }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return problem(c, 400, 'bad_request', 'The body must be a JSON object.')
      }
      const parsed = spec.body.safeParse(raw)
      if (!parsed.success) return invalid(c, parsed.error)
      body = parsed.data
    }

    return await handler({
      c,
      db: getDb(c.env),
      env: c.env,
      query: query as Out<Q>,
      body: body as Out<B>,
      id: Number(c.req.param(numericParams[0] ?? 'id')),
      param: (name) => c.req.param(name) ?? '',
    })
  })
}

/** The first zod issue, as `{ field, message }`. */
function invalid(c: Context, error: z.ZodError): Response {
  const issue = error.issues[0]
  const field = issue?.path.length ? issue.path.join('.') : undefined
  const message = issue ? `${field ? `${field}: ` : ''}${issue.message}` : 'invalid input'
  return problem(c, 422, 'invalid', message, field)
}
