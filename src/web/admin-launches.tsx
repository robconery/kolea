import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Child, FC } from 'hono/jsx'
import { aiReady, modelFor, modelLabel } from '../core/ai/openrouter.ts'
import { listCampaigns } from '../core/campaigns.ts'
import {
  type BriefInput,
  type LaunchStep,
  STEPS,
  STEP_LABEL,
  blockedReason,
  buildSequence,
  choosePlan,
  closeLaunch,
  createLaunch,
  deleteLaunch,
  getLaunch,
  handOff,
  isStep,
  launchTemplates,
  listLaunches,
  offerChoices,
  openCampaign,
  readiness,
  review,
  saveBrief,
  saveCopy,
  stepIndex,
  suggestOutline,
} from '../core/launches/index.ts'
import { templateSchedule } from '../core/sequence-templates/index.ts'
import { getDb } from '../db/index.ts'
import type { Launch } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate, fmtDay, fmtMoney, statusPill } from './layout.tsx'

/**
 * Launch Studio: seven screens from describing an offer to reading how the
 * launch went. Thin: every rule is in `core/launches/`.
 *
 * Nothing on these screens sends, activates, schedules or publishes. Step 6
 * hands the operator to the sequence's own screen (Go live, behind its
 * preflight) and to the broadcast composer; the studio only links there.
 */
export const launchesAdmin = new Hono<{ Bindings: Env }>()

type C = Context<{ Bindings: Env }>

const BASE = '/launches'

const flashTo = (path: string, msg: string, kind?: string) =>
  `${path}?flash=${encodeURIComponent(msg)}${kind ? `&kind=${kind}` : ''}`

const stepUrl = (id: number, step: LaunchStep) => `${BASE}/${id}/${step}`

const STATUS_LABEL: Record<Launch['status'], string> = {
  draft: 'draft',
  handed_off: 'handed off',
  closed: 'closed',
}

const money = (rows: { currency: string; cents: number }[]) =>
  rows.length === 0 ? '$0.00' : rows.map((r) => fmtMoney(r.cents, r.currency)).join(' + ')

const str = (form: FormData, k: string) => String(form.get(k) ?? '')

function readBriefForm(form: FormData): BriefInput {
  const offerId = Number(str(form, 'storeOfferId'))
  return {
    name: str(form, 'name'),
    offer: str(form, 'offer'),
    audience: str(form, 'audience'),
    problem: str(form, 'problem'),
    promise: str(form, 'promise'),
    story: str(form, 'story'),
    objections: str(form, 'objections'),
    priceNote: str(form, 'priceNote'),
    storeOfferId: Number.isInteger(offerId) && offerId > 0 ? offerId : null,
  }
}

// ─────────────────────────────────────────────────── pieces

const Stepper: FC<{ l: Launch; on: LaunchStep }> = ({ l, on }) => (
  <ol class="tabs" style="list-style:none;padding:0;flex-wrap:wrap">
    {STEPS.map((s, i) => {
      const open = blockedReason(l, s) === null
      const label = `${i + 1}. ${STEP_LABEL[s]}`
      return (
        <li>
          {open ? (
            <a href={stepUrl(l.id, s)} class={s === on ? 'on' : ''} aria-current={s === on ? 'step' : undefined}>
              {label}
            </a>
          ) : (
            <span class="faint" style="padding:8px 12px;display:inline-block">
              {label}
            </span>
          )}
        </li>
      )
    })}
  </ol>
)

const Shell: FC<{ c: C; l: Launch; on: LaunchStep; children?: Child }> = ({ c, l, on, children }) => (
  <Layout title={`${l.name} · ${STEP_LABEL[on]}`} nav="launch">
    <div class="head">
      <div>
        <h1>{l.name}</h1>
        <div class="sub">
          {statusPill(l.status === 'closed' ? 'archived' : l.status === 'handed_off' ? 'active' : 'draft')}{' '}
          {STATUS_LABEL[l.status]} · step {stepIndex(on) + 1} of 7 · nothing here sends mail
        </div>
      </div>
      <div class="actions">
        <a class="btn" href={BASE}>
          All launches
        </a>
      </div>
    </div>
    <Stepper l={l} on={on} />
    <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />
    {children}
  </Layout>
)

