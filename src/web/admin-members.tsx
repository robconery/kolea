import { Hono } from 'hono'
import { listMembers, membersEnabled } from '../core/members.ts'
import { billingConfigured } from '../core/premium-billing.ts'
import {
  convertingPosts,
  getPremiumSettings,
  paidTwice,
  premiumPriceOptions,
  premiumTotals,
  savePremiumSettings,
} from '../core/premium.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate, fmtMoney } from './layout.tsx'

export const membersAdmin = new Hono<{ Bindings: Env }>()

/**
 * Members and Premium: who has signed in on the site, who pays, and which post
 * converted them. Read-mostly — Premium state is written by the Stripe webhook,
 * never from here. The one setting is which two synced Stripe prices are on
 * sale.
 */

const STATUS_LABEL = { active: 'Premium', past_due: 'Past due', canceled: 'Canceled' } as const

membersAdmin.get('/members', async (c) => {
  const db = getDb(c.env)
  const [members, totals, twice, posts, settings, monthly, yearly] = await Promise.all([
    listMembers(db),
    premiumTotals(db),
    paidTwice(db),
    convertingPosts(db),
    getPremiumSettings(db),
    premiumPriceOptions(db, 'month'),
    premiumPriceOptions(db, 'year'),
  ])
  const enabled = membersEnabled(c.env)
  const canBill = billingConfigured(c.env)

  const priceSelect = (name: string, current: string | null | undefined, options: typeof monthly) => (
    <select name={name}>
      <option value="">Not on sale</option>
      {options.map((p) => (
        <option value={p.id} selected={p.id === current}>
          {p.nickname ? `${p.nickname} · ` : ''}
          {p.unitAmount === null ? 'tiered' : fmtMoney(p.unitAmount, p.currency)} · {p.id}
        </option>
      ))}
      {current && !options.some((p) => p.id === current) ? (
        <option value={current} selected>
          {current} (no longer in the catalog)
        </option>
      ) : null}
    </select>
  )

  return c.html(
    <Layout title="Members" nav="members">
      <div class="head">
        <div>
          <h1>Members</h1>
          <div class="sub">Readers who sign in on the site, who pays for Premium, and the post that converted them.</div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      {!enabled ? (
        <div class="flash warn">
          Signing in is off: set <span class="mono">SITE_URL</span> and the{' '}
          <span class="mono">MEMBER_SESSION_SECRET</span> secret. Until then members-only and Premium posts show their
          teaser to everyone.
        </div>
      ) : null}

      <div class="stats">
        <div class="stat hi">
          <div class="n">{totals.active.toLocaleString('en-US')}</div>
          <div class="l">Premium now</div>
          <div class="h">
            {totals.monthly} monthly · {totals.yearly} yearly
          </div>
        </div>
        <div class="stat">
          <div class="n">{totals.pastDue.toLocaleString('en-US')}</div>
          <div class="l">Past due</div>
          <div class="h">payment failing, access paused</div>
        </div>
        <div class="stat">
          <div class="n">{totals.canceled.toLocaleString('en-US')}</div>
          <div class="l">Canceled</div>
          <div class="h">ever</div>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>Premium prices</h2>
        </div>
        <div class="card-b">
          {!canBill ? (
            <p class="faint" style="margin-top:0">
              Checkout needs <span class="mono">STRIPE_SECRET_KEY</span> with permission to create Checkout Sessions.
            </p>
          ) : null}
          <form method="post" action="/members/prices" class="stack">
            <label>
              <span>Monthly</span>
              {priceSelect('monthly', settings?.monthlyPriceId, monthly)}
            </label>
            <label>
              <span>Yearly</span>
              {priceSelect('yearly', settings?.yearlyPriceId, yearly)}
            </label>
            <p class="faint" style="margin:-4px 0 4px;font-size:12.5px">
              Recurring prices from the synced Stripe catalog. Create them in Stripe, sync the catalog, then pick them
              here. Changing a price leaves existing subscribers on theirs.
            </p>
            <div>
              <button class="btn primary">Save prices</button>
            </div>
          </form>
        </div>
      </div>

      {posts.length ? (
        <div class="card" style="margin-top:18px">
          <div class="card-h">
            <h2>Posts that converted</h2>
          </div>
          <div class="card-b flush">
            <table>
              <thead>
                <tr>
                  <th>Post</th>
                  <th class="num">Premium signups</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr>
                    <td>
                      <a href={`/broadcasts/${p.postId}`}>{p.subject}</a>
                    </td>
                    <td class="num">{p.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {twice.length ? (
        <div class="card" style="margin-top:18px">
          <div class="card-h">
            <h2>Paid twice</h2>
          </div>
          <div class="card-b flush">
            <p class="faint" style="padding:0 16px">
              These people completed a second Checkout while already Premium. The second subscription was not
              recorded; cancel and refund it in Stripe.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Stripe subscription</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {twice.map((t) => (
                  <tr>
                    <td>{t.email ?? t.stripeCustomerId ?? '-'}</td>
                    <td class="mono">{t.stripeSubscriptionId}</td>
                    <td class="faint">{fmtDate(t.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>{members.length} members</h2>
        </div>
        <div class="card-b flush">
          {members.length === 0 ? (
            <div class="empty">
              <p>Nobody has signed in yet.</p>
              <p class="faint">A member is a subscriber who signed in on the site, or who paid for Premium.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Premium</th>
                  <th>Converted by</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr>
                    <td>
                      <a href={`/subscribers/${m.subscriberId}`} style="font-weight:500">
                        {m.name || m.email}
                      </a>
                      <div class="faint mono">
                        {m.name ? `${m.email} · ` : ''}newsletter: {m.status}
                      </div>
                    </td>
                    <td>
                      {m.premium ? (
                        <>
                          <span class="pill">{STATUS_LABEL[m.premium.status]}</span>{' '}
                          <span class="faint">
                            {fmtMoney(m.premium.amountCents, m.premium.currency)}/{m.premium.interval}
                            {m.premium.cancelAtPeriodEnd ? ' · ends this period' : ''}
                          </span>
                        </>
                      ) : (
                        <span class="faint">Free</span>
                      )}
                    </td>
                    <td>
                      {m.premium?.postId ? (
                        <a href={`/broadcasts/${m.premium.postId}`}>{m.premium.postSubject ?? `#${m.premium.postId}`}</a>
                      ) : (
                        <span class="faint">{m.premium ? 'the Premium page' : '-'}</span>
                      )}
                    </td>
                    <td class="faint">{fmtDate(m.lastSeenAt)}</td>
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

membersAdmin.post('/members/prices', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const result = await savePremiumSettings(db, {
    monthlyPriceId: String(form.get('monthly') ?? '').trim() || null,
    yearlyPriceId: String(form.get('yearly') ?? '').trim() || null,
  })
  const msg = result.ok ? 'Premium prices saved.' : result.reason
  return c.redirect(`/members?flash=${encodeURIComponent(msg)}${result.ok ? '' : '&kind=warn'}`, 303)
})
