import { Hono } from 'hono'
import { deleteMedia, listMedia, storeMedia } from '../core/media.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { requireOperator } from '../web/auth.ts'
import { requireRole } from '../web/roles.ts'

export const mediaRoutes = new Hono<{ Bindings: Env }>()

/** The icon files a reader-facing page may ask for. Nothing else in `public/` is served this way. */
export const PUBLIC_ICONS = new Set(['favicon.ico', 'favicon.png', 'apple-touch-icon.png'])

/**
 * The product's own icons, for pages a reader opens without signing in.
 *
 * `/favicon.ico` and friends are static assets on the console's hostname, and
 * on a live install that hostname is behind the operator's login. A reader on
 * a form or the preference centre has no session, so their browser was handed a
 * redirect to the login page instead of an icon. `/media/*` is already open to
 * everyone, because images in sent mail live there, so the same files are
 * answered under it and no install has to open another path.
 *
 * Registered before the uploaded-media route: `_icons/` is not a key that route
 * could ever hold, since its keys are random tokens.
 */
mediaRoutes.get('/media/_icons/:file', async (c) => {
  const file = c.req.param('file')
  if (!PUBLIC_ICONS.has(file)) return c.notFound()
  const asset = await c.env.ASSETS.fetch(new Request(new URL(`/${file}`, c.req.url)))
  if (!asset.ok) return c.notFound()

  const headers = new Headers()
  const type = asset.headers.get('content-type')
  if (type) headers.set('content-type', type)
  headers.set('Cache-Control', 'public, max-age=86400')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(asset.body, { headers })
})

/**
 * Serve an uploaded image out of R2. Public — these URLs go into email, so they
 * must resolve for any recipient with no session.
 */
mediaRoutes.get('/media/:key{.+}', async (c) => {
  const key = c.req.param('key')
  // Uploaded themes keep their assets in the same bucket. Those are served by
  // the public site's host, never here: an SVG with a <script> in someone's
  // theme must not run on the console's origin.
  if (key.startsWith('themes/')) return c.notFound()
  const object = await c.env.MEDIA.get(key)
  if (!object) return c.notFound()

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  // Keys are content-addressed by a random token, so a URL never changes meaning.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  // Belt and braces: never sniffed into HTML, and sandboxed if it is an SVG.
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")

  return new Response(object.body, { headers })
})

// Uploading is operator-only even though serving is public.
mediaRoutes.use('/api/media/*', requireOperator, requireRole)

mediaRoutes.post('/api/media/upload', async (c) => {
  const db = getDb(c.env)

  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return c.json({ error: 'expected a `file` field' }, 400)

  const result = await storeMedia(c.env, db, file)
  if (!result.ok) return c.json({ error: result.message }, result.status)

  return c.json({ url: result.url, key: result.key })
})

/**
 * The library as JSON, newest first, paged: what the composer's image picker
 * reads. `?page=` and `?per_page=` (at most 200).
 */
mediaRoutes.get('/api/media', async (c) => {
  const page = await listMedia(c.env, getDb(c.env), {
    page: Number(c.req.query('page') ?? 1),
    perPage: Number(c.req.query('per_page') ?? 48),
  })
  return c.json({
    items: page.items.map((m) => ({
      url: m.url,
      key: m.key,
      filename: m.filename,
      bytes: m.bytes,
      width: m.width,
      height: m.height,
      created_at: m.createdAt.getTime(),
    })),
    page: page.page,
    per_page: page.perPage,
    total: page.total,
    pages: page.pages,
  })
})

/** Refused with 409 and the places it is used while anything shows it; `?force=1` deletes anyway. */
mediaRoutes.delete('/api/media/:key{.+}', async (c) => {
  const result = await deleteMedia(c.env, getDb(c.env), c.req.param('key'), {
    force: c.req.query('force') === '1',
  })
  if (result.ok) return c.json({ ok: true })
  if (result.reason === 'not_found') return c.json({ error: 'No such image.' }, 404)
  return c.json({ error: 'That image is still in use.', usage: result.usage }, 409)
})
