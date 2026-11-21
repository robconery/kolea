import { Hono } from 'hono'
import {
  addDomain,
  checkDomain,
  customTracking,
  type DomainRecord,
  domainPorts,
  domainRecords,
  getDomain,
  listDomains,
  removeDomain,
  setupWithCloudflare,
} from '../core/domains.ts'
import { getDb } from '../db/index.ts'
import type { DomainRecordStatus, SendingDomain } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate } from './layout.tsx'

/**
 * Sending domains: add the domain mail comes from, see the DNS records it needs,
 * check them, and (with a Cloudflare token) add them in one click. Operator-only
 * config, mounted after `requireOperator`. Every rule is in `core/domains.ts`.
 */
export const domainsAdmin = new Hono<{ Bindings: Env }>()

const back = (path: string, msg: string, kind?: 'warn') =>
  `${path}?flash=${encodeURIComponent(msg)}${kind ? `&kind=${kind}` : ''}`

const STATUS_PILL: Record<SendingDomain['status'], { cls: string; label: string }> = {
  pending: { cls: 'pill warn', label: 'pending' },
  verified: { cls: 'pill ok', label: 'verified' },
  failed: { cls: 'pill bad', label: 'failed' },
}

const RECORD_PILL: Record<DomainRecordStatus, { cls: string; label: string }> = {
  unchecked: { cls: 'pill', label: 'not checked' },
  found: { cls: 'pill ok', label: 'found' },
  existing: { cls: 'pill ok', label: 'yours, kept' },
  missing: { cls: 'pill warn', label: 'missing' },
  mismatch: { cls: 'pill bad', label: 'says something else' },
}

const PURPOSE: Record<DomainRecord['purpose'], string> = {
  dkim: 'DKIM',
  spf: 'SPF',
  return_path: 'Return path',
  dmarc: 'DMARC',
  tracking: 'Tracking',
}

