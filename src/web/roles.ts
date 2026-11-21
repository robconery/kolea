import type { Context, MiddlewareHandler } from 'hono'
import { atLeast, type Role } from '../core/team.ts'
import type { Env } from '../types.ts'
import { refuse } from './audit.ts'
import { getDb } from '../db/index.ts'
import { sequenceIsLive } from '../core/sequences.ts'

/**
 * ⭐ Which role each console route needs. The ONE place a route's role is
 * decided; handlers never check a role themselves.
 *
 * Deny by default: a route that matches nothing here needs `admin`. So a new
 * admin screen is closed to writers until somebody decides it is writing, and
 * the failure of forgetting this table is a writer seeing a 403, never a writer
 * sending mail. The rules in words are in `core/team.ts`.
 *
 * First match wins. Patterns are anchored and only ever match plain segments
 * (digits, a slug), and a path carrying a percent-escape skips the table to the
 * default, so an encoded path can never borrow a writer rule for a route the
 * router decodes into something else.
 *
 * What a writer is kept from, and why it is not in the list below:
 *   - `GET|POST /broadcasts/:id/send`, `/resume`: sending and scheduling
 *   - `/sequences/:id/toggle`, `/enroll`, `/enroll-all`, `/sequences/tick`,
 *     `/next`, `/exits`: activating, or moving people into mail
 *   - `/sequences/:id/window`: it also sets the install's time zone
 *   - every audience write (tagging, adding, cleaning up, importing, consent):
 *     a tag or a new address can start a sequence, and that is a send
 *   - settings, keys, agents, connected apps, webhooks, domains, imports,
 *     the team, site and themes, money
 */
interface Rule {
  method: 'GET' | 'POST' | 'DELETE' | '*'
  path: RegExp
  min: Role
}

const ID = String.raw`\d+`

