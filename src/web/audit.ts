import type { Context, MiddlewareHandler } from 'hono'
import { describeRequest, keyIdFor, outcomeOf, recordAudit, summarize } from '../core/audit.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'

/**
 * ⭐ One middleware writes the audit trail for every mutating request.
 *
 * Mounted in `worker.tsx`: after `requireOperator` for the console (the
 * actor is the verified Access email), and on `/api/send`, `/api/sales` and
 * `/api/v1/*` for keys (the actor is the key the bearer token names). GET, HEAD and OPTIONS
 * pass straight through — a read is not a change.
 *
 * It runs the handler first and reads the outcome off the response, so a new
 * admin route is audited without anyone remembering to. Where a handler refuses
 * with a response that looks like success, it calls `refuse()` below.
 *
 * Skipped on purpose: the composer's writing help (`/ai/*`, writes nothing) and
 * autosave (fires every few seconds while typing; the Save that follows it is
 * the change worth recording).
 */
const SKIP = [/^\/ai\//, /\/autosave$/]

const REFUSAL = 'auditRefusal' as never

/** Mark this request as refused, for a route whose response does not say so. */
export function refuse(c: Context, reason: string): void {
  c.set(REFUSAL, reason as never)
}

export function auditWrites(kind: 'operator' | 'key'): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return await next()

    const path = new URL(c.req.url).pathname
    if (SKIP.some((re) => re.test(path))) return await next()

    // A copy of the body for the allowlisted summary. Only small, parseable
    // bodies: a multipart upload is bytes, and tee-ing it costs memory for a
    // summary that would hold nothing anyway.
    const type = c.req.header('content-type') ?? ''
    const copy =
      type.includes('application/x-www-form-urlencoded') || type.includes('application/json')
        ? c.req.raw.clone()
        : null

    await next()

    const db = getDb(c.env)
    const res = c.res
    const status = c.error ? 500 : res.status
    const { outcome, flash } = outcomeOf(status, res.headers.get('location'))
    const marked = c.get(REFUSAL) as unknown as string | undefined

    let detail: string | null = marked ?? flash ?? null
    if (!detail && c.error) detail = c.error.message
    if (!detail && status >= 400) detail = await reasonIn(res)

    let summary: Record<string, string> = {}
    if (copy) {
      try {
        summary = summarize(
          type.includes('json')
            ? ((await copy.json()) as Record<string, unknown>)
            : Object.fromEntries(new URLSearchParams(await copy.text())),
        )
      } catch {
        /* an unparseable body is the handler's problem, not the trail's */
      }
    }

    let actorId: string | null
    let actorRole: 'owner' | 'admin' | 'writer' | null = null
    let apiKeyId: number | null = null
    if (kind === 'operator') {
      const email = c.get('operatorEmail' as never) as unknown as string | null | undefined
      actorId = email ?? (c.env.DEV_AUTH_BYPASS === 'true' ? 'dev-bypass' : null)
      actorRole = (c.get('operatorRole' as never) as unknown as typeof actorRole | undefined) ?? null
    } else {
      apiKeyId = await keyIdFor(db, c.req.header('Authorization'))
      actorId = apiKeyId === null ? null : String(apiKeyId)
    }

    const { action, target } = describeRequest(method, path)
    await recordAudit(db, {
      actorKind: kind,
      actorId,
      actorRole,
      apiKeyId,
      action,
      target,
      outcome: marked ? 'denied' : outcome,
      detail,
      status,
      summary,
    })
  }
}

/** The one-line reason a refusal gave: `{ error }` from the API, or a plain-text body. */
async function reasonIn(res: Response): Promise<string | null> {
  const type = res.headers.get('content-type') ?? ''
  try {
    if (type.includes('json')) {
      // `{ error: "..." }` from /api/send, `{ error: { code, message } }` from /api/v1.
      const body = (await res.clone().json()) as { error?: unknown }
      if (typeof body.error === 'string') return body.error
      const message = (body.error as { message?: unknown } | undefined)?.message
      return typeof message === 'string' ? message : null
    }
    if (type.includes('text/plain')) return (await res.clone().text()).split('\n')[0] ?? null
  } catch {
    /* fall through */
  }
  return null
}
