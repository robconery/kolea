/**
 * Imports from other tools: connect Kit, Ghost, Mailchimp or Drip with an API
 * key, start a run, watch it, cancel it, read what it did.
 *
 * Thin by design. Every rule — what consent survives, what is left behind,
 * what can never send — is in `core/importers/`. This screen never shows a
 * key back: the forms post it once, and every read goes through
 * `importRunColumns`, which does not include it.
 */
import { Hono } from 'hono'
import {
  type ImportRunView,
  cancelImport,
  getImport,
  importPercent,
  importSourceList,
  listImports,
  startImport,
} from '../core/importers/runs.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate } from './layout.tsx'

export const importsAdmin = new Hono<{ Bindings: Env }>()

const LABEL: Record<string, string> = Object.fromEntries(importSourceList().map((s) => [s.id, s.label]))

const PILL: Record<string, string> = {
  queued: 'warn',
  running: 'warn',
  completed: 'ok',
  failed: 'bad',
  cancelled: '',
}

const RunStatus = ({ run }: { run: ImportRunView }) => (
  <span class={`pill ${PILL[run.status] ?? ''}`}>{run.status}</span>
)

const Progress = ({ run }: { run: ImportRunView }) => (
  <span class="faint">
    {run.status === 'queued' || run.status === 'running'
      ? `${importPercent(run)}% · ${run.phase ?? 'finishing'} · page ${run.pages + 1}`
      : `${run.pages} pages`}
  </span>
)

const Counts = ({ run }: { run: ImportRunView }) => (
  <span class="mono">
    {run.created} new · {run.updated} matched · {run.skipped} skipped · {run.invalid} invalid
  </span>
)

importsAdmin.get('/imports', async (c) => {
  const db = getDb(c.env)
  const runs = await listImports(db)
  const active = runs.find((r) => r.status === 'queued' || r.status === 'running')
  const flash = c.req.query('flash')
  const error = c.req.query('error')

  return c.html(
    <Layout title="Imports" nav="imp">
      <div class="head">
        <div>
          <h1>Imports</h1>
          <div class="sub">
            Bring a list and its past mail over from another tool. It runs in the background, a page a minute,
            and resumes where it stopped.
          </div>
        </div>
        <div class="actions">
          <a class="btn" href="/imports">
            Refresh
          </a>
        </div>
      </div>
      <Flash msg={flash} />
      <Flash msg={error} kind="warn" />

      <div class="card">
        <div class="card-h">
          <h2>Runs</h2>
        </div>
        <div class="card-b flush">
          {runs.length === 0 ? (
            <div class="empty">
              <p>No imports yet.</p>
              <p class="faint">Connect a tool below to start one.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>From</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Results</th>
                  <th>Started</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr>
                    <td>
                      <a href={`/imports/${r.id}`}>{r.id}</a>
                    </td>
                    <td>{LABEL[r.source] ?? r.source}</td>
                    <td>
                      <RunStatus run={r} />
                    </td>
                    <td>
                      <Progress run={r} />
                    </td>
                    <td>
                      <Counts run={r} />
                      {r.lastError ? <div class="faint">{r.lastError}</div> : null}
                    </td>
                    <td>{fmtDate(r.createdAt)}</td>
                    <td>
                      {r.status === 'queued' || r.status === 'running' ? (
                        <form method="post" action={`/imports/${r.id}/cancel`}>
                          <button class="btn sm">Cancel</button>
                        </form>
                      ) : null}
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
          <h2>Connect a tool</h2>
        </div>
        <div class="card-b">
          <div class="note">
            Nothing imported can send. People who left in the other tool stay left here, and anyone already
            unsubscribed or suppressed here stays that way. Nobody is enrolled in a sequence or tagged by a rule.
            Past mail lands as sent and unpublished; sequences land switched off. The key is used once to check it,
            kept only on the run while it works, and deleted the moment it ends.
          </div>
          {active ? (
            <p class="faint">Import #{active.id} is still running. One at a time.</p>
          ) : (
            importSourceList().map((s) => (
              <form method="post" action="/imports" style="margin-top:20px">
                <input type="hidden" name="source" value={s.id} />
                <h3>{s.label}</h3>
                <div class="row">
                  {s.fields.map((f) => (
                    <div class="field">
                      <label>{f.label}</label>
                      <input
                        type={f.secret ? 'password' : 'text'}
                        name={f.name}
                        autocomplete="off"
                        required
                        placeholder={f.hint ?? ''}
                      />
                    </div>
                  ))}
                </div>
                <button class="btn primary">Check the key and start</button>
              </form>
            ))
          )}
        </div>
      </div>
    </Layout>,
  )
})

importsAdmin.get('/imports/:id', async (c) => {
  const run = await getImport(getDb(c.env), Number(c.req.param('id')))
  if (!run) return c.notFound()
  const detail = Object.entries(run.detail).filter(([, n]) => n > 0)
  return c.html(
    <Layout title={`Import #${run.id}`} nav="imp">
      <div class="head">
        <div>
          <h1>
            Import #{run.id} from {LABEL[run.source] ?? run.source}
          </h1>
          <div class="sub">
            <RunStatus run={run} /> <Progress run={run} />
          </div>
        </div>
        <div class="actions">
          <a class="btn" href="/imports">
            All imports
          </a>
          {run.status === 'queued' || run.status === 'running' ? (
            <form method="post" action={`/imports/${run.id}/cancel`}>
              <button class="btn">Cancel</button>
            </form>
          ) : null}
        </div>
      </div>
      <div class="card">
        <div class="card-b">
          <p>
            <Counts run={run} />
          </p>
          {Object.keys(run.settings).length ? (
            <p class="faint mono">
              {Object.entries(run.settings)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ')}
            </p>
          ) : null}
          {run.lastError ? <div class="flash warn">{run.lastError}</div> : null}
          <p class="faint">
            Started {fmtDate(run.startedAt ?? run.createdAt)}
            {run.finishedAt ? ` · finished ${fmtDate(run.finishedAt)}` : ''}
          </p>
        </div>
      </div>
      {detail.length ? (
        <div class="card">
          <div class="card-h">
            <h2>By kind</h2>
          </div>
          <div class="card-b flush">
            <table>
              <tbody>
                {detail.map(([k, n]) => (
                  <tr>
                    <td>{k.replace(/_/g, ' ')}</td>
                    <td class="num">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {run.notes.length ? (
        <div class="card">
          <div class="card-h">
            <h2>Worth knowing</h2>
          </div>
          <div class="card-b flush">
            <table>
              <tbody>
                {run.notes.map((n) => (
                  <tr>
                    <td class="num">{n.count}</td>
                    <td>{n.message}</td>
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

importsAdmin.post('/imports', async (c) => {
  const form = await c.req.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) if (typeof v === 'string') params[k] = v
  const result = await startImport(c.env, getDb(c.env), params.source ?? '', params)
  if (!result.ok) return c.redirect(`/imports?error=${encodeURIComponent(result.error)}`)
  return c.redirect(
    `/imports?flash=${encodeURIComponent(`Import #${result.id} is queued. It starts on the next minute.`)}`,
  )
})

importsAdmin.post('/imports/:id/cancel', async (c) => {
  const id = Number(c.req.param('id'))
  const result = await cancelImport(getDb(c.env), id)
  if (!result.ok) return c.redirect(`/imports?error=${encodeURIComponent(result.error)}`)
  return c.redirect(`/imports?flash=${encodeURIComponent(`Import #${id} cancelled. Rows already written stay.`)}`)
})
