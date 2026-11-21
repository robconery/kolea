import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  ANONYMOUS,
  SESSION_MAX_AGE_SECONDS,
  type Viewer,
  membersEnabled,
  requestSignIn,
  sessionCookieName,
  sessionCookieSecure,
  signIn,
  signInLinkIsLive,
  signOut,
  viewerFromCookie,
} from '../core/members.ts'
import { type Interval, checkoutState, liveSubscription, premiumOnSale, premiumPrices, startPremiumCheckout } from '../core/premium.ts'
import { type SiteRequest, loadSiteConfig, renderSitePage } from '../core/theme/site.ts'
import { loadActiveTheme } from '../core/theme/store.ts'
import { escapeHtml } from '../core/text.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'

/**
 * ⭐ Members and Premium on the public site. Thin: every rule is in
 * `core/members.ts` and `core/premium.ts`.
 *
 *   /members/sign-in   GET form · POST asks for a link (same answer, known or not)
 *   /members/verify    GET a confirmation page · POST spends the link, signs in
 *   /members           the reader's own page          /members/sign-out  POST
 *   /premium           the plans · /premium/checkout POST · /premium/return
 *
 * Every POST that changes who is signed in, or starts a Checkout, runs only
 * when the request comes from the site's own origin (`Origin`, or with none,
 * `Sec-Fetch-Site: same-origin`), so another page cannot sign a visitor in as
 * somebody else or spend their link. Every page here is per-reader, so none is
 * shared-cached.
 */
export const memberRoutes = new Hono<{ Bindings: Env }>()

type Ctx = Context<{ Bindings: Env }>

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const e = escapeHtml

async function page(c: Ctx, title: string, html: string, status = 200): Promise<Response> {
  const db = getDb(c.env)
  const [cfg, theme] = await Promise.all([loadSiteConfig(db, c.env), loadActiveTheme(db)])
  const req: SiteRequest = { db, cfg, theme, path: c.req.path }
  const r = await renderSitePage(req, { title, html, path: c.req.path, noindex: true })
  return c.html(r.html, status as 200, NO_STORE)
}

function siteOrigin(env: Env): string {
  return (env.SITE_URL ?? '').replace(/\/$/, '')
}

/** A state-changing POST must come from the site itself. */
function fromOurOrigin(c: Ctx): boolean {
  const origin = c.req.header('Origin')
  if (origin) return origin === new URL(siteOrigin(c.env)).origin
  return c.req.header('Sec-Fetch-Site') === 'same-origin'
}

function ip(c: Ctx): string | null {
  return c.req.header('CF-Connecting-IP') ?? null
}

/** The reader behind this request's cookie. */
export async function viewerOf(c: Ctx): Promise<Viewer> {
  if (!membersEnabled(c.env)) return ANONYMOUS
  return await viewerFromCookie(c.env, getDb(c.env), getCookie(c, sessionCookieName(c.env)))
}

/** Slugs come from our own links; anything else is dropped, not echoed. */
function slugParam(raw: string | undefined | null): string | null {
  return raw && /^[a-z0-9-]{1,80}$/.test(raw) ? raw : null
}

function money(cents: number | null, currency: string): string {
  if (cents === null) return ''
  return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)
}

const field = 'width:100%;max-width:24rem;padding:.6em .8em;font:inherit'

// ───────────────────────────────────────────────── signing in

memberRoutes.get('/members/sign-in', async (c) => {
  if (!membersEnabled(c.env)) return page(c, 'Sign in', '<p>Signing in isn’t available on this site.</p>')
  const from = slugParam(c.req.query('from'))
  return page(
    c,
    'Sign in',
    `<p>Members sign in with a link sent by email. No password.</p><form method="post" action="/members/sign-in" class="kolea-sign-in"><p><input type="email" name="email" required autocomplete="email" placeholder="you@example.com" aria-label="Email address" style="${field}"> <button type="submit">Email me a link</button></p>${from ? `<input type="hidden" name="from" value="${e(from)}">` : ''}</form><p>Not on the list yet? <a href="/subscribe">Join free</a>, then sign in.</p>`,
  )
})

