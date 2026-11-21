import { Hono } from 'hono'
import type { Context } from 'hono'
import type { FC } from 'hono/jsx'
import {
  type AuthorizeRequest,
  approve,
  checkAuthorizeRequest,
  denyUrl,
  listConnectedApps,
  resourceUrl,
  revokeGrant,
} from '../core/oauth.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate } from './layout.tsx'

/**
 * The operator's half of "add the mailer to Claude by URL" (rules:
 * `core/oauth.ts`): the consent page and the Connected apps list.
 *
 * ⭐ Mounted *after* `requireOperator`. The operator approving here, signed in
 * through Cloudflare Access, is the whole authentication of the OAuth flow —
 * so `/oauth/authorize` must never get an Access Bypass, unlike its public
 * siblings in `api/oauth.ts`.
 */
export const connectAdmin = new Hono<{ Bindings: Env }>()

const origin = (c: Context) => new URL(c.req.url).origin

/** The fields an authorization request is made of, carried through the form. */
const REQUEST_KEYS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
] as const

/**
 * The consent page must not be framed (a hidden "Approve" under a decoy is the
 * classic way to win one), and its form posts back here and is answered with
 * a redirect to the client's registered URI.
 */
function lockDown(c: Context) {
  c.header('X-Frame-Options', 'DENY')
  c.header('Content-Security-Policy', "frame-ancestors 'none'")
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cache-Control', 'no-store')
}

/**
 * A cross-site post can't carry the Access cookie under SameSite=Lax, but the
 * approval is the one form in the console that mints a credential for someone
 * else, so it checks the browser's own word too: a present `Origin` (or
 * `Sec-Fetch-Site`) has to say this site.
 */
function sameOrigin(c: Context): boolean {
  const o = c.req.header('origin')
  if (o && o !== origin(c)) return false
  const site = c.req.header('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  return true
}

const Broken: FC<{ message: string }> = ({ message }) => (
  <Layout title="This link doesn't work" nav="apps">
    <div class="head">
      <div>
        <h1>This link doesn't work</h1>
        <div class="sub">{message}</div>
      </div>
    </div>
  </Layout>
)

/** What a scope string asks for, in words. Display only — the checkbox decides. */
function asksToChange(scope: string | null): boolean {
  return (scope ?? '').split(/\s+/).some((s) => s === 'mcp:write' || s === 'write')
}

const Consent: FC<{ request: AuthorizeRequest; fields: Record<string, string>; mcpUrl: string }> = ({
  request,
  fields,
  mcpUrl,
}) => (
  <Layout title={`Connect ${request.client.clientName}`} nav="apps">
    <div class="head">
      <div>
        <h1>Connect {request.client.clientName}?</h1>
        <div class="sub">An app is asking to use this mailer through MCP at {mcpUrl}.</div>
      </div>
    </div>

    <div class="card" style="margin-top:18px;max-width:640px">
      <div class="card-b">
        <dl style="display:grid;grid-template-columns:150px 1fr;gap:10px 16px;margin:0">
          <dt>App</dt>
          <dd>
            <strong>{request.client.clientName}</strong>
            <div class="faint">The name is what the app called itself. Check the address below.</div>
          </dd>
          <dt>Sends you back to</dt>
          <dd>
            <span class="mono">{request.redirectUri}</span>
          </dd>
          <dt>Asks for</dt>
          <dd>
            {request.scope ? <span class="mono">{request.scope}</span> : <span class="faint">nothing specific</span>}
            {asksToChange(request.scope) ? (
              <div class="faint">It asks to make changes. It only gets that if you tick the box.</div>
            ) : null}
          </dd>
        </dl>

        <form method="post" action="/oauth/authorize" style="margin-top:18px">
          {REQUEST_KEYS.map((k) =>
            fields[k] !== undefined ? <input type="hidden" name={k} value={fields[k]} /> : null,
          )}
          <p style="margin:0 0 6px">
            <strong>It will be able to read</strong> your subscribers, broadcasts, sequences, sales and
            stats.
          </p>
          <label style="display:flex;gap:8px;align-items:flex-start;margin:12px 0">
            <input type="checkbox" name="allow_changes" value="on" />
            <span>
              <strong>Allow changes</strong>
              <span class="faint">
                {' '}
                Create, edit and delete, the same as an admin key. Sending still needs the send switch
                and a preflight, the same as any agent.
              </span>
            </span>
          </label>
          <div style="display:flex;gap:10px;margin-top:14px">
            <button class="btn primary" name="decision" value="approve">
              Connect
            </button>
            <button class="btn" name="decision" value="deny">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  </Layout>
)

function requestFields(source: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of REQUEST_KEYS) {
    const v = source[k]
    if (typeof v === 'string') out[k] = v
  }
  return out
}

