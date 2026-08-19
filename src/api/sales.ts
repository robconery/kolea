import { Hono } from 'hono'
import { recordSale } from '../core/sales.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { verifyApiKey } from './auth.ts'

export const salesApi = new Hono<{ Bindings: Env }>()

interface SaleBody {
  email?: string
  name?: string
  /** Integer cents. Preferred — money in floats is how you lose a penny per order. */
  amount_cents?: number
  /** Convenience for checkouts that only speak dollars. Converted and rounded. */
  amount?: number
  currency?: string
  product?: string
  external_id?: string
  campaign?: string
  tags?: string[]
  end_sequence?: string
  status?: 'paid' | 'refunded'
  occurred_at?: string
  meta?: Record<string, unknown>
}

/**
 * `POST /api/sales` — record money against a person.
 *
 * Attribution order is explicit `campaign` first, then the subscriber's most
 * recent attribution touch, then nothing. The response says which one applied,
 * because a revenue number you can't explain is worse than no revenue number.
 */
salesApi.post('/api/sales', async (c) => {
  const db = getDb(c.env)

  const key = await verifyApiKey(db, c.req.header('Authorization'))
  if (!key) return c.json({ error: 'invalid token' }, 401)

  let payload: SaleBody
  try {
    payload = await c.req.json<SaleBody>()
  } catch {
    return c.json({ error: 'body must be JSON' }, 400)
  }

  if (!payload.email) return c.json({ error: 'field `email` is required' }, 400)

  const cents =
    payload.amount_cents !== undefined
      ? Number(payload.amount_cents)
      : payload.amount !== undefined
        ? Math.round(Number(payload.amount) * 100)
        : Number.NaN
  if (!Number.isFinite(cents)) {
    return c.json({ error: 'field `amount_cents` (or `amount`) is required' }, 400)
  }

  const occurredAt = payload.occurred_at ? new Date(payload.occurred_at) : undefined
  if (occurredAt && Number.isNaN(occurredAt.getTime())) {
    return c.json({ error: 'field `occurred_at` must be an ISO date' }, 400)
  }

  const result = await recordSale(db, {
    email: payload.email,
    name: payload.name ?? null,
    amountCents: cents,
    currency: payload.currency,
    product: payload.product ?? null,
    externalId: payload.external_id ?? null,
    campaignSlug: payload.campaign ?? null,
    tagNames: Array.isArray(payload.tags) ? payload.tags.map(String) : undefined,
    endSequenceSlug: payload.end_sequence ?? null,
    status: payload.status,
    occurredAt,
    meta: payload.meta,
  })

  if (result.status === 'invalid_email') return c.json({ error: 'invalid email' }, 400)
  if (result.status === 'invalid_amount') return c.json({ error: 'invalid amount' }, 400)

  const body = {
    id: result.saleId,
    status: result.status,
    subscriber_id: result.subscriberId,
    campaign: result.campaignSlug ?? null,
    attributed_by: result.attributedBy ?? null,
    tags_applied: result.tagsApplied ?? 0,
    ended_sequence: result.endedSequence ?? false,
    ...(result.warnings ? { warnings: result.warnings } : {}),
  }

  // A replay is a success, not a conflict — the caller's retry did its job.
  return c.json(body, result.status === 'recorded' ? 201 : 200)
})
