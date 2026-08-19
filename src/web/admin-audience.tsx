import { type SQL, and, asc, desc, eq, inArray, like, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { touchesFor } from '../core/campaigns.ts'
import { preferencesFor } from '../core/consent.ts'
import { salesForSubscriber } from '../core/sales.ts'
import { addTags, findOrCreateTag, importCsv, removeTag, upsertSubscriber } from '../core/subscribers.ts'
import { getDb } from '../db/index.ts'
import { messages, subscriberTags, subscribers, tags } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { AudienceTabs, Flash, Layout, fmtDate, fmtMoney, statusPill } from './layout.tsx'

export const audience = new Hono<{ Bindings: Env }>()

/** The current filter, rebuilt from scratch — so a redirect can't stack flashes. */
function backQuery(q: string, tagId: number): string {
  const qs = new URLSearchParams()
  if (q) qs.set('q', q)
  if (tagId) qs.set('tag', String(tagId))
  const s = qs.toString()
  return s ? `?${s}` : ''
}

audience.get('/subscribers', async (c) => {
  const db = getDb(c.env)
  const q = (c.req.query('q') ?? '').trim()
  const tagId = Number(c.req.query('tag') ?? 0)

  const filters: SQL[] = []
  if (q) filters.push(or(like(subscribers.email, `%${q}%`), like(subscribers.name, `%${q}%`))!)
  if (tagId) {
    filters.push(
      inArray(
        subscribers.id,
        db
          .select({ id: subscriberTags.subscriberId })
          .from(subscriberTags)
          .where(eq(subscriberTags.tagId, tagId)),
      ),
    )
  }

  const [rows, allTags] = await Promise.all([
    db
      .select()
      .from(subscribers)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(subscribers.id))
      .limit(200)
      .all(),
    db.select().from(tags).orderBy(asc(tags.name)).all(),
  ])

  return c.html(
    <Layout title="Subscribers" nav="subs">
      <div class="head">
        <div>
          <h1>Subscribers</h1>
          <div class="sub">
            {rows.length} shown{rows.length === 200 ? ' (first 200)' : ''}
          </div>
        </div>
        <div class="actions">
          <form method="get" action="/subscribers" class="row" style="gap:6px">
            <input type="text" name="q" placeholder="Search…" value={q} style="min-width:0" />
            <select name="tag" style="min-width:0">
              <option value="">Any tag</option>
              {allTags.map((t) => (
                <option value={String(t.id)} selected={t.id === tagId}>
                  {t.name}
                </option>
              ))}
            </select>
            <button class="btn" style="flex:0 0 auto;min-width:0">
              Filter
            </button>
          </form>
          <a class="btn" href="/subscribers/import">
            Import CSV
          </a>
          <a class="btn primary" href="/subscribers/new">
            Add
          </a>
        </div>
      </div>

      <AudienceTabs on="people" />
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b flush">
          {rows.length === 0 ? (
            <div class="empty">
              <p>{q || tagId ? 'Nobody matches that.' : 'No subscribers yet.'}</p>
              <p class="faint">
                {q || tagId ? (
                  <a href="/subscribers">Clear the filter</a>
                ) : (
                  'Run `bun run seed` or import a CSV.'
                )}
              </p>
            </div>
          ) : (
            /* One form around the table: tick people, then act on them at the bottom. */
            <form method="post" action="/subscribers/bulk-tag">
              <input type="hidden" name="back" value={backQuery(q, tagId)} />
              <table>
                <thead>
                  <tr>
                    <th class="tick" />
                    <th>Person</th>
                    <th>Status</th>
                    <th>Source</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr>
                      <td class="tick">
                        <input type="checkbox" name="sub" value={String(s.id)} />
                      </td>
                      <td>
                        <a href={`/subscribers/${s.id}`}>
                          <div style="font-weight:500">{s.name ?? s.email}</div>
                          {s.name ? <div class="faint mono">{s.email}</div> : null}
                        </a>
                      </td>
                      <td>{statusPill(s.status)}</td>
                      <td class="faint">{s.source ?? '—'}</td>
                      <td class="faint">{fmtDate(s.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div
                class="row"
                style="gap:8px;padding:14px 18px;border-top:1px solid var(--line-2);align-items:center"
              >
                <span class="faint" style="flex:0 0 auto">
                  With the ticked people:
                </span>
                <input
                  type="text"
                  name="tag"
                  list="bulktags"
                  placeholder="tag name"
                  style="flex:0 1 220px;min-width:0"
                />
                <datalist id="bulktags">
                  {allTags.map((t) => (
                    <option value={t.name} />
                  ))}
                </datalist>
                <span style="flex:0 0 auto">
                  <button class="btn" name="op" value="add">
                    Tag
                  </button>{' '}
                  <button class="btn" name="op" value="remove">
                    Untag
                  </button>
                </span>
              </div>
            </form>
          )}
        </div>
      </div>
    </Layout>,
  )
})

audience.post('/subscribers/bulk-tag', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const ids = form.getAll('sub').map(Number).filter(Boolean)
  const name = String(form.get('tag') ?? '').trim()
  const remove = form.get('op') === 'remove'
  const back = `/subscribers${String(form.get('back') ?? '')}`
  const sep = back.includes('?') ? '&' : '?'

  if (!ids.length || !name) {
    return c.redirect(`${back}${sep}flash=Tick some people and name a tag.&kind=warn`)
  }

  const tagId = await findOrCreateTag(db, name)
  for (const id of ids) {
    if (remove) await removeTag(db, id, tagId)
    else await addTags(db, id, [tagId])
  }

  const verb = remove ? 'Untagged' : 'Tagged'
  const who = `${ids.length} ${ids.length === 1 ? 'person' : 'people'}`
  return c.redirect(`${back}${sep}flash=${encodeURIComponent(`${verb} ${who}.`)}`)
})

audience.get('/subscribers/new', (c) =>
  c.html(
    <Layout title="Add subscriber" nav="subs">
      <div class="head">
        <h1>Add subscriber</h1>
      </div>
      <div class="card">
        <div class="card-b">
          <form method="post" action="/subscribers">
            <div class="row">
              <div class="field">
                <label>Email</label>
                <input type="email" name="email" required />
              </div>
              <div class="field">
                <label>Name</label>
                <input type="text" name="name" />
              </div>
            </div>
            <div class="field">
              <label>Tags (comma separated)</label>
              <input type="text" name="tags" placeholder="customer, ruby" />
            </div>
            <button class="btn primary">Add subscriber</button>
          </form>
        </div>
      </div>
    </Layout>,
  ),
)

audience.post('/subscribers', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const tagNames = String(form.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  const tagIds: number[] = []
  for (const t of tagNames) tagIds.push(await findOrCreateTag(db, t))

  const { outcome } = await upsertSubscriber(db, {
    email: String(form.get('email') ?? ''),
    name: (String(form.get('name') ?? '') || null) as string | null,
    source: 'manual',
    tagIds,
  })

  if (outcome === 'invalid') return c.redirect('/subscribers?flash=That email looked invalid.')
  return c.redirect(`/subscribers?flash=Subscriber ${outcome}.`)
})

audience.get('/subscribers/import', (c) =>
  c.html(
    <Layout title="Import" nav="subs">
      <div class="head">
        <h1>Import CSV</h1>
      </div>
      <div class="card">
        <div class="card-b">
          <div class="note">
            Needs a header row with <span class="mono">email</span>. Optional:{' '}
            <span class="mono">name</span>, <span class="mono">tags</span> (semicolon separated).
            Existing people are updated, never duplicated — and an unsubscribe is never undone.
          </div>
          <form method="post" action="/subscribers/import">
            <div class="field">
              <label>CSV</label>
              <textarea name="csv" placeholder="email,name,tags&#10;rob@example.com,Rob,customer;ruby" />
            </div>
            <button class="btn primary">Import</button>
          </form>
        </div>
      </div>
    </Layout>,
  ),
)

audience.post('/subscribers/import', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const report = await importCsv(db, String(form.get('csv') ?? ''))
  const msg = `Imported: ${report.created} created, ${report.updated} updated, ${report.invalid} invalid (${report.rows} rows).`
  return c.redirect(`/subscribers?flash=${encodeURIComponent(msg)}`)
})

