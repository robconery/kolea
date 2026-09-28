import { Hono } from 'hono'
import {
  ALLOWED_DOWNLOAD_TYPES,
  MAX_DOWNLOAD_BYTES,
  attachFile,
  countDownload,
  countShareDownload,
  detachFile,
  downloadKey,
  downloadUrl,
  resolveGrant,
  resolveShare,
} from '../core/downloads.ts'
import { getForm } from '../core/forms.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { requireOperator } from '../web/auth.ts'

export const downloadRoutes = new Hono<{ Bindings: Env }>()

/**
 * ⭐ The only way a form's file leaves the building.
 *
 * Public, because the link arrives in email and the reader has no session. The
 * token *is* the authorization: it resolves to one grant row, issued to one
 * person, for one form — or to the form itself, when it is the direct link the
 * operator hands out. Nothing else about the request is trusted, and no route
 * serves the DOWNLOADS bucket by key, so a guessed R2 key gets you nothing.
 */
downloadRoutes.get('/d/:token', async (c) => {
  const db = getDb(c.env)
  const token = c.req.param('token')
  const granted = await resolveGrant(db, token)
  // Grants first: they are nearly every request, and the two token spaces are
  // random strings of different lengths, so one can't shadow the other.
  const form = granted?.form ?? (await resolveShare(db, token))
  if (!form?.downloadKey) return c.notFound()

  const object = await c.env.DOWNLOADS.get(form.downloadKey)
  // The row outlived the file — worth being explicit, because the person is
  // holding a link we sent them and "not found" reads like their fault.
  if (!object) return c.text('That file is no longer available.', 410)

  // Counted before the body streams: a row in D1 is the only durable record that
  // this download happened (invariant 7).
  if (granted) await countDownload(db, granted.grant.id)
  else await countShareDownload(db, form.id)

  const filename = (form.downloadFilename ?? 'download').replace(/"/g, '')
  return new Response(object.body, {
    headers: {
      'Content-Type': form.downloadContentType ?? 'application/octet-stream',
      ...(form.downloadBytes ? { 'Content-Length': String(form.downloadBytes) } : {}),
      'Content-Disposition': `attachment; filename="${filename}"`,
      // Never let a shared cache anywhere hold a copy: most of these URLs are
      // personal, and a cached one would go uncounted and outlive a reset.
      'Cache-Control': 'private, no-store',
    },
  })
})

// The file is edited from the form's own page, so these are operator-only.
downloadRoutes.use('/api/forms/*', requireOperator)

/**
 * Attach a file to a form, streaming.
 *
 * A raw `PUT` rather than a multipart form on purpose: `formData()` buffers the
 * whole body, and a Worker has 128MB of memory, so a 100MB zip posted as
 * multipart is a crash. `request.body` goes to R2 as a stream and never lands in
 * the isolate at all.
 */
downloadRoutes.put('/api/forms/:id/file', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await getForm(db, id)
  if (!form) return c.json({ error: 'no such form' }, 404)

  const filename = (c.req.query('filename') ?? '').trim() || 'download.zip'
  const contentType = (c.req.header('Content-Type') ?? 'application/octet-stream')
    .split(';')[0]!
    .trim()

  if (!ALLOWED_DOWNLOAD_TYPES.has(contentType)) {
    return c.json({ error: `unsupported type ${contentType || 'unknown'}` }, 415)
  }

  // Content-Length is advisory — a chunked upload has none — so it is a cheap
  // early reject, not the enforcement. The object's real size is checked after.
  const declared = Number(c.req.header('Content-Length') ?? '0')
  if (declared > MAX_DOWNLOAD_BYTES) {
    return c.json({ error: `file is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB` }, 413)
  }
  if (!c.req.raw.body) return c.json({ error: 'empty body' }, 400)

  const key = downloadKey(id, contentType, filename)
  const object = await c.env.DOWNLOADS.put(key, c.req.raw.body, { httpMetadata: { contentType } })
  if (!object) return c.json({ error: 'upload failed' }, 500)

  if (object.size > MAX_DOWNLOAD_BYTES) {
    await c.env.DOWNLOADS.delete(key)
    return c.json({ error: `file is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB` }, 413)
  }

  // Replacing a file keeps the links working: the grants point at the form, not
  // at the bytes, so everyone who already has a link now gets the new version.
  const previous = form.downloadKey
  await attachFile(db, id, { key, filename, contentType, bytes: object.size })
  if (previous && previous !== key) await c.env.DOWNLOADS.delete(previous)

  const saved = await getForm(db, id)
  return c.json({
    filename,
    bytes: object.size,
    url: saved?.downloadShareToken ? downloadUrl(c.env.PUBLIC_URL, saved.downloadShareToken) : null,
  })
})

downloadRoutes.delete('/api/forms/:id/file', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await getForm(db, id)
  if (!form) return c.json({ error: 'no such form' }, 404)

  // Rows first, so every grant is revoked before the bytes go: a dead link that
  // 404s is a cleaner story than one that 410s forever.
  await detachFile(db, id)
  if (form.downloadKey) await c.env.DOWNLOADS.delete(form.downloadKey)
  return c.json({ ok: true })
})