const Field: FC<{ name: string; label: string; value?: string | null; hint?: string; long?: boolean; required?: boolean }> = ({
  name,
  label,
  value,
  hint,
  long,
  required,
}) => (
  <div class="field">
    <label for={name}>{label}</label>
    {long ? (
      <textarea id={name} name={name} style="min-height:90px">
        {value ?? ''}
      </textarea>
    ) : (
      <input type="text" id={name} name={name} value={value ?? ''} required={required} />
    )}
    {hint ? (
      <div class="faint" style="margin-top:6px">
        {hint}
      </div>
    ) : null}
  </div>
)

const BriefFields: FC<{ l?: Launch | null; offers: { id: number; name: string; slug: string }[] }> = ({ l, offers }) => (
  <>
    <Field name="name" label="Name the launch" value={l?.name} required />
    <Field name="offer" label="What are you selling?" value={l?.offer} long hint="A sentence or two, in your own words." />
    <Field name="priceNote" label="Price" value={l?.priceNote} hint="As you would say it: “$149”, “pay what you want”." />
    <Field name="audience" label="Who is it for?" value={l?.audience} long />
    <Field name="problem" label="What are they stuck on?" value={l?.problem} long />
    <Field name="promise" label="What does it promise?" value={l?.promise} long />
    <Field name="story" label="Why do you care? The story behind it." value={l?.story} long />
    <Field name="objections" label="What makes people hesitate?" value={l?.objections} long />
    {offers.length > 0 ? (
      <div class="field">
        <label for="storeOfferId">Sold through the store as</label>
        <select id="storeOfferId" name="storeOfferId">
          <option value="">(not sold through the store)</option>
          {offers.map((o) => (
            <option value={String(o.id)} selected={l?.storeOfferId === o.id}>
              {o.name} · /offers/{o.slug}
            </option>
          ))}
        </select>
      </div>
    ) : null}
  </>
)

/** Closed launches show their forms, but nothing can be saved. */
const Save: FC<{ l: Launch; label: string }> = ({ l, label }) =>
  l.status === 'closed' ? null : <button class="btn primary">{label}</button>

// ─────────────────────────────────────────────────── list and create

