import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { randomToken } from '../core/ids.ts'
import { getDb } from '../db/index.ts'
import { media } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { requireOperator } from '../web/auth.ts'

export const mediaRoutes = new Hono<{ Bindings: Env }>()

const MAX_BYTES = 10 * 1024 * 1024

// Allowlist rather than blocklist: an uploaded SVG can carry script, and these
// files are served from our own origin.
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

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

  if (file.size > MAX_BYTES) {
    return c.json({ error: `file is larger than ${MAX_BYTES / 1024 / 1024}MB` }, 413)
  }
  if (!ALLOWED.has(file.type)) {
    return c.json({ error: `unsupported type ${file.type || 'unknown'}` }, 415)
  }

  const ext = EXT[file.type] ?? 'bin'
  const key = `${new Date().toISOString().slice(0, 7)}/${randomToken(20)}.${ext}`
  const bytes = await file.arrayBuffer()

  await c.env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
  })

  await db.insert(media).values({
    key,
    filename: file.name || `upload.${ext}`,
    contentType: file.type,
    bytes: file.size,
    createdAt: new Date(),
  })

  // Absolute URL: this lands in an email, where a relative path is meaningless.
  return c.json({ url: `${c.env.PUBLIC_URL}/media/${key}`, key })
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
  const db = getDb(c.env)
  const key = c.req.param('key')
  await c.env.MEDIA.delete(key)
  await db.delete(media).where(eq(media.key, key))
  return c.json({ ok: true })
})
