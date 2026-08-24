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
import {
  createForm,
  deleteForm,
  formTagList,
  getForm,
  listForms,
  updateForm,
} from '../core/forms.ts'
import { listSales, recordSale, revenueTotals, salesForCampaign } from '../core/sales.ts'
import { findOrCreateTag } from '../core/subscribers.ts'
import { getDb } from '../db/index.ts'
import { sequences } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { CampaignTabs, Flash, Layout, fmtDate, fmtMoney, statusPill } from './layout.tsx'

export const campaignsAdmin = new Hono<{ Bindings: Env }>()

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
  const [rows, seqs, allCampaigns] = await Promise.all([
    listForms(db),
    db.select().from(sequences).orderBy(asc(sequences.name)).all(),
    listCampaigns(db),
  ])

  return c.html(
    <Layout title="Forms" nav="camp">
      <div class="head">
        <div>
          <h1>Forms</h1>
          <div class="sub">A named POST endpoint. No embed script, no hosted landing page.</div>
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

      <div class="card">
        <div class="card-h">
          <h2>New form</h2>
        </div>
        <div class="card-b">
          <div class="note">
            <strong>Submitting is one request.</strong> The person is created or updated, tagged,
            credited to the campaign, and dropped into the sequence: all idempotent, so a
            double-click changes nothing the second time.
          </div>
          <FormFields seqs={seqs} allCampaigns={allCampaigns} tagNames="" action="/forms" />
        </div>
      </div>
    </Layout>,
  )
})

const FormFields = ({
  seqs,
  allCampaigns,
  action,
  form,
  tagNames,
}: {
  seqs: { id: number; name: string; isActive: boolean }[]
  allCampaigns: { id: number; name: string }[]
  action: string
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
}) => (
  <form method="post" action={action}>
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
  if (!input.name) return c.redirect('/forms?flash=A form needs a name.&kind=warn')

  const id = await createForm(db, {
    ...input,
    tagIds: await readTagIds(db, String(body.get('tags') ?? '')),
  })
  return c.redirect(`/forms/${id}?flash=Form created. Grab the snippet below.`)
})

campaignsAdmin.get('/forms/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await getForm(db, id)
  if (!form) return c.notFound()

  const [seqs, allCampaigns, theirTags] = await Promise.all([
    db.select().from(sequences).orderBy(asc(sequences.name)).all(),
    listCampaigns(db),
    formTagList(db, id),
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

  return c.html(
    <Layout title={form.name} nav="camp">
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
    <Layout title="Sales" nav="camp">
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
