import type { FC } from 'hono/jsx'
import { Hono } from 'hono'
import { listCampaigns } from '../core/campaigns.ts'
import {
  type KindRow,
  createKind,
  deleteKind,
  listKinds,
  offerOptions,
  updateKind,
} from '../core/conversions.ts'
import {
  type GoalProgress,
  type PeriodType,
  MONTH_OPTIONS,
  QUARTERS,
  createGoal,
  currentPeriod,
  deleteGoal,
  getGoal,
  kindOptions,
  listGoalProgress,
  updateGoal,
  windowFor,
  yearOptions,
} from '../core/goals.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtMoney } from './layout.tsx'

export const goalsAdmin = new Hono<{ Bindings: Env }>()

/**
 * ⭐ Goals — targets, and the kinds they are measured in.
 *
 * Two things live on this screen because they are two halves of one idea: a kind
 * is *what counts* ("joined a cohort"), a goal is *how many by when* ("30 of them
 * in Q3"). Splitting them across two pages would mean bouncing between screens to
 * set up a single number.
 */

const PERIOD_TYPES: PeriodType[] = ['month', 'quarter', 'year']

const RULE_HELP: Record<KindRow['ruleType'], string> = {
  price_interval:
    'Matches when the sale bills on this Stripe interval. Put "year" here for subscriptions — it is the only signal that survives, since most yearly subscribers sit on products that were never tagged as such.',
  offer_in:
    'Matches when the sale resolves to one of these offer slugs, comma separated. This is how a cohort works — it is just a specific offer.',
  any_sale: 'Matches anything that got this far. The catch-all; give it the highest priority number so it goes last.',
  manual: 'Never matches automatically. For goals you fill in by hand.',
}

