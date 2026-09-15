import { asc } from 'drizzle-orm'
import { Hono } from 'hono'
import { TRAP_FIELD } from '../api/forms.tsx'
import {
  campaignPeople,
  campaignStats,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  setCampaignStatus,
  updateCampaign,
} from '../core/campaigns.ts'
import { MAX_DOWNLOAD_BYTES, detachFile, fileStats } from '../core/downloads.ts'
import {
  createForm,
  deleteForm,
  formDeliveryCount,
  formTagList,
  getForm,
  listForms,
  setFormReply,
  updateForm,
} from '../core/forms.ts'
import { listSales, recordSale, revenueTotals, salesForCampaign } from '../core/sales.ts'
import { findOrCreateTag } from '../core/subscribers.ts'
import { getDb } from '../db/index.ts'
import { sequences } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { BROADCAST_SCOPE_LABEL, footerPreviewHtml } from '../core/render.ts'
import { previewAddress, sendPreview } from '../core/sending.ts'
import {
  CampaignTabs,
  EditorHint,
  Flash,
  Layout,
  RichEditor,
  fmtBytes,
  fmtDate,
  fmtMoney,
  readEditorBody,
  statusPill,
} from './layout.tsx'

export const campaignsAdmin = new Hono<{ Bindings: Env }>()

/**
 * The consent footer a reply carries, for the editor's paper preview.
 *
 * Broadcast-scoped: submitting the form put this person on the list, so the
 * unsubscribe they are offered is the newsletter. The *eligibility* rule for the
 * reply is transactional — see `core/sending.ts` — which is a different question
 * from what the footer says.
 */
const replyFooter = footerPreviewHtml({ kind: 'broadcast' }, BROADCAST_SCOPE_LABEL)

/** "$1,240.00 · €95.00" — one entry per currency, because totals can't be added. */
const money = (rows: { currency: string; cents: number }[]) =>
  rows.length === 0 ? '$0.00' : rows.map((r) => fmtMoney(r.cents, r.currency)).join(' · ')

