import { type Context, Hono } from 'hono'
import { applyProviderEvent } from '../core/events.ts'
import { dispatch, webhookReaderFor } from '../core/sending.ts'
import {
  type StripeEventEnvelope,
  handleStripeEvent,
  verifyStripeSignature,
} from '../core/stripe-webhook.ts'
import { upsertSubscriber } from '../core/subscribers.ts'
import { acceptSend, parseSendRequest } from '../core/transactional.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { verifyApiKey } from './auth.ts'

export const api = new Hono<{ Bindings: Env }>()

// ───────────────────────────────────────────────── transactional send

/**
 * `POST /api/send` — HTTP shape only. The rules (whole mail or stored template,
 * `{{variables}}`, idempotency, the quiet recipient) are `core/transactional.ts`.
 *
 * 401 for any key problem, 400 for a malformed body, 422 for a well-formed
 * request naming a template that is missing, inactive, or short of variables,
 * 202 once the message is durable, 200 for an idempotent replay.
 */
api.post('/api/send', async (c) => {
  const db = getDb(c.env)

  const key = await verifyApiKey(db, c.req.header('Authorization'))
  if (!key) return c.json({ error: 'invalid token' }, 401)

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'body must be JSON' }, 400)
  }

  const parsed = parseSendRequest(payload)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const result = await acceptSend(db, parsed.request)

  if (result.kind === 'refused') {
    return c.json({ error: result.error, ...(result.missing ? { missing: result.missing } : {}) }, 422)
  }
  if (result.kind === 'replayed') {
    return c.json({
      id: result.messageId,
      status: result.status,
      template: result.template,
      idempotent: true,
    })
  }

  // Respond once the message is durably recorded — don't block on the provider
  // (SPEC 7.5).
  c.executionCtx.waitUntil(dispatch(c.env, db, [result.messageId]))

  return c.json({ id: result.messageId, status: 'queued', template: result.template }, 202)
})

// ───────────────────────────────────────────────── provider webhooks

// Named providers only: the admin's own `/webhooks/:id` screens share the prefix.
api.post('/webhooks/:provider{resend|mailgun|stripe}', async (c) => {
  const db = getDb(c.env)
  const name = c.req.param('provider')

  if (name === 'stripe') return await stripeWebhook(c)
  const reader = webhookReaderFor(c.env, name)
  if (!reader.ok) return c.json({ error: reader.error }, reader.status)

  let evs: Awaited<ReturnType<typeof reader.provider.parseWebhook>>
  try {
    evs = await reader.provider.parseWebhook(c.req.raw, reader.secret)
  } catch (err) {
    // A bad signature is rejected and observable, never silently accepted.
    return c.json({ error: String(err) }, reader.rejectStatus)
  }
  // ⭐ Its own try, and a different answer. The webhook was genuine; we could not
  // take it right now (most often the database refusing under load). A 503 is
  // what makes the provider deliver it again later. A 401 would say "forged",
  // and a real bounce or complaint would be lost. Events already applied are
  // safe to see twice: each one's dedupe key makes the replay a no-op.
  try {
    for (const ev of evs) await applyProviderEvent(db, ev)
  } catch (err) {
    return c.json({ error: 'could not record the event right now; deliver it again', detail: String(err).slice(0, 300) }, 503, {
      'Retry-After': '60',
    })
  }
  return c.json({ ok: true, applied: evs.length })
})

/**
 * `POST /webhooks/stripe` — the live money path.
 *
 * Reads the body as raw text and verifies the signature *before* parsing: the
 * HMAC covers the exact bytes Stripe sent, and JSON that has been through a
 * parse-and-reserialize no longer matches.
 *
 * Status codes are load-bearing here. Stripe retries any non-2xx for up to three
 * days, so:
 *   - a bad signature → 401, and it stays rejected however often it is retried
 *   - a handler that threw → 500, so Stripe redelivers and we get another go
 *   - anything we understood, including "ignored" → 200, or Stripe hammers the
 *     endpoint forever over an event we deliberately do not act on
 */
async function stripeWebhook(c: Context<{ Bindings: Env }>) {
  const db = getDb(c.env)

  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    // Fails closed. An endpoint that accepts unsigned bodies is an endpoint
    // anybody can post fake revenue to.
    return c.json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' }, 503)
  }

  const raw = await c.req.text()
  const verified = await verifyStripeSignature(
    raw,
    c.req.header('stripe-signature') ?? null,
    c.env.STRIPE_WEBHOOK_SECRET,
  )
  if (!verified.ok) return c.json({ error: verified.reason }, 401)

  let event: StripeEventEnvelope
  try {
    event = JSON.parse(raw) as StripeEventEnvelope
  } catch {
    return c.json({ error: 'body is not JSON' }, 400)
  }
  if (!event?.id || !event?.type || !event?.data?.object) {
    return c.json({ error: 'not a Stripe event envelope' }, 400)
  }

  try {
    const result = await handleStripeEvent(c.env, db, event)
    return c.json(result)
  } catch (err) {
    // Already recorded as a failed `stripe_events` row. The 500 is what buys the
    // retry — swallowing it here would lose the order silently.
    return c.json({ error: String(err), event: event.id }, 500)
  }
}

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