audience.get('/subscribers/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const sub = await db.select().from(subscribers).where(eq(subscribers.id, id)).get()
  if (!sub) return c.notFound()

  const prefs = await preferencesFor(db, id)
  const theirTags = await db
    .select({ id: tags.id, name: tags.name })
    .from(subscriberTags)
    .innerJoin(tags, eq(tags.id, subscriberTags.tagId))
    .where(eq(subscriberTags.subscriberId, id))
    .all()

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.subscriberId, id))
    .orderBy(desc(messages.id))
    .limit(20)
    .all()

  const [touches, purchases] = await Promise.all([
    touchesFor(db, id),
    salesForSubscriber(db, id),
  ])

  // Net of refunds, per currency — the same arithmetic the campaign pages use:
  // a refunded row stops counting rather than subtracting.
  const spend = new Map<string, number>()
  for (const { sale } of purchases) {
    if (sale.status === 'refunded') continue
    spend.set(sale.currency, (spend.get(sale.currency) ?? 0) + sale.amountCents)
  }

  return c.html(
    <Layout title={sub.email} nav="subs">
      <div class="head">
        <div>
          <h1>{sub.name ?? sub.email}</h1>
          <div class="sub mono">{sub.email}</div>
        </div>
        <div class="actions">
          {statusPill(sub.status)}
          <a class="btn" href={`/p/${sub.unsubToken}`} target="_blank" rel="noreferrer">
            Open their preference center ↗
          </a>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} />

      <div class="card">
        <div class="card-h">
          <h2>What they've consented to</h2>
        </div>
        <div class="card-b">
          <div class="note">
            Newsletter and each series are tracked separately. Leaving one never touches the others.
          </div>
          <table>
            <tbody>
              <tr>
                <td style="font-weight:500">The newsletter</td>
                <td style="text-align:right">
                  {sub.status === 'unsubscribed' ? (
                    <span class="pill">unsubscribed</span>
                  ) : (
                    <span class="pill ok">subscribed</span>
                  )}
                </td>
              </tr>
              {prefs.map((p) => (
                <tr>
                  <td>
                    <div style="font-weight:500">{p.name}</div>
                    <div class="faint">{p.description}</div>
                  </td>
                  <td style="text-align:right">
                    {p.optedOut ? (
                      <span class="pill warn">left this series</span>
                    ) : p.enrolled ? (
                      <span class="pill ok">receiving</span>
                    ) : (
                      <span class="pill">finished</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Tags</h2>
          <div class="actions">
            <form method="post" action={`/subscribers/${id}/tags`} class="row" style="gap:6px">
              <input type="text" name="tag" placeholder="add tag" style="min-width:0" />
              <button class="btn sm">Add</button>
            </form>
          </div>
        </div>
        <div class="card-b">
          {theirTags.length === 0 ? (
            <span class="faint">No tags.</span>
          ) : (
            theirTags.map((t) => (
              <form method="post" action={`/subscribers/${id}/tags/remove`} style="display:inline">
                <input type="hidden" name="tagId" value={String(t.id)} />
                <button class="pill" style="border:0;cursor:pointer;margin-right:6px">
                  {t.name} ✕
                </button>
              </form>
            ))
          )}
        </div>
      </div>

      {touches.length > 0 || purchases.length > 0 ? (
        <div class="card">
          <div class="card-h">
            <h2>Where they came from, and what they bought</h2>
            {spend.size > 0 ? (
              <span class="pill ok">
                {[...spend].map(([cur, cents]) => fmtMoney(cents, cur)).join(' · ')} lifetime
              </span>
            ) : null}
          </div>
          <div class="card-b">
            {touches.length === 0 ? (
              <p class="faint">No campaign has touched this person.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Via</th>
                    <th>When</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {touches.map((t, i) => (
                    <tr>
                      <td>
                        <a href={`/campaigns/${t.campaignId}`}>{t.campaignName}</a>
                      </td>
                      <td>
                        <span class="pill">{t.sourceKind}</span>
                      </td>
                      <td class="faint">{fmtDate(t.occurredAt)}</td>
                      <td style="text-align:right">
                        {/* Both ends of the ledger, named — because "which campaign
                            gets the credit" is a question with two right answers. */}
                        {i === 0 ? <span class="pill">first touch</span> : null}
                        {i === touches.length - 1 && touches.length > 1 ? (
                          <span class="pill ok">last touch</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {purchases.length > 0 ? (
              <table style="margin-top:18px">
                <thead>
                  <tr>
                    <th>Bought</th>
                    <th>Credited to</th>
                    <th class="num">Amount</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map(({ sale, campaignName }) => (
                    <tr style={sale.status === 'refunded' ? 'opacity:.55' : ''}>
                      <td>{sale.product ?? '—'}</td>
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
            ) : null}
          </div>
        </div>
      ) : null}

      <div class="card">
        <div class="card-h">
          <h2>Message history</h2>
        </div>
        <div class="card-b flush">
          {history.length === 0 ? (
            <div class="empty">
              <p>No messages yet.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {history.map((m) => (
                  <tr>
                    <td>{m.subject}</td>
                    <td>
                      <span class="pill">{m.kind}</span>
                    </td>
                    <td>
                      {statusPill(m.status)}
                      {m.suppressedReason ? (
                        <span class="faint"> {m.suppressedReason}</span>
                      ) : null}
                    </td>
                    <td class="faint">{fmtDate(m.createdAt)}</td>
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

audience.post('/subscribers/:id/tags', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const name = String(form.get('tag') ?? '').trim()
  if (name) await addTags(db, id, [await findOrCreateTag(db, name)])
  return c.redirect(`/subscribers/${id}?flash=Tag added.`)
})

audience.post('/subscribers/:id/tags/remove', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  await removeTag(db, id, Number(form.get('tagId')))
  return c.redirect(`/subscribers/${id}?flash=Tag removed.`)
})
