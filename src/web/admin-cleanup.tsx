import { Hono } from 'hono'
import {
  DEFAULT_INACTIVE_DAYS,
  MIN_SENDS,
  PENDING_DAYS,
  PRUNE_GROUPS,
  type PruneGroup,
  SEND_AGE_DAYS,
  cancelPrune,
  clampDays,
  getPrune,
  parseGroups,
  planPrune,
  previewPrune,
  pruneBackupCsv,
  recentPrunes,
  runPrune,
} from '../core/cleanup.ts'
import { getDb } from '../db/index.ts'
import type { ListPrune } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate } from './layout.tsx'

/**
 * Clean up (gap.md "Clean up", Kōlea's prune screen): pick groups, see the
 * counts, plan, download the backup of exactly those people, type the count to
 * confirm, delete. Every clean-up is a `list_prunes` row, listed here.
 *
 * Mounted before the audience router: its `/subscribers/:id` would otherwise
 * claim `/subscribers/clean-up`.
 */
export const cleanupAdmin = new Hono<{ Bindings: Env }>()

const LABEL: Record<PruneGroup, string> = {
  never_engaged: 'Never opened',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced or complained',
  unconfirmed: 'Never confirmed',
}

function describe(group: PruneGroup, days: number): string {
  switch (group) {
    case 'never_engaged':
      return `Active, sent at least ${MIN_SENDS} mails in the last ${days} days (each over ${SEND_AGE_DAYS} days old), and no open or click in that time.`
    case 'unsubscribed':
      return 'Left the newsletter. Their address keeps that choice, so a re-import brings them back unsubscribed. A series they join, or signing up again themselves, still works.'
    case 'bounced':
      return 'The address bounced hard or marked mail as spam. The suppression stays.'
    case 'unconfirmed':
      return `Pending for more than ${PENDING_DAYS} days and never confirmed.`
  }
}

const groupList = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([g, n]) => `${LABEL[g as PruneGroup] ?? g}: ${n}`)
    .join(' · ') || '-'

const statusPill = (p: ListPrune) => {
  const kind = p.status === 'done' ? 'ok' : p.status === 'cancelled' ? '' : 'warn'
  return <span class={`pill ${kind}`}>{p.status}</span>
}