/** Dollars typed into a form → integer cents. */
function readCents(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

function readCount(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * One goal, as a headline and a bar.
 *
 * Shows pace only while the period is open: "62% of the way there, 45% through
 * the quarter" is the sentence that makes a number actionable, and it is
 * meaningless once the window has closed.
 */
export const GoalBar: FC<{ g: GoalProgress }> = ({ g }) => {
  const pct = g.pctCount ?? g.pctCents
  const actual = g.targetCount !== null ? `${g.count.toLocaleString('en-US')}` : fmtMoney(g.cents)
  const target =
    g.targetCount !== null
      ? g.targetCount.toLocaleString('en-US')
      : g.targetCents !== null
        ? fmtMoney(g.targetCents)
        : null
  const elapsedPct = g.elapsed === null ? null : Math.round(g.elapsed * 100)

  return (
    <div style="margin-bottom:20px">
      <div class="row" style="justify-content:space-between;align-items:baseline;gap:12px">
        <div>
          <a href={`/goals/${g.id}`} style="font-weight:500">
            {g.name}
          </a>
          <span class="faint"> · {g.window.label}</span>
          {g.state === 'closed' ? <span class="faint"> · closed</span> : null}
          {g.state === 'upcoming' ? <span class="faint"> · not started</span> : null}
        </div>
        <div style="font-variant-numeric:tabular-nums">
          <strong>{actual}</strong>
          {target ? <span class="faint"> / {target}</span> : null}
          {pct !== null ? <span class="faint"> · {pct}%</span> : null}
        </div>
      </div>

      {pct === null ? (
        <div class="faint" style="font-size:12.5px;margin-top:6px">
          No target set — tracking only.
        </div>
      ) : (
        <div class="meter">
          <i style={`width:${Math.min(100, pct)}%`} />
        </div>
      )}

      <div class="faint" style="font-size:12.5px;margin-top:6px">
        {g.kindLabel}
        {g.campaignName ? ` · ${g.campaignName}` : ''}
        {/* Both targets set: the bar tracks one, so the other still needs saying. */}
        {g.targetCount !== null && g.targetCents !== null
          ? ` · ${fmtMoney(g.cents)} of ${fmtMoney(g.targetCents)}`
          : ''}
        {elapsedPct !== null ? ` · ${elapsedPct}% through the period` : ''}
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────── list

goalsAdmin.get('/goals', async (c) => {
  const db = getDb(c.env)
  const [progress, kinds, kindPick, camps] = await Promise.all([
    listGoalProgress(db),
    listKinds(db, true),
    kindOptions(db),
    listCampaigns(db),
  ])

  const now = currentPeriod('quarter')
  const years = yearOptions()

  return c.html(
    <Layout title="Goals" nav="goals">
      <div class="head">
        <div>
          <h1>Goals</h1>
          <div class="sub">How many of what, by when — measured against the conversion log.</div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>{progress.length} goals</h2>
        </div>
        <div class="card-b">
          {progress.length === 0 ? (
            <div class="empty">
              <p>No goals yet.</p>
              <p class="faint">Set one below — a kind, a number, and a period.</p>
            </div>
          ) : (
            progress.map((g) => <GoalBar g={g} />)
          )}
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>New goal</h2>
        </div>
        <div class="card-b">
          <form method="post" action="/goals">
            <label>Name</label>
            <input type="text" name="name" placeholder="Q3 cohort signups" required />

            <label style="margin-top:16px">What counts</label>
            <select name="kindId">
              <option value="">Any conversion</option>
              {kindPick.map((k) => (
                <option value={String(k.id)}>{k.label}</option>
              ))}
            </select>

            <label style="margin-top:16px">Period</label>
            <div class="row" style="gap:8px">
              <select name="periodType">
                {PERIOD_TYPES.map((t) => (
                  <option value={t} selected={t === 'year'}>
                    {t === 'month' ? 'Month' : t === 'quarter' ? 'Quarter' : 'Year'}
                  </option>
                ))}
              </select>
              <select name="periodYear">
                {years.map((y) => (
                  <option value={String(y)} selected={y === now.year}>
                    {y}
                  </option>
                ))}
              </select>
              <select name="periodIndex">
                <optgroup label="If quarter">
                  {QUARTERS.map((q) => (
                    <option value={String(q)} selected={q === now.index}>
                      Q{q}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="If month">
                  {MONTH_OPTIONS.map((m) => (
                    <option value={String(m.index)}>{m.name}</option>
                  ))}
                </optgroup>
              </select>
            </div>
            <p class="faint" style="margin:6px 0 16px">
              Periods are whole months, quarters or years — never an arbitrary range, so this
              quarter can always be held against the last one. The third box is ignored for a
              yearly goal.
            </p>

            <div class="row" style="gap:12px">
              <div style="flex:1">
                <label>Target — how many people</label>
                <input type="text" name="targetCount" placeholder="30" inputmode="numeric" />
              </div>
              <div style="flex:1">
                <label>Target — how much money</label>
                <input type="text" name="targetCents" placeholder="40000" inputmode="decimal" />
              </div>
            </div>
            <p class="faint" style="margin:6px 0 16px">
              Set either or both. The bar tracks headcount when it is set, money otherwise.
            </p>

            <label>Only this campaign (optional)</label>
            <select name="campaignId">
              <option value="">Everything in the period</option>
              {camps.map((cam) => (
                <option value={String(cam.id)}>{cam.name}</option>
              ))}
            </select>
            <p class="faint" style="margin:6px 0 16px">
              Goals overlap on purpose — a campaign goal and a quarterly goal both count the same
              conversion. They are lenses, not buckets, so their totals will not sum to anything.
            </p>

            <button class="btn primary">Create goal</button>
          </form>
        </div>
      </div>

      {/* ── kinds ─────────────────────────────────────────────────────── */}
      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>What counts as a conversion</h2>
        </div>
        <div class="card-b flush">
          <table>
            <thead>
              <tr>
                <th class="num">Order</th>
                <th>Kind</th>
                <th>Rule</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {kinds.map((k) => (
                <tr style={k.isActive ? '' : 'opacity:.5'}>
                  <td class="num faint">{k.priority}</td>
                  <td>
                    <strong>{k.label}</strong>
                    <div class="faint mono">{k.slug}</div>
                  </td>
                  <td class="mono faint">
                    {k.ruleType}
                    {k.ruleValue ? ` = ${k.ruleValue}` : ''}
                  </td>
                  <td style="text-align:right">
                    <form method="post" action={`/goals/kinds/${k.id}/toggle`} style="display:inline">
                      <button class="btn sm">{k.isActive ? 'Disable' : 'Enable'}</button>
                    </form>
                    <form method="post" action={`/goals/kinds/${k.id}/delete`} style="display:inline;margin-left:6px">
                      <button class="btn sm danger">Delete</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="card-b">
          <p class="faint" style="margin:0 0 16px">
            Walked lowest order first, and the <strong>first match wins</strong> — which is what
            keeps one sale from counting as two things and doubling revenue. Keep the catch-all
            last.
          </p>

          <form method="post" action="/goals/kinds">
            <div class="row" style="gap:12px">
              <div style="flex:1">
                <label>Label</label>
                <input type="text" name="label" placeholder="Joined a cohort" required />
              </div>
              <div style="flex:1">
                <label>Slug</label>
                <input type="text" name="slug" placeholder="cohort" required />
              </div>
              <div style="width:110px">
                <label>Order</label>
                <input type="text" name="priority" value="50" inputmode="numeric" />
              </div>
            </div>

            <label style="margin-top:16px">Rule</label>
            <select name="ruleType">
              <option value="offer_in">Offer is one of…</option>
              <option value="price_interval">Stripe price interval is…</option>
              <option value="any_sale">Any sale (catch-all)</option>
              <option value="manual">Manual only</option>
            </select>

            <label style="margin-top:16px">Rule value</label>
            <input type="text" name="ruleValue" placeholder="ai-pivot, accelerator" />
            <p class="faint" style="margin:6px 0 16px">
              {RULE_HELP.offer_in} For an interval rule the value is <span class="mono">year</span>{' '}
              or <span class="mono">month</span>; the catch-all and manual rules ignore it.
            </p>

            <button class="btn primary">Add kind</button>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

// ───────────────────────────────────────────────── goal write

goalsAdmin.post('/goals', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const name = String(form.get('name') ?? '').trim()
  if (!name) return c.redirect('/goals?flash=A goal needs a name.&kind=warn')

  const periodTypeRaw = String(form.get('periodType') ?? 'year')
  const periodType: PeriodType = PERIOD_TYPES.includes(periodTypeRaw as PeriodType)
    ? (periodTypeRaw as PeriodType)
    : 'year'

  const kindRaw = String(form.get('kindId') ?? '').trim()
  const campRaw = String(form.get('campaignId') ?? '').trim()

  const id = await createGoal(db, {
    name,
    kindId: kindRaw ? Number(kindRaw) : null,
    periodType,
    periodYear: Number(String(form.get('periodYear') ?? '')) || currentPeriod('year').year,
    // A yearly goal has no index; storing 0 keeps the row honest about that.
    periodIndex: periodType === 'year' ? 0 : Number(String(form.get('periodIndex') ?? '1')) || 1,
    targetCount: readCount(String(form.get('targetCount') ?? '')),
    targetCents: readCents(String(form.get('targetCents') ?? '')),
    campaignId: campRaw ? Number(campRaw) : null,
  })

  if (!id) return c.redirect('/goals?flash=Could not create that goal.&kind=warn')
  return c.redirect(`/goals/${id}?flash=Goal created.`)
})

// ───────────────────────────────────────────────── kinds write
//
// ⚠️ Registered BEFORE `/goals/:id`. Hono matches in registration order, so with
// the parameter route first, `POST /goals/kinds` binds `id = "kinds"` and every
// kind you add silently redirects to `/goals/NaN`.

goalsAdmin.post('/goals/kinds', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const ruleTypeRaw = String(form.get('ruleType') ?? 'manual')
  const ruleType: KindRow['ruleType'] = (
    ['price_interval', 'offer_in', 'any_sale', 'manual'] as const
  ).includes(ruleTypeRaw as KindRow['ruleType'])
    ? (ruleTypeRaw as KindRow['ruleType'])
    : 'manual'

  const id = await createKind(db, {
    slug: String(form.get('slug') ?? ''),
    label: String(form.get('label') ?? ''),
    ruleType,
    ruleValue: String(form.get('ruleValue') ?? '') || null,
    priority: Number(String(form.get('priority') ?? '50').replace(/[^0-9]/g, '')) || 50,
  })

  if (!id) {
    return c.redirect('/goals?flash=That kind needs a label and a unique slug.&kind=warn')
  }
  return c.redirect('/goals?flash=Kind added.')
})

goalsAdmin.post('/goals/kinds/:id/toggle', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const kinds = await listKinds(db, true)
  const kind = kinds.find((k) => k.id === id)
  if (kind) await updateKind(db, id, { isActive: !kind.isActive })
  return c.redirect('/goals?flash=Saved.')
})

goalsAdmin.post('/goals/kinds/:id/delete', async (c) => {
  const db = getDb(c.env)
  await deleteKind(db, Number(c.req.param('id')))
  return c.redirect(
    '/goals?flash=Kind deleted. Conversions counted under it keep their frozen label.',
  )
})

// Referenced by the rule help text above; kept here so the picker and the copy
// cannot drift apart.
export { RULE_HELP, offerOptions }

goalsAdmin.get('/goals/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const goal = await getGoal(db, id)
  if (!goal) return c.notFound()

  const [kindPick, camps] = await Promise.all([kindOptions(db), listCampaigns(db)])
  const win = windowFor({
    type: goal.periodType,
    year: goal.periodYear,
    index: goal.periodIndex,
  })
  const years = yearOptions()

  return c.html(
    <Layout title={goal.name} nav="goals">
      <div class="head">
        <div>
          <div class="eyebrow">
            <a href="/goals">Goals</a>
          </div>
          <h1>{goal.name}</h1>
          <div class="sub">
            {win.label} · {win.start.toISOString().slice(0, 10)} to{' '}
            {new Date(win.end.getTime() - 1).toISOString().slice(0, 10)}
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b">
          <form method="post" action={`/goals/${goal.id}`}>
            <label>Name</label>
            <input type="text" name="name" value={goal.name} required />

            <label style="margin-top:16px">What counts</label>
            <select name="kindId">
              <option value="">Any conversion</option>
              {kindPick.map((k) => (
                <option value={String(k.id)} selected={goal.kindId === k.id}>
                  {k.label}
                </option>
              ))}
            </select>

            <label style="margin-top:16px">Period</label>
            <div class="row" style="gap:8px">
              <select name="periodType">
                {PERIOD_TYPES.map((t) => (
                  <option value={t} selected={goal.periodType === t}>
                    {t === 'month' ? 'Month' : t === 'quarter' ? 'Quarter' : 'Year'}
                  </option>
                ))}
              </select>
              <select name="periodYear">
                {years.map((y) => (
                  <option value={String(y)} selected={goal.periodYear === y}>
                    {y}
                  </option>
                ))}
              </select>
              <select name="periodIndex">
                <optgroup label="If quarter">
                  {QUARTERS.map((q) => (
                    <option
                      value={String(q)}
                      selected={goal.periodType === 'quarter' && goal.periodIndex === q}
                    >
                      Q{q}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="If month">
                  {MONTH_OPTIONS.map((m) => (
                    <option
                      value={String(m.index)}
                      selected={goal.periodType === 'month' && goal.periodIndex === m.index}
                    >
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>

            <div class="row" style="gap:12px;margin-top:16px">
              <div style="flex:1">
                <label>Target — how many people</label>
                <input
                  type="text"
                  name="targetCount"
                  value={goal.targetCount === null ? '' : String(goal.targetCount)}
                  inputmode="numeric"
                />
              </div>
              <div style="flex:1">
                <label>Target — how much money</label>
                <input
                  type="text"
                  name="targetCents"
                  value={goal.targetCents === null ? '' : (goal.targetCents / 100).toFixed(2)}
                  inputmode="decimal"
                />
              </div>
            </div>

            <label style="margin-top:16px">Only this campaign (optional)</label>
            <select name="campaignId">
              <option value="">Everything in the period</option>
              {camps.map((cam) => (
                <option value={String(cam.id)} selected={goal.campaignId === cam.id}>
                  {cam.name}
                </option>
              ))}
            </select>

            <div class="row" style="gap:8px;margin-top:18px">
              <button class="btn primary">Save</button>
              <a class="btn" href="/goals">
                Back
              </a>
            </div>
          </form>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-b">
          <form method="post" action={`/goals/${goal.id}/delete`}>
            <button class="btn danger sm">Delete goal</button>
            <p class="faint" style="margin:8px 0 0">
              Only the target goes. Every conversion it was counting stays exactly where it is.
            </p>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

goalsAdmin.post('/goals/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const name = String(form.get('name') ?? '').trim()
  if (!name) return c.redirect(`/goals/${id}?flash=A goal needs a name.&kind=warn`)

  const periodTypeRaw = String(form.get('periodType') ?? 'year')
  const periodType: PeriodType = PERIOD_TYPES.includes(periodTypeRaw as PeriodType)
    ? (periodTypeRaw as PeriodType)
    : 'year'

  const kindRaw = String(form.get('kindId') ?? '').trim()
  const campRaw = String(form.get('campaignId') ?? '').trim()

  await updateGoal(db, id, {
    name,
    kindId: kindRaw ? Number(kindRaw) : null,
    periodType,
    periodYear: Number(String(form.get('periodYear') ?? '')) || currentPeriod('year').year,
    periodIndex: periodType === 'year' ? 0 : Number(String(form.get('periodIndex') ?? '1')) || 1,
    targetCount: readCount(String(form.get('targetCount') ?? '')),
    targetCents: readCents(String(form.get('targetCents') ?? '')),
    campaignId: campRaw ? Number(campRaw) : null,
  })
  return c.redirect(`/goals/${id}?flash=Saved.`)
})

goalsAdmin.post('/goals/:id/delete', async (c) => {
  const db = getDb(c.env)
  await deleteGoal(db, Number(c.req.param('id')))
  return c.redirect('/goals?flash=Goal deleted. The conversions it counted are untouched.')
})
