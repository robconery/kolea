import { Hono } from 'hono'
import { listTopics, updateTopic } from '../core/post-tags.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout } from './layout.tsx'

/**
 * Topics: the public site's post tags, managed as things in their own right.
 *
 * ⚠️ Not subscriber tags. Those live on Tags & automation and can put mail in
 * an inbox; these only organise pages (see the schema note on `post_tags`).
 *
 * A topic is born the first time a post is tagged with it, on the post's
 * Publishing screen. Here it gets a name, a description for its archive page,
 * and a shelf on the front page. The slug is shown and never edited: it is in
 * the URL of every post under the topic, including links in mail already sent.
 */
export const topicsAdmin = new Hono<{ Bindings: Env }>()

topicsAdmin.get('/topics', async (c) => {
  const topics = await listTopics(getDb(c.env))
  const siteUrl = (c.env.SITE_URL ?? '').replace(/\/$/, '')

  return c.html(
    <Layout title="Topics" nav="topics">
      <div class="head">
        <div>
          <h1>Topics</h1>
          <div class="sub">
            What the site's posts are about. A post's first topic is the first part of its URL: tag it “AI” and it
            lives at <code>/ai/its-slug</code>, and <code>/ai</code> lists everything under AI. Tag posts on their
            Publishing screen. These are not subscriber tags and never send anything.
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>Every topic</h2>
          <span class="pill">{topics.length}</span>
        </div>
        <div class="card-b">
          {topics.length ? (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Posts</th>
                  <th>Description (on its archive page)</th>
                  <th>Front page</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {topics.map((t) => {
                  const form = `topic-${t.id}`
                  return (
                    <tr>
                      <td>
                        <form id={form} method="post" action={`/topics/${t.id}`} />
                        <input type="text" name="name" value={t.name} form={form} maxlength={80} required />
                        <div class="faint mono">
                          {siteUrl && t.published ? <a href={`${siteUrl}/${t.slug}`}>/{t.slug}</a> : `/${t.slug}`}
                        </div>
                      </td>
                      <td class="mono">
                        {t.published}
                        {t.tagged > t.published ? <div class="faint">{t.tagged - t.published} not up</div> : null}
                      </td>
                      <td>
                        <input
                          type="text"
                          name="description"
                          value={t.description ?? ''}
                          form={form}
                          maxlength={500}
                          style="width:100%"
                        />
                      </td>
                      <td>
                        <label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font:14px var(--sans)">
                          <input type="checkbox" name="show_on_home" value="1" checked={t.showOnHome} form={form} />
                          Shelf
                        </label>
                      </td>
                      <td>
                        <button class="btn sm" form={form}>
                          Save
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <p class="faint">No topics yet. Tag a post on its Publishing screen and it appears here.</p>
          )}
          <p class="faint" style="margin:14px 0 0">
            A topic shows on the site once it has a published post. The busiest are the site's navigation; ticked ones
            also get a shelf of their newest posts on the front page.
          </p>
        </div>
      </div>
    </Layout>,
  )
})

topicsAdmin.post('/topics/:id', async (c) => {
  const form = await c.req.formData()
  const r = await updateTopic(getDb(c.env), Number(c.req.param('id')), {
    name: String(form.get('name') ?? ''),
    description: String(form.get('description') ?? ''),
    showOnHome: form.get('show_on_home') === '1',
  })
  const flash = r.ok ? `Saved “${r.topic.name}”.` : `Not saved: ${r.reason}.`
  return c.redirect(`/topics?flash=${encodeURIComponent(flash)}${r.ok ? '' : '&kind=warn'}`)
})
