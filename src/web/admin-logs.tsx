import { Hono } from 'hono'
import {
  LOG_CATEGORIES,
  LOG_RETENTION_DAYS,
  LOG_TYPES,
  type LogEvent,
  searchLog,
} from '../core/event-log.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Layout, fmtDate } from './layout.tsx'

export const logsAdmin = new Hono<{ Bindings: Env }>()

/**
 * ⭐ Logs — everything that happened, in plain words, newest first.
 *
 * The Activity screen answers "is the mail working"; this one answers "what
 * happened, and when". It reads `core/event-log.ts`, which reads the tables the
 * facts already live in, so nothing here can disagree with the screen that owns
 * a fact.
 *
 * Read-only by construction: GET only, no form posts anywhere on the page.
 * Every name, subject and note is rendered as text through JSX, which escapes
 * it — a subscriber called `<script>` is a name, not markup.
 */

const LEVEL_TONE: Record<LogEvent['level'], string> = {
  info: '',
  warning: 'warn',
  error: 'bad',
}

logsAdmin.get('/logs', async (c) => {
  const db = getDb(c.env)
  const category = c.req.query('category') ?? ''
  const type = c.req.query('type') ?? ''
  const q = c.req.query('q') ?? ''
  const cursor = c.req.query('cursor') ?? ''

  const result = await searchLog(db, {
    category: category || undefined,
    type: type || undefined,
    q: q || undefined,
    cursor: cursor || undefined,
    limit: 50,
  })

  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams()
    if (category) p.set('category', category)
    if (type) p.set('type', type)
    if (q) p.set('q', q)
    for (const [k, v] of Object.entries(extra)) p.set(k, v)
    return `/logs?${p}`
  }

  const types = category ? LOG_TYPES.filter((x) => x.category === category) : LOG_TYPES

  return c.html(
    <Layout title="Logs" nav="logs">
      <div class="head">
        <div>
          <div class="eyebrow">What happened</div>
          <h1>Logs</h1>
          <div class="sub">
            Everything the mailer did and saw in the last {LOG_RETENTION_DAYS} days, in plain words:
            who joined and left, what went out, what failed or was held back, and what Stripe told
            us.
          </div>
        </div>
      </div>

      <div class="tabs">
        <a href="/logs" class={category ? '' : 'on'}>
          Everything
        </a>
        {LOG_CATEGORIES.map((cat) => (
          <a href={`/logs?category=${cat.id}`} class={category === cat.id ? 'on' : ''}>
            {cat.label}
          </a>
        ))}
      </div>

      <div class="card">
        <div class="card-b">
          <form method="get" action="/logs" class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
            {category ? <input type="hidden" name="category" value={category} /> : null}
            <label>
              <span class="l">Find</span>
              <input type="search" name="q" value={q} placeholder="Name, address, subject, note" maxlength={200} />
            </label>
            <label>
              <span class="l">Type</span>
              <select name="type">
                <option value="">Any</option>
                {types.map((x) => (
                  <option value={x.type} selected={x.type === type}>
                    {x.type}
                  </option>
                ))}
              </select>
            </label>
            <button class="btn sm primary" type="submit">
              Search
            </button>
            {q || type ? (
              <a class="btn sm" href={category ? `/logs?category=${category}` : '/logs'}>
                Clear
              </a>
            ) : null}
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-b flush">
          {!result.ok ? (
            <div class="empty">{result.reason}</div>
          ) : result.page.events.length === 0 ? (
            <div class="empty">Nothing matches in the last {LOG_RETENTION_DAYS} days.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What happened</th>
                  <th>Detail</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {result.page.events.map((e) => (
                  <tr data-log-id={e.id}>
                    <td class="muted" title={e.at.toISOString()} style="white-space:nowrap">
                      {fmtDate(e.at)}
                    </td>
                    <td>
                      {e.summary}
                      {e.email && e.name ? <div class="muted">{e.email}</div> : null}
                    </td>
                    <td class="muted">{e.detail ?? ''}</td>
                    <td>
                      <a class={`pill ${LEVEL_TONE[e.level]}`} href={qs({ type: e.type })}>
                        {e.type}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {result.ok && result.page.nextCursor ? (
        <div class="row" style="justify-content:flex-end">
          <a class="btn sm" href={qs({ cursor: result.page.nextCursor })}>
            Older
          </a>
        </div>
      ) : null}
    </Layout>,
  )
})