cleanupAdmin.get('/subscribers/clean-up', async (c) => {
  const db = getDb(c.env)
  const days = clampDays(c.req.query('days') ?? DEFAULT_INACTIVE_DAYS)
  const [counts, history] = await Promise.all([previewPrune(db, days), recentPrunes(db)])

  return c.html(
    <Layout title="Clean up" nav="subs">
      <div class="head">
        <div>
          <h1>Clean up the list</h1>
          <div class="sub">Delete people who are only costing you sends. Buyers and anyone with mail queued are never included.</div>
        </div>
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b">
          <form method="get" action="/subscribers/clean-up" class="row" style="gap:6px;margin-bottom:16px">
            <label for="days" style="margin:0">Never opened means no open or click in the last</label>
            <input type="number" id="days" name="days" value={String(days)} min="30" style="width:90px;min-width:0" />
            <span>days</span>
            <button class="btn" style="flex:0 0 auto;min-width:0">
              Recount
            </button>
          </form>

          <form method="post" action="/subscribers/clean-up">
            <input type="hidden" name="days" value={String(days)} />
            <table>
              <thead>
                <tr>
                  <th class="tick" />
                  <th>Group</th>
                  <th style="text-align:right">People</th>
                </tr>
              </thead>
              <tbody>
                {PRUNE_GROUPS.map((g) => (
                  <tr>
                    <td class="tick">
                      <input type="checkbox" name="group" value={g} id={`g-${g}`} disabled={counts[g] === 0} />
                    </td>
                    <td>
                      <label for={`g-${g}`} style="margin:0;font-weight:500">
                        {LABEL[g]}
                      </label>
                      <div class="faint">{describe(g, days)}</div>
                    </td>
                    <td class="mono" style="text-align:right">
                      {counts[g]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div class="row" style="margin-top:12px">
              <button class="btn primary">Review these people</button>
            </div>
            <p class="faint">Nothing is deleted yet. The next step shows the count, gives you the backup CSV, and asks you to confirm.</p>
          </form>
        </div>
      </div>

      {history.length ? (
        <div class="card">
          <div class="card-b flush">
            <table>
              <thead>
                <tr>
                  <th>Clean-up</th>
                  <th>Status</th>
                  <th>Planned</th>
                  <th style="text-align:right">Deleted</th>
                </tr>
              </thead>
              <tbody>
                {history.map((p) => (
                  <tr>
                    <td>
                      <a href={`/subscribers/clean-up/${p.id}`}>{fmtDate(p.createdAt)}</a>
                    </td>
                    <td>{statusPill(p)}</td>
                    <td class="faint">{groupList(p.planned)}</td>
                    <td class="mono" style="text-align:right">
                      {p.deleted}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Layout>,
  )
})

cleanupAdmin.post('/subscribers/clean-up', async (c) => {
  const form = await c.req.formData()
  const groups = parseGroups(form.getAll('group'))
  const days = clampDays(form.get('days'))
  const result = await planPrune(getDb(c.env), groups, days)
  if (!result.ok) {
    return c.redirect(`/subscribers/clean-up?${new URLSearchParams({ days: String(days), flash: result.message, kind: 'warn' })}`)
  }
  return c.redirect(`/subscribers/clean-up/${result.prune.id}`)
})

cleanupAdmin.get('/subscribers/clean-up/:id{[0-9]+}/backup.csv', async (c) => {
  const db = getDb(c.env)
  const prune = await getPrune(db, Number(c.req.param('id')))
  if (!prune) return c.notFound()
  const csv = await pruneBackupCsv(db, prune)
  return c.body(csv, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="clean-up-${prune.id}-backup.csv"`,
    'cache-control': 'no-store',
  })
})

cleanupAdmin.get('/subscribers/clean-up/:id{[0-9]+}', async (c) => {
  const prune = await getPrune(getDb(c.env), Number(c.req.param('id')))
  if (!prune) return c.notFound()
  const left = prune.subscriberIds.length - prune.position

  return c.html(
    <Layout title="Clean up" nav="subs">
      <div class="head">
        <div>
          <h1>
            {prune.status === 'planned'
              ? `Delete ${prune.total} ${prune.total === 1 ? 'person' : 'people'}?`
              : prune.status === 'running'
                ? 'Clean-up in progress'
                : prune.status === 'done'
                  ? 'Clean-up finished'
                  : 'Clean-up cancelled'}
          </h1>
          <div class="sub">
            Planned {fmtDate(prune.createdAt)} · {statusPill(prune)}
          </div>
        </div>
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b">
          <p>
            <strong>Planned:</strong> {groupList(prune.planned)}
          </p>
          {prune.status !== 'planned' ? (
            <p>
              <strong>Deleted:</strong> {prune.deleted} ({groupList(prune.deletedByGroup)})
              {prune.skipped ? ` · ${prune.skipped} skipped because they no longer matched` : ''}
            </p>
          ) : null}
          <p>
            <a class="btn" href={`/subscribers/clean-up/${prune.id}/backup.csv`}>
              Download backup CSV
            </a>{' '}
            <span class="faint">
              {prune.backedUpAt ? `Downloaded ${fmtDate(prune.backedUpAt)}.` : 'Not downloaded yet.'}
            </span>
          </p>

          {prune.status === 'planned' ? (
            <>
              <div class="note">
                This deletes these people and their history (mail, opens, clicks, enrollments) for good. Anyone who
                bounced or complained stays suppressed. Anyone who left the newsletter stays off it, even if
                they are imported later, until they sign up again themselves. Download the backup first: importing
                it brings people back as they were, never more subscribed.
              </div>
              <form method="post" action={`/subscribers/clean-up/${prune.id}/run`} class="row" style="gap:6px">
                <label for="confirm" style="margin:0">
                  Type {prune.total} to confirm
                </label>
                <input
                  type="text"
                  inputmode="numeric"
                  id="confirm"
                  name="confirm"
                  autocomplete="off"
                  required
                  style="width:110px;min-width:0"
                />
                <button class="btn danger" style="flex:0 0 auto;min-width:0">
                  Delete {prune.total} {prune.total === 1 ? 'person' : 'people'}
                </button>
              </form>
              <form method="post" action={`/subscribers/clean-up/${prune.id}/cancel`} style="margin-top:12px">
                <button class="btn">Cancel this clean-up</button>
              </form>
            </>
          ) : null}

          {prune.status === 'running' ? (
            <form method="post" action={`/subscribers/clean-up/${prune.id}/run`}>
              <p>{left} still to go. Each press deletes the next batch.</p>
              <button class="btn danger">Continue</button>
            </form>
          ) : null}

          <p style="margin-top:16px">
            <a href="/subscribers/clean-up">Back to clean up</a>
          </p>
        </div>
      </div>
    </Layout>,
  )
})

cleanupAdmin.post('/subscribers/clean-up/:id{[0-9]+}/run', async (c) => {
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const raw = String(form.get('confirm') ?? '').replace(/[,\s]/g, '')
  const result = await runPrune(getDb(c.env), id, { confirmCount: raw === '' ? undefined : Number(raw) })
  const flash = result.ok
    ? result.prune.status === 'done'
      ? `Deleted ${result.prune.deleted} people.`
      : `Deleted ${result.prune.deleted} so far. Press Continue for the rest.`
    : result.message
  return c.redirect(
    `/subscribers/clean-up/${id}?${new URLSearchParams({ flash, ...(result.ok ? {} : { kind: 'warn' }) })}`,
  )
})

cleanupAdmin.post('/subscribers/clean-up/:id{[0-9]+}/cancel', async (c) => {
  const id = Number(c.req.param('id'))
  const cancelled = await cancelPrune(getDb(c.env), id)
  return c.redirect(
    `/subscribers/clean-up/${id}?${new URLSearchParams({ flash: cancelled ? 'Cancelled. Nobody was deleted.' : 'Only a planned clean-up can be cancelled.' })}`,
  )
})
