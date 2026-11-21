import { Hono } from 'hono'
import { deleteMedia, listMedia, storeMedia } from '../core/media.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { requireOperator } from '../web/auth.ts'
import { requireRole } from '../web/roles.ts'

export const mediaRoutes = new Hono<{ Bindings: Env }>()

/**
 * Serve an uploaded image out of R2. Public — these URLs go into email, so they
 * must resolve for any recipient with no session.
 */
mediaRoutes.get('/media/:key{.+}', async (c) => {
  const key = c.req.param('key')
  const object = await c.env.MEDIA.get(key)
  if (!object) return c.notFound()

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  // Keys are content-addressed by a random token, so a URL never changes meaning.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')

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
