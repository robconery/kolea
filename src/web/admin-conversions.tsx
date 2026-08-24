import { Hono } from 'hono'
import { listCampaigns } from '../core/campaigns.ts'
import {
  conversionTotals,
  deleteConversion,
  editConversion,
  getConversion,
  listConversions,
  listKinds,
  offerOptions,
  unconvertedSales,
} from '../core/conversions.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate, fmtMoney } from './layout.tsx'

export const conversionsAdmin = new Hono<{ Bindings: Env }>()

/**
 * ⭐ The bottom of the funnel, and the only screen where it can be corrected.
 *
 * Everything here is written automatically by the Stripe webhook. This exists
 * because last-touch attribution is a guess: it credits the most recent click
 * inside a window, and sometimes Rob knows better — that sale came from the
 * sequence, not the newsletter that happened to go out on Tuesday.
 *
 * Any edit stamps `attributed_by: 'explicit'`, which every automatic pass treats
 * as final. A correction made here survives the next backfill.
 */

/** "3 days" / "4 hours" / "12 min" — how stale the click was when the money landed. */
function lag(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} hr`
  return `${Math.round(seconds / 86_400)} d`
}

function kindPill(slug: string, label: string | null) {
  return <span class="pill">{label ?? slug}</span>
}

/** Where the credit went, written as a sentence rather than three columns of ids. */
function pathOf(row: {
  sourceKind: string
  sourceId: number
  campaignName: string | null
  attributedBy: string
}) {
  if (row.attributedBy === 'explicit' && row.sourceKind === 'direct') {
    return <span>Set by hand</span>
  }
  if (row.sourceKind === 'direct') {
    return <span class="faint">Direct — no click in window</span>
  }
  const where =
    row.sourceKind === 'broadcast' ? (
      <a href={`/broadcasts/${row.sourceId}`}>broadcast #{row.sourceId}</a>
    ) : (
      <a href={`/sequences/${row.sourceId}`}>sequence #{row.sourceId}</a>
    )
  return (
    <span>
      Clicked {where}
      {row.campaignName ? <span class="faint"> · {row.campaignName}</span> : null}
    </span>
  )
}

// ───────────────────────────────────────────────── list

conversionsAdmin.get('/conversions', async (c) => {
  const db = getDb(c.env)
  const [rows, totals, pending] = await Promise.all([
    listConversions(db, 200),
    conversionTotals(db),
    unconvertedSales(db, 1),
  ])

  // One tile per kind — the set is data now, so the page cannot hardcode two.
  const allCents = totals.reduce((a, t) => a + t.cents, 0)
  const allCount = totals.reduce((a, t) => a + t.n, 0)

  return c.html(
    <Layout title="Conversions" nav="conv">
      <div class="head">
        <div>
          <h1>Conversions</h1>
          <div class="sub">
            The bottom of the funnel — who clicked, and then actually bought.
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="stats">
        {totals.map((t) => (
          <div class="stat">
            <div class="n">{t.n.toLocaleString('en-US')}</div>
            <div class="l">{t.label ?? t.kindSlug}</div>
            <div class="h">{fmtMoney(t.cents)}</div>
          </div>
        ))}
        <div class="stat hi">
          <div class="n">{fmtMoney(allCents)}</div>
          <div class="l">Total converted</div>
          <div class="h">{allCount.toLocaleString('en-US')} conversions</div>
        </div>
      </div>

      {pending.length > 0 ? (
        <div class="card" style="margin-top:18px">
          <div class="card-b">
            <p style="margin:0">
              Some paid sales have no conversion row yet. Run{' '}
              <span class="mono">bun scripts/backfill-conversions.ts --remote --dry-run</span> to
              see what would be created.
            </p>
          </div>
        </div>
      ) : null}

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>{rows.length} conversions</h2>
        </div>
        <div class="card-b flush">
          {rows.length === 0 ? (
            <div class="empty">
              <p>Nothing has converted yet.</p>
              <p class="faint">
                A conversion is written automatically when a Stripe sale lands. Only accounts whose
                webhooks point at this worker will show up here.
              </p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>What</th>
                  <th>Came from</th>
                  <th class="num">Lag</th>
                  <th class="num">Value</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr>
                    <td>
                      <a href={`/subscribers/${row.subscriberId}`} style="font-weight:500">
                        {row.name || row.email}
                      </a>
                      {row.name ? <div class="faint mono">{row.email}</div> : null}
                    </td>
                    <td>
                      {kindPill(row.kindSlug, row.kindLabel)}
                      <div class="faint mono">{row.offerSlug ?? 'no offer — membership'}</div>
                    </td>
                    <td>{pathOf(row)}</td>
                    <td class="num faint">{lag(row.touchLagSeconds)}</td>
                    <td class="num">{fmtMoney(row.valueCents, row.currency)}</td>
                    <td class="faint">{fmtDate(row.occurredAt)}</td>
                    <td style="text-align:right">
                      <a class="btn sm" href={`/conversions/${row.id}`}>
                        Edit
                      </a>
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

// ───────────────────────────────────────────────── editor

conversionsAdmin.get('/conversions/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const row = await getConversion(db, id)
  if (!row) return c.notFound()

  const [allCampaigns, allOffers, allKinds] = await Promise.all([
    listCampaigns(db),
    offerOptions(db),
    listKinds(db, true),
  ])

  return c.html(
    <Layout title="Edit conversion" nav="conv">
      <div class="head">
        <div>
          <div class="eyebrow">
            <a href="/conversions">Conversions</a>
          </div>
          <h1>Conversion #{row.id}</h1>
          <div class="sub">
            {fmtMoney(row.valueCents, row.currency)} · {fmtDate(row.occurredAt)}
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>What this was</h2>
        </div>
        <div class="card-b">
          <form method="post" action={`/conversions/${row.id}`}>
            <label>Kind</label>
            <select name="kindSlug">
              {allKinds.map((k) => (
                <option value={k.slug} selected={row.kindSlug === k.slug}>
                  {k.label}
                  {k.isActive ? '' : ' (disabled)'}
                </option>
              ))}
            </select>
            <p class="faint" style="margin:6px 0 18px">
              Detected automatically by walking the <a href="/goals">kind rules</a> in order.
              Change this only if that got it wrong — a yearly subscription, for instance, is
              spotted from the Stripe price interval, because most yearly subscribers sit on
              products that were never tagged as subscriptions.
            </p>

            <label>Offer</label>
            <select name="offerSlug">
              <option value="">— none (a membership is not an offer) —</option>
              {allOffers.map((o) => (
                <option value={o.slug} selected={row.offerSlug === o.slug}>
                  {o.title}
                  {o.active ? '' : ' (retired)'}
                </option>
              ))}
            </select>
            <p class="faint" style="margin:6px 0 18px">
              Resolved automatically through the Stripe product's <span class="mono">sku</span>.
            </p>

            <label>Campaign</label>
            <select name="campaignId">
              <option value="">— none —</option>
              {allCampaigns.map((cam) => (
                <option value={String(cam.id)} selected={row.campaignId === cam.id}>
                  {cam.name}
                </option>
              ))}
            </select>
            <p class="faint" style="margin:6px 0 18px">
              Currently attributed by <strong>{row.attributedBy.replace('_', ' ')}</strong>
              {row.touchLagSeconds !== null
                ? ` — the click landed ${lag(row.touchLagSeconds)} before the sale.`
                : '.'}{' '}
              Saving anything on this page marks it as set by hand, and no automatic pass will
              overwrite it again.
            </p>

            <label>Value (dollars)</label>
            <input
              type="text"
              name="value"
              value={(row.valueCents / 100).toFixed(2)}
              inputmode="decimal"
            />
            <p class="faint" style="margin:6px 0 18px">
              Frozen at conversion time. Editing this does not touch the underlying sale.
            </p>

            <div class="row" style="gap:8px;margin-top:8px">
              <button class="btn primary">Save</button>
              <a class="btn" href="/conversions">
                Cancel
              </a>
            </div>
          </form>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>The record</h2>
        </div>
        <div class="card-b">
          <table>
            <tbody>
              <tr>
                <td class="faint">Sale</td>
                <td class="mono">{row.saleId ? `#${row.saleId}` : '—'}</td>
              </tr>
              <tr>
                <td class="faint">Message</td>
                <td class="mono">{row.messageId ? `#${row.messageId}` : '—'}</td>
              </tr>
              <tr>
                <td class="faint">Source</td>
                <td class="mono">
                  {row.sourceKind}
                  {row.sourceId ? ` #${row.sourceId}` : ''}
                </td>
              </tr>
              <tr>
                <td class="faint">Recorded</td>
                <td class="mono">{fmtDate(row.createdAt)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-b">
          <form method="post" action={`/conversions/${row.id}/delete`}>
            <button class="btn danger sm">Delete this conversion</button>
            <p class="faint" style="margin:8px 0 0">
              The sale stays. Only the funnel credit is removed — and the next backfill will book
              a fresh one, so this is for genuine mistakes, not for refunds. A refunded sale still
              counts as a conversion here by design.
            </p>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

conversionsAdmin.post('/conversions/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()

  const campaignRaw = String(form.get('campaignId') ?? '').trim()
  const valueRaw = String(form.get('value') ?? '').replace(/[^0-9.]/g, '')
  const dollars = Number(valueRaw)

  const ok = await editConversion(db, id, {
    kindSlug: String(form.get('kindSlug') ?? '') || undefined,
    campaignId: campaignRaw ? Number(campaignRaw) : null,
    offerSlug: String(form.get('offerSlug') ?? ''),
    ...(Number.isFinite(dollars) ? { valueCents: Math.round(dollars * 100) } : {}),
  })

  if (!ok) return c.redirect('/conversions?flash=That conversion is gone.&kind=warn')
  return c.redirect(`/conversions/${id}?flash=Saved, and marked as set by hand.`)
})

conversionsAdmin.post('/conversions/:id/delete', async (c) => {
  const db = getDb(c.env)
  await deleteConversion(db, Number(c.req.param('id')))
  return c.redirect('/conversions?flash=Conversion deleted. The sale was left alone.')
})