memberRoutes.post('/members/sign-in', async (c) => {
  if (!membersEnabled(c.env)) return page(c, 'Sign in', '<p>Signing in isn’t available on this site.</p>')
  if (!fromOurOrigin(c)) return c.text('Forbidden', 403)
  const form = await c.req.formData()
  await requestSignIn(c.env, getDb(c.env), {
    email: String(form.get('email') ?? ''),
    fromSlug: slugParam(String(form.get('from') ?? '')),
    ip: ip(c),
    userAgent: c.req.header('User-Agent') ?? null,
  })
  // The same answer whatever happened: known or unknown, sent, throttled or blocked.
  return page(
    c,
    'Check your inbox',
    '<p>If that address is on the list, a sign-in link is on its way. It works once, for the next 20 minutes.</p><p>Nothing arriving? Check spam, or <a href="/members/sign-in">ask again</a>.</p>',
  )
})

memberRoutes.get('/members/verify', async (c) => {
  const token = c.req.query('token') ?? ''
  if (!membersEnabled(c.env) || !(await signInLinkIsLive(getDb(c.env), token))) {
    return page(
      c,
      'Link expired',
      '<p>That sign-in link has expired or was already used. Links work once, for 20 minutes.</p><p><a href="/members/sign-in">Get a new link</a></p>',
      410,
    )
  }
  // A button, not an automatic sign-in: a mail scanner that fetches the link spends nothing.
  return page(
    c,
    'Sign in',
    `<form method="post" action="/members/verify"><input type="hidden" name="token" value="${e(token)}"><p><button type="submit">Sign in</button></p></form>`,
  )
})

memberRoutes.post('/members/verify', async (c) => {
  if (!membersEnabled(c.env)) return c.redirect('/members/sign-in', 303)
  if (!fromOurOrigin(c)) return c.text('Forbidden', 403)
  const form = await c.req.formData()
  const result = await signIn(c.env, getDb(c.env), {
    token: String(form.get('token') ?? ''),
    ip: ip(c),
    userAgent: c.req.header('User-Agent') ?? null,
  })
  if (!result.ok) {
    return page(
      c,
      'Link expired',
      '<p>That sign-in link has expired or was already used.</p><p><a href="/members/sign-in">Get a new link</a></p>',
      410,
    )
  }
  const secure = sessionCookieSecure(c.env)
  setCookie(c, sessionCookieName(c.env), result.cookieValue, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
    // The name already carries `__Host-` when secure (core/members.ts), which
    // requires exactly this: Secure, Path=/, and no Domain.
  })
  return c.redirect(result.returnTo ?? '/members', 303)
})

memberRoutes.post('/members/sign-out', async (c) => {
  if (!fromOurOrigin(c)) return c.text('Forbidden', 403)
  const name = sessionCookieName(c.env)
  await signOut(c.env, getDb(c.env), getCookie(c, name))
  const secure = sessionCookieSecure(c.env)
  deleteCookie(c, name, { path: '/', secure })
  return c.redirect('/', 303)
})

memberRoutes.get('/members', async (c) => {
  const viewer = await viewerOf(c)
  if (!viewer.subscriberId) return c.redirect('/members/sign-in', 303)
  const db = getDb(c.env)
  const live = await liveSubscription(db, viewer.subscriberId)
  const premiumLine = live
    ? live.status === 'active'
      ? `<p>You’re a Premium member (${live.interval}ly)${live.cancelAtPeriodEnd ? ', ending at the close of this billing period' : ''}. Stripe emails your receipts.</p>`
      : '<p>Your Premium payment didn’t go through. Stripe will email you to update your card; Premium posts open again as soon as it’s paid.</p>'
    : (await premiumOnSale(c.env, db))
      ? '<p><a href="/premium">Go Premium</a> to read every post.</p>'
      : ''
  return page(
    c,
    'Your membership',
    `<p>Signed in as <strong>${e(viewer.email ?? '')}</strong>.</p>${premiumLine}<form method="post" action="/members/sign-out"><p><button type="submit">Sign out</button></p></form>`,
  )
})

// ───────────────────────────────────────────────── premium

