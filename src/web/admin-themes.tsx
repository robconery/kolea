import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { listAllPostTags, listPublicTags } from '../core/post-tags.ts'
import { ADAPT_GHOST_THEME_PROMPT } from '../core/theme/adapt-prompt.ts'
import { renderIndex, renderPost, siteConfig } from '../core/theme/site.ts'
import {
  ThemeInstallError,
  activateTheme,
  builtinTheme,
  customSettings,
  deleteTheme,
  installThemeZip,
  listThemes,
  loadThemeById,
  readThemeAsset,
  saveThemeSettings,
} from '../core/theme/store.ts'
import { listPosts } from '../core/posts.ts'
import { tagsForPost } from '../core/post-tags.ts'
import { getDb } from '../db/index.ts'
import { postTags, themes } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate } from './layout.tsx'

/**
 * Themes: what the public site looks like.
 *
 * Install a zip (a Ghost theme, or one written for Kōlea), preview it against
 * the real archive, switch it on. Switching is instant and reversible, and the
 * built-in theme is always there underneath — deleting the live theme drops the
 * site back to it rather than to a blank page.
 *
 * Nothing on this screen touches mail. Topics (post tags) are here rather than
 * under Audience because they organise pages, not people.
 */
export const themesAdmin = new Hono<{ Bindings: Env }>()

type Ctx = Context<{ Bindings: Env }>

const back = (c: Ctx, msg: string, kind?: 'warn') =>
  c.redirect(`/themes?flash=${encodeURIComponent(msg)}${kind ? `&kind=${kind}` : ''}`)

