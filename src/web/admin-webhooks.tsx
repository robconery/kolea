import type { FC } from 'hono/jsx'
import { Hono } from 'hono'
import {
  WEBHOOK_EVENTS,
  type WebhookEndpointView,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  redeliverWebhook,
  updateWebhookEndpoint,
} from '../core/webhooks.ts'
import { getDb } from '../db/index.ts'
import type { WebhookDelivery } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate, statusPill } from './layout.tsx'

export const webhooksAdmin = new Hono<{ Bindings: Env }>()

/**
 * ⭐ Outbound webhooks — where facts about the list are POSTed, and the log of
 * every delivery. A thin wrapper over `core/webhooks.ts`; every rule (the URL
 * policy, signing, retries, switching a failing endpoint off) lives there.
 *
 * The signing secret is shown once, on the page the create POST renders, and
 * never again — the same contract as an API key.
 */

const EVENT_HELP: Record<(typeof WEBHOOK_EVENTS)[number], string> = {
  subscribed: 'someone joins the list, confirms, or comes back',
  unsubscribed: 'someone leaves the newsletter, or everything',
  bounced: 'an address hard-bounces',
  complained: 'someone marks your mail as spam',
  purchased: 'a sale is recorded',
  published: 'a post goes up on the site',
}

const go = (path: string, flash: string, warn = false) =>
  `${path}?flash=${encodeURIComponent(flash)}${warn ? '&kind=warn' : ''}`

const EventBoxes: FC<{ checked: readonly string[] }> = ({ checked }) => (
  <div style="display:grid;gap:6px;margin-top:6px">
    {WEBHOOK_EVENTS.map((e) => (
      <label style="display:flex;gap:8px;align-items:baseline;font-weight:400;margin:0">
        <input type="checkbox" name="events" value={e} checked={checked.includes(e)} />
        <span>
          <span class="mono">{e}</span> <span class="faint">— {EVENT_HELP[e]}</span>
        </span>
      </label>
    ))}
  </div>
)

const EndpointState: FC<{ e: WebhookEndpointView }> = ({ e }) =>
  e.isActive ? (
    <span class="pill ok">on</span>
  ) : (
    <span title={e.disabledReason ?? ''} class="pill bad">
      off
    </span>
  )

const Signing: FC = () => (
  <p class="faint" style="margin:0">
    Every request carries <span class="mono">Kolea-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</span>,
    where the hex is HMAC-SHA256 of <span class="mono">"&lt;t&gt;.&lt;raw body&gt;"</span> under the
    endpoint's secret. Recompute it, compare in constant time, and reject a{' '}
    <span class="mono">t</span> more than five minutes old. <span class="mono">Kolea-Event-Id</span> is
    the same for every retry of one fact, so dedupe on it. Answer 2xx within ten seconds;
    anything else is retried with backoff (30 s, 2 min, 8 min … up to 6 h, eight tries).
    Redirects are not followed.
  </p>
)

webhooksAdmin.get('/webhooks', async (c) => {
  const endpoints = await listWebhookEndpoints(getDb(c.env))
  return c.html(<WebhooksPage endpoints={endpoints} flash={c.req.query('flash')} kind={c.req.query('kind')} />)
})

