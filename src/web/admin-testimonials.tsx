import { Hono } from 'hono'
import {
  decideTestimonial,
  deleteTestimonial,
  listTestimonials,
} from '../core/testimonials.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate } from './layout.tsx'

/**
 * The testimonials inbox: approve, hide, delete. Every rule (approving needs the
 * writer's permission) lives in `core/testimonials.ts`.
 */
export const testimonialsAdmin = new Hono<{ Bindings: Env }>()

testimonialsAdmin.get('/testimonials', async (c) => {
  const rows = await listTestimonials(getDb(c.env))
  return c.html(
    <Layout title="Testimonials" nav="testi">
      <div class="head">
        <div>
          <h1>Testimonials</h1>
          <div class="sub">
            What readers wrote through <span class="mono">{'{{testimonial_link}}'}</span> in your
            mail. Approved ones show on the site's <span class="mono">/testimonials</span> wall.
          </div>
        </div>
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b flush">
          {rows.length === 0 ? (
            <div class="empty">
              <p>No testimonials yet.</p>
              <p class="faint">
                Put <span class="mono">{'{{testimonial_link}}'}</span> in a broadcast or a sequence
                step and each reader gets their own link to write one.
              </p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>What they said</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ testimonial: t, email }) => (
                  <tr>
                    <td>
                      <a href={`/subscribers/${t.subscriberId}`}>{t.displayName}</a>
                      <div class="faint mono">{email}</div>
                      <div class="faint">{fmtDate(t.createdAt)}</div>
                    </td>
                    <td style="white-space:pre-wrap;max-width:520px">{t.body}</td>
                    <td>
                      <span class="pill">{t.status}</span>
                      {t.mayPublish ? null : <div class="faint">not for publishing</div>}
                    </td>
                    <td>
                      <div class="actions">
                        {t.status !== 'approved' && t.mayPublish ? (
                          <form method="post" action={`/testimonials/${t.id}/approve`}>
                            <button class="btn sm primary">Approve</button>
                          </form>
                        ) : null}
                        {t.status !== 'hidden' ? (
                          <form method="post" action={`/testimonials/${t.id}/hide`}>
                            <button class="btn sm">Hide</button>
                          </form>
                        ) : null}
                        <form method="post" action={`/testimonials/${t.id}/delete`}>
                          <button class="btn sm danger">Delete</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>,
  )
})

testimonialsAdmin.post('/testimonials/:id/:action{approve|hide}', async (c) => {
  const action = c.req.param('action') as 'approve' | 'hide'
  const result = await decideTestimonial(getDb(c.env), Number(c.req.param('id')), action)
  if (!result.ok) {
    const msg =
      result.reason === 'no_publish_consent'
        ? 'The writer did not allow this one to be published.'
        : 'That testimonial is gone.'
    return c.redirect(`/testimonials?flash=${encodeURIComponent(msg)}&kind=warn`)
  }
  return c.redirect(`/testimonials?flash=${action === 'approve' ? 'Approved.' : 'Hidden.'}`)
})

testimonialsAdmin.post('/testimonials/:id/delete', async (c) => {
  await deleteTestimonial(getDb(c.env), Number(c.req.param('id')))
  return c.redirect('/testimonials?flash=Deleted.')
})