/** Dollars in the admin form → integer cents in the database. */
function readAmountCents(raw: string): number {
  const n = Number(raw.replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN
}

// ───────────────────────────────────────────────── campaigns

campaignsAdmin.get('/campaigns', async (c) => {
  const db = getDb(c.env)
  const all = await listCampaigns(db)
  const withStats = await Promise.all(
    all.map(async (campaign) => ({ campaign, stats: await campaignStats(db, campaign.id) })),
  )

  return c.html(
    <Layout title="Campaigns" nav="camp">
      <div class="head">
        <div>
          <h1>Campaigns</h1>
          <div class="sub">A named push. Mail joins one, forms feed one, money lands on one.</div>
        </div>
      </div>

      <CampaignTabs on="campaigns" />
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>{all.length} campaigns</h2>
          <div class="actions">
            <form method="post" action="/campaigns" class="row" style="gap:6px;max-width:340px">
              <input type="text" name="name" placeholder="new campaign" required style="min-width:0" />
              <button class="btn sm primary" style="flex:0 0 auto;min-width:0">
                Create
              </button>
            </form>
          </div>
        </div>
        <div class="card-b flush">
          {withStats.length === 0 ? (
            <div class="empty">
              <p>No campaigns yet.</p>
              <p class="faint">
                Make one for your next launch, point a form at it, and every sale that follows knows
                where it came from.
              </p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th class="num">People</th>
                  <th class="num">Orders</th>
                  <th class="num">Revenue</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {withStats.map(({ campaign, stats }) => (
                  <tr style={campaign.status === 'archived' ? 'opacity:.55' : ''}>
                    <td>
                      <a href={`/campaigns/${campaign.id}`} style="font-weight:500">
                        {campaign.name}
                      </a>
                      <div class="faint mono">{campaign.slug}</div>
                    </td>
                    <td class="num">{stats.people}</td>
                    <td class="num">
                      {stats.orders}
                      {stats.refunds > 0 ? <div class="faint">{stats.refunds} refunded</div> : null}
                    </td>
                    <td class="num">{money(stats.revenue)}</td>
                    <td>{statusPill(campaign.status)}</td>
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

campaignsAdmin.post('/campaigns', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const name = String(form.get('name') ?? '').trim()
  if (!name) return c.redirect('/campaigns?flash=A campaign needs a name.&kind=warn')

  const id = await createCampaign(db, name)
  return c.redirect(`/campaigns/${id}?flash=Campaign created.`)
})

campaignsAdmin.get('/campaigns/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const campaign = await getCampaign(db, id)
  if (!campaign) return c.notFound()

  const [stats, people, sales] = await Promise.all([
    campaignStats(db, id),
    campaignPeople(db, id),
    salesForCampaign(db, id),
  ])

  const goalPct =
    campaign.goalCents && campaign.goalCents > 0
      ? Math.min(100, Math.round(((stats.revenue[0]?.cents ?? 0) / campaign.goalCents) * 100))
      : null

  return c.html(
    <Layout title={campaign.name} nav="camp">
      <div class="head">
        <div>
          <h1>{campaign.name}</h1>
          <div class="sub">
            {statusPill(campaign.status)} · <span class="mono">{campaign.slug}</span> · started{' '}
            {fmtDate(campaign.startedAt)}
          </div>
        </div>
        <div class="actions">
          <form method="post" action={`/campaigns/${id}/archive`}>
            <button class="btn">{campaign.status === 'archived' ? 'Reopen' : 'Archive'}</button>
          </form>
        </div>
      </div>

      <CampaignTabs on="campaigns" />
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b flush">
          <div class="stats">
            <div class="stat hi">
              <div class="n">{money(stats.revenue)}</div>
              <div class="l">Net revenue</div>
            </div>
            <div class="stat">
              <div class="n">{stats.orders}</div>
              <div class="l">Orders</div>
            </div>
            <div class="stat">
              <div class="n">{stats.people}</div>
              <div class="l">People touched</div>
            </div>
            <div class="stat">
              <div class="n">
                {stats.people > 0 ? `${Math.round((stats.orders / stats.people) * 100)}%` : '-'}
              </div>
              <div class="l">Converted</div>
            </div>
            <div class="stat">
              <div class="n">{stats.forms}</div>
              <div class="l">Forms</div>
            </div>
          </div>
        </div>
      </div>

      {goalPct !== null ? (
        <div class="note">
          <strong>{goalPct}% of goal.</strong> {money(stats.revenue)} of{' '}
          {fmtMoney(campaign.goalCents ?? 0, stats.revenue[0]?.currency ?? 'usd')}.
        </div>
      ) : null}


      <div class="card">
        <div class="card-h">
          <h2>Sales</h2>
          <span class="pill">{sales.length} recorded</span>
        </div>
        <div class="card-b flush">
          {sales.length === 0 ? (
            <div class="empty">
              <p>No sales credited to this campaign yet.</p>
              <p class="faint">
                POST to <span class="mono">/api/sales</span> with{' '}
                <span class="mono">"campaign": "{campaign.slug}"</span>, or leave it off and the
                person's last touch decides.
              </p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Product</th>
                  <th class="num">Amount</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {sales.map(({ sale, email, subscriberName }) => (
                  <tr style={sale.status === 'refunded' ? 'opacity:.55' : ''}>
                    <td>
                      <a href={`/subscribers/${sale.subscriberId}`}>{subscriberName ?? email}</a>
                      <div class="faint mono">{email}</div>
                    </td>
                    <td>{sale.product ?? '-'}</td>
                    <td class="num">
                      {fmtMoney(sale.amountCents, sale.currency)}
                      {sale.status === 'refunded' ? (
                        <div class="faint">refunded</div>
                      ) : null}
                    </td>
                    <td class="faint">{fmtDate(sale.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>People it reached</h2>
          <span class="pill">{stats.people} touched</span>
        </div>
        <div class="card-b flush">
          {people.length === 0 ? (
            <div class="empty">
              <p>Nobody has been attributed to this campaign yet.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>How they arrived</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr>
                    <td>
                      <a href={`/subscribers/${p.id}`}>{p.name ?? p.email}</a>
                      <div class="faint mono">{p.email}</div>
                    </td>
                    <td>
                      <span class="pill">{p.sourceKind}</span>
                    </td>
                    <td class="faint">{fmtDate(p.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Settings</h2>
        </div>
        <div class="card-b">
          <form method="post" action={`/campaigns/${id}`}>
            <div class="row">
              <div class="field">
                <label>Name</label>
                <input type="text" name="name" value={campaign.name} required />
              </div>
              <div class="field">
                <label>Revenue goal (optional)</label>
                <input
                  type="text"
                  name="goal"
                  value={campaign.goalCents ? String(campaign.goalCents / 100) : ''}
                  placeholder="5000"
                />
              </div>

            </div>
            <div class="field">
              <label>Description</label>
              <input type="text" name="description" value={campaign.description ?? ''} />
            </div>
            <button class="btn primary">Save</button>
          </form>

          <p class="faint" style="margin-top:20px">
            Deleting a campaign removes the label and its attribution history. Sales and mail keep
            their rows; they just stop being credited to anything.
          </p>
          <form method="post" action={`/campaigns/${id}/delete`}>
            <button class="btn danger sm">Delete campaign</button>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

campaignsAdmin.post('/campaigns/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const name = String(form.get('name') ?? '').trim()
  if (!name) return c.redirect(`/campaigns/${id}?flash=A campaign needs a name.&kind=warn`)

  const goalRaw = String(form.get('goal') ?? '').trim()
  const goalCents = goalRaw ? readAmountCents(goalRaw) : null
  await updateCampaign(db, id, {
    name,
    description: String(form.get('description') ?? '') || null,
    goalCents: goalCents !== null && Number.isFinite(goalCents) ? goalCents : null,
  })
  return c.redirect(`/campaigns/${id}?flash=Saved.`)
})

campaignsAdmin.post('/campaigns/:id/archive', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const campaign = await getCampaign(db, id)
  if (!campaign) return c.notFound()

  const next = campaign.status === 'archived' ? 'active' : 'archived'
  await setCampaignStatus(db, id, next)
  return c.redirect(`/campaigns/${id}?flash=${next === 'archived' ? 'Archived.' : 'Reopened.'}`)
})

campaignsAdmin.post('/campaigns/:id/delete', async (c) => {
  const db = getDb(c.env)
  await deleteCampaign(db, Number(c.req.param('id')))
  return c.redirect('/campaigns?flash=Campaign deleted. Sales kept, attribution dropped.')
})

// ───────────────────────────────────────────────── forms

campaignsAdmin.get('/forms', async (c) => {
  const db = getDb(c.env)
  const rows = await listForms(db)

  return c.html(
    <Layout title="Forms" nav="forms">
      <div class="head">
        <div>
          <h1>Forms</h1>
          <div class="sub">A named POST endpoint. No embed script, no hosted landing page.</div>
        </div>
        <div class="actions">
          <a class="btn primary" href="/forms/new">
            New form
          </a>
        </div>
      </div>

      <CampaignTabs on="forms" />
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b flush">
          {rows.length === 0 ? (
            <div class="empty">
              <p>No forms yet.</p>
              <p class="faint">Create one below and paste the snippet into your own site.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Form</th>
                  <th>Endpoint</th>
                  <th>Starts</th>
                  <th>Sends back</th>
                  <th>Campaign</th>
                  <th class="num">Submits</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ form, sequenceName, sequenceActive, campaignName }) => (
                  <tr style={form.isActive ? '' : 'opacity:.55'}>
                    <td>
                      <a href={`/forms/${form.id}`} style="font-weight:500">
                        {form.name}
                      </a>
                      {form.isActive ? null : <div class="faint">closed</div>}
                    </td>
                    <td class="mono faint">POST /f/{form.slug}</td>
                    <td>
                      {sequenceName ? (
                        sequenceActive ? (
                          <span class="pill ok">{sequenceName}</span>
                        ) : (
                          <span class="pill warn" title="The sequence is paused; nothing will send">
                            {sequenceName} (paused)
                          </span>
                        )
                      ) : (
                        <span class="faint">-</span>
                      )}
                    </td>
                    <td>
                      {form.deliverySubject ? (
                        <span class="pill ok">{form.downloadFilename ?? 'reply only'}</span>
                      ) : form.downloadFilename ? (
                        <span class="pill warn" title="A file with no reply reaches nobody">
                          {form.downloadFilename} (no reply)
                        </span>
                      ) : (
                        <span class="faint">-</span>
                      )}
                    </td>
                    <td>{campaignName ?? <span class="faint">-</span>}</td>
                    <td class="num">
                      {form.submitCount}
                      <div class="faint">{fmtDate(form.lastSubmittedAt)}</div>
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

/**
 * The file upload, in about thirty lines of browser JavaScript.
 *
 * A raw `PUT` rather than a plain `<form enctype="multipart/form-data">` because
 * `formData()` in the Worker buffers the whole body into a 128MB isolate.
 * Streaming the file straight into R2 is the difference between a 90MB zip
 * working and the Worker dying.
 */
const newFormJs = `
const form = document.querySelector('#new-form')
const input = document.querySelector('#dl-file')
const status = document.querySelector('#dl-status')
form?.addEventListener('submit', async (e) => {
  const file = input && input.files && input.files[0]
  // No file: let the browser post the form the ordinary way. Nothing to intercept.
  if (!file) return
  e.preventDefault()
  if (file.size > ${MAX_DOWNLOAD_BYTES}) {
    status.textContent = 'That file is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB.'
    return
  }
  const button = form.querySelector('button[type=submit]')
  if (button) button.disabled = true
  try {
    status.textContent = 'Creating the form…'
    // The file input has no name, so it is not in here — the form post stays small.
    const made = await fetch('/forms', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new FormData(form),
    })
    const form_ = await made.json()
    if (!made.ok || !form_.id) throw new Error(form_.error || 'could not create the form')

    status.textContent = 'Uploading ' + file.name + '…'
    const put = await fetch('/api/forms/' + form_.id + '/file?filename=' + encodeURIComponent(file.name), {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    const up = await put.json()
    if (!put.ok) throw new Error(up.error || ('upload failed (' + put.status + ')'))

    location.href = '/forms/' + form_.id + '?flash=' + encodeURIComponent('Form created, ' + file.name + ' attached.')
  } catch (err) {
    status.textContent = String(err.message || err)
    if (button) button.disabled = false
  }
})
`

const uploadJs = (formId: number) => `
const input = document.querySelector('#dl-file')
const status = document.querySelector('#dl-status')
input?.addEventListener('change', async () => {
  const file = input.files && input.files[0]
  if (!file) return
  if (file.size > ${MAX_DOWNLOAD_BYTES}) {
    status.textContent = 'That file is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB.'
    return
  }
  status.textContent = 'Uploading ' + file.name + '…'
  input.disabled = true
  try {
    const res = await fetch('/api/forms/${formId}/file?filename=' + encodeURIComponent(file.name), {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error || ('upload failed (' + res.status + ')'))
    location.href = '/forms/${formId}?flash=' + encodeURIComponent(file.name + ' attached.')
  } catch (err) {
    status.textContent = String(err.message || err)
    input.disabled = false
  }
})
`

interface FieldsProps {
  seqs: { id: number; name: string; isActive: boolean }[]
  allCampaigns: { id: number; name: string }[]
  form?: {
    name: string
    slug: string
    sequenceId: number | null
    campaignId: number | null
    redirectUrl: string | null
    successMessage: string
    isActive: boolean
  }
  tagNames: string
}

/**
 * The settings themselves, with no `<form>` around them.
 *
 * Split out because the new-form page posts these *and* the reply in a single
 * submit — one page, one button — while the detail page saves them on their own.
 */
const FormFieldsInner = ({ seqs, allCampaigns, form, tagNames }: FieldsProps) => (
  <>
    <div class="row">
      <div class="field">
        <label>Name</label>
        <input type="text" name="name" value={form?.name ?? ''} placeholder="Newsletter footer" required />
      </div>
      <div class="field">
        <label>Slug (the URL)</label>
        <input type="text" name="slug" value={form?.slug ?? ''} placeholder="newsletter" />
      </div>
    </div>

    <div class="row">
      <div class="field">
        <label>Start this sequence</label>
        <select name="sequenceId">
          <option value="">(none)</option>
          {seqs.map((s) => (
            <option value={String(s.id)} selected={s.id === form?.sequenceId}>
              {s.name}
              {s.isActive ? '' : ' (paused)'}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label>Credit this campaign</label>
        <select name="campaignId">
          <option value="">(none)</option>
          {allCampaigns.map((x) => (
            <option value={String(x.id)} selected={x.id === form?.campaignId}>
              {x.name}
            </option>
          ))}
        </select>
      </div>
    </div>

    <div class="field">
      <label>Tags to apply (comma separated)</label>
      <input type="text" name="tags" value={tagNames} placeholder="newsletter, from-blog" />
    </div>

    <div class="row">
      <div class="field">
        <label>Redirect after submit (optional)</label>
        <input
          type="url"
          name="redirectUrl"
          value={form?.redirectUrl ?? ''}
          placeholder="https://yoursite.com/thanks"
        />
      </div>
      <div class="field">
        <label>Success message (used when there's no redirect)</label>
        <input
          type="text"
          name="successMessage"
          value={form?.successMessage ?? "You're subscribed. Thanks!"}
        />
      </div>
    </div>

    <div class="field">
      <label style="font-weight:400">
        <input
          type="checkbox"
          name="isActive"
          value="1"
          checked={form ? form.isActive : true}
          style="width:auto"
        />{' '}
        Accepting submissions
      </label>
    </div>

  </>
)

const FormFields = ({ action, ...props }: FieldsProps & { action: string }) => (
  <form method="post" action={action}>
    <FormFieldsInner {...props} />
    <button class="btn primary">Save form</button>
  </form>
)

/** Comma-separated tag names → ids, creating any that are new. */
async function readTagIds(db: ReturnType<typeof getDb>, raw: string): Promise<number[]> {
  const names = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const ids: number[] = []
  for (const name of names) ids.push(await findOrCreateTag(db, name))
  return ids
}

function readFormInput(form: FormData) {
  const num = (key: string) => {
    const raw = String(form.get(key) ?? '').trim()
    const n = Number(raw)
    return raw && Number.isFinite(n) && n > 0 ? n : null
  }
  return {
    name: String(form.get('name') ?? '').trim(),
    slug: String(form.get('slug') ?? '').trim() || undefined,
    sequenceId: num('sequenceId'),
    campaignId: num('campaignId'),
    redirectUrl: String(form.get('redirectUrl') ?? '').trim() || null,
    successMessage: String(form.get('successMessage') ?? '').trim(),
    isActive: form.get('isActive') === '1',
  }
}

campaignsAdmin.post('/forms', async (c) => {
  const db = getDb(c.env)
  const body = await c.req.formData()
  const input = readFormInput(body)

  // The new-form page posts with `fetch` when it has a file to upload after, and
  // needs the new id back rather than a redirect it can't follow usefully.
  const wantsJson = (c.req.header('Accept') ?? '').includes('application/json')
  const bail = (msg: string) =>
    wantsJson ? c.json({ error: msg }, 400) : c.redirect(`/forms/new?flash=${encodeURIComponent(msg)}&kind=warn`)

  if (!input.name) return bail('A form needs a name.')

  const subject = String(body.get('deliverySubject') ?? '').trim()
  const { bodyJson, bodyMd } = readEditorBody(body)
  if (subject && !bodyJson && !bodyMd.trim()) {
    return bail("The reply has a subject and no body. An empty email is worse than none.")
  }

  const id = await createForm(db, {
    ...input,
    tagIds: await readTagIds(db, String(body.get('tags') ?? '')),
  })
  // Written separately, and only when there is one: the reply is the part that
  // puts mail on the wire, so it never rides along silently with the settings.
  if (subject) await setFormReply(db, id, { subject, bodyJson, bodyMd })

  if (wantsJson) return c.json({ id })
  return c.redirect(
    `/forms/${id}?flash=${encodeURIComponent(
      subject ? 'Form created. Attach the file below.' : 'Form created. Grab the snippet below.',
    )}`,
  )
})

/**
 * Everything a form is, on one page, in one submit: the settings, the file it
 * hands over, and the reply that carries it.
 *
 * The file is the one part that can't be written until the form has an id, so
 * `newFormJs` creates the form first and then streams the file at it. With
 * JavaScript off the page still posts normally and the file is attached from the
 * form's own page afterwards — which is what the `<noscript>` note says.
 */
campaignsAdmin.get('/forms/new', async (c) => {
  const db = getDb(c.env)
  const [seqs, allCampaigns] = await Promise.all([
    db.select().from(sequences).orderBy(asc(sequences.name)).all(),
    listCampaigns(db),
  ])

  return c.html(
    <Layout title="New form" nav="forms" editor>
      <div class="head">
        <div>
          <h1>New form</h1>
          <div class="sub">A named POST endpoint, a file, and the reply that hands it over.</div>
        </div>
        <div class="actions">
          <a class="btn" href="/forms">
            Back to forms
          </a>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <form method="post" action="/forms" id="new-form">
        <div class="card">
          <div class="card-h">
            <h2>Settings</h2>
          </div>
          <div class="card-b">
            <div class="note">
              <strong>Submitting is one request.</strong> The person is created or updated, tagged,
              credited to the campaign, and dropped into the sequence: all idempotent, so a
              double-click changes nothing the second time.
            </div>
            <FormFieldsInner seqs={seqs} allCampaigns={allCampaigns} tagNames="" />
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            <h2>The file</h2>
          </div>
          <div class="card-b">
            <div class="field">
              <label>The file people are signing up for (optional)</label>
              <input type="file" id="dl-file" accept=".zip,.pdf,.epub,.gz,.tar" />
            </div>
            <p class="faint" id="dl-status">
              Zip, PDF, epub, tar or gzip, up to {MAX_DOWNLOAD_BYTES / 1024 / 1024}MB. It is never
              public: it leaves only through <span class="mono">/d/&lt;token&gt;</span>, one link
              issued to one person, and <span class="mono">{'{{link}}'}</span> in the reply is how
              they get it.
            </p>
            <noscript>
              <p class="faint">
                JavaScript is off, so this file input won't upload. Create the form, then attach the
                file from its own page.
              </p>
            </noscript>
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            <h2>The reply</h2>
          </div>
          <div class="card-b">
            <div class="note">
              <strong>This goes out the moment somebody submits.</strong> Not on the minutely tick,
              not as step one of a sequence — inside the request, so it's in their inbox before
              they've switched tabs. Leave the subject empty and no reply is sent at all.
            </div>

            <div class="field">
              <label>Subject (empty = send nothing)</label>
              <input
                type="text"
                name="deliverySubject"
                placeholder="Here's the Claude Code Toolkit"
              />
            </div>

            <div class="field">
              <label>Body</label>
              <RichEditor bare inline footer={replyFooter} />
              <p class="faint" style="margin:10px 0 0">
                Put <span class="mono">{'{{link}}'}</span> wherever the download belongs — as a
                button's link, a text link, or on its own line. It becomes that one person's private
                URL.
              </p>
              <EditorHint />
            </div>
          </div>
        </div>

        <div class="actions">
          <button class="btn primary" type="submit">
            Create form
          </button>
        </div>
      </form>

      <script dangerouslySetInnerHTML={{ __html: newFormJs }} />
    </Layout>,
  )
})

campaignsAdmin.get('/forms/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await getForm(db, id)
  if (!form) return c.notFound()

  const [seqs, allCampaigns, theirTags, stats, replied] = await Promise.all([
    db.select().from(sequences).orderBy(asc(sequences.name)).all(),
    listCampaigns(db),
    formTagList(db, id),
    fileStats(db, id),
    formDeliveryCount(db, id),
  ])

  const endpoint = `${c.env.PUBLIC_URL}/f/${form.slug}`
  const seq = seqs.find((s) => s.id === form.sequenceId)

  const html = `<form action="${endpoint}" method="post">
  <input type="email" name="email" placeholder="you@example.com" required>
  <input type="text" name="name" placeholder="Your name">
  <!-- spam trap: hide it, humans never fill it in -->
  <div style="position:absolute;left:-9999px" aria-hidden="true">
    <input type="text" name="${TRAP_FIELD}" tabindex="-1" autocomplete="off">
  </div>
  <button type="submit">Subscribe</button>
</form>`

  const js = `await fetch('${endpoint}', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, name })
})
// → { ok: true, message: "...", enrolled: true }`

  const hasFile = Boolean(form.downloadKey)
  const hasSubject = Boolean(form.deliverySubject?.trim())
  const hasBody = Boolean(form.deliveryBodyJson) || Boolean(form.deliveryBodyMd?.trim())
  // Cheap and blunt: the token is looked for in the serialized document as well
  // as the markdown, because it can sit in a link href where no text node has it.
  const linksTheFile = `${JSON.stringify(form.deliveryBodyJson ?? '')}${form.deliveryBodyMd ?? ''}`.includes(
    '{{link}}',
  )

  return c.html(
    <Layout title={form.name} nav="forms" editor>
      <div class="head">
        <div>
          <h1>{form.name}</h1>
          <div class="sub mono">POST {endpoint}</div>
        </div>
        <div class="actions">
          {form.isActive ? <span class="pill ok">accepting</span> : <span class="pill">closed</span>}
          <a class="btn" href={`/f/${form.slug}`} target="_blank" rel="noreferrer">
            Try it ↗
          </a>
        </div>
      </div>

      <CampaignTabs on="forms" />
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      {seq && !seq.isActive ? (
        <div class="flash warn">
          This form starts “{seq.name}”, but that sequence is paused, so people will be enrolled and
          nothing will send until you turn it on.
        </div>
      ) : null}

      {hasFile && !hasSubject ? (
        <div class="flash warn">
          {form.downloadFilename} is attached, but there's no reply — the link only ever travels by
          email, so nobody who submits this form can reach the file. Write the reply below.
        </div>
      ) : null}

      {hasSubject && !hasBody ? (
        <div class="flash warn">
          The reply has a subject and no body, so it won't send. An empty email is worse than none.
        </div>
      ) : null}

      {hasFile && hasSubject && hasBody && !linksTheFile ? (
        <div class="flash warn">
          A file is attached but the reply never says <span class="mono">{'{{link}}'}</span>, so it
          goes out with no download link in it. Add one below.
        </div>
      ) : null}

      <div class="card">
        <div class="card-b flush">
          <div class="stats">
            <div class="stat hi">
              <div class="n">{form.submitCount}</div>
              <div class="l">Submissions</div>
            </div>
            <div class="stat">
              <div class="n" style="font-size:15px;padding-top:6px">
                {fmtDate(form.lastSubmittedAt)}
              </div>
              <div class="l">Last one</div>
            </div>
            <div class="stat">
              <div class="n" style="font-size:15px;padding-top:6px">
                {seq?.name ?? '-'}
              </div>
              <div class="l">Starts</div>
            </div>
            <div class="stat">
              <div class="n">{replied}</div>
              <div class="l">Replies sent</div>
            </div>
            {hasFile ? (
              <div class="stat">
                <div class="n">{stats.taken}</div>
                <div class="l">Downloads</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Paste this into your site</h2>
        </div>
        <div class="card-b">
          <p class="muted">
            Plain HTML, no JavaScript, no library. It works from a static site, a Ghost theme, or
            anywhere else you can put a <span class="mono">&lt;form&gt;</span>.
          </p>
          <pre class="mono code">
            {html}
          </pre>
          <p class="muted" style="margin-top:18px">
            Or post JSON from a client component and stay on the page:
          </p>
          <pre class="mono code">
            {js}
          </pre>
          <p class="faint">
            The endpoint answers in whatever you spoke: a form post gets a redirect or a page, JSON
            gets JSON. CORS is open, because there's nothing here to read back.
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>The file</h2>
        </div>
        <div class="card-b">
          {hasFile ? (
            <div class="row" style="align-items:start">
              <div class="field">
                <label>Attached</label>
                <div class="mono">{form.downloadFilename}</div>
                <p class="faint" style="margin:6px 0 0">
                  {fmtBytes(form.downloadBytes ?? 0)} · uploaded {fmtDate(form.downloadUploadedAt)} ·{' '}
                  {stats.links} link{stats.links === 1 ? '' : 's'} handed out
                </p>
              </div>
              <div class="field">
                <label>Replace it</label>
                <input type="file" id="dl-file" accept=".zip,.pdf,.epub,.gz,.tar" />
                <p class="faint" style="margin:6px 0 0">
                  Every link already sent keeps working and starts serving the new file.
                </p>
              </div>
            </div>
          ) : (
            <div class="field">
              <label>Upload the file people are signing up for</label>
              <input type="file" id="dl-file" accept=".zip,.pdf,.epub,.gz,.tar" />
            </div>
          )}

          <p class="faint" id="dl-status">
            Zip, PDF, epub, tar or gzip, up to {MAX_DOWNLOAD_BYTES / 1024 / 1024}MB. Nothing here is
            public: the file leaves only through <span class="mono">/d/&lt;token&gt;</span>, one link
            issued to one person, and <span class="mono">{'{{link}}'}</span> in the reply below is how
            they get it.
          </p>

          {hasFile ? (
            <form method="post" action={`/forms/${id}/file/delete`} style="margin-top:14px">
              <button class="btn danger sm">Remove the file</button>
            </form>
          ) : null}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>The reply</h2>
        </div>
        <div class="card-b">
          <div class="note">
            <strong>This goes out the moment somebody submits.</strong> Not on the minutely tick, not
            as step one of a sequence — inside the request, so it's in their inbox before they've
            switched tabs. It follows the transactional consent rule: somebody who left the
            newsletter still gets what they just asked for. One per address per form per day.
            {form.sequenceId
              ? ' The sequence in the settings below still runs afterwards, for the nurture.'
              : ' Point “Start this sequence” below at a sequence if you want nurture to follow.'}
          </div>

          <form method="post" action={`/forms/${id}/reply`}>
            <div class="field">
              <label>Subject (empty = send nothing)</label>
              <input
                type="text"
                name="deliverySubject"
                value={form.deliverySubject ?? ''}
                placeholder="Here's the Claude Code Toolkit"
              />
            </div>

            <div class="field">
              <label>Body</label>
              <RichEditor
                bare
                inline
                json={form.deliveryBodyJson}
                md={form.deliveryBodyMd ?? ''}
                footer={replyFooter}
              />
              <p class="faint" style="margin:10px 0 0">
                Put <span class="mono">{'{{link}}'}</span> wherever the download belongs — as a
                button's link, a text link, or on its own line. It becomes that one person's private
                URL.
              </p>
              <EditorHint />
            </div>

            <div class="actions">
              <button class="btn primary">Save the reply</button>
              <button class="btn" name="action" value="test">
                Save and send me a test
              </button>
            </div>
            <p class="faint" style="margin:10px 0 0">
              A test goes to {previewAddress(c.env)} and nowhere else, with a real download link, so
              you can click it.
            </p>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Settings</h2>
        </div>
        <div class="card-b">
          <FormFields
            seqs={seqs}
            allCampaigns={allCampaigns}
            action={`/forms/${id}`}
            form={form}
            tagNames={theirTags.map((t) => t.name).join(', ')}
          />

          <p class="faint" style="margin-top:20px">
            Deleting a form doesn't touch anyone who came through it; their tags, enrollment and
            attribution all stay.
          </p>
          <form method="post" action={`/forms/${id}/delete`}>
            <button class="btn danger sm">Delete form</button>
          </form>
        </div>
      </div>

      <script dangerouslySetInnerHTML={{ __html: uploadJs(id) }} />
    </Layout>,
  )
})

campaignsAdmin.post('/forms/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const body = await c.req.formData()
  const input = readFormInput(body)
  if (!input.name) return c.redirect(`/forms/${id}?flash=A form needs a name.&kind=warn`)

  await updateForm(db, id, {
    ...input,
    tagIds: await readTagIds(db, String(body.get('tags') ?? '')),
  })
  return c.redirect(`/forms/${id}?flash=Saved.`)
})

/**
 * Save the reply, and optionally send one copy to the operator.
 *
 * A separate endpoint from the settings save on purpose: this is the only part
 * of a form that puts mail on the wire, and it should not be possible to change
 * it by accident while editing a redirect URL.
 */
campaignsAdmin.post('/forms/:id/reply', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await getForm(db, id)
  if (!form) return c.notFound()

  const body = await c.req.formData()
  const subject = String(body.get('deliverySubject') ?? '').trim()
  const { bodyJson, bodyMd } = readEditorBody(body)

  await setFormReply(db, id, { subject: subject || null, bodyJson, bodyMd })

  if (String(body.get('action') ?? '') !== 'test') {
    return c.redirect(
      `/forms/${id}?flash=${encodeURIComponent(subject ? 'Reply saved.' : 'Reply turned off — no subject, nothing sends.')}`,
    )
  }
  if (!subject) return c.redirect(`/forms/${id}?flash=Give it a subject first.&kind=warn`)

  const result = await sendPreview(
    c.env,
    db,
    {
      kind: 'form',
      formId: id,
      subject,
      body: { json: bodyJson, md: bodyMd },
      hasFile: Boolean(form.downloadKey),
    },
    previewAddress(c.env),
  )
  return c.redirect(
    result.ok
      ? `/forms/${id}?flash=${encodeURIComponent(`Saved. Test sent to ${result.to}.`)}`
      : `/forms/${id}?flash=${encodeURIComponent(`Saved, but the test didn't send: ${result.reason}`)}&kind=warn`,
  )
})

/**
 * Drop the file. Every link ever sent for it stops working, which is the point —
 * there is no other way to revoke one.
 */
campaignsAdmin.post('/forms/:id/file/delete', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await getForm(db, id)
  if (!form) return c.notFound()

  await detachFile(db, id)
  if (form.downloadKey) await c.env.DOWNLOADS.delete(form.downloadKey)
  return c.redirect(`/forms/${id}?flash=File removed. Every link sent for it is now dead.&kind=warn`)
})

campaignsAdmin.post('/forms/:id/delete', async (c) => {
  const db = getDb(c.env)
  await deleteForm(db, Number(c.req.param('id')))
  return c.redirect('/forms?flash=Form deleted.')
})

// ───────────────────────────────────────────────── sales

campaignsAdmin.get('/sales', async (c) => {
  const db = getDb(c.env)
  const [rows, totals, allCampaigns] = await Promise.all([
    listSales(db),
    revenueTotals(db),
    listCampaigns(db),
  ])

  const unattributed = rows.filter((r) => !r.sale.campaignId && r.sale.status === 'paid').length

  return c.html(
    <Layout title="Sales" nav="sales">
      <div class="head">
        <div>
          <h1>Sales</h1>
          <div class="sub">Money, posted in from wherever your checkout lives.</div>
        </div>
      </div>

      <CampaignTabs on="sales" />
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b flush">
          <div class="stats">
            <div class="stat hi">
              <div class="n">{money(totals)}</div>
              <div class="l">Net revenue</div>
            </div>
            <div class="stat">
              <div class="n">{totals.reduce((sum, t) => sum + t.orders, 0)}</div>
              <div class="l">Orders</div>
            </div>
            <div class="stat">
              <div class="n">{unattributed}</div>
              <div class="l">Unattributed</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>How to record one</h2>
        </div>
        <div class="card-b">
          <pre class="mono code">
{`curl -X POST ${c.env.PUBLIC_URL}/api/sales \\
  -H 'Authorization: Bearer <key>' \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"buyer@example.com",
       "amount_cents":4900,
       "product":"The Imposter Handbook",
       "external_id":"ch_3Qx...",
       "tags":["customer"],
       "end_sequence":"launch-drip"}'`}
          </pre>
          <p class="faint">
            Leave <span class="mono">campaign</span> off and the buyer's most recent attribution
            touch takes the credit; the response tells you which rule applied. Re-posting the same{' '}
            <span class="mono">external_id</span> never double-counts, and re-posting it with{' '}
            <span class="mono">"status":"refunded"</span> flips the original row.
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Record one by hand</h2>
        </div>
        <div class="card-b">
          <form method="post" action="/sales">
            <div class="row">
              <div class="field">
                <label>Email</label>
                <input type="email" name="email" required />
              </div>
              <div class="field">
                <label>Amount</label>
                <input type="text" name="amount" placeholder="49.00" required />
              </div>
              <div class="field">
                <label>Product</label>
                <input type="text" name="product" placeholder="The Imposter Handbook" />
              </div>
              <div class="field">
                <label>Campaign</label>
                <select name="campaign">
                  <option value="">(use last touch)</option>
                  {allCampaigns.map((x) => (
                    <option value={x.slug}>{x.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <button class="btn primary">Record sale</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Recent</h2>
          <span class="pill">{rows.length}</span>
        </div>
        <div class="card-b flush">
          {rows.length === 0 ? (
            <div class="empty">
              <p>No sales recorded.</p>
              <p class="faint">Post one from your checkout, or add one by hand above.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Product</th>
                  <th>Campaign</th>
                  <th class="num">Amount</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ sale, email, subscriberName, campaignName }) => (
                  <tr style={sale.status === 'refunded' ? 'opacity:.55' : ''}>
                    <td>
                      <a href={`/subscribers/${sale.subscriberId}`}>{subscriberName ?? email}</a>
                      <div class="faint mono">{email}</div>
                    </td>
                    <td>{sale.product ?? '-'}</td>
                    <td>
                      {campaignName ? (
                        <a href={`/campaigns/${sale.campaignId}`}>{campaignName}</a>
                      ) : (
                        <span class="faint">unattributed</span>
                      )}
                    </td>
                    <td class="num">
                      {fmtMoney(sale.amountCents, sale.currency)}
                      {sale.status === 'refunded' ? <div class="faint">refunded</div> : null}
                    </td>
                    <td class="faint">{fmtDate(sale.occurredAt)}</td>
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

campaignsAdmin.post('/sales', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const cents = readAmountCents(String(form.get('amount') ?? ''))
  if (!Number.isFinite(cents)) return c.redirect('/sales?flash=That amount looked wrong.&kind=warn')

  const result = await recordSale(db, {
    email: String(form.get('email') ?? ''),
    amountCents: cents,
    product: String(form.get('product') ?? '') || null,
    campaignSlug: String(form.get('campaign') ?? '') || null,
  })

  if (result.status === 'invalid_email') {
    return c.redirect('/sales?flash=That email looked wrong.&kind=warn')
  }

  const where = result.campaignSlug
    ? `credited to ${result.campaignSlug} (${result.attributedBy})`
    : 'unattributed, no campaign touch on record'
  return c.redirect(`/sales?flash=${encodeURIComponent(`Sale recorded, ${where}.`)}`)
})
