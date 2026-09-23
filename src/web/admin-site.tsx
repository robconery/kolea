import { Hono } from 'hono'
import { storeMedia } from '../core/media.ts'
import { listAllPostTags, listPublicTags, setHomeTopics } from '../core/post-tags.ts'
import { listPosts } from '../core/posts.ts'
import {
  formatSocialLinks,
  getSiteSettings,
  parseSocialLinks,
  saveSiteSettings,
} from '../core/site-settings.ts'
import { PROFILE_ICONS, readProfile, validateProfile } from '../core/site-profile.ts'
import { siteConfig } from '../core/theme/site.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, RichEditor, readEditorBody } from './layout.tsx'

/**
 * The Profile screen: who the site is and who writes it. Everything here feeds the
 * public site's front page and `/about`, through whichever theme is live.
 *
 * Deliberately a handful of fields, not a page builder. Themes decide how a
 * front page looks; this decides what it says. (The onboarding interview will
 * fill these in later; this is where they get edited afterwards.)
 */
export const siteAdmin = new Hono<{ Bindings: Env }>()

siteAdmin.get('/site', async (c) => {
  const db = getDb(c.env)
  const s = await getSiteSettings(db)
  // What renders when a field is left blank — shown as the placeholder, so an
  // empty box never looks like the site has no name.
  const env = siteConfig(c.env)
  const topics = await listAllPostTags(db)
  const counts = new Map((await listPublicTags(db, 500)).map((t) => [t.id, t.posts]))
  const { posts: featured } = await listPosts(db, { featured: true, limit: 50 })
  const siteUrl = env.origin
  const profile = readProfile(s?.profile)
  // Always a few empty rows to fill in; blank rows are ignored on save.
  const doRows = [...profile.what_i_do, ...Array(6).fill(null)].slice(0, 6)
  const linkRows = [...profile.links, ...Array(8).fill(null)].slice(0, 8)

  return c.html(
    <Layout title="Profile" nav="site" editor>
      <div class="head">
        <div>
          <h1>Profile</h1>
          <div class="sub">
            Who the site is and who writes it. The live theme decides how it looks.
            {siteUrl ? (
              <>
                {' '}
                <a href={siteUrl}>View the site →</a>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <form method="post" action="/site" enctype="multipart/form-data">
        <div class="card">
          <div class="card-h">
            <h2>The site</h2>
          </div>
          <div class="card-b">
            <div class="row">
              <div class="field">
                <label>Name</label>
                <input type="text" name="title" value={s?.title ?? ''} placeholder={env.title} />
              </div>
              <div class="field">
                <label>Tagline</label>
                <input type="text" name="tagline" value={s?.tagline ?? ''} placeholder={env.tagline} />
              </div>
            </div>
            <div class="row">
              <div class="field">
                <label>Logo URL</label>
                <input type="url" name="logo_url" value={s?.logoUrl ?? ''} placeholder="https://…" />
              </div>
              <div class="field">
                <label>…or upload a logo</label>
                <input type="file" name="logo_file" accept="image/*" />
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            <h2>About you</h2>
          </div>
          <div class="card-b">
            <div class="row">
              <div class="field">
                <label>Your name</label>
                <input type="text" name="author_name" value={s?.authorName ?? ''} placeholder={env.author} />
              </div>
              <div class="field">
                <label>Photo URL</label>
                <input type="url" name="author_photo_url" value={s?.authorPhotoUrl ?? ''} placeholder="https://…" />
              </div>
              <div class="field">
                <label>…or upload a photo</label>
                <input type="file" name="author_photo_file" accept="image/*" />
              </div>
            </div>
            {s?.authorPhotoUrl ? (
              <p style="margin:-8px 0 20px">
                <img
                  src={s.authorPhotoUrl}
                  alt=""
                  width="72"
                  height="72"
                  style="border-radius:50%;object-fit:cover;display:block"
                />
              </p>
            ) : null}
            <div class="field">
              <label>Short bio</label>
              <textarea
                name="short_bio"
                rows={5}
                style="min-height:0;font:15px/1.6 var(--sans)"
                placeholder="Two or three sentences: who you are, what you write about, and why someone should listen. Shown on the front page."
              >
                {s?.shortBio ?? ''}
              </textarea>
              <p class="faint" style="margin:8px 0 0">
                Plain text. A blank line starts a new paragraph. Shown in the front page's About section.
              </p>
            </div>
            <div class="field">
              <label>Links</label>
              <textarea
                name="social_links"
                rows={5}
                style="min-height:0"
                placeholder={'GitHub https://github.com/you\nPodcast https://…'}
              >
                {formatSocialLinks(s?.socialLinks ?? [])}
              </textarea>
              <p class="faint" style="margin:8px 0 0">One per line: a label, then the URL.</p>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            <h2>The About page</h2>
          </div>
          <div class="card-b">
            <p class="faint" style="margin:0 0 16px">
              The long version, at <code>/about</code>. Leave it empty and there is no About page and no link to one.
            </p>
            <RichEditor json={s?.longBioJson ?? null} md={s?.longBioMd ?? ''} inline />
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            <h2>The front page</h2>
          </div>
          <div class="card-b">
            <div class="field">
              <label>Lede</label>
              <textarea
                name="profile_lede"
                rows={3}
                style="min-height:0;font:15px/1.6 var(--sans)"
                placeholder="One paragraph under the headline: what you do and why someone should subscribe."
              >
                {profile.lede}
              </textarea>
            </div>

            <div class="field">
              <label>What I do</label>
              <p class="faint" style="margin:6px 0 12px">Up to six. Leave a title empty to skip that row.</p>
              {doRows.map((item, i) => (
                <div class="row" style="margin-bottom:10px">
                  <div class="field" style="flex:0 0 190px;margin:0">
                    <input type="text" name={`do_title_${i}`} value={item?.title ?? ''} placeholder="Title" />
                  </div>
                  <div class="field" style="flex:0 0 130px;min-width:0;margin:0">
                    <select name={`do_icon_${i}`}>
                      {PROFILE_ICONS.map((ic) => (
                        <option value={ic} selected={(item?.icon ?? 'pen') === ic}>
                          {ic}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div class="field" style="margin:0">
                    <input type="text" name={`do_body_${i}`} value={item?.body ?? ''} placeholder="A sentence or two" />
                  </div>
                </div>
              ))}
            </div>

            <div class="field">
              <label>Notable links</label>
              <p class="faint" style="margin:6px 0 12px">Up to eight: a podcast, a book, a repo, anything. Leave a title empty to skip.</p>
              {linkRows.map((l, i) => (
                <div class="row" style="margin-bottom:10px">
                  <div class="field" style="flex:0 0 130px;min-width:0;margin:0">
                    <input type="text" name={`link_kind_${i}`} value={l?.kind ?? ''} placeholder="Kind" />
                  </div>
                  <div class="field" style="flex:0 0 200px;margin:0">
                    <input type="text" name={`link_title_${i}`} value={l?.title ?? ''} placeholder="Title" />
                  </div>
                  <div class="field" style="flex:0 0 240px;margin:0">
                    <input type="url" name={`link_url_${i}`} value={l?.url ?? ''} placeholder="https://…" />
                  </div>
                  <div class="field" style="margin:0">
                    <input type="text" name={`link_blurb_${i}`} value={l?.blurb ?? ''} placeholder="One line about it" />
                  </div>
                </div>
              ))}
            </div>

            <div class="field">
              <label>Start here</label>
              {featured.length ? (
                <ul style="margin:6px 0 0;padding-left:18px">
                  {featured.map((p) => (
                    <li>
                      <a href={`/broadcasts/${p.id}/publishing`}>{p.subject}</a>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p class="faint" style="margin:8px 0 0">
                {featured.length
                  ? 'Featured posts, newest first. '
                  : 'No featured posts yet, so the front page has no "Start here". '}
                Feature a post from its Publishing screen.
              </p>
            </div>

            <div class="field">
              <label>Show these topics on the front page</label>
              {topics.length ? (
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px 20px;margin-top:10px">
                  {topics.map((t) => (
                    <label style="display:flex;gap:10px;align-items:center;text-transform:none;letter-spacing:0;font:14px var(--sans)">
                      <input type="checkbox" name="home_topics" value={String(t.id)} checked={t.showOnHome} />
                      <span>
                        {t.name} <span class="faint">({counts.get(t.id) ?? 0})</span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p class="faint" style="margin:8px 0 0">No topics yet. Tag posts on their Publishing screen.</p>
              )}
              <p class="faint" style="margin:10px 0 0">Each ticked topic gets a shelf of its newest posts.</p>
            </div>
          </div>
        </div>

        <div style="margin:8px 0 60px">
          <button class="btn primary">Save</button>
        </div>
      </form>
    </Layout>,
  )
})

siteAdmin.post('/site', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const text = (k: string) => String(form.get(k) ?? '').trim() || null

  // An upload wins over a typed URL; a failed upload stops the save rather
  // than silently keeping the old picture.
  const upload = async (field: string): Promise<string | null | { error: string }> => {
    const file = form.get(field)
    if (!(file instanceof File) || file.size === 0) return null
    const stored = await storeMedia(c.env, db, file)
    return stored.ok ? stored.url : { error: stored.message }
  }
  const logo = await upload('logo_file')
  const photo = await upload('author_photo_file')
  for (const r of [logo, photo]) {
    if (r && typeof r === 'object') return c.redirect(`/site?flash=${encodeURIComponent(r.error)}&kind=warn`)
  }

  const str = (k: string) => String(form.get(k) ?? '').trim()
  const what_i_do = []
  for (let i = 0; i < 6; i++) {
    const title = str(`do_title_${i}`)
    if (title) what_i_do.push({ title, body: str(`do_body_${i}`), icon: str(`do_icon_${i}`) || 'pen' })
  }
  const links = []
  for (let i = 0; i < 8; i++) {
    const title = str(`link_title_${i}`)
    if (title) links.push({ kind: str(`link_kind_${i}`), title, url: str(`link_url_${i}`), blurb: str(`link_blurb_${i}`) })
  }
  const checked = validateProfile({ lede: str('profile_lede'), what_i_do, links })
  if (!checked.ok) {
    // Nothing is saved: a half-saved form is harder to reason about than a refused one.
    return c.redirect(`/site?flash=${encodeURIComponent(`Not saved. ${checked.error}`)}&kind=warn`)
  }

  const bio = readEditorBody(form)
  await saveSiteSettings(db, {
    profile: checked.profile,
    title: text('title'),
    tagline: text('tagline'),
    logoUrl: (logo as string | null) ?? text('logo_url'),
    authorName: text('author_name'),
    authorPhotoUrl: (photo as string | null) ?? text('author_photo_url'),
    shortBio: String(form.get('short_bio') ?? '').trim() || null,
    socialLinks: parseSocialLinks(String(form.get('social_links') ?? '')),
    longBioJson: bio.bodyJson,
    longBioMd: bio.bodyMd || null,
  })
  await setHomeTopics(
    db,
    form
      .getAll('home_topics')
      .map((v) => Number(v))
      .filter(Number.isFinite),
  )

  return c.redirect('/site?flash=Saved.')
})
