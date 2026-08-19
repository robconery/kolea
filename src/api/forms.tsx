import { Hono } from 'hono'
import { getFormBySlug, submitForm } from '../core/forms.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { PublicLayout } from '../web/layout.tsx'

export const formsApi = new Hono<{ Bindings: Env }>()

/**
 * The honeypot field. Hidden from people by CSS in the embed snippet, invisible
 * to a screen reader via `aria-hidden`, and irresistible to a dumb bot. Named
 * something a form-filler wants to complete rather than `honeypot`.
 */
export const TRAP_FIELD = 'website'

/**
 * Wide-open CORS, deliberately: this endpoint takes an email address and returns
 * a thank-you. There is no session, no cookie and nothing to read back, so an
 * origin allowlist would only be a list to keep in sync with your own sites.
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

formsApi.options('/f/:slug', (c) => c.body(null, 204, CORS))

/**
 * A bare fallback page, so a form slug is something you can open and test in a
 * browser before wiring it into your own site's markup.
 */
formsApi.get('/f/:slug', async (c) => {
  const db = getDb(c.env)
  const form = await getFormBySlug(db, c.req.param('slug'))
  if (!form || !form.isActive) return c.notFound()

  return c.html(
    <PublicLayout title={form.name}>
      <h1>{form.name}</h1>
      <form method="post" action={`/f/${form.slug}`}>
        <div class="field">
          <label>Email</label>
          <input type="email" name="email" required autofocus />
        </div>
        <div class="field">
          <label>Name</label>
          <input type="text" name="name" />
        </div>
        <div style="position:absolute;left:-9999px" aria-hidden="true">
          <input type="text" name={TRAP_FIELD} tabindex={-1} autocomplete="off" />
        </div>
        <button class="btn primary">Subscribe</button>
      </form>
    </PublicLayout>,
  )
})

/**
 * The whole integration: `POST /f/:slug` with an `email` field.
 *
 * Takes urlencoded, multipart or JSON, and answers in kind — a plain HTML form
 * gets a redirect or a page, `fetch` gets JSON. Which means a `<form action>` on
 * a static site needs no JavaScript at all, and a client component that wants to
 * stay on the page just posts JSON.
 */
formsApi.post('/f/:slug', async (c) => {
  const db = getDb(c.env)
  const slug = c.req.param('slug')

  const contentType = c.req.header('Content-Type') ?? ''
  const wantsJson =
    contentType.includes('application/json') ||
    (c.req.header('Accept') ?? '').includes('application/json')

  let email = ''
  let name: string | null = null
  let trap: string | null = null

  if (contentType.includes('application/json')) {
    try {
      const body = await c.req.json<Record<string, unknown>>()
      email = String(body.email ?? '')
      name = body.name ? String(body.name) : null
      trap = body[TRAP_FIELD] ? String(body[TRAP_FIELD]) : null
    } catch {
      return c.json({ error: 'body must be JSON' }, 400, CORS)
    }
  } else {
    const form = await c.req.formData()
    email = String(form.get('email') ?? '')
    name = String(form.get('name') ?? '') || null
    trap = String(form.get(TRAP_FIELD) ?? '') || null
  }

  const result = await submitForm(db, slug, { email, name, trap })

  if (result.status === 'unknown_form') {
    return wantsJson ? c.json({ error: 'unknown form' }, 404, CORS) : c.notFound()
  }

  const failed = result.status === 'invalid_email' || result.status === 'inactive_form'

  if (wantsJson) {
    return failed
      ? c.json({ ok: false, error: result.message }, 400, CORS)
      : c.json({ ok: true, message: result.message, enrolled: result.enrolled ?? false }, 200, CORS)
  }

  if (failed) {
    return c.html(
      <PublicLayout title="Hmm">
        <h1>That didn't work</h1>
        <p>{result.message}</p>
        <p>
          <a href={`/f/${slug}`}>Try again</a>
        </p>
      </PublicLayout>,
      400,
    )
  }

  // Only the *configured* redirect is honoured. Taking a redirect target from
  // the posted body would turn every form into an open redirect.
  if (result.redirectUrl) return c.redirect(result.redirectUrl, 303)

  return c.html(
    <PublicLayout title="Thanks">
      <h1>Thanks!</h1>
      <p>{result.message}</p>
    </PublicLayout>,
  )
})