const RULES: Rule[] = [
  // Local-only tooling that rewrites the whole database.
  { method: '*', path: /^\/dev\//, min: 'owner' },

  // ── Reading what writing needs
  { method: 'GET', path: /^\/$/, min: 'writer' },
  { method: 'GET', path: /^\/help$/, min: 'writer' },
  { method: 'GET', path: /^\/broadcasts(\/new)?$/, min: 'writer' },
  { method: 'GET', path: new RegExp(`^/broadcasts/${ID}(/publishing)?$`), min: 'writer' },
  { method: 'GET', path: /^\/sequences(\/new)?$/, min: 'writer' },
  { method: 'GET', path: new RegExp(`^/sequences/${ID}$`), min: 'writer' },
  { method: 'GET', path: new RegExp(`^/sequences/${ID}/steps/(new|${ID})$`), min: 'writer' },
  { method: 'GET', path: /^\/sequences\/templates(\/new|\/[a-z0-9-]+(\/edit)?)?$/, min: 'writer' },
  { method: 'GET', path: /^\/media$/, min: 'writer' },
  { method: 'GET', path: /^\/api\/media$/, min: 'writer' },
  { method: 'GET', path: /^\/fields\.json$/, min: 'writer' },
  { method: 'GET', path: /^\/analytics(\/(sequences|broadcasts|contribution|health))?$/, min: 'writer' },
  { method: 'GET', path: new RegExp(`^/analytics/sequences/${ID}$`), min: 'writer' },
  { method: 'GET', path: /^\/activity$/, min: 'writer' },
  { method: 'GET', path: /^\/subscribers$/, min: 'writer' },
  { method: 'GET', path: new RegExp(`^/subscribers/${ID}$`), min: 'writer' },
  { method: 'GET', path: /^\/(tags|segments)$/, min: 'writer' },

  // ── Writing: broadcasts and posts, up to (never including) sending
  { method: 'POST', path: /^\/broadcasts(\/autosave|\/preview)?$/, min: 'writer' },
  {
    method: 'POST',
    path: new RegExp(`^/broadcasts/${ID}/(edit|preview|revise|publish|unpublish|feature-image/(upload|unsplash|clear))$`),
    min: 'writer',
  },

  // ── Writing: sequences and their steps, never switching one on
  { method: 'POST', path: /^\/sequences$/, min: 'writer' },
  { method: 'POST', path: new RegExp(`^/sequences/${ID}$`), min: 'writer' },
  { method: 'POST', path: new RegExp(`^/sequences/${ID}/steps(/autosave|/preview|/reorder)?$`), min: 'writer' },
  { method: 'POST', path: new RegExp(`^/sequences/${ID}/steps/${ID}(/delete)?$`), min: 'writer' },
  // The template library. `use` creates a sequence, always switched off.
  { method: 'POST', path: /^\/sequences\/templates(\/[a-z0-9-]+\/(use|edit|duplicate))?$/, min: 'writer' },

  // The reader council on a draft: advisory, never changes or sends anything.
  { method: 'GET', path: new RegExp(`^/(broadcasts/${ID}|sequences/${ID}/steps/${ID})/council$`), min: 'writer' },
  { method: 'POST', path: new RegExp(`^/(broadcasts/${ID}|sequences/${ID}/steps/${ID})/council$`), min: 'writer' },
  { method: 'POST', path: new RegExp(`^/council/${ID}/notes/[a-z0-9-]+$`), min: 'writer' },

  // ── The composer's helpers: writing help, images
  { method: 'POST', path: /^\/ai\/(subject|cleanup)$/, min: 'writer' },
  { method: 'POST', path: /^\/media$/, min: 'writer' },
  { method: 'POST', path: /^\/api\/media\/upload$/, min: 'writer' },
]

/** The least role `method path` needs. Anything unlisted needs `admin`. */
export function minimumRole(method: string, path: string): Role {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  if (path.includes('%')) return 'admin'
  for (const rule of RULES) {
    if ((rule.method === '*' || rule.method === m) && rule.path.test(path)) return rule.min
  }
  return 'admin'
}

/** The role `requireOperator` put on this request. */
export function roleOf(c: Context): Role | null {
  return (c.get('operatorRole' as never) as unknown as Role | undefined) ?? null
}

/**
 * Refuse a request whose role is below the route's minimum. Mounted after
 * `auditWrites('operator')` in `worker.tsx`, so a refused write is in the trail
 * as `denied`, with the reason.
 */
export const requireRole: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const path = new URL(c.req.url).pathname
  const min = minimumRole(c.req.method, path)
  const role = roleOf(c)
  if (atLeast(role, min)) {
    // ⭐ A writer may edit a sequence only while it is switched off. On a live
    // one, a changed step is mailed by the next tick with no preflight, and a
    // changed trigger starts enrolling people — both are "putting mail in an
    // inbox", which is exactly what the writer role may not do.
    const seq = role === 'writer' && c.req.method === 'POST' ? /^\/sequences\/(\d+)(\/|$)/.exec(path) : null
    if (seq && (await sequenceIsLive(getDb(c.env), Number(seq[1])))) {
      const reason = 'writers cannot change a live sequence'
      refuse(c, reason)
      return c.html(
        page(
          'This sequence is live',
          '<p>A writer can change a sequence only while it is switched off. An owner or admin can switch it off, or make the change.</p><p><a href="/sequences">Back to sequences</a></p>',
        ),
        403,
      )
    }
    return await next()
  }

  const reason = `needs ${min}, signed in as ${role ?? 'nobody'}`
  refuse(c, reason)
  return c.html(
    page(
      'Not with your role',
      `<p>This needs the <strong>${min}</strong> role, and you are signed in as ${
        role ? `a <strong>${role}</strong>` : 'nobody'
      }.</p><p>An owner or admin can change your role on the Team screen.</p><p><a href="/">Back to the dashboard</a></p>`,
    ),
    403,
  )
}

/** A bare page for refusals: no nav, because the nav would offer what was just refused. */
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Kōlea</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 16px;color:#1d2433;background:#fbfaf7}h1{font-size:1.4rem}code{font-size:.9em}@media (prefers-color-scheme:dark){body{color:#e7e4dc;background:#16181d}a{color:#7cc4d6}}</style></head><body><h1>${title}</h1>${body}</body></html>`
}
