import { Hono } from 'hono'
import { type ResendTarget, sendAgain, undeliveredMail } from '../core/undelivered.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate } from './layout.tsx'

/**
 * Undelivered — every message that should have gone and didn't, with a way to
 * send it again. A thin wrapper over `core/undelivered.ts`, where the rules
 * (what counts, what is never offered, why it cannot duplicate) live.
 */
export const undeliveredAdmin = new Hono<{ Bindings: Env }>()

const back = (msg: string, kind?: string) =>
  `/undelivered?flash=${encodeURIComponent(msg)}${kind ? `&kind=${kind}` : ''}`

const SOURCE_LABEL: Record<string, string> = {
  broadcast: 'Broadcast',
  sequence: 'Sequence',
  transactional: 'Transactional',
  form: 'Form delivery',
  preview: 'Preview',
}

const SendAgain = ({ target, n }: { target: ResendTarget; n: number }) => (
  <form method="post" action="/undelivered/send-again" style="display:inline">
    <input type="hidden" name="kind" value={target.kind} />
    <input type="hidden" name="id" value={String(target.id)} />
    <input type="hidden" name="confirm" value="send-again" />
    <button class="btn sm">{n === 1 ? 'Send again' : `Send ${n.toLocaleString('en-US')} again`}</button>
  </form>
)

/**
 * One message that may already have gone. The operator has to tick that they
 * checked the provider before the button does anything; there is no bulk form.
 */
const SendCheckedAgain = ({ id }: { id: number }) => (
  <form method="post" action="/undelivered/send-again" style="display:inline">
    <input type="hidden" name="kind" value="message" />
    <input type="hidden" name="id" value={String(id)} />
    <input type="hidden" name="confirm" value="send-again" />
    <label class="faint" style="margin-right:8px">
      <input type="checkbox" name="checked" value="yes" required /> I checked: it did not arrive
    </label>
    <button class="btn sm">Send this one again</button>
  </form>
)

