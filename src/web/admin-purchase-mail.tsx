import type { FC } from 'hono/jsx'
import { Hono } from 'hono'
import {
  ACCOUNT_URL,
  FALLBACK_SLUG,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  planPurchaseMail,
  purchasedItems,
  sendPurchaseMail,
  updateTemplate,
} from '../core/purchase-mail.ts'
import { previewHtml } from '../core/render.ts'
import { getDb } from '../db/index.ts'
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
 * Purchase mail — the templates, and the deliberate act of sending one.
 *
 * Its own router rather than another thousand lines in `admin-campaigns.tsx`,
 * and mounted after `requireOperator` like every other admin screen.
 *
 * A template is written in the same composer a broadcast is written in: the body
 * is the page, the metadata sits in the right-hand rail. It is the same job —
 * writing an email — so it is deliberately not a different-shaped form.
 */
export const purchaseMailAdmin = new Hono<{ Bindings: Env }>()

const back = (msg: string, kind?: string) =>
  `/purchase-mail?flash=${encodeURIComponent(msg)}${kind ? `&kind=${kind}` : ''}`

/** The big subject field at the top of the sheet, as the broadcast composer has it. */
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
      placeholder="Subject line"
      autocomplete="off"
      required
    />
  </div>
)

/** The right-hand rail. Identical on new and edit, so the screen doesn't move under you. */
const Side: FC<{ offerSlug?: string; name?: string; discord?: string | null; active?: boolean }> = ({
  offerSlug,
  name,
  discord,
  active = true,
}) => (
  <>
    <div class="side-sec">
      <h3>Offer</h3>
      <input
        type="text"
        name="offerSlug"
        value={offerSlug ?? ''}
        placeholder="cohort"
        required
        autocomplete="off"
      />
      <p class="faint" style="margin:8px 0 0">
        The sku on the Stripe product (<span class="mono">metadata.sku</span>) — e.g.{' '}
        <span class="mono">cohort</span>, <span class="mono">yearly</span>. Use{' '}
        <span class="mono">*</span> for the template that catches everything else.
      </p>
    </div>

    <div class="side-sec">
      <h3>Name</h3>
      <input
        type="text"
        name="name"
        value={name ?? ''}
        placeholder="Cohort welcome"
        required
        autocomplete="off"
      />
      <p class="faint" style="margin:8px 0 0">
        Yours, for the list. Never shown to a buyer.
      </p>
    </div>

    <div class="side-sec">
      <h3>Placeholders</h3>
      <p class="faint" style="margin:0">
        <span class="mono">{'{{first_name}}'}</span>
        <br />
        <span class="mono">{'{{offer_name}}'}</span> — what they bought
        <br />
        <span class="mono">{'{{account_url}}'}</span> — {ACCOUNT_URL}
        <br />
        <span class="mono">{'{{downloads}}'}</span> — their files, empty when none
        <br />
        <span class="mono">{'{{discord_url}}'}</span> — the invite below
      </p>
      <p class="faint" style="margin:10px 0 0">
        These work in the subject line too.
      </p>
    </div>

    <div class="side-sec">
      <h3>Discord</h3>
      <input
        type="url"
        name="discordInviteUrl"
        value={discord ?? ''}
        placeholder="https://discord.gg/…"
        autocomplete="off"
      />
      <p class="faint" style="margin:8px 0 0">
        Optional. Leave it blank and <span class="mono">{'{{discord_url}}'}</span> resolves to
        nothing.
      </p>
    </div>

    <div class="side-sec">
      <h3>Status</h3>
      <label style="text-transform:none;letter-spacing:0;font-size:13px;color:var(--muted);display:flex;gap:9px;align-items:flex-start;margin:0">
        <input type="checkbox" name="isActive" value="1" checked={active} style="width:auto;margin-top:3px" />
        <span>Active</span>
      </label>
      <p class="faint" style="margin:10px 0 0">
        Inactive falls this offer back to the <span class="mono">*</span> template rather than
        sending nothing.
      </p>
    </div>

    <div class="side-sec">
      <h3>Writing</h3>
      <EditorHint />
    </div>
  </>
)

// ───────────────────────────────────────────────── the list