// ───────────────────────────────────────────────── consent

connectAdmin.get('/oauth/authorize', async (c) => {
  lockDown(c)
  const fields = requestFields(c.req.query())
  const checked = await checkAuthorizeRequest(getDb(c.env), fields, origin(c))
  if (!checked.ok) {
    if ('redirect' in checked) return c.redirect(checked.redirect, 302)
    return c.html(<Broken message={checked.show} />, 400)
  }
  return c.html(<Consent request={checked.request} fields={fields} mcpUrl={resourceUrl(origin(c))} />)
})

connectAdmin.post('/oauth/authorize', async (c) => {
  lockDown(c)
  if (!sameOrigin(c)) return c.html(<Broken message="That approval came from another site." />, 403)

  const form = (await c.req.parseBody()) as Record<string, unknown>
  const db = getDb(c.env)
  // Re-checked from scratch: the hidden fields are just another query string.
  const checked = await checkAuthorizeRequest(db, requestFields(form), origin(c))
  if (!checked.ok) {
    if ('redirect' in checked) return c.redirect(checked.redirect, 302)
    return c.html(<Broken message={checked.show} />, 400)
  }

  if (form.decision !== 'approve') return c.redirect(denyUrl(checked.request, origin(c)), 302)

  const approvedBy = (c.get('operatorEmail' as never) as string | null | undefined) ?? null
  const url = await approve(db, checked.request, {
    access: form.allow_changes === 'on' ? 'write' : 'read',
    approvedBy,
    origin: origin(c),
  })
  return c.redirect(url, 302)
})

// ───────────────────────────────────────────────── connected apps

connectAdmin.get('/connected-apps', async (c) => {
  const apps = await listConnectedApps(getDb(c.env))
  const mcpUrl = resourceUrl(origin(c))

  return c.html(
    <Layout title="Connected apps" nav="apps">
      <div class="head">
        <div>
          <h1>Connected apps</h1>
          <div class="sub">
            Apps you approved to use this mailer through MCP. Add one by pasting{' '}
            <span class="mono">{mcpUrl}</span> into Claude (or any MCP client) and approving it here.
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card" style="margin-top:18px">
        <div class="card-b flush">
          {apps.length === 0 ? (
            <div class="empty">
              <p>No apps connected yet.</p>
              <p class="faint">
                In Claude, add a custom connector with the URL <span class="mono">{mcpUrl}</span>. You
                will be sent here to approve it.
              </p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>App</th>
                  <th>Access</th>
                  <th>Connected</th>
                  <th>Last used</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {apps.map((a) => (
                  <tr>
                    <td>
                      <strong>{a.clientName}</strong>
                      <div class="faint mono" style="font-size:12px">
                        {a.redirectUri}
                      </div>
                      {a.approvedBy ? <div class="faint">approved by {a.approvedBy}</div> : null}
                    </td>
                    <td>
                      {a.access === 'write' ? (
                        <span class="pill warn">Can make changes</span>
                      ) : (
                        <span class="pill">Read only</span>
                      )}
                    </td>
                    <td>{fmtDate(a.createdAt)}</td>
                    <td>{a.lastUsedAt ? fmtDate(a.lastUsedAt) : <span class="faint">never</span>}</td>
                    <td style="text-align:right">
                      {a.revokedAt ? (
                        <span class="faint">Disconnected {fmtDate(a.revokedAt)}</span>
                      ) : (
                        <form method="post" action={`/connected-apps/${a.id}/revoke`}>
                          <button class="btn sm danger">Disconnect</button>
                        </form>
                      )}
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

connectAdmin.post('/connected-apps/:id/revoke', async (c) => {
  const id = Number(c.req.param('id'))
  const result = Number.isInteger(id) ? await revokeGrant(getDb(c.env), id) : { ok: false, reason: 'no such connection' }
  const flash = result.ok ? 'Disconnected. Its tokens stopped working immediately.' : (result.reason ?? 'refused')
  return c.redirect(
    `/connected-apps?flash=${encodeURIComponent(flash)}${result.ok ? '' : '&kind=warn'}`,
    303,
  )
})
