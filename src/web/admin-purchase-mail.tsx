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
import { EditorHint, Flash, Layout, RichEditor, fmtDate, readEditorBody } from './layout.tsx'

/**
 * Purchase mail — the templates, and the deliberate act of sending one.
 *
 * Its own router rather than another thousand lines in `admin-campaigns.tsx`,
 * and mounted after `requireOperator` like every other admin screen.
 */
export const purchaseMailAdmin = new Hono<{ Bindings: Env }>()

const back = (msg: string, kind?: string) =>
  `/purchase-mail?flash=${encodeURIComponent(msg)}${kind ? `&kind=${kind}` : ''}`

// ───────────────────────────────────────────────── the list

purchaseMailAdmin.get('/purchase-mail', async (c) => {
  const db = getDb(c.env)
  const rows = await listTemplates(db)
  const hasFallback = rows.some((r) => r.offerSlug === FALLBACK_SLUG && r.isActive)

  return c.html(
    <Layout title="Purchase mail" nav="sales">
      <div class="head">
        <div>
          <h1>Purchase mail</h1>
          <div class="sub">What somebody is told after they buy. One template per offer.</div>
        </div>
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
              There's no active <span class="mono">*</span> template. Any sale whose offer has no
              template of its own can't be sent at all until one exists.
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
              <p class="faint">Start with the fallback, then add one per offer that needs its own voice.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Offer</th>
                  <th>Name</th>
                  <th>Subject</th>
                  <th>Discord</th>
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
                    <td>{t.discordInviteUrl ? 'yes' : <span class="faint">-</span>}</td>
                    <td class="faint">{fmtDate(t.updatedAt ?? t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>New template</h2>
        </div>
        <div class="card-b">
          <form method="post" action="/purchase-mail">
            <div class="row">
              <div class="field">
                <label>Offer sku</label>
                <input type="text" name="offerSlug" placeholder="cohort" required />
              </div>
              <div class="field">
                <label>Name</label>
                <input type="text" name="name" placeholder="Cohort welcome" required />
              </div>
            </div>
            <div class="field">
              <label>Subject</label>
              <input type="text" name="subject" placeholder="You're in" required />
            </div>
            <button class="btn primary">Create</button>
          </form>
          <p class="faint" style="margin:14px 0 0">
            The sku is the one on the Stripe product (<span class="mono">metadata.sku</span>) —{' '}
            <span class="mono">cohort</span>, <span class="mono">yearly</span>,{' '}
            <span class="mono">imposter-second</span>. Use <span class="mono">*</span> for the
            template that catches everything else.
          </p>
        </div>
      </div>
    </Layout>,
  )
})

purchaseMailAdmin.post('/purchase-mail', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()

  const id = await createTemplate(db, {
    offerSlug: String(form.get('offerSlug') ?? ''),
    name: String(form.get('name') ?? ''),
    subject: String(form.get('subject') ?? ''),
  })

  if (!id) {
    return c.redirect(
      back('That didn’t save. Either a field was empty, or that offer already has a template.', 'warn'),
    )
  }
  return c.redirect(`/purchase-mail/${id}?flash=${encodeURIComponent('Created. Now write it.')}`)
})

// ───────────────────────────────────────────────── one template

purchaseMailAdmin.get('/purchase-mail/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const t = await getTemplate(db, id)
  if (!t) return c.notFound()

  return c.html(
    <Layout title={t.name} nav="sales">
      <div class="head">
        <div>
          <h1>{t.name}</h1>
          <div class="sub">
            <span class="mono">{t.offerSlug === FALLBACK_SLUG ? '* (fallback)' : t.offerSlug}</span>
          </div>
        </div>
        <a class="btn" href="/purchase-mail">
          All templates
        </a>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>The mail</h2>
        </div>
        <div class="card-b">
          <form method="post" action={`/purchase-mail/${id}`}>
            <div class="row">
              <div class="field">
                <label>Offer sku</label>
                <input type="text" name="offerSlug" value={t.offerSlug} required />
              </div>
              <div class="field">
                <label>Name</label>
                <input type="text" name="name" value={t.name} required />
              </div>
            </div>

            <div class="field">
              <label>Subject</label>
              <input type="text" name="subject" value={t.subject} required />
            </div>

            <div class="field">
              <label>Discord invite</label>
              <input
                type="url"
                name="discordInviteUrl"
                value={t.discordInviteUrl ?? ''}
                placeholder="https://discord.gg/..."
              />
              <p class="faint" style="margin:8px 0 0">
                Merged as <span class="mono">{'{{discord_url}}'}</span>. Make it an invite that
                grants the right role on join, and the role rule is this field.
              </p>
            </div>

            <div class="field">
              <label>Body</label>
              <RichEditor bare inline json={t.bodyJson} md={t.bodyMd ?? ''} />
              <EditorHint />
            </div>

            <div class="field">
              <label>
                <input type="checkbox" name="isActive" value="1" checked={t.isActive} /> Active
              </label>
              <p class="faint" style="margin:8px 0 0">
                Inactive falls this offer back to the <span class="mono">*</span> template rather
                than sending nothing.
              </p>
            </div>

            <button class="btn primary">Save</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Placeholders</h2>
        </div>
        <div class="card-b">
          <table>
            <tbody>
              <tr>
                <td class="mono">{'{{first_name}}'}</td>
                <td class="faint">Their first name, or "there".</td>
              </tr>
              <tr>
                <td class="mono">{'{{offer_name}}'}</td>
                <td class="faint">What they bought, named as Stripe names it.</td>
              </tr>
              <tr>
                <td class="mono">{'{{account_url}}'}</td>
                <td class="faint">
                  <span class="mono">{ACCOUNT_URL}</span>
                </td>
              </tr>
              <tr>
                <td class="mono">{'{{downloads}}'}</td>
                <td class="faint">
                  The files this purchase grants. Empty when it grants none, so it's safe to leave
                  in a shared template.
                </td>
              </tr>
              <tr>
                <td class="mono">{'{{discord_url}}'}</td>
                <td class="faint">The invite above. Empty when there isn't one.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-b">
          <form method="post" action={`/purchase-mail/${id}/delete`}>
            <button class="btn danger sm">Delete template</button>
          </form>
          <p class="faint" style="margin:10px 0 0">
            Mail already sent from it is unaffected — every body is snapshotted onto its message.
          </p>
        </div>
      </div>
    </Layout>,
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
                        ({planned.plan.matchedSlug === FALLBACK_SLUG
                          ? 'fallback'
                          : planned.plan.matchedSlug})
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
                          {i.title}{' '}
                          <span class="faint mono">{i.sku ?? 'no sku'}</span>
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