domainsAdmin.get('/domains', async (c) => {
  const db = getDb(c.env)
  const domains = await listDomains(db)
  const from = c.env.FROM_EMAIL

  return c.html(
    <Layout title="Sending domains" nav="dom">
      <div class="head">
        <div>
          <h1>Sending domains</h1>
          <div class="sub">
            The domains mail is sent from, and whether DNS is set up for them. Mail goes out from{' '}
            <span class="mono">{from}</span>.
          </div>
        </div>
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>Add a domain</h2>
        </div>
        <div class="card-b">
          <form method="post" action="/domains" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
            <div class="field" style="flex:1;min-width:240px;margin:0">
              <label for="domain-name">Domain</label>
              <input id="domain-name" type="text" name="name" placeholder="news.example.com" required />
            </div>
            <button class="btn primary">Add domain</button>
          </form>
          <p class="faint" style="margin:12px 0 0">
            A subdomain such as news.example.com keeps list mail apart from your everyday email. A name that already
            points somewhere else (a CNAME, like the one your site uses) cannot hold mail records.
          </p>
        </div>
      </div>

      <div class="card">
        {domains.length === 0 ? (
          <div class="empty">
            <p>No sending domains yet.</p>
            <p>Add the domain in your From address to see the records it needs.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Domain</th>
                <th>Status</th>
                <th>Last checked</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr>
                  <td>
                    <a href={`/domains/${d.id}`}>{d.name}</a>
                  </td>
                  <td>
                    <span class={STATUS_PILL[d.status].cls}>{STATUS_PILL[d.status].label}</span>
                  </td>
                  <td class="muted">{d.lastCheckedAt ? fmtDate(d.lastCheckedAt) : 'not yet'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>,
  )
})

domainsAdmin.post('/domains', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const result = await addDomain(c.env, db, String(form.get('name') ?? ''))
  if (!result.ok) return c.redirect(back('/domains', result.error, 'warn'))
  return c.redirect(back(`/domains/${result.value.id}`, `${result.value.name} added. Create the records below, then check.`))
})

domainsAdmin.get('/domains/:id', async (c) => {
  const db = getDb(c.env)
  const d = await getDomain(db, Number(c.req.param('id')))
  if (!d) return c.notFound()
  const records = domainRecords(d, customTracking(c.env))
  const ports = domainPorts(c.env, db)
  const fromDomain = (c.env.FROM_EMAIL ?? '').split('@')[1]?.toLowerCase()
  const pill = STATUS_PILL[d.status]

  return c.html(
    <Layout title={`${d.name} · Sending domains`} nav="dom">
      <div class="head">
        <div>
          <h1>
            {d.name} <span class={pill.cls}>{pill.label}</span>
          </h1>
          <div class="sub">
            <a href="/domains">← Sending domains</a>
            {' · '}
            {d.lastCheckedAt ? `Checked ${fmtDate(d.lastCheckedAt)}` : 'Not checked yet'}
            {d.status === 'pending' && d.nextCheckAt ? ` · next look ${fmtDate(d.nextCheckAt)}` : ''}
          </div>
        </div>
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      {d.lastError ? (
        <div class="note warn">
          <strong>The last check could not finish.</strong> {d.lastError}
        </div>
      ) : null}
      {d.status === 'verified' && fromDomain !== d.name ? (
        <div class="note">
          Verified. Your From address (<span class="mono">{c.env.FROM_EMAIL}</span>) is on another domain; set{' '}
          <span class="mono">FROM_EMAIL</span> to an address here to send from it.
        </div>
      ) : null}

      <div class="card">
        <div class="card-h">
          <h2>DNS records</h2>
          <div class="actions">
            <form method="post" action={`/domains/${d.id}/check`} style="display:inline">
              <button class="btn sm">Check now</button>
            </form>
            {ports.cloudflare ? (
              <form method="post" action={`/domains/${d.id}/cloudflare`} style="display:inline">
                <button class="btn sm accent">Add to Cloudflare</button>
              </form>
            ) : null}
          </div>
        </div>
        <div class="card-b">
          <p class="faint" style="margin:0 0 14px">
            Create these at your DNS host. Most hosts want the Host column typed into their Name field. An SPF or DMARC
            record you already have is never replaced: add the provider's <span class="mono">include:</span> to your
            SPF record instead of making a second one.
            {ports.cloudflare
              ? ' Add to Cloudflare creates the missing ones and leaves anything already there alone.'
              : ' Set CLOUDFLARE_DNS_API_TOKEN to add them in one click.'}
          </p>
          {ports.identity && !records.some((r) => r.purpose === 'dkim') ? (
            <div class="note warn">
              <strong>{ports.provider} has not said which records it wants yet.</strong> Check now to ask again.
            </div>
          ) : null}
          <table>
            <thead>
              <tr>
                <th>Purpose</th>
                <th>Type</th>
                <th>Host</th>
                <th>Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr>
                  <td>
                    {PURPOSE[r.purpose]}
                    {r.requirement === 'recommended' ? <div class="faint">recommended</div> : null}
                  </td>
                  <td class="mono">
                    {r.type}
                    {r.priority !== undefined ? <div class="faint">priority {r.priority}</div> : null}
                  </td>
                  <td class="mono">
                    {r.host}{' '}
                    <button type="button" class="btn sm" data-copy={r.host}>
                      Copy
                    </button>
                  </td>
                  <td class="mono" style="word-break:break-all;max-width:36ch">
                    {r.value}{' '}
                    <button type="button" class="btn sm" data-copy={r.value}>
                      Copy
                    </button>
                  </td>
                  <td>
                    <span class={RECORD_PILL[r.status].cls}>{RECORD_PILL[r.status].label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Remove</h2>
        </div>
        <div class="card-b">
          <p class="faint" style="margin:0 0 12px">
            Takes the domain off this list. DNS records and the provider's copy of the domain are left as they are.
          </p>
          <form method="post" action={`/domains/${d.id}/remove`}>
            <input type="hidden" name="confirm" value={d.name} />
            <button class="btn sm danger">Remove {d.name}</button>
          </form>
        </div>
      </div>

      <script dangerouslySetInnerHTML={{ __html: copyJs }} />
    </Layout>,
  )
})

domainsAdmin.post('/domains/:id/check', async (c) => {
  const id = Number(c.req.param('id'))
  const result = await checkDomain(c.env, getDb(c.env), id, 'manual')
  if (!result.ok) return c.redirect(back('/domains', result.error, 'warn'))
  const d = result.value
  const msg =
    d.status === 'verified'
      ? `${d.name} is verified.`
      : d.lastError
        ? 'Checked, but the check could not finish. Nothing changed.'
        : `Checked. ${d.name} is ${d.status}; the records still missing are marked below.`
  return c.redirect(back(`/domains/${id}`, msg, d.status === 'verified' ? undefined : 'warn'))
})

domainsAdmin.post('/domains/:id/cloudflare', async (c) => {
  const id = Number(c.req.param('id'))
  const result = await setupWithCloudflare(c.env, getDb(c.env), id)
  if (!result.ok) return c.redirect(back(`/domains/${id}`, result.error, 'warn'))
  const { created, kept, conflicts } = result.value
  const parts = [
    created.length ? `Added ${created.length} record${created.length === 1 ? '' : 's'} to Cloudflare.` : 'Nothing needed adding.',
    kept.length ? `${kept.length} already there.` : '',
    conflicts.length
      ? `Left alone, because something else is already there: ${conflicts.map((x) => `${x.id} (${x.existing})`).join('; ')}. Edit ${conflicts.length === 1 ? 'that one' : 'those'} by hand.`
      : '',
  ]
  return c.redirect(back(`/domains/${id}`, parts.filter(Boolean).join(' '), conflicts.length ? 'warn' : undefined))
})

domainsAdmin.post('/domains/:id/remove', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const d = await getDomain(db, id)
  if (!d) return c.redirect('/domains')
  const form = await c.req.formData()
  // Only the screen's own button carries the name.
  if (String(form.get('confirm') ?? '') !== d.name) return c.redirect(`/domains/${id}`)
  await removeDomain(db, id)
  return c.redirect(back('/domains', `${d.name} removed.`))
})

/** Copy buttons. The value is on the page too, for a context with no clipboard. */
const copyJs = `
document.addEventListener('click', async (e) => {
  const button = e.target.closest && e.target.closest('[data-copy]')
  if (!button) return
  const label = button.textContent
  try {
    await navigator.clipboard.writeText(button.dataset.copy)
    button.textContent = 'Copied'
  } catch {
    button.textContent = 'Copy it by hand'
  }
  setTimeout(() => { button.textContent = label }, 1600)
})
`
