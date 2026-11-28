import { Hono } from 'hono'
import { recordEvent, recordOpen } from '../core/events.ts'
import { fixedDestination } from '../core/link-fixes.ts'
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
    if (messageId) {
      await recordOpen(db, messageId, {
        userAgent: c.req.header('user-agent'),
        ip: c.req.header('cf-connecting-ip'),
      })
    }
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

  // A link fixed after the send (SPEC 5.15) sends the reader to the corrected
  // address. A lookup that fails falls back to the link as written: a click
  // that goes where the mail said is better than one that goes nowhere.
  let to = url
  try {
    if (messageId) to = (await fixedDestination(db, messageId, url)) ?? url
  } catch {
    /* swallow — the redirect matters more than the fix */
  }

  // Recording must never be able to break the reader's click (SPEC 5.4).
  // `url` stays the link as mailed, so per-link counts keep adding up across a
  // fix; `fixed_to` says where the reader was actually sent.
  try {
    if (messageId) await recordEvent(db, messageId, 'click', to === url ? { url } : { url, fixed_to: to })
  } catch {
    /* swallow — the redirect matters more than the datapoint */
  }

  return c.redirect(to, 302)
})