purchaseMailAdmin.get('/purchase-mail', async (c) => {
  const db = getDb(c.env)
  const rows = await listTemplates(db)
  const hasFallback = rows.some((r) => r.offerSlug === FALLBACK_SLUG && r.isActive)

  return c.html(
    <Layout title="Purchase mail" nav="pmail">
      <div class="head">
        <div>
          <h1>Purchase mail</h1>
          <div class="sub">What somebody is told after they buy. One template per offer.</div>
        </div>
        <a class="btn primary" href="/purchase-mail/new">
          New template
        </a>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b">
          <div class="note">
            <strong>Nothing here sends on its own.</strong> A Stripe webhook records the sale and
            stops. Sending the thank-you is a button on the sale, pressed by you. These are
            transactional: no unsubscribe footer, no tracking, and only a hard bounce or a spam
            complaint can stop one — somebody who left the newsletter still gets told what they
            just bought.
          </div>
          {hasFallback ? null : (
            <div class="note warn" style="margin-top:12px">
              There is no active <span class="mono">*</span> template. Any sale whose offer has no
              template of its own cannot be sent at all until one exists.
            </div>
          )}
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
                Start with the <span class="mono">*</span> fallback, then add one per offer that
                needs its own voice.
              </p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Offer</th>
                  <th>Name</th>
                  <th>Subject</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr style={t.isActive ? '' : 'opacity:.55'}>
                    <td>
                      <a href={`/purchase-mail/${t.id}`} class="mono">
                        {t.offerSlug === FALLBACK_SLUG ? '* (fallback)' : t.offerSlug}
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

purchaseMailAdmin.get('/purchase-mail/new', (c) =>
  c.html(
    <ComposeLayout
      title="New purchase mail"
      nav="pmail"
      action="/purchase-mail"
      back="/purchase-mail"
      backLabel="Back to purchase mail"
      heading="New purchase mail"
      sub={<>nothing is sent until you press the button on a sale</>}
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

const FootNote = ({ msg, kind }: { msg?: string; kind?: string }) =>
  msg ? <span class={kind === 'warn' ? 'foot-warn' : 'faint'}>{msg}</span> : null

purchaseMailAdmin.post('/purchase-mail', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const { bodyJson, bodyMd } = readEditorBody(form)

  const id = await createTemplate(db, {
    offerSlug: String(form.get('offerSlug') ?? ''),
    name: String(form.get('name') ?? ''),
    subject: String(form.get('subject') ?? ''),
    bodyJson,
    bodyMd,
    discordInviteUrl: String(form.get('discordInviteUrl') ?? ''),
    isActive: form.get('isActive') === '1',
  })

  if (!id) {
    return c.redirect(
      back(
        'That did not save. Either the offer, name or subject was empty, or that offer already has a template.',
        'warn',
      ),
    )
  }
  return c.redirect(`/purchase-mail/${id}?flash=${encodeURIComponent('Saved.')}`)
})

// ───────────────────────────────────────────────── one template

purchaseMailAdmin.get('/purchase-mail/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const t = await getTemplate(db, id)
  if (!t) return c.notFound()

  return c.html(
    <ComposeLayout
      title={t.name}
      nav="pmail"
      action={`/purchase-mail/${id}`}
      recordId={id}
      back="/purchase-mail"
      backLabel="Back to purchase mail"
      heading={t.name || 'Untitled'}
      sub={
        <>
          <span class="mono">
            {t.offerSlug === FALLBACK_SLUG ? '* (fallback)' : t.offerSlug}
          </span>
          {t.isActive ? null : ' · inactive'}
        </>
      }
      actions={<button class="btn primary">Save</button>}
      side={
        <Side
          offerSlug={t.offerSlug}
          name={t.name}
          discord={t.discordInviteUrl}
          active={t.isActive}
        />
      }
      foot={
        <>
          <FootNote msg={c.req.query('flash')} kind={c.req.query('kind')} />
          <button class="btn danger sm" form="delete-template">
            Delete
          </button>
          <button class="btn primary">Save</button>
        </>
      }
      // Deleting posts somewhere else, so it is its own form reached by id —
      // forms cannot nest.
      extra={<form id="delete-template" method="post" action={`/purchase-mail/${id}/delete`} hidden />}
    >
      <Subject value={t.subject} />
      <RichEditor bare json={t.bodyJson} md={t.bodyMd ?? ''} />
    </ComposeLayout>,
  )
})

purchaseMailAdmin.post('/purchase-mail/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  if (!(await getTemplate(db, id))) return c.notFound()

  const form = await c.req.formData()
  const { bodyJson, bodyMd } = readEditorBody(form)

  await updateTemplate(db, id, {
    offerSlug: String(form.get('offerSlug') ?? ''),
    name: String(form.get('name') ?? ''),
    subject: String(form.get('subject') ?? ''),
    discordInviteUrl: String(form.get('discordInviteUrl') ?? ''),
    bodyJson,
    bodyMd,
    isActive: form.get('isActive') === '1',
  })

  return c.redirect(`/purchase-mail/${id}?flash=${encodeURIComponent('Saved.')}`)
})

purchaseMailAdmin.post('/purchase-mail/:id/delete', async (c) => {
  const db = getDb(c.env)
  await deleteTemplate(db, Number(c.req.param('id')))
  return c.redirect(back('Template deleted.'))
})

// ───────────────────────────────────────────────── sending one

/**
 * The preview. Everything the send would do, shown before it does any of it —
 * which template matched, what the buyer is credited with owning, and the body
 * with the merge values already resolved.
 */
purchaseMailAdmin.get('/sales/:id/thanks', async (c) => {
  const db = getDb(c.env)
  const saleId = Number(c.req.param('id'))
  const planned = await planPurchaseMail(db, saleId)
  const items = await purchasedItems(db, saleId)

  return c.html(
    <Layout title="Send the thank-you" nav="sales">
      <div class="head">
        <div>
          <h1>Send the thank-you</h1>
          <div class="sub">Sale #{saleId}</div>
        </div>
        <a class="btn" href="/sales">
          Back to sales
        </a>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      {!planned.ok ? (
        <div class="card">
          <div class="card-b">
            <div class="note warn">{planned.reason}</div>
          </div>
        </div>
      ) : (
        <>
          <div class="card">
            <div class="card-h">
              <h2>What would go out</h2>
            </div>
            <div class="card-b">
              <table>
                <tbody>
                  <tr>
                    <td>To</td>
                    <td class="mono">{planned.plan.to}</td>
                  </tr>
                  <tr>
                    <td>Template</td>
                    <td>
                      <a href={`/purchase-mail/${planned.plan.template.id}`}>
                        {planned.plan.template.name}
                      </a>{' '}
                      <span class="faint mono">
                        (
                        {planned.plan.matchedSlug === FALLBACK_SLUG
                          ? 'fallback'
                          : planned.plan.matchedSlug}
                        )
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td>Subject</td>
                    <td>{planned.plan.subject}</td>
                  </tr>
                  <tr>
                    <td>They bought</td>
                    <td>
                      {items.map((i) => (
                        <div>
                          {i.title} <span class="faint mono">{i.sku ?? 'no sku'}</span>
                          {i.file ? <span class="faint"> · has a download</span> : null}
                        </div>
                      ))}
                    </td>
                  </tr>
                </tbody>
              </table>

              {planned.plan.alreadySentMessageId ? (
                <div class="note warn" style="margin-top:14px">
                  This sale was already thanked in message #{planned.plan.alreadySentMessageId}.
                  Sending again is deliberate.
                </div>
              ) : null}
            </div>
          </div>

          <div class="card">
            <div class="card-h">
              <h2>The body</h2>
            </div>
            <div class="card-b">
              <div
                class="paper"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: our own renderer, same one the wire uses
                dangerouslySetInnerHTML={{
                  __html: previewHtml(planned.plan.bodyJson, planned.plan.bodyMd ?? ''),
                }}
              />
              <p class="faint" style="margin:14px 0 0">
                Merge values shown as a sample reader would see them. The real send resolves them
                against this buyer.
              </p>
            </div>
          </div>

          <div class="card">
            <div class="card-b">
              <form method="post" action={`/sales/${saleId}/thanks`}>
                <button class="btn primary">
                  {planned.plan.alreadySentMessageId ? 'Send it again' : 'Send it'}
                </button>
                {planned.plan.alreadySentMessageId ? (
                  <input type="hidden" name="resend" value="1" />
                ) : null}
              </form>
              <p class="faint" style="margin:12px 0 0">
                This mails {planned.plan.to}. It is a real send.
              </p>
            </div>
          </div>
        </>
      )}
    </Layout>,
  )
})

purchaseMailAdmin.post('/sales/:id/thanks', async (c) => {
  const db = getDb(c.env)
  const saleId = Number(c.req.param('id'))

  // A send must not 500 on a malformed request. `formData()` throws when the
  // body carries no content type, and the only thing read from it is an opt-in
  // flag whose safe reading is "no".
  let resend = false
  try {
    resend = (await c.req.formData()).get('resend') === '1'
  } catch {
    resend = false
  }

  const result = await sendPurchaseMail(c.env, db, saleId, { resend })

  return c.redirect(
    result.ok
      ? `/sales?flash=${encodeURIComponent(`Sent to ${result.to}.`)}`
      : `/sales/${saleId}/thanks?flash=${encodeURIComponent(result.reason)}&kind=warn`,
  )
})