memberRoutes.get('/premium', async (c) => {
  const db = getDb(c.env)
  if (!(await premiumOnSale(c.env, db))) return page(c, 'Premium', '<p>Premium isn’t available right now.</p>')
  const viewer = await viewerOf(c)
  if (viewer.kind === 'premium') {
    return page(c, 'Premium', '<p>You’re already a Premium member. Every post is open to you.</p>')
  }
  const from = slugParam(c.req.query('from'))
  const prices = await premiumPrices(db)
  const plan = (interval: Interval, label: string) => {
    const p = prices[interval]
    if (!p) return ''
    return `<form method="post" action="/premium/checkout" class="kolea-plan"><input type="hidden" name="interval" value="${interval}">${from ? `<input type="hidden" name="from" value="${e(from)}">` : ''}<p><button type="submit">${e(label)} · ${e(money(p.amountCents, p.currency))}</button></p></form>`
  }
  const signedOut = viewer.subscriberId
    ? ''
    : '<p>Already Premium? <a href="/members/sign-in">Sign in</a> with the address you paid with.</p>'
  return page(
    c,
    'Go Premium',
    `<p>Premium opens every post on the site. Billed through Stripe; cancel any time.</p>${plan('month', 'Monthly')}${plan('year', 'Yearly')}${signedOut}`,
  )
})

memberRoutes.post('/premium/checkout', async (c) => {
  if (!fromOurOrigin(c)) return c.text('Forbidden', 403)
  const form = await c.req.formData()
  const interval = String(form.get('interval') ?? '')
  if (interval !== 'month' && interval !== 'year') return c.redirect('/premium', 303)
  const viewer = await viewerOf(c)
  const result = await startPremiumCheckout(c.env, getDb(c.env), {
    interval,
    viewer,
    fromSlug: slugParam(String(form.get('from') ?? '')),
    ip: ip(c),
    userAgent: c.req.header('User-Agent') ?? null,
    origin: siteOrigin(c.env),
  })
  if (result.ok) return c.redirect(result.url, 303)
  const message: Record<typeof result.reason, string> = {
    not_on_sale: 'Premium isn’t available right now.',
    already_premium: 'You already have Premium. <a href="/members">See your membership</a>.',
    throttled: 'Too many tries from here. Please wait an hour and try again.',
    provider_error: 'Stripe didn’t answer. Nothing was charged; please try again in a minute.',
  }
  return page(c, 'Premium', `<p>${message[result.reason]}</p>`, result.reason === 'throttled' ? 429 : 200)
})

/**
 * The Checkout return page. It grants nothing (the webhook does): it reloads
 * itself every 3 seconds, with no script, until the webhook has landed, and
 * gives up saying so after three minutes.
 */
memberRoutes.get('/premium/return', async (c) => {
  const token = c.req.query('c') ?? ''
  const n = Math.max(0, Math.min(Number(c.req.query('n') ?? 0) || 0, 1000))
  const state = await checkoutState(getDb(c.env), token)
  const viewer = await viewerOf(c)
  if (state === 'completed') {
    return page(
      c,
      'Welcome to Premium',
      viewer.subscriberId
        ? '<p>You’re Premium. Every post is open to you.</p><p><a href="/">Start reading</a></p>'
        : '<p>You’re Premium. <a href="/members/sign-in">Sign in</a> with the address you paid with to read every post.</p>',
    )
  }
  if (state === 'failed') return page(c, 'Payment', '<p>The payment didn’t go through. Nothing was charged.</p>')
  if (state === 'expired') return page(c, 'Payment', '<p>That checkout closed unpaid. <a href="/premium">Start again</a>.</p>')
  if (state === 'unknown') return page(c, 'Payment', '<p>We don’t recognise that checkout.</p>', 404)
  if (n >= 60) {
    return page(
      c,
      'Still processing',
      '<p>Your payment is still processing. Some payment methods take a few days. You can close this page; Premium switches on when it clears.</p>',
    )
  }
  const res = await page(c, 'Confirming', '<p>Confirming your payment…</p>')
  res.headers.set('Refresh', `3; url=/premium/return?c=${encodeURIComponent(token)}&n=${n + 1}`)
  return res
})