const WebhooksPage: FC<{
  endpoints: WebhookEndpointView[]
  flash?: string
  kind?: string
  secret?: { url: string; value: string }
}> = ({ endpoints, flash, kind, secret }) => (
  <Layout title="Webhooks" nav="hooks">
    <div class="head">
      <div>
        <h1>Webhooks</h1>
        <div class="sub">Tell your other systems when something happens on the list.</div>
      </div>
    </div>

    <Flash msg={flash} kind={kind} />

    {secret ? (
      <div class="card" style="margin-bottom:18px">
        <div class="card-h">
          <h2>Signing secret for {secret.url}</h2>
        </div>
        <div class="card-b">
          <p style="margin:0 0 10px">
            Copy it now. This is the only time it is shown; after this the list shows its first
            few characters only.
          </p>
          <input type="text" readonly value={secret.value} class="mono" onclick="this.select()" />
        </div>
      </div>
    ) : null}

    <div class="card">
      <div class="card-h">
        <h2>{endpoints.length === 1 ? '1 endpoint' : `${endpoints.length} endpoints`}</h2>
      </div>
      {endpoints.length === 0 ? (
        <div class="card-b">
          <div class="empty">
            <p>No endpoints yet.</p>
            <p class="faint">Add one below and pick the events it should hear about.</p>
          </div>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Events</th>
              <th>State</th>
              <th class="num">Waiting</th>
              <th class="num">Failed</th>
              <th>Last delivered</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((e) => (
              <tr>
                <td>
                  <a href={`/webhooks/${e.id}`} class="mono">
                    {e.url}
                  </a>
                  {e.description ? <div class="faint">{e.description}</div> : null}
                  {!e.isActive && e.disabledReason ? (
                    <div class="faint">{e.disabledReason}</div>
                  ) : null}
                </td>
                <td class="mono faint">{e.events.join(', ')}</td>
                <td>
                  <EndpointState e={e} />
                </td>
                <td class="num">{e.pending}</td>
                <td class="num">{e.failed ? <a href={`/webhooks/${e.id}?status=failed`}>{e.failed}</a> : 0}</td>
                <td class="faint">{fmtDate(e.lastDeliveredAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-h">
        <h2>New endpoint</h2>
      </div>
      <div class="card-b">
        <form method="post" action="/webhooks">
          <label>URL</label>
          <input type="url" name="url" placeholder="https://example.com/hooks/kolea" required />
          <p class="faint" style="margin:6px 0 0">
            https on a public host, port 443 or 8443. No user name or password in it.
          </p>

          <label style="margin-top:16px">Description</label>
          <input type="text" name="description" maxlength={200} placeholder="CRM sync" />

          <label style="margin-top:16px">Events</label>
          <EventBoxes checked={WEBHOOK_EVENTS} />

          <button class="btn primary" style="margin-top:16px">
            Add endpoint
          </button>
        </form>
      </div>
      <div class="card-b">
        <Signing />
      </div>
    </div>
  </Layout>
)

webhooksAdmin.post('/webhooks', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const result = await createWebhookEndpoint(db, {
    url: String(form.get('url') ?? ''),
    description: String(form.get('description') ?? ''),
    events: form.getAll('events').map(String),
  })
  if (!result.ok) return c.redirect(go('/webhooks', `Not added: ${result.reason}.`, true), 303)

  // Rendered, not redirected: the secret must never ride in a URL.
  return c.html(
    <WebhooksPage
      endpoints={await listWebhookEndpoints(db)}
      flash="Endpoint added. It hears about new events from now on."
      secret={{ url: result.endpoint.url, value: result.secret }}
    />,
  )
})

webhooksAdmin.post('/webhooks/deliveries/:id/redeliver', async (c) => {
  const id = Number(c.req.param('id'))
  const db = getDb(c.env)
  const row = Number.isInteger(id) ? await redeliverWebhook(c.env, db, id) : null
  if (!row) return c.redirect(go('/webhooks', 'That delivery no longer exists.', true), 303)
  const back = `/webhooks/${row.endpointId}`
  if (row.status === 'delivered') {
    return c.redirect(go(back, `Redelivered: the endpoint answered ${row.lastStatusCode}.`), 303)
  }
  return c.redirect(
    go(back, `Tried again: ${row.lastError ?? 'no answer'}. ${row.status === 'pending' ? 'It will keep retrying.' : ''}`, true),
    303,
  )
})

const DeliveryRow: FC<{ d: WebhookDelivery }> = ({ d }) => (
  <tr>
    <td class="mono">{d.event}</td>
    <td>{statusPill(d.status)}</td>
    <td class="num">{d.attempts}</td>
    <td class="num">{d.lastStatusCode ?? '-'}</td>
    <td class="faint" style="max-width:280px">
      {d.lastError ?? (d.lastResponse ? <span class="mono">{d.lastResponse.slice(0, 120)}</span> : '')}
    </td>
    <td class="faint">
      {fmtDate(d.createdAt)}
      {d.status === 'pending' && d.nextAttemptAt ? <div>next {fmtDate(d.nextAttemptAt)}</div> : null}
    </td>
    <td style="text-align:right">
      <form method="post" action={`/webhooks/deliveries/${d.id}/redeliver`} style="display:inline">
        <button class="btn sm">Redeliver</button>
      </form>
    </td>
  </tr>
)

webhooksAdmin.get('/webhooks/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const db = getDb(c.env)
  const endpoint = Number.isInteger(id) ? await getWebhookEndpoint(db, id) : null
  if (!endpoint) return c.redirect(go('/webhooks', 'No such endpoint.', true), 303)

  const status = c.req.query('status')
  const filter = status === 'pending' || status === 'delivered' || status === 'failed' ? status : undefined
  const deliveries = await listWebhookDeliveries(db, { endpointId: id, status: filter, limit: 100 })

  return c.html(
    <Layout title="Webhook" nav="hooks">
      <div class="head">
        <div>
          <h1 class="mono" style="font-size:20px;word-break:break-all">
            {endpoint.url}
          </h1>
          <div class="sub">
            <EndpointState e={endpoint} /> · secret <span class="mono">{endpoint.secretPrefix}…</span>
            {!endpoint.isActive && endpoint.disabledReason ? ` · ${endpoint.disabledReason}` : ''}
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>Delivery log</h2>
          <div class="row" style="gap:10px">
            {(['all', 'pending', 'failed', 'delivered'] as const).map((s) => (
              <a href={s === 'all' ? `/webhooks/${id}` : `/webhooks/${id}?status=${s}`} class={(filter ?? 'all') === s ? '' : 'faint'}>
                {s}
              </a>
            ))}
          </div>
        </div>
        {deliveries.length === 0 ? (
          <div class="card-b">
            <div class="empty">
              <p>Nothing here yet.</p>
              <p class="faint">Deliveries appear as events happen, and go out within a minute.</p>
            </div>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th class="num">Tries</th>
                <th class="num">Code</th>
                <th>Last answer</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <DeliveryRow d={d} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>Settings</h2>
        </div>
        <div class="card-b">
          <form method="post" action={`/webhooks/${id}`}>
            <label>URL</label>
            <input type="url" name="url" value={endpoint.url} required />

            <label style="margin-top:16px">Description</label>
            <input type="text" name="description" maxlength={200} value={endpoint.description} />

            <label style="margin-top:16px">Events</label>
            <EventBoxes checked={endpoint.events} />

            <label style="margin-top:16px;display:flex;gap:8px;align-items:center;font-weight:400">
              <input type="checkbox" name="active" value="on" checked={endpoint.isActive} />
              On — switching it back on clears the failure count
            </label>

            <button class="btn primary" style="margin-top:16px">
              Save
            </button>
          </form>
        </div>
        <div class="card-b">
          <Signing />
        </div>
        <div class="card-b">
          <form method="post" action={`/webhooks/${id}/delete`}>
            <button class="btn danger">Delete endpoint and its log</button>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

webhooksAdmin.post('/webhooks/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const result = await updateWebhookEndpoint(getDb(c.env), id, {
    url: String(form.get('url') ?? ''),
    description: String(form.get('description') ?? ''),
    events: form.getAll('events').map(String),
    active: form.get('active') === 'on',
  })
  if (!result.ok) return c.redirect(go(`/webhooks/${id}`, `Not saved: ${result.reason}.`, true), 303)
  return c.redirect(go(`/webhooks/${id}`, 'Saved.'), 303)
})

webhooksAdmin.post('/webhooks/:id/delete', async (c) => {
  const id = Number(c.req.param('id'))
  const gone = Number.isInteger(id) && (await deleteWebhookEndpoint(getDb(c.env), id))
  return c.redirect(go('/webhooks', gone ? 'Endpoint deleted with its delivery log.' : 'No such endpoint.', !gone), 303)
})
