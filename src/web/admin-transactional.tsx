import type { FC } from 'hono/jsx'
import { Hono } from 'hono'
import {
  createTxTemplate,
  deleteTxTemplate,
  getTxTemplate,
  listTxTemplates,
  templateAsks,
  txTemplateUsage,
  updateTxTemplate,
} from '../core/transactional.ts'
import { getDb } from '../db/index.ts'
import type { TransactionalTemplate } from '../db/schema.ts'
import type { Env } from '../types.ts'
import {
  ComposeLayout,
  EditorHint,
  Flash,
  Layout,
  RichEditor,
  fmtDate,
  readEditorBody,
} from './layout.tsx'

/**
 * Transactional templates — the stored receipts and resets another app sends
 * through `POST /api/send` by slug. Thin: every rule is `core/transactional.ts`.
 *
 * Written in the same composer as everything else, because it is the same job.
 * Not purchase mail (keyed by offer, sent by you on a sale) and not sequence
 * templates (recipes for a sequence) — this one is sent by another program.
 */
export const transactionalAdmin = new Hono<{ Bindings: Env }>()

const back = (msg: string, kind?: string) =>
  `/transactional?flash=${encodeURIComponent(msg)}${kind ? `&kind=${kind}` : ''}`

const Subject: FC<{ value?: string }> = ({ value }) => (
  <div class="compose-subject">
    <label class="hide-vis" for="subject">
      Subject
    </label>
    <input
      class="subj"
      id="subject"
      type="text"
      name="subject"
      value={value ?? ''}
      placeholder="Subject line — {{variables}} work here too"
      autocomplete="off"
      required
    />
  </div>
)

/** The call another app makes, with this template's own variables filled in. */
function exampleCall(t: TransactionalTemplate): string {
  const vars = Object.fromEntries(templateAsks(t).map((v) => [v, '…']))
  return JSON.stringify(
    { to: 'customer@example.com', template: t.slug, variables: vars, idempotency_key: 'order-1234' },
    null,
    2,
  )
}

const Side: FC<{ t?: TransactionalTemplate; usage?: number }> = ({ t, usage }) => (
  <>
    <div class="side-sec">
      <h3>Slug</h3>
      {t ? (
        <>
          <div class="mono">{t.slug}</div>
          <p class="faint" style="margin:8px 0 0">
            What a request names. Set once and never changed — another app has it in its code.
          </p>
        </>
      ) : (
        <>
          <input type="text" name="slug" value="" placeholder="from the name" autocomplete="off" />
          <p class="faint" style="margin:8px 0 0">
            Optional. Lowercase and dashes, e.g. <span class="mono">password-reset</span>. Leave it
            blank to make one from the name. It can't be changed later.
          </p>
        </>
      )}
    </div>

    <div class="side-sec">
      <h3>Name</h3>
      <input
        type="text"
        name="name"
        value={t?.name ?? ''}
        placeholder="Password reset"
        required
        autocomplete="off"
      />
      <p class="faint" style="margin:8px 0 0">
        Yours, for the list. Never shown to a recipient.
      </p>
    </div>

    <div class="side-sec">
      <h3>Variables</h3>
      <p class="faint" style="margin:0">
        Type <span class="mono">{'{{order_id}}'}</span> anywhere — subject, text, or a link — and
        the request fills it from <span class="mono">variables</span>. A request missing one is
        refused with a 422 naming it, and nothing is sent.
      </p>
      <p class="faint" style="margin:10px 0 0">
        <span class="mono">{'{{first_name}}'}</span>, <span class="mono">{'{{name}}'}</span> and{' '}
        <span class="mono">{'{{email}}'}</span> come from the recipient.
      </p>
      {t ? (
        <p class="faint" style="margin:10px 0 0">
          This one asks for:{' '}
          {templateAsks(t).length ? (
            templateAsks(t).map((v, i) => (
              <>
                {i ? ', ' : ''}
                <span class="mono">{v}</span>
              </>
            ))
          ) : (
            <>nothing</>
          )}
        </p>
      ) : null}
    </div>

    {t ? (
      <div class="side-sec">
        <h3>Calling it</h3>
        <pre class="mono" style="margin:0;font-size:11.5px;white-space:pre-wrap">
          {`POST /api/send\nAuthorization: Bearer <send key>\n\n${exampleCall(t)}`}
        </pre>
      </div>
    ) : null}

    <div class="side-sec">
      <h3>Status</h3>
      <label style="text-transform:none;letter-spacing:0;font-size:13px;color:var(--muted);display:flex;gap:9px;align-items:flex-start;margin:0">
        <input
          type="checkbox"
          name="isActive"
          value="1"
          checked={t?.isActive ?? true}
          style="width:auto;margin-top:3px"
        />
        <span>Active</span>
      </label>
      <p class="faint" style="margin:10px 0 0">
        A request naming an inactive template is refused with a 422, so the calling app knows
        and can send it again once this is back on.
      </p>
    </div>

    {t ? (
      <div class="side-sec">
        <h3>Sent</h3>
        <p class="faint" style="margin:0">
          {usage ?? 0} {usage === 1 ? 'message' : 'messages'} so far. Each keeps its own copy, so
          editing or deleting this never changes one that went out.
        </p>
      </div>
    ) : null}

    <div class="side-sec">
      <h3>Writing</h3>
      <EditorHint />
    </div>
  </>
)

const FootNote = ({ msg, kind }: { msg?: string; kind?: string }) =>
  msg ? <span class={kind === 'warn' ? 'foot-warn' : 'faint'}>{msg}</span> : null

