import { Hono } from 'hono'
import {
  confirmPath,
  confirmSignup,
  getFormBySlug,
  lookupConfirmation,
  recordFormView,
  submitForm,
} from '../core/forms.ts'
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

/** A transparent 1×1 GIF. */
const PIXEL = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (ch) => ch.charCodeAt(0),
)

/**
 * The view counter: a pixel inside the embed snippet.
 *
 * An image rather than a script, so the snippet stays what it has always been —
 * plain HTML that works with JavaScript off. Every render of the page fetches
 * it, which is exactly the "the form was shown" event. `no-store` so a browser
 * or CDN cache doesn't swallow the second visit.
 */
formsApi.get('/f/:slug/v.gif', async (c) => {
  await recordFormView(getDb(c.env), c.req.param('slug'), c.req.header('User-Agent') ?? '')
  return c.body(PIXEL as unknown as ArrayBuffer, 200, {
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, max-age=0',
    'Access-Control-Allow-Origin': '*',
  })
})

/**
 * A bare fallback page, so a form slug is something you can open and test in a
 * browser before wiring it into your own site's markup.
 */
formsApi.get('/f/:slug', async (c) => {
  const db = getDb(c.env)
  const form = await getFormBySlug(db, c.req.param('slug'))
  if (!form || !form.isActive) return c.notFound()
  await recordFormView(db, form.slug, c.req.header('User-Agent') ?? '')

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
  // Everything else posted, handed to core, which keeps only defined custom
  // field keys. A nested `fields` object (JSON) is read the same as top-level keys.
  const fields: Record<string, unknown> = Object.create(null)
  const RESERVED = new Set(['email', 'name', TRAP_FIELD])

  if (contentType.includes('application/json')) {
    try {
      const body = await c.req.json<Record<string, unknown>>()
      email = String(body.email ?? '')
      name = body.name ? String(body.name) : null
      trap = body[TRAP_FIELD] ? String(body[TRAP_FIELD]) : null
      for (const [k, v] of Object.entries(body)) if (!RESERVED.has(k) && k !== 'fields') fields[k] = v
      if (body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) {
        Object.assign(fields, body.fields)
      }
    } catch {
      return c.json({ error: 'body must be JSON' }, 400, CORS)
    }
  } else {
    const form = await c.req.formData()
    email = String(form.get('email') ?? '')
    name = String(form.get('name') ?? '') || null
    trap = String(form.get(TRAP_FIELD) ?? '') || null
    for (const [k, v] of form.entries()) {
      if (RESERVED.has(k) || typeof v !== 'string') continue
      // `fields[plan]` and plain `plan` both work, so a hand-written form can use either.
      const m = /^fields\[(.+)\]$/.exec(k)
      fields[m ? m[1]! : k] = v
    }
  }

  const result = await submitForm(c.env, db, slug, { email, name, trap, fields })

  if (result.status === 'unknown_form') {
    return wantsJson ? c.json({ error: 'unknown form' }, 404, CORS) : c.notFound()
  }

  const failed = result.status === 'invalid_email' || result.status === 'inactive_form'

  if (wantsJson) {
    return failed
      ? c.json({ ok: false, error: result.message }, 400, CORS)
      : c.json(
          {
            ok: true,
            message: result.message,
            // A double opt-in form: only the confirmation went out. Everything
            // else waits for the click.
            pending: result.pending ?? false,
            enrolled: result.enrolled ?? false,
            // The link itself is never in this response — it travels by email
            // only, so the address has to be real and working to get the file.
            delivered: result.delivered ?? false,
          },
          200,
          CORS,
        )
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

// ───────────────────────────────────────────────── double opt-in

/**
 * The link in a confirmation mail. Public and unauthenticated: the token in the
 * path is the whole credential. It lives under `/f`, so the Access Bypass app
 * that already covers form posts covers it too.
 *
 * ⚠️ The GET changes nothing. Corporate mail scanners and link previewers fetch
 * every URL in a message, so a GET that confirmed would let a stranger's typed
 * address confirm itself. The page shows one button, and only its POST confirms.
 */
formsApi.get('/f/:slug/confirm/:token', async (c) => {
  const slug = c.req.param('slug')
  const token = c.req.param('token')
  const found = await lookupConfirmation(getDb(c.env), slug, token)

  if (found.state === 'unknown') return c.html(<UnknownLink />, 404)
  if (found.state === 'expired') return c.html(<ExpiredLink slug={slug} />, 410)
  if (found.state === 'confirmed') {
    return c.html(
      <PublicLayout title="Confirmed">
        <h1>You're already confirmed</h1>
        <p>Nothing more to do. Thanks!</p>
      </PublicLayout>,
    )
  }

  return c.html(
    <PublicLayout title="Confirm your subscription">
      <h1>One click to confirm</h1>
      <p>You asked to subscribe through “{found.formName}”. Confirm and you're in.</p>
      <form method="post" action={confirmPath(slug, token)}>
        <button class="btn primary">Yes, subscribe me</button>
      </form>
    </PublicLayout>,
  )
})

formsApi.post('/f/:slug/confirm/:token', async (c) => {
  const slug = c.req.param('slug')
  const result = await confirmSignup(c.env, getDb(c.env), slug, c.req.param('token'))

  if (result.status === 'unknown') return c.html(<UnknownLink />, 404)
  if (result.status === 'expired') return c.html(<ExpiredLink slug={slug} />, 410)

  // Somebody who left the newsletter and confirms is asking for this form's
  // file and series, not to be put back on the newsletter. Only they can do
  // that, from their preferences, so say so and hand them the way there.
  const offList = result.subscriberStatus === 'unsubscribed' && result.unsubToken
  if (!offList && result.redirectUrl) return c.redirect(result.redirectUrl, 303)

  return c.html(
    <PublicLayout title="Confirmed">
      <h1>{result.status === 'already' ? "You're already confirmed" : "You're confirmed"}</h1>
      <p>{result.message}</p>
      {offList ? (
        <p>
          You're still off the newsletter, as you asked earlier. To get it again,{' '}
          <a href={`/p/${result.unsubToken}?scope=broadcast`}>change your preferences</a>.
        </p>
      ) : null}
    </PublicLayout>,
  )
})

const UnknownLink = () => (
  <PublicLayout title="Link not found">
    <h1>That link doesn't work</h1>
    <p>It may have been mistyped. Nothing has changed.</p>
  </PublicLayout>
)

const ExpiredLink = ({ slug }: { slug: string }) => (
  <PublicLayout title="Link expired">
    <h1>That link has expired</h1>
    <p>
      Confirmation links last seven days. <a href={`/f/${slug}`}>Sign up again</a> and we'll send a
      fresh one.
    </p>
  </PublicLayout>
)
