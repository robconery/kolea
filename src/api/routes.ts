import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { applyProviderEvent, recordEvent } from '../core/events.ts'
import { isValidEmail, normalizeEmail } from '../core/ids.ts'
import { dispatch } from '../core/sending.ts'
import { upsertSubscriber } from '../core/subscribers.ts'
import { getDb } from '../db/index.ts'
import { messages, subscribers } from '../db/schema.ts'
import { ResendProvider } from '../providers/resend.ts'
import type { Env } from '../types.ts'
import { verifyApiKey } from './auth.ts'

export const api = new Hono<{ Bindings: Env }>()

// ───────────────────────────────────────────────── transactional send

interface SendBody {
  to?: string
  subject?: string
  body?: string
  name?: string
  idempotency_key?: string
}

api.post('/api/send', async (c) => {
  const db = getDb(c.env)

  const key = await verifyApiKey(db, c.req.header('Authorization'))
  if (!key) return c.json({ error: 'invalid token' }, 401)

  let payload: SendBody
  try {
    payload = await c.req.json<SendBody>()
  } catch {
    return c.json({ error: 'body must be JSON' }, 400)
  }

  const to = normalizeEmail(payload.to ?? '')
  if (!to || !isValidEmail(to)) return c.json({ error: 'field `to` must be a valid email' }, 400)
  if (!payload.subject) return c.json({ error: 'field `subject` is required' }, 400)
  if (!payload.body) return c.json({ error: 'field `body` is required' }, 400)

  // Replaying an idempotency key returns the original result rather than
  // sending twice (SPEC 7.3).
  const idem = payload.idempotency_key ? `txn:${payload.idempotency_key}` : null
  if (idem) {
    const existing = await db
      .select()
      .from(messages)
      .where(eq(messages.idempotencyKey, idem))
      .get()
    if (existing) {
      return c.json({ id: existing.id, status: existing.status, idempotent: true })
    }
  }

  // Transactional recipients may not be on the list at all; create them quietly
  // so the send is attributable, but never enroll or market to them.
  let sub = await db.select().from(subscribers).where(eq(subscribers.email, to)).get()
  if (!sub) {
    const { id } = await upsertSubscriber(db, {
      email: to,
      name: payload.name ?? null,
      source: 'transactional',
      // Somebody receiving a password reset did not join the newsletter.
      triggerSubscribeSequences: false,
    })
    sub = await db.select().from(subscribers).where(eq(subscribers.id, id!)).get()
  }
  if (!sub) return c.json({ error: 'could not resolve recipient' }, 500)

  const inserted = await db
    .insert(messages)
    .values({
      subscriberId: sub.id,
      kind: 'transactional',
      toEmail: to,
      subject: payload.subject,
      bodyMd: payload.body,
      status: 'queued',
      idempotencyKey: idem,
      createdAt: new Date(),
    })
    .returning({ id: messages.id })

  const messageId = inserted[0]!.id

  // Respond once the message is durably recorded — don't block on the provider
  // (SPEC 7.5).
  c.executionCtx.waitUntil(dispatch(c.env, db, [messageId]))

  return c.json({ id: messageId, status: 'queued' }, 202)
})

// ───────────────────────────────────────────────── provider webhooks

api.post('/webhooks/:provider', async (c) => {
  const db = getDb(c.env)
  const name = c.req.param('provider')

  if (name !== 'resend') return c.json({ error: 'unknown provider' }, 404)
  if (!c.env.RESEND_API_KEY) return c.json({ error: 'provider not configured' }, 400)

  const provider = new ResendProvider(c.env.RESEND_API_KEY)
  try {
    const evs = await provider.parseWebhook(c.req.raw, c.env.RESEND_WEBHOOK_SECRET)
    for (const ev of evs) await applyProviderEvent(db, ev)
    return c.json({ ok: true, applied: evs.length })
  } catch (err) {
    // A bad signature is rejected and observable, never silently accepted.
    return c.json({ error: String(err) }, 401)
  }
})

// ───────────────────────────────────────────────── tracking

const PIXEL = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (ch) => ch.charCodeAt(0),
)

api.get('/t/open/:id{[0-9]+\\.gif}', async (c) => {
  const db = getDb(c.env)
  const messageId = Number(c.req.param('id').replace('.gif', ''))

  // Recording must never be able to break the pixel (SPEC 5.4) — a message row
  // deleted after send would otherwise 500 this from inboxes forever.
  try {
    if (messageId) await recordEvent(db, messageId, 'open')
  } catch {
    /* swallow — the pixel matters more than the datapoint */
  }

  return c.body(PIXEL as unknown as ArrayBuffer, 200, {
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  })
})

api.get('/t/click/:id', async (c) => {
  const db = getDb(c.env)
  const messageId = Number(c.req.param('id'))
  const url = c.req.query('u')
  if (!url) return c.notFound()

  // Recording must never be able to break the reader's click (SPEC 5.4).
  try {
    if (messageId) await recordEvent(db, messageId, 'click', { url })
  } catch {
    /* swallow — the redirect matters more than the datapoint */
  }

  return c.redirect(url, 302)
})

// ───────────────────────────────────────────────── public signup

api.post('/subscribe', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const { outcome } = await upsertSubscriber(db, {
    email: String(form.get('email') ?? ''),
    name: (String(form.get('name') ?? '') || null) as string | null,
    source: 'signup',
  })
  if (outcome === 'invalid') return c.text('That email looks invalid.', 400)
  return c.text("You're subscribed. Thanks!")
})
