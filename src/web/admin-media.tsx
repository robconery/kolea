import { Hono } from 'hono'
import { deleteMedia, listMedia, mediaUsage, storeMedia } from '../core/media.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtBytes, fmtDate } from './layout.tsx'

/**
 * The media library: every image uploaded through any door (the editor, a
 * feature image, the site profile, this screen), newest first, paged off the
 * `media` catalogue.
 *
 * Deleting refuses while something still shows the image and names what; the
 * operator can then delete anyway, knowingly. The composer reads the same
 * list as JSON from `GET /api/media` for its "Image from library" picker.
 */
export const mediaAdmin = new Hono<{ Bindings: Env }>()

const PER_PAGE = 48

const back = (msg: string, kind?: 'warn', page = 1) =>
  `/media?${new URLSearchParams({ ...(page > 1 ? { page: String(page) } : {}), flash: msg, ...(kind ? { kind } : {}) })}`

mediaAdmin.get('/media', async (c) => {
  const db = getDb(c.env)
  const lib = await listMedia(c.env, db, { page: Number(c.req.query('page') ?? 1), perPage: PER_PAGE })

  return c.html(
    <Layout title="Media" nav="media">
      <div class="head">
        <div>
          <h1>Media</h1>
          <div class="sub">
            {lib.total} image{lib.total === 1 ? '' : 's'}
            {lib.pages > 1 ? ` · page ${lib.page} of ${lib.pages}` : ''}
          </div>
        </div>
        <div class="actions">
          <form method="post" action="/media" enctype="multipart/form-data" class="row" style="gap:6px">
            <input
              type="file"
              name="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
              required
              style="min-width:0"
            />
            <button class="btn primary" style="flex:0 0 auto;min-width:0">
              Upload
            </button>
          </form>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b flush">
          {lib.items.length === 0 ? (
            <div class="empty">
              <p>{lib.total === 0 ? 'No images yet.' : 'Nothing on this page.'}</p>
              <p class="faint">
                {lib.total === 0 ? 'Upload one here, or drop one into a broadcast.' : <a href="/media">Back to the first page</a>}
              </p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style="width:96px" />
                  <th>File</th>
                  <th>Size</th>
                  <th>Uploaded</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lib.items.map((m) => (
                  <tr>
                    <td>
                      <a href={m.url} target="_blank" rel="noopener">
                        <img
                          src={m.url}
                          alt={m.filename}
                          loading="lazy"
                          style="width:80px;height:56px;object-fit:cover;border-radius:6px;display:block"
                        />
                      </a>
                    </td>
                    <td>
                      <div style="font-weight:500">{m.filename}</div>
                      <input
                        type="text"
                        readonly
                        value={m.url}
                        aria-label={`URL of ${m.filename}`}
                        class="mono"
                        style="width:100%;font-size:12px;margin-top:4px"
                        onclick="this.select();navigator.clipboard&&navigator.clipboard.writeText(this.value)"
                      />
                    </td>
                    <td class="faint">
                      {fmtBytes(m.bytes)}
                      {m.width && m.height ? (
                        <div class="mono">
                          {m.width}×{m.height}
                        </div>
                      ) : null}
                    </td>
                    <td class="faint">{fmtDate(m.createdAt)}</td>
                    <td style="text-align:right">
                      <form method="post" action="/media/delete">
                        <input type="hidden" name="key" value={m.key} />
                        <input type="hidden" name="page" value={String(lib.page)} />
                        <button class="btn">Delete</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {lib.pages > 1 ? (
        <div class="row" style="gap:8px;margin-top:12px">
          {lib.page > 1 ? (
            <a class="btn" href={`/media?page=${lib.page - 1}`}>
              Newer
            </a>
          ) : null}
          {lib.page < lib.pages ? (
            <a class="btn" href={`/media?page=${lib.page + 1}`}>
              Older
            </a>
          ) : null}
        </div>
      ) : null}
    </Layout>,
  )
})

mediaAdmin.post('/media', async (c) => {
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return c.redirect(back('Choose an image to upload.', 'warn'))
  const stored = await storeMedia(c.env, getDb(c.env), file)
  return c.redirect(stored.ok ? back(`Uploaded ${file.name}.`) : back(stored.message, 'warn'))
})

/**
 * Delete, or explain why not. An image still in use gets a confirm page naming
 * every place it shows, with a second button that deletes anyway.
 */
mediaAdmin.post('/media/delete', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const key = String(form.get('key') ?? '')
  const page = Number(form.get('page') ?? 1) || 1
  const force = form.get('force') === '1'

  const result = await deleteMedia(c.env, db, key, { force })
  if (result.ok) return c.redirect(back('Image deleted.', undefined, page))
  if (result.reason === 'not_found') return c.redirect(back('That image was already gone.', 'warn', page))

  const usage = result.usage.length ? result.usage : await mediaUsage(db, key)
  return c.html(
    <Layout title="Delete image?" nav="media">
      <div class="head">
        <h1>This image is still in use</h1>
      </div>
      <div class="card">
        <div class="card-b">
          <div class="note">
            Deleting it leaves a broken picture in each of these. Mail that already went out keeps pointing at
            the old address too.
          </div>
          <ul>
            {usage.map((u) => (
              <li>
                <a href={u.href}>{u.label}</a>
              </li>
            ))}
          </ul>
          <div class="row" style="gap:8px">
            <a class="btn" href={page > 1 ? `/media?page=${page}` : '/media'}>
              Keep it
            </a>
            <form method="post" action="/media/delete">
              <input type="hidden" name="key" value={key} />
              <input type="hidden" name="page" value={String(page)} />
              <input type="hidden" name="force" value="1" />
              <button class="btn danger">Delete anyway</button>
            </form>
          </div>
        </div>
      </div>
    </Layout>,
  )
})
