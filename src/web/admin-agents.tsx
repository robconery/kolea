import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import { type AgentSwitches, getAgentSwitches, sendForcedOff, setAgentSwitches } from '../core/agents.ts'
import { type KeyScope, listApiKeys, mintApiKey, revokeApiKey } from '../core/api-keys.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate } from './layout.tsx'

/**
 * Agents & keys: who may talk to the mailer without a browser (SPEC 7.7, 8.3),
 * and the two switches on what an agent may do with it (`core/agents.ts`).
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

const SWITCHES: { field: keyof AgentSwitches; name: 'send' | 'sensitive'; title: string; body: string }[] = [
  {
    field: 'allowSend',
    name: 'send',
    title: 'Agents may send mail',
    body: 'broadcast_send, broadcast_send_test, broadcast_schedule, broadcast_resume, sequence_activate, sequence_tick, purchase_mail_send, form_resend_replies and undelivered_send_again. Off, an agent can still draft, preview and preflight everything; a person sends.',
  },
  {
    field: 'allowSensitive',
    name: 'sensitive',
    title: 'Agents may make sensitive changes',
    body: 'subscriber_delete, suppression_remove, subscriber_import_csv, sequence_rejoin_person, apikey_create and the three webhook tools that change an endpoint. An agent reads text strangers wrote, and that text can steer it, so changes that mail someone who left, hand out lasting access or send your data somewhere wait for this.',
  },
]

const SwitchCard: FC<{ switches: AgentSwitches; forcedOff: boolean }> = ({ switches, forcedOff }) => (
  <div class="card" style="margin-bottom:18px">
    <div class="card-h">
      <h2>What agents may do</h2>
    </div>
    <div class="card-b flush">
      <table>
        <tbody>
          {SWITCHES.map((sw) => {
            const on = switches[sw.field]
            const forced = sw.name === 'send' && forcedOff
            return (
              <tr>
                <td>
                  <strong>{sw.title}</strong>
                  <div class="faint">{sw.body}</div>
                  {forced ? (
                    <div class="faint" style="margin-top:6px">
                      Forced off: the Worker config sets <span class="mono">MCP_ALLOW_SEND="false"</span>,
                      which overrides this switch.
                    </div>
                  ) : null}
                </td>
                <td style="white-space:nowrap">
                  {forced ? (
                    <span class="pill bad">forced off</span>
                  ) : on ? (
                    <span class="pill ok" data-switch={sw.name}>on</span>
                  ) : (
                    <span class="pill" data-switch={sw.name}>off</span>
                  )}
                </td>
                <td style="text-align:right;white-space:nowrap">
                  <form method="post" action="/settings/agents/switches" style="display:inline">
                    <input type="hidden" name="switch" value={sw.name} />
                    <input type="hidden" name="value" value={on ? 'off' : 'on'} />
                    <button class={on ? 'btn sm' : 'btn sm danger'}>{on ? 'Turn off' : 'Turn on'}</button>
                  </form>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
    <div class="card-b">
      <p class="faint" style="margin:0">
        Both start off. No key can flip them; only this screen can. A refused call is still written to
        the MCP audit log.
      </p>
    </div>
  </div>
)

interface PageProps {
  env: Env
  keys: KeyRow[]
  switches: AgentSwitches
  flash?: string
  flashKind?: string
  /** The one moment the plaintext exists outside the caller's clipboard. */
  minted?: { name: string; scope: KeyScope; token: string }
}

const AgentsPage: FC<PageProps> = ({ env, keys, switches, flash, flashKind, minted }) => (
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

    <SwitchCard switches={switches} forcedOff={sendForcedOff(env)} />

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
      switches={await getAgentSwitches(db)}
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
      switches={await getAgentSwitches(db)}
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

agentsAdmin.post('/settings/agents/switches', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const which = form.get('switch')
  const value = form.get('value')
  if ((which !== 'send' && which !== 'sensitive') || (value !== 'on' && value !== 'off')) {
    return c.redirect('/settings/agents?flash=Unknown switch.&kind=warn')
  }

  const on = value === 'on'
  await setAgentSwitches(db, which === 'send' ? { allowSend: on } : { allowSensitive: on })

  const what = which === 'send' ? 'Agent sending' : 'Sensitive changes by agents'
  let msg = `${what} turned ${value}.`
  if (which === 'send' && on && sendForcedOff(c.env)) {
    msg += ' MCP_ALLOW_SEND="false" in the Worker config still forces it off.'
  }
  return c.redirect(`/settings/agents?flash=${encodeURIComponent(msg)}`)
})