themesAdmin.get('/themes', async (c) => {
  const db = getDb(c.env)
  const all = await listThemes(db)
  const active = all.find((t) => t.isActive) ?? null
  const topics = await listAllPostTags(db)
  const counts = new Map((await listPublicTags(db, 500)).map((t) => [t.id, t.posts]))
  const kolea = builtinTheme()
  const siteUrl = (c.env.SITE_URL ?? '').replace(/\/$/, '')

  return c.html(
    <Layout title="Themes" nav="theme">
      <div class="head">
        <div>
          <h1>Themes</h1>
          <div class="sub">
            What the public site looks like. Ghost themes install as they are.
            {siteUrl ? (
              <>
                {' '}
                Live at <a href={siteUrl}>{siteUrl}</a>.
              </>
            ) : null}
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>Installed</h2>
        </div>
        <div class="card-b">
          <table>
            <thead>
              <tr>
                <th>Theme</th>
                <th>Version</th>
                <th>Installed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>{kolea.name}</strong> <span class="faint">built in</span>{' '}
                  {active ? null : <span class="pill ok">live</span>}
                </td>
                <td class="mono">{kolea.version}</td>
                <td class="faint">ships with Kōlea</td>
                <td style="text-align:right;white-space:nowrap">
                  <a class="btn sm" href="/themes/builtin/preview" target="_blank">
                    Preview
                  </a>{' '}
                  {active ? (
                    <form method="post" action="/themes/builtin/activate" style="display:inline">
                      <button class="btn sm primary">Use this</button>
                    </form>
                  ) : null}
                </td>
              </tr>
              {all.map((t) => (
                <tr>
                  <td>
                    <strong>{t.name}</strong> {t.isActive ? <span class="pill ok">live</span> : null}
                    {customSettings(t.packageJson).length ? (
                      <div>
                        <a class="faint" href={`/themes/${t.id}`}>
                          Settings →
                        </a>
                      </div>
                    ) : null}
                  </td>
                  <td class="mono">{t.version}</td>
                  <td class="faint">{fmtDate(t.updatedAt)}</td>
                  <td style="text-align:right;white-space:nowrap">
                    <a class="btn sm" href={`/themes/${t.id}/preview`} target="_blank">
                      Preview
                    </a>{' '}
                    {t.isActive ? null : (
                      <form method="post" action={`/themes/${t.id}/activate`} style="display:inline">
                        <button class="btn sm primary">Use this</button>
                      </form>
                    )}{' '}
                    <form method="post" action={`/themes/${t.id}/delete`} style="display:inline">
                      <button class="btn sm danger">Delete</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Install a theme</h2>
        </div>
        <div class="card-b">
          <form method="post" action="/themes/upload" enctype="multipart/form-data" class="stack">
            <p class="faint" style="margin:0 0 12px">
              A zip with <code>package.json</code>, <code>index.hbs</code> and <code>post.hbs</code> at its root
              — which is every Ghost theme, including GitHub's "Download ZIP". Uploading a theme with the same
              name replaces it. Nothing goes live until you press <em>Use this</em>.
            </p>
            <input type="file" name="file" accept=".zip,application/zip" required />
            <div style="margin-top:12px">
              <button class="btn primary">Install</button>
            </div>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Topics</h2>
          <span class="pill">{topics.length}</span>
        </div>
        <div class="card-b">
          <p class="faint" style="margin:0 0 14px">
            Post tags. A post's first tag is its topic and the first part of its URL: tag a post “AI” and it lives
            at <code>/ai/its-slug</code>, and <code>/ai</code> lists everything tagged AI. Tag posts on their
            Publishing screen. The busiest topics are the site's navigation.
          </p>
          {topics.length ? (
            <table>
              <thead>
                <tr>
                  <th>Topic</th>
                  <th>Posts</th>
                  <th>Description (shown on its archive page)</th>
                </tr>
              </thead>
              <tbody>
                {topics.map((t) => (
                  <tr>
                    <td>
                      {siteUrl ? <a href={`${siteUrl}/${t.slug}`}>{t.name}</a> : t.name}
                      <div class="faint mono">/{t.slug}</div>
                    </td>
                    <td class="mono">{counts.get(t.id) ?? 0}</td>
                    <td>
                      <form method="post" action={`/themes/topics/${t.id}`} style="display:flex;gap:8px">
                        <input type="text" name="description" value={t.description ?? ''} style="flex:1" />
                        <button class="btn sm" style="flex:0 0 auto;min-width:0">
                          Save
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="faint">No topics yet.</p>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Adapting a Ghost theme</h2>
        </div>
        <div class="card-b">
          <p class="faint" style="margin:0 0 12px">
            Most Ghost themes work as they are. When one leans on paid membership, Portal or a helper Kōlea doesn't
            have, the install tells you which — then give this prompt, and the theme's files, to Claude.
          </p>
          <textarea readonly rows={14} style="width:100%;font:12.5px/1.5 var(--mono)">
            {ADAPT_GHOST_THEME_PROMPT}
          </textarea>
        </div>
      </div>
    </Layout>,
  )
})

themesAdmin.post('/themes/upload', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) return back(c, 'Pick a zip first.', 'warn')

  try {
    const r = await installThemeZip(db, c.env.MEDIA, new Uint8Array(await file.arrayBuffer()))
    const parts = [
      `${r.replaced ? 'Replaced' : 'Installed'} ${r.theme.name} ${r.theme.version}: ${r.templates} templates, ${r.assets} assets.`,
    ]
    if (r.unknownHelpers.length) {
      parts.push(
        `These helpers aren't in Kōlea and will render nothing: ${r.unknownHelpers.join(', ')}. The prompt below adapts them.`,
      )
    }
    return back(c, parts.join(' '), r.unknownHelpers.length ? 'warn' : undefined)
  } catch (err) {
    if (err instanceof ThemeInstallError) {
      const detail = err.details.length ? ` ${err.details.slice(0, 5).join(' · ')}` : ''
      return back(c, `${err.message}${detail}`, 'warn')
    }
    throw err
  }
})

themesAdmin.post('/themes/builtin/activate', async (c) => {
  await activateTheme(getDb(c.env), null)
  return back(c, 'The built-in theme is live.')
})

themesAdmin.post('/themes/:id/activate', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const row = await db.select().from(themes).where(eq(themes.id, id)).get()
  if (!row) return back(c, 'No such theme.', 'warn')
  await activateTheme(db, id)
  return back(c, `${row.name} is live.`)
})

themesAdmin.post('/themes/:id/delete', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const row = await db.select().from(themes).where(eq(themes.id, id)).get()
  if (!row) return back(c, 'No such theme.', 'warn')
  await deleteTheme(db, c.env.MEDIA, id)
  return back(c, row.isActive ? `Deleted ${row.name}. The built-in theme is live again.` : `Deleted ${row.name}.`)
})

themesAdmin.post('/themes/topics/:id', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const description = String(form.get('description') ?? '').trim() || null
  await db
    .update(postTags)
    .set({ description })
    .where(eq(postTags.id, Number(c.req.param('id'))))
  return back(c, 'Topic saved.')
})

// ─────────────────────────────────────────────────────────── settings

themesAdmin.get('/themes/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const row = await db.select().from(themes).where(eq(themes.id, id)).get()
  if (!row) return c.notFound()
  const theme = await loadThemeById(db, id)
  const defs = customSettings(row.packageJson)

  return c.html(
    <Layout title={`${row.name} · Themes`} nav="theme">
      <div class="head">
        <div>
          <h1>{row.name}</h1>
          <div class="sub">
            <a href="/themes">← Themes</a> · version {row.version}
          </div>
        </div>
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />
      <div class="card">
        <div class="card-h">
          <h2>Theme settings</h2>
        </div>
        <div class="card-b">
          {defs.length === 0 ? (
            <p class="faint">This theme has no settings.</p>
          ) : (
            <form method="post" action={`/themes/${id}/settings`} class="stack">
              {defs.map((d) => {
                const value = theme.custom[d.key]
                const label = d.key.replace(/_/g, ' ').replace(/^./, (s) => s.toUpperCase())
                return (
                  <label class="field">
                    <span>
                      {label}
                      {d.group ? <span class="faint"> · {d.group}</span> : null}
                    </span>
                    {d.type === 'select' ? (
                      <select name={d.key}>
                        {d.options.map((o) => (
                          <option value={o} selected={o === value}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : d.type === 'boolean' ? (
                      <input type="checkbox" name={d.key} checked={value === true} />
                    ) : d.type === 'color' ? (
                      <input type="color" name={d.key} value={String(value ?? '#000000')} />
                    ) : (
                      <input type="text" name={d.key} value={value == null ? '' : String(value)} />
                    )}
                    {d.description ? <span class="faint">{d.description}</span> : null}
                  </label>
                )
              })}
              <div>
                <button class="btn primary">Save</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Layout>,
  )
})

themesAdmin.post('/themes/:id/settings', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const row = await db.select().from(themes).where(eq(themes.id, id)).get()
  if (!row) return c.notFound()
  const form = await c.req.formData()
  const input: Record<string, string | null> = {}
  for (const d of customSettings(row.packageJson)) {
    const v = form.get(d.key)
    input[d.key] = typeof v === 'string' ? v : null
  }
  await saveThemeSettings(db, id, input)
  return c.redirect(`/themes/${id}?flash=Saved.`)
})

// ─────────────────────────────────────────────────────────── preview

/**
 * Render the archive (or the newest post, with `?post=1`) through a theme that
 * may not be live. Links point at the real site — this is a look, not a second
 * site — and a `<base>` makes the theme's relative URLs resolve there too.
 * Assets come from this admin route, because the site only serves the live
 * theme's.
 */
themesAdmin.get('/themes/:id/preview', async (c) => {
  const db = getDb(c.env)
  const raw = c.req.param('id')
  const theme = raw === 'builtin' ? builtinTheme() : await loadThemeById(db, Number(raw))
  if (raw !== 'builtin' && theme.id === null) return c.notFound()

  const adminOrigin = new URL(c.req.url).origin
  const req = {
    db,
    cfg: siteConfig(c.env),
    theme,
    path: '/',
    assetBase: `${adminOrigin}/themes/${raw}/assets`,
  }

  let rendered = null
  if (c.req.query('post')) {
    const { posts } = await listPosts(db, { limit: 1 })
    const post = posts[0]
    if (post) rendered = await renderPost({ ...req, path: `/${post.slug}` }, post, await tagsForPost(db, post.id))
  }
  rendered ??= await renderIndex(req, 1)
  if (!rendered) return c.text('Nothing published to preview with yet.', 404)

  const base = siteConfig(c.env).origin
  const banner = `<div style="position:fixed;z-index:2147483647;left:12px;bottom:12px;padding:8px 12px;border-radius:8px;background:#111;color:#fff;font:12px/1.3 system-ui;box-shadow:0 4px 18px rgba(0,0,0,.4)">Preview: ${theme.name} · <a style="color:#7dd3fc" href="${adminOrigin}/themes/${raw}/preview${c.req.query('post') ? '' : '?post=1'}">${c.req.query('post') ? 'archive' : 'a post'}</a></div>`
  const html = rendered.html
    .replace(/<head([^>]*)>/i, `<head$1><base href="${base}/">`)
    .replace(/<\/body>/i, `${banner}</body>`)
  return c.html(html, 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
})

themesAdmin.get('/themes/:id/assets/*', async (c) => {
  const db = getDb(c.env)
  const raw = c.req.param('id')
  const theme = raw === 'builtin' ? builtinTheme() : await loadThemeById(db, Number(raw))
  const prefix = `/themes/${raw}/assets/`
  let path: string
  try {
    path = decodeURIComponent(c.req.path.slice(prefix.length))
  } catch {
    return c.notFound()
  }
  return (await readThemeAsset(theme, c.env.MEDIA, path)) ?? c.notFound()
})
