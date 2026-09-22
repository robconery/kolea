import { Hono } from 'hono'
import { cleanUp } from '../core/ai/cleanup.ts'
import { aiConfigured, spend } from '../core/ai/openrouter.ts'
import { suggestSubjects } from '../core/ai/subjects.ts'
import { getDb } from '../db/index.ts'
import type { DocNode } from '../db/schema.ts'
import type { Env } from '../types.ts'

/**
 * The composer's AI endpoints. JSON in, JSON out, called by `client/ai.ts`.
 *
 * Operator-only like the rest of the console (mounted below `requireOperator`),
 * and JSON-only on top of that: a cross-site form cannot post
 * `application/json`, so another page cannot spend the AI budget by getting
 * the operator's browser to submit to it.
 *
 * Neither endpoint writes anything but a cost row. They hand words back to the
 * browser; the browser puts them in the editor, and the writer decides.
 */
export const aiAdmin = new Hono<{ Bindings: Env }>()

aiAdmin.use('/ai/*', async (c, next) => {
  if (!aiConfigured(c.env)) return c.json({ ok: false, reason: 'AI is not set up. Add OPENROUTER_KEY.' }, 404)
  if (!(c.req.header('content-type') ?? '').includes('application/json')) {
    return c.json({ ok: false, reason: 'Expected JSON.' }, 415)
  }
  await next()
})

interface Body {
  doc?: unknown
  subject?: unknown
  context?: unknown
}

async function readBody(req: Request): Promise<Body> {
  return ((await req.json().catch(() => null)) as Body | null) ?? {}
}

function asDoc(v: unknown): DocNode | null {
  return v && typeof v === 'object' && (v as DocNode).type === 'doc' ? (v as DocNode) : null
}

aiAdmin.post('/ai/subjects', async (c) => {
  const db = getDb(c.env)
  const body = await readBody(c.req.raw)
  const result = await suggestSubjects(c.env, db, {
    doc: asDoc(body.doc),
    current: typeof body.subject === 'string' ? body.subject : '',
    context: typeof body.context === 'string' ? body.context.slice(0, 200) : '',
  })
  return c.json({ ...result, spend: await spend(c.env, db) })
})

aiAdmin.post('/ai/cleanup', async (c) => {
  const db = getDb(c.env)
  const body = await readBody(c.req.raw)
  const result = await cleanUp(c.env, db, { doc: asDoc(body.doc) })
  return c.json({ ...result, spend: await spend(c.env, db) })
})
