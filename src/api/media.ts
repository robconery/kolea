import { desc } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteMedia, storeMedia } from '../core/media.ts'
import { getDb } from '../db/index.ts'
import { media } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { requireOperator } from '../web/auth.ts'

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
mediaRoutes.use('/api/media/*', requireOperator)

mediaRoutes.post('/api/media/upload', async (c) => {
  const db = getDb(c.env)

  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return c.json({ error: 'expected a `file` field' }, 400)

  const result = await storeMedia(c.env, db, file)
  if (!result.ok) return c.json({ error: result.message }, result.status)

  return c.json({ url: result.url, key: result.key })
})

mediaRoutes.get('/api/media', async (c) => {
  const db = getDb(c.env)
  const rows = await db.select().from(media).orderBy(desc(media.id)).limit(60).all()
  return c.json({
    items: rows.map((m) => ({
      url: `${c.env.PUBLIC_URL}/media/${m.key}`,
      key: m.key,
      filename: m.filename,
      bytes: m.bytes,
    })),
  })
})

mediaRoutes.delete('/api/media/:key{.+}', async (c) => {
  await deleteMedia(c.env, getDb(c.env), c.req.param('key'))
  return c.json({ ok: true })
})
