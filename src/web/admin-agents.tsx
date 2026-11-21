import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import { type KeyScope, listApiKeys, mintApiKey, revokeApiKey } from '../core/api-keys.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate } from './layout.tsx'

/**
 * Agents & keys: who may talk to the mailer without a browser (SPEC 7.7, 8.3).
 *
 * Operator-only, mounted after `requireOperator`. Every rule is in
 * `core/api-keys.ts`; this file reads forms and draws tables.
 *
 * ⭐ The raw token is rendered into the response to the create POST and
 * nowhere else — never a redirect, never a query string, never a row. Only its
 * hash is stored, so a page reload is the last chance to copy it, and the page
 * says so.
 */
export const agentsAdmin = new Hono<{ Bindings: Env }>()

const SCOPE_HELP: Record<KeyScope, string> = {
  send: 'Transactional mail and sales only (POST /api/send, /api/sales). For a checkout or another app.',
  read: 'Reads only. Cannot send and cannot reach MCP. For the REST API.',
  admin: 'Everything, including the MCP server. For an agent you trust with the whole mailer.',
}

type KeyRow = Awaited<ReturnType<typeof listApiKeys>>[number]

const KeyTable: FC<{ keys: KeyRow[] }> = ({ keys }) =>
  keys.length === 0 ? (
    <div class="card-b">
      <div class="empty">
        <p>No keys yet.</p>
        <p class="faint">Make one below for each program that talks to the mailer.</p>
      </div>
    </div>
  ) : (
    <div class="card-b flush">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Scope</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr style={k.revokedAt ? 'opacity:.55' : ''}>
              <td>
                <strong>{k.name}</strong>
                <div class="faint mono">#{k.id}</div>
              </td>
              <td class="mono">{k.scope}</td>
              <td class="faint">{fmtDate(k.createdAt)}</td>
              <td class="faint">{k.lastUsedAt ? fmtDate(k.lastUsedAt) : 'never'}</td>
              <td>
                {k.revokedAt ? (
                  <span class="pill bad">revoked {fmtDate(k.revokedAt)}</span>
                ) : (
                  <span class="pill ok">live</span>
                )}
              </td>
              <td style="text-align:right">
                {k.revokedAt ? null : (
                  <form method="post" action={`/settings/agents/keys/${k.id}/revoke`} style="display:inline">
                    <button class="btn sm danger">Revoke</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

interface PageProps {
  env: Env
  keys: KeyRow[]
  flash?: string
  flashKind?: string
  /** The one moment the plaintext exists outside the caller's clipboard. */
  minted?: { name: string; scope: KeyScope; token: string }
}

const AgentsPage: FC<PageProps> = ({ keys, flash, flashKind, minted }) => (
  <Layout title="Agents & keys" nav="agents">
    <div class="head">
      <div>
        <div class="eyebrow">
          <a href="/settings">Settings</a>
        </div>
        <h1>Agents &amp; keys</h1>
        <div class="sub">Every program that talks to the mailer without a browser holds one of these.</div>
      </div>
    </div>

    <Flash msg={flash} kind={flashKind} />

    {minted ? (
      <div class="card" style="margin-bottom:18px">
        <div class="card-h">
          <h2>New key: {minted.name}</h2>
        </div>
        <div class="card-b">
          <div class="note">
            <strong>Copy this now.</strong> Only its hash is stored, so it is shown this once and
            cannot be recovered, only revoked.
          </div>
          <pre class="mono code" data-token="">{minted.token}</pre>
          <p class="faint">
            Scope <span class="mono">{minted.scope}</span>: {SCOPE_HELP[minted.scope]}
          </p>
        </div>
      </div>
    ) : null}

    <div class="card">
      <div class="card-h">
        <h2>API keys</h2>
      </div>
      <KeyTable keys={keys} />
      <div class="card-b">
        <p class="faint" style="margin:0">
          Revoking takes effect on the next request. The row stays so the audit log still says
          which key did what.
        </p>
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-h">
        <h2>New key</h2>
      </div>
      <div class="card-b">
        <form method="post" action="/settings/agents/keys">
          <label>Name</label>
          <input type="text" name="name" placeholder="Checkout webhook" maxlength={80} required />

          <label style="margin-top:16px">Scope</label>
          <select name="scope">
            <option value="send" selected>
              send — transactional mail only
            </option>
            <option value="read">read — reads only</option>
            <option value="admin">admin — everything, including MCP</option>
          </select>
          <ul class="faint" style="margin:10px 0 0;padding-left:18px">
            {(Object.keys(SCOPE_HELP) as KeyScope[]).map((s) => (
              <li>
                <span class="mono">{s}</span>: {SCOPE_HELP[s]}
              </li>
            ))}
          </ul>

          <div class="row" style="gap:8px;margin-top:18px">
            <button class="btn primary">Create key</button>
          </div>
        </form>
      </div>
    </div>
  </Layout>
)

agentsAdmin.get('/settings/agents', async (c) => {
  const db = getDb(c.env)
  return c.html(
    <AgentsPage
      env={c.env}
      keys={await listApiKeys(db)}
      flash={c.req.query('flash')}
      flashKind={c.req.query('kind')}
    />,
  )
})

agentsAdmin.post('/settings/agents/keys', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const minted = await mintApiKey(db, { name: form.get('name'), scope: form.get('scope') })

  if (!minted.ok) {
    return c.redirect(`/settings/agents?flash=${encodeURIComponent(minted.reason)}&kind=warn`)
  }

  // Rendered, not redirected: the token must never land in a URL or history.
  c.header('Cache-Control', 'no-store')
  return c.html(
    <AgentsPage
      env={c.env}
      keys={await listApiKeys(db)}
      minted={{ name: minted.name, scope: minted.scope, token: minted.token }}
    />,
  )
})

agentsAdmin.post('/settings/agents/keys/:id/revoke', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const result = Number.isInteger(id) ? await revokeApiKey(db, id) : { ok: false, reason: 'no such key' }
  if (!result.ok) {
    return c.redirect(`/settings/agents?flash=${encodeURIComponent(`Not revoked: ${result.reason}.`)}&kind=warn`)
  }
  return c.redirect('/settings/agents?flash=Key revoked. It stops working on its next request.')
})