// ───────────────────────────────────────────────── the list

transactionalAdmin.get('/transactional', async (c) => {
  const db = getDb(c.env)
  const rows = await listTxTemplates(db)

  return c.html(
    <Layout title="Transactional" nav="txn">
      <div class="head">
        <div>
          <h1>Transactional templates</h1>
          <div class="sub">Receipts, resets and notices your other apps send by name.</div>
        </div>
        <a class="btn primary" href="/transactional/new">
          New template
        </a>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b">
          <div class="note">
            <strong>Nothing here sends on its own.</strong> Another app calls{' '}
            <span class="mono">POST /api/send</span> with a <span class="mono">send</span> key and{' '}
            <span class="mono">template: "slug"</span>. These are transactional: no unsubscribe
            footer, no tracking, and only a hard bounce or a spam complaint stops one.
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Templates</h2>
          <span class="pill">{rows.length}</span>
        </div>
        <div class="card-b flush">
          {rows.length === 0 ? (
            <div class="empty">
              <p>No templates yet.</p>
              <p class="faint">
                Until there is one, a request has to carry its own subject and body.
              </p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Slug</th>
                  <th>Name</th>
                  <th>Subject</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr style={t.isActive ? '' : 'opacity:.55'}>
                    <td>
                      <a href={`/transactional/${t.id}`} class="mono">
                        {t.slug}
                      </a>
                      {t.isActive ? null : <div class="faint">inactive</div>}
                    </td>
                    <td>{t.name}</td>
                    <td class="faint">{t.subject}</td>
                    <td class="faint">{fmtDate(t.updatedAt ?? t.createdAt)}</td>
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

// ───────────────────────────────────────────────── new

transactionalAdmin.get('/transactional/new', (c) =>
  c.html(
    <ComposeLayout
      title="New transactional template"
      nav="txn"
      action="/transactional"
      back="/transactional"
      backLabel="Back to transactional"
      heading="New transactional template"
      sub={<>sent only when another app asks for it by slug</>}
      actions={<button class="btn primary">Save</button>}
      side={<Side />}
      foot={
        <>
          <FootNote msg={c.req.query('flash')} kind={c.req.query('kind')} />
          <button class="btn primary">Save</button>
        </>
      }
    >
      <Subject />
      <RichEditor bare />
    </ComposeLayout>,
  ),
)

transactionalAdmin.post('/transactional', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const { bodyJson, bodyMd } = readEditorBody(form)

  const result = await createTxTemplate(db, {
    slug: String(form.get('slug') ?? ''),
    name: String(form.get('name') ?? ''),
    subject: String(form.get('subject') ?? ''),
    bodyJson,
    bodyMd,
    isActive: form.get('isActive') === '1',
  })

  if (!result.ok) return c.redirect(`/transactional/new?flash=${encodeURIComponent(result.reason)}&kind=warn`)
  return c.redirect(`/transactional/${result.template.id}?flash=${encodeURIComponent('Saved.')}`)
})

// ───────────────────────────────────────────────── one template

transactionalAdmin.get('/transactional/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const t = await getTxTemplate(db, id)
  if (!t) return c.notFound()
  const usage = await txTemplateUsage(db, t.slug)

  return c.html(
    <ComposeLayout
      title={t.name}
      nav="txn"
      action={`/transactional/${id}`}
      recordId={id}
      back="/transactional"
      backLabel="Back to transactional"
      heading={t.name || 'Untitled'}
      sub={
        <>
          <span class="mono">{t.slug}</span>
          {t.isActive ? null : ' · inactive'}
        </>
      }
      actions={<button class="btn primary">Save</button>}
      side={<Side t={t} usage={usage} />}
      foot={
        <>
          <FootNote msg={c.req.query('flash')} kind={c.req.query('kind')} />
          <button class="btn danger sm" form="delete-template">
            Delete
          </button>
          <button class="btn primary">Save</button>
        </>
      }
      // Forms cannot nest, so delete is its own form reached by id.
      extra={
        <form
          id="delete-template"
          method="post"
          action={`/transactional/${id}/delete`}
          onsubmit={`return confirm(${JSON.stringify(
            `Delete "${t.slug}"? Any app still sending it will get a 422 from now on.`,
          )})`}
          hidden
        />
      }
    >
      <Subject value={t.subject} />
      <RichEditor bare json={t.bodyJson} md={t.bodyMd ?? ''} />
    </ComposeLayout>,
  )
})

transactionalAdmin.post('/transactional/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  if (!(await getTxTemplate(db, id))) return c.notFound()

  const form = await c.req.formData()
  const { bodyJson, bodyMd } = readEditorBody(form)

  const result = await updateTxTemplate(db, id, {
    name: String(form.get('name') ?? ''),
    subject: String(form.get('subject') ?? ''),
    bodyJson,
    bodyMd,
    isActive: form.get('isActive') === '1',
  })

  const msg = result.ok ? 'Saved.' : result.reason
  return c.redirect(
    `/transactional/${id}?flash=${encodeURIComponent(msg)}${result.ok ? '' : '&kind=warn'}`,
  )
})

transactionalAdmin.post('/transactional/:id/delete', async (c) => {
  const db = getDb(c.env)
  const gone = await deleteTxTemplate(db, Number(c.req.param('id')))
  return c.redirect(gone ? back('Template deleted. Mail it sent keeps its copy.') : back('No such template.', 'warn'))
})
