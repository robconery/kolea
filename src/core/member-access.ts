import { escapeHtml } from './text.ts'

/**
 * Who may read a post: the one decision every exit asks (Kōlea SPEC 15.11.5,
 * 15.11.6). Pure — no database, no request.
 *
 *     level      anonymous  member  premium
 *     public     full       full    full
 *     members    teaser     full    full
 *     premium    teaser     teaser  full
 *
 * Listings, the front page, `{{#get}}`, next/prev and the feed are cached for
 * everybody, so they always ask as `anonymous`. Only the post page itself asks
 * with the real viewer, and a gated post page is never shared-cached.
 */

export const ACCESS_LEVELS = ['public', 'members', 'premium'] as const
export type AccessLevel = (typeof ACCESS_LEVELS)[number]
export type ViewerKind = 'anonymous' | 'member' | 'premium'
export type AccessDecision = 'full' | 'teaser'

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value)
}

/** What `viewer` sees of a post at `level`. */
export function decideAccess(viewer: ViewerKind, level: AccessLevel): AccessDecision {
  if (level === 'public') return 'full'
  if (level === 'members') return viewer === 'anonymous' ? 'teaser' : 'full'
  return viewer === 'premium' ? 'full' : 'teaser'
}

/** Whether a post is closed to somebody — its body must never derive anything public. */
export function isGated(level: AccessLevel): boolean {
  return level !== 'public'
}

/** Ghost's `visibility` value for a level, so Ghost themes can branch on it. */
export function ghostVisibility(level: AccessLevel): 'public' | 'members' | 'paid' {
  return level === 'premium' ? 'paid' : level
}

export const LEVEL_LABEL: Record<AccessLevel, string> = {
  public: 'Everyone',
  members: 'Members (signed in, free)',
  premium: 'Premium members',
}

/**
 * The teaser a gated post shows in place of its body: the hand-written excerpt
 * (never one derived from the body) and a call to action. The links name the
 * post, so signing in lands the reader back on it and an upgrade records what
 * converted them (SPEC 16.7.3).
 *
 * `origin` is empty for on-site HTML and the site's origin for the feed, where
 * a relative link resolves against nothing.
 */
export function teaserHtml(input: {
  level: AccessLevel
  slug: string
  excerpt: string | null
  origin?: string
}): string {
  const e = escapeHtml
  const o = input.origin ?? ''
  const from = encodeURIComponent(input.slug)
  const lead = input.excerpt ? `<p class="kolea-gate-lead">${e(input.excerpt)}</p>` : ''
  const signIn = `${o}/members/sign-in?from=${from}`

  if (input.level === 'premium') {
    return `<div class="kolea-gate">${lead}<p class="kolea-gate-note"><strong>This post is for Premium members.</strong></p><p><a class="kolea-gate-cta" href="${e(`${o}/premium?from=${from}`)}">Go Premium</a></p><p class="kolea-gate-alt">Already Premium? <a href="${e(signIn)}">Sign in</a>.</p></div>`
  }
  return `<div class="kolea-gate">${lead}<p class="kolea-gate-note"><strong>This post is for members.</strong> Membership is free: it is the newsletter, with a way to sign in here.</p><p><a class="kolea-gate-cta" href="${e(signIn)}">Sign in</a></p><p class="kolea-gate-alt">Not on the list yet? <a href="${e(`${o}/subscribe`)}">Join free</a>, then sign in.</p></div>`
}
