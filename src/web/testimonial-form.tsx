import { Hono } from 'hono'
import {
  BODY_MAX,
  NAME_MAX,
  submitTestimonial,
  subscriberForToken,
} from '../core/testimonials.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { PublicLayout } from './layout.tsx'

/**
 * Where a reader writes a testimonial, reached from `{{testimonial_link}}`.
 *
 * Public, token-only, no session, no JavaScript, like the preference centre it
 * sits beside. The POST is bound to the token in its own URL, so a page
 * elsewhere cannot forge one without already holding the reader's link; a
 * cross-origin POST is refused outright as well. Everything typed is plain text,
 * escaped by JSX here and on the wall.
 */
export const testimonialForm = new Hono<{ Bindings: Env }>()

const NotFound = () => (
  <PublicLayout title="Write a testimonial">
    <h1>Link not recognized</h1>
    <p class="lede">This link is no longer valid.</p>
  </PublicLayout>
)

const Form = ({
  name,
  body,
  error,
}: {
  name: string
  body: string
  error?: string
}) => (
  <PublicLayout title="Write a testimonial">
    <h1>Say a few words?</h1>
    <p class="lede">
      If the writing has helped you, a sentence or two about how means a great deal. Nothing is
      published unless you allow it below.
    </p>
    {error ? <p class="lede" role="alert">{error}</p> : null}
    <form method="post">
      <p>
        <label>
          Your name, as you would like it shown
          <br />
          <input type="text" name="display_name" value={name} maxlength={NAME_MAX} required />
        </label>
      </p>
      <p>
        <label>
          What you would like to say
          <br />
          <textarea name="body" rows={8} maxlength={BODY_MAX} required style="width:100%">
            {body}
          </textarea>
        </label>
      </p>
      <p>
        <label>
          <input type="checkbox" name="may_publish" value="1" checked /> You may publish this on the
          site with my name
        </label>
      </p>
      <button class="btn" type="submit">
        Send it
      </button>
    </form>
  </PublicLayout>
)

testimonialForm.get('/p/:token/testimonial', async (c) => {
  const sub = await subscriberForToken(getDb(c.env), c.req.param('token'))
  if (!sub) return c.html(<NotFound />, 404)
  return c.html(<Form name={sub.name ?? ''} body="" />)
})

testimonialForm.post('/p/:token/testimonial', async (c) => {
  const origin = c.req.header('Origin')
  if (origin && origin !== 'null' && origin !== new URL(c.req.url).origin) {
    return c.text('Forbidden', 403)
  }

  const form = await c.req.formData()
  const name = String(form.get('display_name') ?? '').slice(0, NAME_MAX * 2)
  const body = String(form.get('body') ?? '').slice(0, BODY_MAX * 2)
  const result = await submitTestimonial(getDb(c.env), c.req.param('token'), {
    displayName: name,
    body,
    mayPublish: form.get('may_publish') === '1',
  })

  if (result.ok) {
    return c.html(
      <PublicLayout title="Thank you">
        <h1>Thank you</h1>
        <p class="lede">It means a lot. It will be read by a person before anything goes up.</p>
      </PublicLayout>,
    )
  }
  if (result.reason === 'not_found') return c.html(<NotFound />, 404)
  return c.html(
    <Form name={name} body={body} error={result.message} />,
    result.reason === 'rate_limited' ? 429 : 400,
  )
})
