import { count, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { tickSequences } from '../core/sequences.ts'
import { unsuppressAddress, suppressAddress } from '../core/consent.ts'
import { getDb } from '../db/index.ts'
import {
  broadcasts,
  devOutbox,
  messages,
  sequenceEnrollments,
  sequenceOptouts,
  sequences,
  subscribers,
  suppressions,
} from '../db/schema.ts'
import type { Env } from '../types.ts'
import { commerceTotals, listOffers } from '../core/purchases.ts'
import { customerTiers, headlines, revenueByMonth } from '../core/insights.ts'
import { signalTrend } from '../core/signal.ts'
import { SignalHero } from './admin-signal.tsx'
import { activeGoals } from '../core/goals.ts'
import { GoalBar } from './admin-goals.tsx'
import { StoreHeadline, TierCard, monthColumn } from './admin-store.tsx'
import { ColumnChart } from './charts.tsx'
import { Flash, Layout, fmtDate, fmtMoney, statusPill } from './layout.tsx'

export const admin = new Hono<{ Bindings: Env }>()

/** Preview links should open the real page in the top window, not inside the preview frame. */
const topTargeted = (html: string) =>
  /<head[^>]*>/i.test(html)
    ? html.replace(/<head([^>]*)>/i, '<head$1><base target="_top">')
    : `<base target="_top">${html}`

// ───────────────────────────────────────────────── dashboard

admin.get('/', async (c) => {
  const db = getDb(c.env)

  const [subs, active, unsub, seqCount, optouts, suppressed, sent, drafts] = await Promise.all([
    db.select({ n: count() }).from(subscribers).get(),
    db.select({ n: count() }).from(subscribers).where(eq(subscribers.status, 'active')).get(),
    db.select({ n: count() }).from(subscribers).where(eq(subscribers.status, 'unsubscribed')).get(),
    db.select({ n: count() }).from(sequences).where(eq(sequences.isActive, true)).get(),
    db.select({ n: count() }).from(sequenceOptouts).get(),
    db.select({ n: count() }).from(suppressions).get(),
    db.select({ n: count() }).from(messages).where(eq(messages.status, 'sent')).get(),
    db.select({ n: count() }).from(broadcasts).where(eq(broadcasts.status, 'draft')).get(),
  ])

  // The commerce half of the dashboard. Loaded alongside the operational counts
  // rather than on its own page: what the list is worth is the first question,
  // and how many messages went out is the second.
  const [totals, months, tiers, head, catalog, trend] = await Promise.all([
    commerceTotals(db),
    revenueByMonth(db, 12),
    customerTiers(db),
    headlines(db),
    listOffers(db),
    // The hero. Loaded first among equals: "was the last one any good?" is the
    // question this screen exists to answer, and everything else is context for it.
    signalTrend(db, 14),
  ])
  const liveOffers = catalog.filter((o) => o.active).length

  // ⭐ Goals sit under the money because they are the question the money can't
  // answer on its own: revenue says how much came in, a goal says whether that
  // was the number you were aiming at.
  const goals = await activeGoals(db, 4)

  const recent = await db
    .select({
      id: messages.id,
      toEmail: messages.toEmail,
      subject: messages.subject,
      kind: messages.kind,
      status: messages.status,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .orderBy(desc(messages.id))
    .limit(8)
    .all()

  return c.html(
    <Layout title="Dashboard" nav="home" charts>
      <div class="head">
        <div>
          <div class="eyebrow">Mission control</div>
          <h1>Dashboard</h1>
          <div class="sub">
            Provider: <span class="mono">{c.env.EMAIL_PROVIDER}</span>
            {c.env.EMAIL_PROVIDER === 'console' ? ', mail goes to the Outbox, not the internet' : ''}
          </div>
        </div>
        <div class="actions">
          <form method="post" action="/sequences/tick">
            <button class="btn">Run sequences now</button>
          </form>
          {c.env.DEV_AUTH_BYPASS === 'true' ? (
            (subs?.n ?? 0) === 0 ? (
              <form method="post" action="/dev/seed">
                <button class="btn primary">Seed demo data</button>
              </form>
            ) : (
              <>
                <form method="post" action="/dev/fast-forward">
                  <button class="btn" title="Pull every pending sequence step forward to now">
                    Fast-forward the clock
                  </button>
                </form>
                <form method="post" action="/dev/reset">
                  <button class="btn danger">Reset data</button>
                </form>
              </>
            )
          ) : null}
        </div>
      </div>

      <Flash msg={c.req.query('flash')} />

      {(subs?.n ?? 0) === 0 ? (
        <div class="note">
          <strong>Empty database.</strong> Hit <em>Seed demo data</em> above for twelve people, two
          live series, and a sent broadcast, then open the Outbox to read the mail.
        </div>
      ) : null}

      <SignalHero trend={trend} />

      <div class="card">
        <div class="card-b flush">
          <div class="stats">
            <div class="stat">
              <div class="n">{(subs?.n ?? 0).toLocaleString('en-US')}</div>
              <div class="l">Subscribers</div>
            </div>
            <div class="stat hi">
              <div class="n">{(active?.n ?? 0).toLocaleString('en-US')}</div>
              <div class="l">Active</div>
            </div>
            <div class="stat">
              <div class="n">{(seqCount?.n ?? 0).toLocaleString('en-US')}</div>
              <div class="l">Live series</div>
            </div>
            <div class="stat">
              <div class="n">{(sent?.n ?? 0).toLocaleString('en-US')}</div>
              <div class="l">Sent</div>
            </div>
            <div class="stat">
              <div class="n">{(drafts?.n ?? 0).toLocaleString('en-US')}</div>
              <div class="l">Drafts</div>
            </div>
          </div>
        </div>
      </div>

      {totals.orders > 0 ? (
        <>
          <StoreHeadline
            totals={totals}
            head={head}
            yearCents={months.reduce((n, m) => n + m.cents, 0)}
            yearOrders={months.reduce((n, m) => n + m.orders, 0)}
            liveCount={liveOffers}
            catalogCount={catalog.length}
            trend={months.map((m) => m.cents)}
          />

          <TierCard
            tiers={tiers}
            listSize={tiers.reduce((n, t) => n + t.people, 0)}
            customers={tiers.reduce((n, t) => n + (t.key === 'none' ? 0 : t.people), 0)}
          />
        </>
      ) : (
        <div class="note">
          <strong>No storefront data yet.</strong> Run{' '}
          <span class="mono">bun scripts/import-neon-purchases.ts</span> to mirror the store, and
          this dashboard fills in.
        </div>
      )}

      {/* ⭐ Goals — directly under the money, because they are what the money is
          being measured against. A conversion is an event; this is the target. */}
      <div class="card">
        <div class="card-h">
          <h2>Goals</h2>
          <div class="actions">
            <a class="btn sm" href="/goals">
              {goals.length ? 'All goals' : 'Set one'}
            </a>
          </div>
        </div>
        <div class="card-b">
          {goals.length === 0 ? (
            <div class="empty">
              <p>No goals set.</p>
              <p class="faint">
                A goal is a target over a named period — "30 yearly subscriptions in Q3". Set one
                and this fills in as conversions land.
              </p>
            </div>
          ) : (
            goals.map((g) => <GoalBar g={g} />)
          )}
        </div>
      </div>

      <div class="bento">
        {totals.orders > 0 ? (
          <div class="card col-7">
            <div class="card-h">
              <h2>Revenue, last 12 months</h2>
              <div class="actions">
                <a class="btn sm" href="/store">
                  The whole store
                  <span class="chip" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M6 18 18 6M9 6h9v9" />
                    </svg>
                  </span>
                </a>
              </div>
            </div>
            <div class="card-b">
              <ColumnChart data={months.map(monthColumn)} height={300} />
              <div class="faint" style="font-size:12px;margin-top:10px;text-align:right">
                The last column is the current month so far, not a finished one.
              </div>
            </div>
          </div>
        ) : null}

        <div class={totals.orders > 0 ? 'card col-5' : 'card col-12'}>
          <div class="card-h">
            <h2>Consent, by scope</h2>
            <div class="actions">
              <a class="btn sm" href="/consent">
                Details
              </a>
            </div>
          </div>
          <div class="card-b">
            <div class="note">
              <strong>The whole point.</strong> {optouts?.n ?? 0} people left an individual series
              and are <em>still on the list</em>. Only {suppressed?.n ?? 0} asked to be removed
              from everything. On Kit those two numbers would be the same.
            </div>
            <div class="stats" style="padding:0">
              <div class="stat hi">
                <div class="n">{(optouts?.n ?? 0).toLocaleString('en-US')}</div>
                <div class="l">Left one series</div>
              </div>
              <div class="stat">
                <div class="n">{(unsub?.n ?? 0).toLocaleString('en-US')}</div>
                <div class="l">Off newsletter</div>
              </div>
              <div class="stat">
                <div class="n">{(suppressed?.n ?? 0).toLocaleString('en-US')}</div>
                <div class="l">Gone entirely</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Recent messages</h2>
          <div class="actions">
            <a class="btn sm" href="/outbox">
              Open Outbox
            </a>
          </div>
        </div>
        <div class="card-b flush">
          {recent.length === 0 ? (
            <div class="empty">
              <p>Nothing sent yet.</p>
              <p class="faint">Send a broadcast or run the sequences to see mail here.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>To</th>
                  <th>Subject</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((m) => (
                  <tr>
                    <td class="mono">{m.toEmail}</td>
                    <td>{m.subject}</td>
                    <td>
                      <span class="pill">{m.kind}</span>
                    </td>
                    <td>{statusPill(m.status)}</td>
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

// ───────────────────────────────────────────────── outbox

admin.get('/outbox', async (c) => {
  const db = getDb(c.env)
  const items = await db.select().from(devOutbox).orderBy(desc(devOutbox.id)).limit(50).all()
  const selectedId = Number(c.req.query('id') ?? items[0]?.id ?? 0)
  const selected = items.find((i) => i.id === selectedId) ?? items[0]

  return c.html(
    <Layout title="Outbox" nav="out">
      <div class="head">
        <div>
          <h1>Outbox</h1>
          <div class="sub">
            Everything the <span class="mono">console</span> provider "sent". Nothing left your
            machine.
          </div>
        </div>
        <div class="actions">
          <form method="post" action="/outbox/clear">
            <button class="btn danger">Clear</button>
          </form>
        </div>
      </div>

      {items.length === 0 ? (
        <div class="card">
          <div class="empty">
            <p>The outbox is empty.</p>
            <p class="faint">Send a broadcast or run the sequences.</p>
          </div>
        </div>
      ) : (
        <div class="row" style="align-items:flex-start">
          <div class="card" style="flex:0 0 300px;min-width:280px">
            <div class="card-h">
              <h2>{items.length} messages</h2>
            </div>
            <div class="card-b flush">
              <table>
                <tbody>
                  {items.map((i) => (
                    <tr class={i.id === selected?.id ? 'sel' : ''}>
                      <td>
                        <a href={`/outbox?id=${i.id}`}>
                          <div style="font-weight:500">{i.subject}</div>
                          <div class="faint mono">{i.toEmail}</div>
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {selected ? (
            <div style="flex:1;min-width:340px">
              <div class="mailview">
                <div class="mailhead">
                  <div>
                    <b>To</b> <span class="mono">{selected.toEmail}</span>
                  </div>
                  <div>
                    <b>From</b> <span class="mono">{selected.fromEmail}</span>
                  </div>
                  <div>
                    <b>Subject</b> <strong>{selected.subject}</strong>
                  </div>
                </div>
                {/* Clicking a link in the preview (e.g. unsubscribe) lands on a real page with a
                    form — a bare sandbox="" would block that POST. No allow-scripts: still inert. */}
                <iframe
                  srcdoc={topTargeted(selected.html)}
                  title="Email preview"
                  sandbox="allow-forms allow-top-navigation-by-user-activation"
                />
              </div>
              <p class="faint" style="margin-top:10px">
                Scroll to the footer: the unsubscribe link is scoped to whatever this message was
                sent under.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Layout>,
  )
})

admin.post('/outbox/clear', async (c) => {
  const db = getDb(c.env)
  await db.delete(devOutbox)
  return c.redirect('/outbox')
})

// ───────────────────────────────────────────────── consent

admin.get('/consent', async (c) => {
  const db = getDb(c.env)

  const optouts = await db
    .select({
      email: subscribers.email,
      name: subscribers.name,
      sequenceName: sequences.name,
      at: sequenceOptouts.optedOutAt,
      status: subscribers.status,
    })
    .from(sequenceOptouts)
    .innerJoin(subscribers, eq(subscribers.id, sequenceOptouts.subscriberId))
    .innerJoin(sequences, eq(sequences.id, sequenceOptouts.sequenceId))
    .orderBy(desc(sequenceOptouts.optedOutAt))
    .limit(100)
    .all()

  const sups = await db
    .select()
    .from(suppressions)
    .orderBy(desc(suppressions.createdAt))
    .limit(100)
    .all()

  return c.html(
    <Layout title="Consent" nav="cons">
      <div class="head">
        <div>
          <h1>Consent</h1>
          <div class="sub">Three scopes. A narrow choice never escalates to a wide one.</div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} />

      <div class="card">
        <div class="card-h">
          <h2>Left a single series</h2>
          <span class="pill ok">still subscribed</span>
        </div>
        <div class="card-b flush">
          {optouts.length === 0 ? (
            <div class="empty">
              <p>Nobody has left an individual series yet.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Left</th>
                  <th>Still on the list?</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {optouts.map((o) => (
                  <tr>
                    <td>
                      <div>{o.name ?? '-'}</div>
                      <div class="faint mono">{o.email}</div>
                    </td>
                    <td>{o.sequenceName}</td>
                    <td>{statusPill(o.status)}</td>
                    <td class="faint">{fmtDate(o.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Suppressed: off everything</h2>
          <div class="actions">
            <form method="post" action="/consent/suppress" class="row" style="gap:6px">
              <input type="email" name="email" placeholder="address" required style="min-width:0" />
              <button class="btn sm">Suppress</button>
            </form>
          </div>
        </div>
        <div class="card-b flush">
          {sups.length === 0 ? (
            <div class="empty">
              <p>Nobody is globally suppressed.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Reason</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sups.map((s) => (
                  <tr>
                    <td class="mono">{s.email}</td>
                    <td>
                      <span class="pill bad">{s.reason}</span>
                    </td>
                    <td class="faint">{fmtDate(s.createdAt)}</td>
                    <td style="text-align:right">
                      <form method="post" action="/consent/unsuppress">
                        <input type="hidden" name="email" value={s.email} />
                        <button class="btn sm">Remove</button>
                      </form>
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

admin.post('/consent/suppress', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const email = String(form.get('email') ?? '')
  if (email) await suppressAddress(db, email, 'manual')
  return c.redirect('/consent?flash=Suppressed.')
})

admin.post('/consent/unsuppress', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  await unsuppressAddress(db, String(form.get('email') ?? ''))
  return c.redirect('/consent?flash=Suppression removed.')
})

// ───────────────────────────────────────────────── sequences tick

admin.post('/sequences/tick', async (c) => {
  const db = getDb(c.env)
  const n = await tickSequences(c.env, db)
  return c.redirect(`/?flash=${encodeURIComponent(`Sequence tick sent ${n} message(s).`)}`)
})

// ───────────────────────────────────────────────── settings

admin.get('/settings', async (c) => {
  const db = getDb(c.env)
  const counts = await db
    .select({ table: sql<string>`'messages'`, n: count() })
    .from(messages)
    .get()

  return c.html(
    <Layout title="Settings" nav="set">
      <div class="head">
        <div>
          <h1>Settings</h1>
          <div class="sub">Local development configuration.</div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Sending</h2>
        </div>
        <div class="card-b">
          <div class="note">
            <strong>Provider: {c.env.EMAIL_PROVIDER}.</strong>{' '}
            {c.env.EMAIL_PROVIDER === 'console'
              ? 'Mail is written to the Outbox and never sent. To send for real, set EMAIL_PROVIDER=resend and RESEND_API_KEY in .dev.vars.'
              : 'Live sending is enabled.'}
          </div>
          <table>
            <tbody>
              <tr>
                <td class="muted">From</td>
                <td class="mono">
                  {c.env.FROM_NAME} &lt;{c.env.FROM_EMAIL}&gt;
                </td>
              </tr>
              <tr>
                <td class="muted">Public URL</td>
                <td class="mono">{c.env.PUBLIC_URL}</td>
              </tr>
              <tr>
                <td class="muted">Queue</td>
                <td class="mono">{c.env.SEND_QUEUE ? 'bound' : 'not bound, sending inline'}</td>
              </tr>
              <tr>
                <td class="muted">Auth</td>
                <td class="mono">
                  {c.env.DEV_AUTH_BYPASS === 'true'
                    ? 'DEV BYPASS (local only)'
                    : 'Cloudflare Access'}
                </td>
              </tr>
              <tr>
                <td class="muted">Messages recorded</td>
                <td class="mono">{counts?.n ?? 0}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Transactional API</h2>
        </div>
        <div class="card-b">
          <p class="muted">
            Your other apps post here. Suppression is enforced, and every send is recorded.
          </p>
          <pre class="mono code">
{`curl -X POST ${c.env.PUBLIC_URL}/api/send \\
  -H 'Authorization: Bearer <key>' \\
  -H 'Content-Type: application/json' \\
  -d '{"to":"someone@example.com",
       "subject":"Your download",
       "body":"Here you go: [link](https://example.com)",
       "idempotency_key":"order-1234"}'`}
          </pre>
          <p class="faint">
            Create a key with <span class="mono">bun run seed</span> output, or via the API keys
            table. ⚠️ TODO: key management UI.
          </p>
        </div>
      </div>
    </Layout>,
  )
})