undeliveredAdmin.get('/undelivered', async (c) => {
  const db = getDb(c.env)
  const report = await undeliveredMail(db)

  return c.html(
    <Layout title="Undelivered" nav="undel">
      <div class="head">
        <div>
          <h1>Undelivered</h1>
          <div class="sub">
            Mail that should have gone and didn't: the queue gave up on it, or the provider
            refused it. Nothing here is lost. Fix what stopped it, then send it again. Anyone who
            has unsubscribed since is checked again and skipped, and nobody who already got it is
            mailed twice.
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>
            {report.total === 0
              ? 'Nothing undelivered'
              : `${report.total.toLocaleString('en-US')} undelivered`}
          </h2>
        </div>
        <div class="card-b flush">
          {report.groups.length === 0 ? (
            <div class="empty">
              <p>
                {report.checkFirstTotal > 0
                  ? 'Nothing to send again in bulk. The messages under "Check before sending" need a look first.'
                  : 'Every message either went, or was held back on purpose.'}
              </p>
              <p class="faint">
                Suppressed mail (unsubscribed, bounced, opted out) is not here: it was never meant
                to go.
              </p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>What</th>
                  <th>Kind</th>
                  <th>Messages</th>
                  <th>Error</th>
                  <th>Latest</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {report.groups.map((g) => (
                  <tr>
                    <td>
                      {g.target.kind === 'broadcast' ? (
                        <a href={`/broadcasts/${g.target.id}`}>{g.label}</a>
                      ) : (
                        g.label
                      )}
                    </td>
                    <td>
                      <span class="pill">{SOURCE_LABEL[g.source] ?? g.source}</span>
                    </td>
                    <td class="mono">{g.count.toLocaleString('en-US')}</td>
                    <td class="faint">{g.sampleError ?? '-'}</td>
                    <td class="faint">{fmtDate(g.lastAt)}</td>
                    <td style="text-align:right">
                      <SendAgain target={g.target} n={g.count} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {report.recent.length > 0 ? (
        <div class="card">
          <div class="card-h">
            <h2>One at a time</h2>
          </div>
          <div class="card-b flush">
            <table>
              <thead>
                <tr>
                  <th>To</th>
                  <th>Subject</th>
                  <th>Error</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {report.recent.map((m) => (
                  <tr>
                    <td class="mono">{m.toEmail}</td>
                    <td>{m.subject}</td>
                    <td class="faint">{m.error ?? '-'}</td>
                    <td class="faint">{fmtDate(m.createdAt)}</td>
                    <td style="text-align:right">
                      <SendAgain target={{ kind: 'message', id: m.id }} n={1} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {report.checkFirst.length > 0 ? (
        <div class="card">
          <div class="card-h">
            <h2>Check before sending ({report.checkFirstTotal.toLocaleString('en-US')})</h2>
          </div>
          <div class="card-b">
            <p class="faint">
              These may already be in the reader's inbox, or the provider took them and then refused
              them. Sending one again blind could be their second copy, so none of them are sent in
              bulk. Look each one up in the provider's logs first; if it really did not arrive, send
              that one again.
            </p>
          </div>
          <div class="card-b flush">
            <table>
              <thead>
                <tr>
                  <th>To</th>
                  <th>Subject</th>
                  <th>What happened</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {report.checkFirst.map((m) => (
                  <tr>
                    <td class="mono">{m.toEmail}</td>
                    <td>{m.subject}</td>
                    <td class="faint">{m.error ?? '-'}</td>
                    <td class="faint">{fmtDate(m.createdAt)}</td>
                    <td style="text-align:right">
                      <SendCheckedAgain id={m.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {report.notOffered.length > 0 ? (
        <div class="card">
          <div class="card-h">
            <h2>Not offered</h2>
          </div>
          <div class="card-b flush">
            <table>
              <thead>
                <tr>
                  <th>Sequence step</th>
                  <th>Messages</th>
                  <th>Why not</th>
                </tr>
              </thead>
              <tbody>
                {report.notOffered.map((g) => (
                  <tr>
                    <td>{g.label}</td>
                    <td class="mono">{g.count.toLocaleString('en-US')}</td>
                    <td class="faint">{g.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {report.renderedToOutbox > 0 ? (
        <p class="faint">
          {report.renderedToOutbox.toLocaleString('en-US')} messages were rendered to the{' '}
          <a href="/outbox">Outbox</a> by the <span class="mono">console</span> provider instead of
          going out. They are not offered here: the console provider is also the development
          default, and sending its renderings for real would mail people old test copies.
        </p>
      ) : null}
    </Layout>,
  )
})

undeliveredAdmin.post('/undelivered/send-again', async (c) => {
  const form = await c.req.parseBody()
  // Same shape as the broadcast send button: a request without the confirm
  // field sends nothing, so a stray POST or a prefetch can't put mail out.
  if (form.confirm !== 'send-again') return c.redirect(back('Nothing was sent.', 'warn'))

  const kind = String(form.kind ?? '')
  const id = Number(form.id)
  if (!Number.isInteger(id) || id <= 0 || !['broadcast', 'step', 'message'].includes(kind)) {
    return c.redirect(back('Nothing was sent: that is not something that can be sent again.', 'warn'))
  }

  // Mail that may already have gone needs the operator's tick that they
  // looked, and only ever goes one message at a time.
  const checked = form.checked === 'yes'
  if (checked && kind !== 'message') {
    return c.redirect(back('Nothing was sent: that is sent again one message at a time.', 'warn'))
  }
  const result = await sendAgain(c.env, getDb(c.env), { kind, id } as ResendTarget, { checked })
  if (!result.ok) return c.redirect(back(`Nothing was sent: ${result.reason}.`, 'warn'))
  return c.redirect(
    back(
      result.requeued === 0
        ? 'Nothing left to send: it has already been sent again.'
        : `Queued ${result.requeued.toLocaleString('en-US')} to send again.`,
    ),
  )
})
