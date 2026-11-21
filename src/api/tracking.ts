import { Hono } from 'hono'
import { recordEvent } from '../core/events.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'

/**
 * `GET /t/open/:id.gif` and `GET /t/click/:id` — the only routes that answer on
 * a tracking host.
 *
 * Its own router so `worker.tsx` can mount it twice: in the console app (where
 * every link sent on `PUBLIC_URL` has always pointed, and must keep pointing),
 * and alone on `TRACKING_HOST`, where nothing else exists. See
 * `core/tracking-host.ts`.
 */
export const tracking = new Hono<{ Bindings: Env }>()

// ───────────────────────────────────────────────── tracking

const PIXEL = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (ch) => ch.charCodeAt(0),
)

tracking.get('/t/open/:id{[0-9]+\\.gif}', async (c) => {
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

tracking.get('/t/click/:id', async (c) => {
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