launchesAdmin.get(BASE, async (c) => {
  const db = getDb(c.env)
  const [all, offers] = await Promise.all([listLaunches(db), offerChoices(db)])
  return c.html(
    <Layout title="Launch Studio" nav="launch">
      <div class="head">
        <div>
          <h1>Launch Studio</h1>
          <div class="sub">
            Seven steps from describing an offer to reading how it went. The studio builds a campaign and
            a paused sequence; you take them live on their own screens.
          </div>
        </div>
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />
      {all.length > 0 ? (
        <div class="card">
          <div class="card-b flush">
            <table>
              <thead>
                <tr>
                  <th>Launch</th>
                  <th>Step</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {all.map((l) => (
                  <tr>
                    <td>
                      <a href={`${BASE}/${l.id}`}>{l.name}</a>
                    </td>
                    <td>
                      {stepIndex(l.step) + 1}. {STEP_LABEL[l.step]}
                    </td>
                    <td>{STATUS_LABEL[l.status]}</td>
                    <td>{fmtDate(l.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      <div class="card">
        <div class="card-h">
          <h2>1. Describe a new offer</h2>
        </div>
        <div class="card-b">
          <form method="post" action={BASE}>
            <BriefFields offers={offers} />
            <button class="btn primary">Start the launch</button>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

launchesAdmin.post(BASE, async (c) => {
  const r = await createLaunch(getDb(c.env), readBriefForm(await c.req.formData()))
  if (!r.ok) return c.redirect(flashTo(BASE, r.reason, 'warn'))
  return c.redirect(flashTo(stepUrl(r.id, 'plan'), 'Saved. Now choose how it launches.'))
})

launchesAdmin.get(`${BASE}/:id{[0-9]+}`, async (c) => {
  const l = await getLaunch(getDb(c.env), Number(c.req.param('id')))
  if (!l) return c.notFound()
  return c.redirect(stepUrl(l.id, l.step))
})

launchesAdmin.post(`${BASE}/:id{[0-9]+}/delete`, async (c) => {
  await deleteLaunch(getDb(c.env), Number(c.req.param('id')))
  return c.redirect(flashTo(BASE, 'Launch deleted. Its campaign and sequence are still there.'))
})

// ─────────────────────────────────────────────────── the step screens

async function stepPage(c: C, step: LaunchStep, extra: { outline?: string; flash?: string } = {}) {
  const db = getDb(c.env)
  const l = await getLaunch(db, Number(c.req.param('id')))
  if (!l) return c.notFound()
  const blocked = blockedReason(l, step)
  if (blocked) return c.redirect(flashTo(stepUrl(l.id, l.step), blocked, 'warn'))

  const ai = (await aiReady(c.env, db)) ? modelLabel(await modelFor(c.env, db, 'launch')) : null
  const body = await STEP_BODY[step](c, l, ai, extra)
  return c.html(
    <Shell c={c} l={l} on={step}>
      {extra.flash ? <Flash msg={extra.flash} kind="warn" /> : null}
      {body}
    </Shell>,
  )
}

type Body = (c: C, l: Launch, ai: string | null, extra: { outline?: string }) => Promise<Child>

const STEP_BODY: Record<LaunchStep, Body> = {
  async offer(c, l) {
    const offers = await offerChoices(getDb(c.env))
    return (
      <div class="card">
        <div class="card-b">
          <form method="post" action={stepUrl(l.id, 'offer')}>
            <BriefFields l={l} offers={offers} />
            <Save l={l} label="Save the brief" />
          </form>
        </div>
      </div>
    )
  },

  async plan(c, l) {
    const templates = await launchTemplates(getDb(c.env))
    if (templates.length === 0) {
      return (
        <div class="note">
          There are no launch templates in the library. <a href="/sequences/templates">Restore the starters</a>{' '}
          (Product Launch and The Big Sale), then come back.
        </div>
      )
    }
    const locked = l.sequenceId !== null
    return (
      <div class="card">
        <div class="card-b">
          <form method="post" action={stepUrl(l.id, 'plan')}>
            {templates.map((t) => {
              const days = templateSchedule(t.steps)
              return (
                <label class="field" style="display:block">
                  <input
                    type="radio"
                    name="templateSlug"
                    value={t.slug}
                    checked={l.templateSlug === t.slug}
                    disabled={locked && l.templateSlug !== t.slug}
                    required
                  />{' '}
                  <strong>{t.name}</strong> · {t.steps.length} mails over {(days[days.length - 1] ?? 0) + 1} days
                  <div class="faint">{t.tagline}</div>
                </label>
              )
            })}
            <div class="field">
              <label for="startsOn">The day you mean to open (a note for you; nothing is scheduled)</label>
              <input
                type="date"
                id="startsOn"
                name="startsOn"
                value={l.startsOn ? new Date(l.startsOn).toISOString().slice(0, 10) : ''}
              />
            </div>
            <Save l={l} label="Use this plan" />
          </form>
        </div>
      </div>
    )
  },

  async campaign(c, l) {
    const all = await listCampaigns(getDb(c.env))
    const locked = l.sequenceId !== null
    return (
      <div class="card">
        <div class="card-b">
          <div class="note">
            A campaign is how the launch's sales and clicks are counted together. Making one sends nothing.
          </div>
          <form method="post" action={stepUrl(l.id, 'campaign')}>
            <div class="field">
              <label for="campaignId">Campaign</label>
              <select id="campaignId" name="campaignId" disabled={locked}>
                <option value="">A new campaign called “{l.name}”</option>
                {all.map((cp) => (
                  <option value={String(cp.id)} selected={l.campaignId === cp.id}>
                    {cp.name}
                  </option>
                ))}
              </select>
            </div>
            {l.campaignId ? null : (
              <div class="field">
                <label for="goal">Revenue goal in dollars (optional)</label>
                <input type="number" id="goal" name="goal" min="0" step="1" />
              </div>
            )}
            <Save l={l} label={l.campaignId ? 'Keep this campaign' : 'Open the campaign'} />
          </form>
        </div>
      </div>
    )
  },

  async sequence(c, l, ai) {
    if (l.sequenceId) {
      const r = await readiness(getDb(c.env), l)
      return (
        <div class="note">
          Built: <a href={`/sequences/${l.sequenceId}`}>{r.sequence?.name ?? 'the sequence'}</a>, paused, with{' '}
          {r.sequence?.placeholders ?? 0} placeholders left to rewrite.{' '}
          <a href={stepUrl(l.id, 'copy')}>On to the copy</a>.
        </div>
      )
    }
    return (
      <div class="card">
        <div class="card-b">
          <div class="note">
            This copies the <strong>{l.templateSlug}</strong> template into a <strong>paused</strong> sequence on the
            launch's campaign. Nobody is enrolled and nothing is sent. It can't go live until every{' '}
            <mark class="ph">[[ placeholder ]]</mark> is rewritten, and going live is the sequence's own Go live.
          </div>
          <form method="post" action={stepUrl(l.id, 'sequence')} style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn primary">Build the paused sequence</button>
            {ai ? (
              <button class="btn" name="draft" value="1">
                Build it and draft the mails from the brief with AI
              </button>
            ) : null}
          </form>
        </div>
      </div>
    )
  },

  async copy(c, l, ai, extra) {
    const r = await readiness(getDb(c.env), l)
    return (
      <>
        {r.sequence ? (
          <div class="note">
            The mails live in the sequence: <a href={`/sequences/${r.sequence.id}`}>{r.sequence.name}</a>,{' '}
            {r.sequence.steps} mails, {r.sequence.placeholders} placeholders left.
          </div>
        ) : null}
        <div class="card">
          <div class="card-h">
            <h2>The sales angle</h2>
          </div>
          <div class="card-b">
            <form method="post" action={stepUrl(l.id, 'copy')}>
              <div class="field">
                <label for="outline">The points the sales page and the mails should make</label>
                <textarea id="outline" name="outline" style="min-height:220px">
                  {extra.outline ?? l.outline ?? ''}
                </textarea>
              </div>
              <Save l={l} label="Save the angle" />
            </form>
            {ai && l.status !== 'closed' ? (
              <form method="post" action={`${BASE}/${l.id}/outline`} style="margin-top:12px">
                <button class="btn">Suggest an outline from the brief with {ai}</button>
                <div class="faint" style="margin-top:6px">
                  Fills the box above for you to edit. Nothing is saved until you save it.
                </div>
              </form>
            ) : null}
          </div>
        </div>
      </>
    )
  },

  async handoff(c, l) {
    const r = await readiness(getDb(c.env), l)
    const seq = r.sequence
    return (
      <div class="card">
        <div class="card-h">
          <h2>Take it live, on the screens that do that</h2>
        </div>
        <div class="card-b">
          <ul>
            <li>
              {seq ? (
                <>
                  The sequence <a href={`/sequences/${seq.id}`}>{seq.name}</a> is{' '}
                  <strong>{seq.isActive ? 'live' : 'paused'}</strong>
                  {seq.placeholders > 0 ? `, with ${seq.placeholders} placeholders to rewrite first` : ''}. Go live is
                  on its own screen, after its preflight.
                </>
              ) : (
                'The sequence has been deleted.'
              )}
            </li>
            {l.triggerTagId ? (
              <li>
                It starts when someone gets the <span class="mono">launch-{l.slug}</span> tag.
              </li>
            ) : null}
            <li>
              Announce it with a <a href="/broadcasts/new">broadcast</a>, and put it in the campaign
              {r.campaign ? (
                <>
                  {' '}
                  <a href={`/campaigns/${r.campaign.id}`}>{r.campaign.name}</a>
                </>
              ) : null}
              .
            </li>
            <li>
              {r.offer ? (
                <>
                  The store sells it at <a href={`/store/for-sale`}>/offers/{r.offer.slug}</a>.
                </>
              ) : (
                <>
                  Not sold through the store. <a href="/store/for-sale">Put it on sale</a> if it should be.
                </>
              )}
            </li>
            {l.startsOn ? <li>You meant to open on {fmtDay(l.startsOn)}.</li> : null}
          </ul>
          {l.status === 'draft' ? (
            <form method="post" action={stepUrl(l.id, 'handoff')}>
              <button class="btn primary">I have what I need: on to the review</button>
            </form>
          ) : null}
        </div>
      </div>
    )
  },

  async review(c, l) {
    const rv = await review(getDb(c.env), l)
    const totalConv = rv.conversions.reduce((n, x) => n + x.n, 0)
    return (
      <>
        {rv.stats ? (
          <div class="card">
            <div class="card-b flush">
              <div class="stats">
                <div class="stat hi">
                  <div class="n">{money(rv.stats.revenue)}</div>
                  <div class="l">Net revenue</div>
                </div>
                <div class="stat">
                  <div class="n">{rv.stats.orders}</div>
                  <div class="l">Orders</div>
                </div>
                <div class="stat">
                  <div class="n">{rv.stats.refunds}</div>
                  <div class="l">Refunds</div>
                </div>
                <div class="stat">
                  <div class="n">{rv.stats.people}</div>
                  <div class="l">People touched</div>
                </div>
                <div class="stat">
                  <div class="n">{totalConv}</div>
                  <div class="l">Conversions</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div class="note">The campaign has been deleted, so there is nothing to count.</div>
        )}
        {rv.steps.length > 0 ? (
          <div class="card">
            <div class="card-h">
              <h2>The sequence, mail by mail</h2>
            </div>
            <div class="card-b flush">
              <table>
                <thead>
                  <tr>
                    <th>Mail</th>
                    <th class="num">Sent</th>
                    <th class="num">Opened</th>
                    <th class="num">Clicked</th>
                    <th class="num">Converted</th>
                  </tr>
                </thead>
                <tbody>
                  {rv.steps.map((s) => (
                    <tr>
                      <td>
                        {s.position}. {s.subject}
                      </td>
                      <td class="num">{s.sent}</td>
                      <td class="num">{s.opened}</td>
                      <td class="num">{s.clicked}</td>
                      <td class="num">{s.converted}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {rv.sales.length > 0 ? (
          <div class="card">
            <div class="card-h">
              <h2>Recent sales</h2>
            </div>
            <div class="card-b flush">
              <table>
                <tbody>
                  {rv.sales.map((s) => (
                    <tr>
                      <td>{s.email}</td>
                      <td>{s.sale.status}</td>
                      <td class="num">{fmtMoney(s.sale.amountCents, s.sale.currency)}</td>
                      <td>{fmtDate(s.sale.occurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {l.campaignId ? (
          <div class="note">
            The full picture is on the <a href={`/campaigns/${l.campaignId}`}>campaign</a> and in{' '}
            <a href={l.sequenceId ? `/analytics/sequences/${l.sequenceId}` : '/analytics/sequences'}>sequence analytics</a>.
          </div>
        ) : null}
        {l.status === 'handed_off' ? (
          <form method="post" action={`${BASE}/${l.id}/close`}>
            <button class="btn">Close the launch</button>
          </form>
        ) : null}
      </>
    )
  },
}

launchesAdmin.get(`${BASE}/:id{[0-9]+}/:step`, async (c) => {
  const step = c.req.param('step')
  if (!isStep(step)) return c.notFound()
  return await stepPage(c, step)
})

// ─────────────────────────────────────────────────── the step writes

/** After a write: on to the next screen, or back with the reason. */
function after(c: C, id: number, here: LaunchStep, r: { ok: true } | { ok: false; reason: string }, msg: string) {
  if (!r.ok) return c.redirect(flashTo(stepUrl(id, here), r.reason, 'warn'))
  const next = STEPS[stepIndex(here) + 1] ?? 'review'
  return c.redirect(flashTo(stepUrl(id, next), msg))
}

const idOf = (c: C) => Number(c.req.param('id'))

launchesAdmin.post(`${BASE}/:id{[0-9]+}/offer`, async (c) => {
  const r = await saveBrief(getDb(c.env), idOf(c), readBriefForm(await c.req.formData()))
  return after(c, idOf(c), 'offer', r, 'Brief saved.')
})

launchesAdmin.post(`${BASE}/:id{[0-9]+}/plan`, async (c) => {
  const form = await c.req.formData()
  const day = str(form, 'startsOn')
  const startsOn = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T12:00:00Z`) : null
  const r = await choosePlan(getDb(c.env), idOf(c), { templateSlug: str(form, 'templateSlug'), startsOn })
  return after(c, idOf(c), 'plan', r, 'Plan chosen.')
})

launchesAdmin.post(`${BASE}/:id{[0-9]+}/campaign`, async (c) => {
  const form = await c.req.formData()
  const picked = Number(str(form, 'campaignId'))
  const goal = Number(str(form, 'goal'))
  const r = await openCampaign(getDb(c.env), idOf(c), {
    campaignId: Number.isInteger(picked) && picked > 0 ? picked : null,
    goalCents: Number.isFinite(goal) && goal > 0 ? Math.round(goal * 100) : null,
  })
  return after(c, idOf(c), 'campaign', r, 'Campaign open.')
})

launchesAdmin.post(`${BASE}/:id{[0-9]+}/sequence`, async (c) => {
  const form = await c.req.formData()
  const r = await buildSequence(c.env, getDb(c.env), idOf(c), { draft: str(form, 'draft') === '1' })
  if (!r.ok) return c.redirect(flashTo(stepUrl(idOf(c), 'sequence'), r.reason, 'warn'))
  return c.redirect(flashTo(stepUrl(idOf(c), 'copy'), r.message, r.warn ? 'warn' : undefined))
})

launchesAdmin.post(`${BASE}/:id{[0-9]+}/outline`, async (c) => {
  const db = getDb(c.env)
  const l = await getLaunch(db, idOf(c))
  if (!l) return c.notFound()
  if (blockedReason(l, 'copy')) return c.redirect(stepUrl(l.id, l.step))
  const r = await suggestOutline(c.env, db, l.id)
  if (!r.ok) return await stepPage(c, 'copy', { flash: r.reason })
  return await stepPage(c, 'copy', { outline: r.outline })
})

launchesAdmin.post(`${BASE}/:id{[0-9]+}/copy`, async (c) => {
  const r = await saveCopy(getDb(c.env), idOf(c), str(await c.req.formData(), 'outline'))
  return after(c, idOf(c), 'copy', r, 'Angle saved.')
})

launchesAdmin.post(`${BASE}/:id{[0-9]+}/handoff`, async (c) => {
  const r = await handOff(getDb(c.env), idOf(c))
  return after(c, idOf(c), 'handoff', r, 'Handed off. Come back here once mail has gone out to see how it went.')
})

launchesAdmin.post(`${BASE}/:id{[0-9]+}/close`, async (c) => {
  const r = await closeLaunch(getDb(c.env), idOf(c))
  if (!r.ok) return c.redirect(flashTo(stepUrl(idOf(c), 'review'), r.reason, 'warn'))
  return c.redirect(flashTo(stepUrl(idOf(c), 'review'), 'Launch closed.'))
})
