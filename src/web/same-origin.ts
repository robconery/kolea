import type { MiddlewareHandler } from 'hono'
import type { Env } from '../types.ts'

/**
 * Refuses a state-changing request to the console that a browser says came from
 * another site.
 *
 * Cloudflare Access authenticates by cookie, so a page the operator happens to
 * visit could otherwise auto-submit a form that turns agent sending on, adds a
 * webhook that streams the list out, or mints a key. SameSite on the Access
 * cookie is not ours to set, so the console checks the browser's own word: a
 * present `Origin` must be this host, and a present `Sec-Fetch-Site` must say
 * same-origin (or `none`, a typed URL or bookmark). A request carrying neither
 * header is not a cross-site browser form (curl, the test harness, a server),
 * and is left to the other gates.
 *
 * GET and HEAD are never refused: they change nothing.
 */
export const sameOriginWrites: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const method = c.req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
  const here = new URL(c.req.url).origin
  const origin = c.req.header('origin')
  const site = c.req.header('sec-fetch-site')
  if ((origin && origin !== here) || (site && site !== 'same-origin' && site !== 'none')) {
    return c.text('That request came from another site, so it was refused.', 403)
  }
  return next()
}
