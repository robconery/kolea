import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import { listCampaigns } from '../core/campaigns.ts'
import {
  FAMILY_LABEL,
  type SequenceTemplate,
  type SequenceTemplateRow,
  TEMPLATE_FAMILIES,
  type TemplateFamily,
  type TemplateStep,
  blankTemplateStep,
  createSequenceFromTemplate,
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  missingStarters,
  restoreStarterTemplates,
  templateSchedule,
  updateTemplate,
} from '../core/sequence-templates/index.ts'
import type { SequenceTrigger } from '../core/sequences.ts'
import { aiConfigured, modelFor, modelLabel } from '../core/ai/openrouter.ts'
import { draftSequence, writeDraftIntoSequence } from '../core/ai/sequence-draft.ts'
import { listTags } from '../core/tagging.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { CampaignPicker, Eyebrow, Flash, Layout, readCampaignId } from './layout.tsx'

/**
 * Sequence templates: the library, a plan page per template, and the screens
 * that create, edit, duplicate and delete them.
 *
 * ⚠️ Mounted AHEAD of `mail` in `worker.tsx`. `mail` owns `/sequences/:id`,
 * which would otherwise read "templates" as an id and 404. Inside this router
 * the fixed paths (`/new`, `/restore`) are registered ahead of `/:slug` for the
 * same reason.
 *
 * Nothing on these screens can send. A template is never mail; using one writes
 * a paused sequence, and core refuses to activate it while scaffolding remains.
 */
export const sequenceTemplatesAdmin = new Hono<{ Bindings: Env }>()

const BASE = '/sequences/templates'

const TRIGGERS = [
  ['subscribe', 'When someone subscribes'],
  ['tag_added', 'When a tag is added'],
  ['manual', 'Manual only'],
] as const

const TRIGGER_LABEL: Record<SequenceTrigger, string> = {
  subscribe: 'Starts on subscribe',
  tag_added: 'Starts on a tag',
  manual: 'Manual enrollment',
}

const flashTo = (path: string, msg: string, kind?: string) =>
  `${path}?flash=${encodeURIComponent(msg)}${kind ? `&kind=${kind}` : ''}`

function lengthLabel(steps: readonly TemplateStep[]): string {
  if (steps.length === 0) return 'no mails yet'
  const days = templateSchedule(steps)
  const total = days[days.length - 1] ?? 0
  const mails = `${steps.length} ${steps.length === 1 ? 'mail' : 'mails'}`
  return total === 0 ? mails : `${mails} over ${total + 1} days`
}

/** One dot per mail, placed on the day it lands. Decorative: the words carry it. */
const Rhythm: FC<{ steps: readonly TemplateStep[] }> = ({ steps }) => {
  const days = templateSchedule(steps)
  const total = days[days.length - 1] ?? 0
  return (
    <div class="rhythm" aria-hidden="true">
      {days.map((d) => (
        <i style={`--at:${total === 0 ? 0 : (d / total).toFixed(4)}`} />
      ))}
    </div>
  )
}

/** Body text with the `[[ scaffolding ]]` tinted, so the draft reads at a glance. */
const Draft: FC<{ text: string }> = ({ text }) => (
  <>
    {text
      .split(/(\[\[[^\]]*\]\])/g)
      .map((part) => (part.startsWith('[[') ? <mark class="ph">{part}</mark> : part))}
  </>
)

// ─────────────────────────────────────────────────── the library

sequenceTemplatesAdmin.get(BASE, async (c) => {
  const db = getDb(c.env)
  const [templates, missing] = await Promise.all([listTemplates(db), missingStarters(db)])

  const restore = missing.length > 0 && (
    <form method="post" action={`${BASE}/restore`}>
      <button class="btn" title={missing.map((t) => t.name).join(', ')}>
        {templates.length === 0
          ? `Load the ${missing.length} starters`
          : `Restore ${missing.length} ${missing.length === 1 ? 'starter' : 'starters'}`}
      </button>
    </form>
  )

  return c.html(
    <Layout title="Sequence templates" nav="tpl">
      <div class="head">
        <div>
          <Eyebrow>Sequence templates</Eyebrow>
          <h1>Pick a shape</h1>
          <div class="sub">
            A template is how many mails, how far apart, and what each one is for. Using one gives
            you a paused draft with every step written as scaffolding. The words are yours to
            replace, and so are the templates.
          </div>
        </div>
        <div class="actions">
          {restore}
          <a class="btn primary" href={`${BASE}/new`}>
            New template
          </a>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      {templates.length === 0 ? (
        <div class="card">
          <div class="card-b">
            <div class="empty">
              <p>No templates yet.</p>
              <p class="faint">
                Load the starters (Soap Opera, Product Launch, welcomes, sales and more), or write
                your own.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div class="tpl-grid">
          {templates.map((t) => (
            <a class="tpl" href={`${BASE}/${t.slug}`}>
              <Eyebrow>{t.source || 'Your template'}</Eyebrow>
              <h2>
                {t.name} <span aria-hidden="true">→</span>
              </h2>
              <p>{t.tagline}</p>
              <Rhythm steps={t.steps} />
              <div class="tpl-meta">
                <span>{lengthLabel(t.steps)}</span>
                <span>{FAMILY_LABEL[t.family]}</span>
                <span>{TRIGGER_LABEL[t.suggestedTrigger]}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </Layout>,
  )
})

sequenceTemplatesAdmin.post(`${BASE}/restore`, async (c) => {
  const n = await restoreStarterTemplates(getDb(c.env))
  return c.redirect(
    flashTo(BASE, n === 0 ? 'Every starter is already here.' : `Added ${n} starter template(s).`),
  )
})

// ─────────────────────────────────────────────────── create

/** The fields that describe a template, shared by the new and edit screens. */
const DetailFields: FC<{ t: Partial<SequenceTemplate> }> = ({ t }) => (
  <>
    <div class="row">
      <div class="field">
        <label>Name</label>
        <input type="text" name="name" value={t.name ?? ''} placeholder="Course pre-sale" required />
      </div>
      <div class="field">
        <label>Kind</label>
        <select name="family">
          {TEMPLATE_FAMILIES.map((f) => (
            <option value={f} selected={f === (t.family ?? 'funnel')}>
              {FAMILY_LABEL[f]}
            </option>
          ))}
        </select>
      </div>
    </div>
    <div class="field">
      <label>One-line pitch</label>
      <input
        type="text"
        name="tagline"
        value={t.tagline ?? ''}
        placeholder="Four mails in a week, ending on a deadline."
      />
    </div>
    <div class="field">
      <label>Credit (where the shape comes from)</label>
      <input type="text" name="source" value={t.source ?? ''} placeholder="Leave blank for your own" />
    </div>
    <div class="field">
      <label>Why it works (blank line between paragraphs)</label>
      <textarea name="description" style="min-height:150px;font-family:var(--sans);font-size:14px">
        {t.description ?? ''}
      </textarea>
    </div>
    <div class="row">
      <div class="field">
        <label>Good for (one per line)</label>
        <textarea name="bestFor" style="min-height:110px;font-family:var(--sans);font-size:14px">
          {(t.bestFor ?? []).join('\n')}
        </textarea>
      </div>
      <div class="field">
        <label>Have ready (one per line)</label>
        <textarea name="needs" style="min-height:110px;font-family:var(--sans);font-size:14px">
          {(t.needs ?? []).join('\n')}
        </textarea>
      </div>
    </div>
  </>
)

const DefaultFields: FC<{ t: Partial<SequenceTemplate> }> = ({ t }) => (
  <>
    <div class="row">
      <div class="field">
        <label>Sequence name</label>
        <input type="text" name="defaultName" value={t.defaultName ?? ''} placeholder="Welcome" />
      </div>
      <div class="field">
        <label>Sequence description (shown to subscribers)</label>
        <input
          type="text"
          name="defaultDescription"
          value={t.defaultDescription ?? ''}
          placeholder="A short welcome to the newsletter"
        />
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Suggested trigger</label>
        <select name="suggestedTrigger">
          {TRIGGERS.map(([value, label]) => (
            <option value={value} selected={value === (t.suggestedTrigger ?? 'manual')}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label>Why that trigger</label>
        <input type="text" name="triggerHint" value={t.triggerHint ?? ''} />
      </div>
    </div>
  </>
)

sequenceTemplatesAdmin.get(`${BASE}/new`, (c) => {
  return c.html(
    <Layout title="New template" nav="tpl">
      <div class="head">
        <div>
          <Eyebrow>Sequence templates</Eyebrow>
          <h1>New template</h1>
          <div class="sub">Describe the shape first. You write the mails on the next screen.</div>
        </div>
        <div class="actions">
          <a class="btn" href={BASE}>
            All templates
          </a>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <form method="post" action={BASE}>
        <div class="card">
          <div class="card-h">
            <h2>The template</h2>
          </div>
          <div class="card-b">
            <DetailFields t={{}} />
          </div>
        </div>
        <div class="card">
          <div class="card-h">
            <h2>What a sequence made from it starts with</h2>
          </div>
          <div class="card-b">
            <DefaultFields t={{}} />
            <button class="btn primary">Create and write the mails</button>
          </div>
        </div>
      </form>
    </Layout>,
  )
})

/**
 * Both forms post the whole template. Steps ride along as `s{i}_*` fields under
 * a `stepCount`, because the edit screen has no JavaScript to assemble anything
 * cleverer and a flat form survives every browser.
 */
function readTemplateForm(form: FormData): Partial<SequenceTemplate> {
  const str = (k: string) => String(form.get(k) ?? '')
  const count = Math.min(Math.max(Math.floor(Number(form.get('stepCount') ?? 0)) || 0, 0), 60)
  const steps: TemplateStep[] = []
  for (let i = 0; i < count; i++) {
    steps.push({
      delayDays: Number(str(`s${i}_delayDays`)),
      label: str(`s${i}_label`),
      purpose: str(`s${i}_purpose`),
      subject: str(`s${i}_subject`),
      bodyMd: str(`s${i}_bodyMd`),
    })
  }
  return {
    name: str('name'),
    family: str('family') as TemplateFamily,
    source: str('source'),
    tagline: str('tagline'),
    description: str('description'),
    bestFor: str('bestFor').split('\n'),
    needs: str('needs').split('\n'),
    suggestedTrigger: str('suggestedTrigger') as SequenceTrigger,
    triggerHint: str('triggerHint'),
    defaultName: str('defaultName'),
    defaultDescription: str('defaultDescription'),
    steps,
  }
}

sequenceTemplatesAdmin.post(BASE, async (c) => {
  const input = readTemplateForm(await c.req.formData())
  const result = await createTemplate(getDb(c.env), { ...input, steps: [blankTemplateStep(1)] })
  if (!result.ok) return c.redirect(flashTo(`${BASE}/new`, result.reason, 'warn'))
  return c.redirect(flashTo(`${BASE}/${result.slug}/edit`, 'Template created. Now write the mails.'))
})

// ─────────────────────────────────────────────────── read: the plan page

sequenceTemplatesAdmin.get(`${BASE}/:slug`, async (c) => {
  const db = getDb(c.env)
  const t = await getTemplate(db, c.req.param('slug'))
  if (!t) return c.notFound()

  const [allTags, allCampaigns] = await Promise.all([listTags(db), listCampaigns(db)])
  const days = templateSchedule(t.steps)
  const here = `${BASE}/${t.slug}`
  // The drafting model's name, or null to hide the pitch box entirely.
  const ai = aiConfigured(c.env) ? modelLabel(modelFor(c.env, 'sequence')) : null

  return c.html(
    <Layout title={t.name} nav="tpl">
      <div class="head">
        <div>
          <Eyebrow>{t.source || 'Your template'}</Eyebrow>
          <h1>{t.name}</h1>
          <div class="sub">{t.tagline}</div>
        </div>
        <div class="actions">
          <a class="btn" href={BASE}>
            All templates
          </a>
          <form method="post" action={`${here}/duplicate`}>
            <button class="btn">Duplicate</button>
          </form>
          <a class="btn" href={`${here}/edit`}>
            Edit template
          </a>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="bento">
        <div class="card col-7">
          <div class="card-h">
            <h2>The plan</h2>
            <span class="faint">{lengthLabel(t.steps)}</span>
          </div>
          <div class="card-b">
            {t.steps.length === 0 ? (
              <div class="empty">
                <p>No mails in this template yet.</p>
                <p>
                  <a href={`${here}/edit`}>Write the first one →</a>
                </p>
              </div>
            ) : (
              <ol class="plan">
                {t.steps.map((s, i) => (
                  <li>
                    <div class="day">Day {days[i]! + 1}</div>
                    <div>
                      <h4>{s.label}</h4>
                      <div class="subj">
                        <em>Subject</em>
                        <Draft text={s.subject} />
                      </div>
                      {s.purpose && <p>{s.purpose}</p>}
                      <details>
                        <summary>Read the draft</summary>
                        <pre>
                          <Draft text={s.bodyMd} />
                        </pre>
                      </details>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <div class="card col-5">
          <div class="card-h">
            <h2>Why it works</h2>
          </div>
          <div class="card-b">
            {t.description ? (
              t.description
                .split(/\n\s*\n/)
                .map((para) => (
                  <p style="color:var(--muted);line-height:1.65;max-width:56ch">{para}</p>
                ))
            ) : (
              <p class="faint">No notes on this one yet.</p>
            )}

            {t.bestFor.length > 0 && (
              <>
                <h3 style="margin:30px 0 14px">Good for</h3>
                <ul class="tpl-list">
                  {t.bestFor.map((b) => (
                    <li>{b}</li>
                  ))}
                </ul>
              </>
            )}

            {t.needs.length > 0 && (
              <>
                <h3 style="margin:0 0 14px">Have ready</h3>
                <ul class="tpl-list">
                  {t.needs.map((n) => (
                    <li>{n}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Make it yours</h2>
        </div>
        <div class="card-b">
          <div class="note">
            This creates a <strong>paused</strong> sequence with {t.steps.length} draft{' '}
            {t.steps.length === 1 ? 'step' : 'steps'}. Nobody is enrolled and nothing is sent.
            Every part you need to rewrite is marked <mark class="ph">[[ like this ]]</mark>, and
            the sequence will refuse to go live until all of them are gone.
          </div>
          <form method="post" action={`${here}/use`}>
            <div class="field">
              <label>Name</label>
              <input type="text" name="name" value={t.defaultName || t.name} required />
            </div>
            <div class="field">
              <label>Description (shown to subscribers)</label>
              <input type="text" name="description" value={t.defaultDescription} />
            </div>
            <div class="row">
              <div class="field">
                <label>Trigger</label>
                <select name="trigger">
                  {TRIGGERS.map(([value, label]) => (
                    <option value={value} selected={value === t.suggestedTrigger}>
                      {label}
                      {value === t.suggestedTrigger ? ' (suggested)' : ''}
                    </option>
                  ))}
                </select>
                {t.triggerHint && (
                  <div class="faint" style="margin-top:8px">
                    {t.triggerHint}
                  </div>
                )}
              </div>
              <div class="field">
                <label>Trigger tag (for "tag added")</label>
                <select name="triggerTagId">
                  <option value="">(none, choose later)</option>
                  {allTags.map((tag) => (
                    <option value={String(tag.id)}>{tag.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <CampaignPicker
              all={allCampaigns}
              value={null}
              hint="Clicks on this series count as a touch for the campaign."
            />
            {ai ? (
              <div class="field" style="margin-top:22px">
                <label for="brief">Your pitch, for a first draft (optional)</label>
                <textarea
                  id="brief"
                  name="brief"
                  placeholder={BRIEF_PLACEHOLDER}
                  style="min-height:170px;font-family:var(--sans);font-size:14px"
                />
                <div class="faint" style="margin-top:8px">
                  Fill this in and {ai} writes a first draft of all {t.steps.length} mails in this
                  shape, using only what you put here. Anything it doesn't know stays a{' '}
                  <mark class="ph">[[ placeholder ]]</mark>. Every mail opens with a note asking
                  you to rewrite it in your own words, and the sequence can't go live until you
                  have. Takes about a minute; costs roughly 20 to 40 cents.
                </div>
              </div>
            ) : null}
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn primary" disabled={t.steps.length === 0}>
                Create paused sequence
              </button>
              {ai ? (
                <button class="btn" name="draft" value="1" disabled={t.steps.length === 0}>
                  Create and draft it with {ai}
                </button>
              ) : null}
            </div>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

sequenceTemplatesAdmin.post(`${BASE}/:slug/use`, async (c) => {
  const slug = c.req.param('slug')
  const form = await c.req.formData()
  const triggerTagId = String(form.get('triggerTagId') ?? '')
  const trigger = String(form.get('trigger') ?? '')

  const result = await createSequenceFromTemplate(getDb(c.env), slug, {
    name: String(form.get('name') ?? ''),
    description: String(form.get('description') ?? ''),
    ...(trigger === 'subscribe' || trigger === 'tag_added' || trigger === 'manual'
      ? { trigger }
      : {}),
    triggerTagId: triggerTagId ? Number(triggerTagId) : null,
    campaignId: readCampaignId(form),
  })

  if (!result.ok) return c.redirect(flashTo(`${BASE}/${slug}`, result.reason, 'warn'))

  // The sequence exists either way. A draft that fails leaves the template's
  // own scaffolding in place, which is exactly what "no draft" would have been.
  const brief = String(form.get('brief') ?? '').trim()
  if (String(form.get('draft') ?? '') === '1' && aiConfigured(c.env)) {
    const flash = await draftInto(c.env, slug, result.id, brief, String(form.get('name') ?? ''))
    return c.redirect(flashTo(`/sequences/${result.id}`, flash.msg, flash.kind))
  }

  return c.redirect(
    flashTo(
      `/sequences/${result.id}`,
      'Created, paused. Rewrite every [[ placeholder ]] before taking it live.',
    ),
  )
})

// ─────────────────────────────────────────────────── update

const StepFields: FC<{ s: TemplateStep; i: number; n: number; day: number }> = ({
  s,
  i,
  n,
  day,
}) => (
  <div class="tpl-step" id={`mail-${i + 1}`}>
    <div class="card-h">
      <h3>
        Mail {i + 1} · lands day {day + 1}
      </h3>
      <div class="actions">
        {/* Each of these saves the whole form first, so moving a mail never
            costs the edits sitting in the other ones. */}
        <button class="btn sm" name="op" value={`up:${i}`} disabled={i === 0} title="Move earlier">
          ↑
        </button>
        <button
          class="btn sm"
          name="op"
          value={`down:${i}`}
          disabled={i === n - 1}
          title="Move later"
        >
          ↓
        </button>
        <button class="btn sm danger" name="op" value={`remove:${i}`}>
          Remove
        </button>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Its job, in two or three words</label>
        <input type="text" name={`s${i}_label`} value={s.label} placeholder="Set the stage" />
      </div>
      <div class="field" style="max-width:240px">
        <label>{i === 0 ? 'Days after enrollment' : 'Days after the previous mail'}</label>
        <input type="number" name={`s${i}_delayDays`} value={String(s.delayDays)} min="0" max="365" />
      </div>
    </div>
    <div class="field">
      <label>What this mail is for (shown on the plan, never sent)</label>
      <input type="text" name={`s${i}_purpose`} value={s.purpose} />
    </div>
    <div class="field">
      <label>Subject</label>
      <input type="text" name={`s${i}_subject`} value={s.subject} placeholder="[[ A curious subject ]]" />
    </div>
    <div class="field">
      <label>Draft (markdown)</label>
      <textarea name={`s${i}_bodyMd`} style="min-height:280px">
        {s.bodyMd}
      </textarea>
    </div>
  </div>
)

sequenceTemplatesAdmin.get(`${BASE}/:slug/edit`, async (c) => {
  const t = await getTemplate(getDb(c.env), c.req.param('slug'))
  if (!t) return c.notFound()

  const here = `${BASE}/${t.slug}`
  const days = templateSchedule(t.steps)

  return c.html(
    <Layout title={`Edit · ${t.name}`} nav="tpl">
      <div class="head">
        <div>
          <Eyebrow>Edit template</Eyebrow>
          <h1>{t.name}</h1>
          <div class="sub">
            Changes here only affect sequences you make from now on. Anything already made from
            this template is its own sequence and is never touched.
          </div>
        </div>
        <div class="actions">
          <a class="btn" href={here}>
            Back to the plan
          </a>
          {/* First submit button in the document, so Enter in any field saves
              rather than firing "move mail 1 up". */}
          <button class="btn primary" form="tpl-form" name="op" value="save">
            Save template
          </button>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <form method="post" action={`${here}/edit`} id="tpl-form">
        <input type="hidden" name="stepCount" value={String(t.steps.length)} />

        <div class="card">
          <div class="card-h">
            <h2>The template</h2>
          </div>
          <div class="card-b">
            <DetailFields t={t} />
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            <h2>What a sequence made from it starts with</h2>
          </div>
          <div class="card-b">
            <DefaultFields t={t} />
          </div>
        </div>

        <div class="card" id="mails">
          <div class="card-h">
            <h2>The mails</h2>
            <span class="faint">{lengthLabel(t.steps)}</span>
          </div>
          <div class="card-b">
            <div class="note">
              Wrap anything the writer must replace in <mark class="ph">[[ double brackets ]]</mark>
              . A sequence can't go live while one is left, so they double as a checklist.{' '}
              <code>{'{{first_name}}'}</code> works as a merge tag.
            </div>
            {t.steps.map((s, i) => (
              <StepFields s={s} i={i} n={t.steps.length} day={days[i]!} />
            ))}
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:26px">
              <button class="btn" name="op" value="add">
                Add a mail
              </button>
              <button class="btn primary" name="op" value="save">
                Save template
              </button>
            </div>
          </div>
        </div>
      </form>

      <div class="card">
        <div class="card-b">
          {/* No JavaScript, so no confirm(). Opening the disclosure is the
              "are you sure". */}
          <details>
            <summary class="faint" style="cursor:pointer">
              Delete this template
            </summary>
            <p style="color:var(--muted);margin:14px 0;max-width:60ch">
              Sequences already made from it are unaffected.
              {t.source ? ' A starter can be brought back later from the templates page.' : ''}
            </p>
            <form method="post" action={`${here}/delete`}>
              <button class="btn danger">Delete “{t.name}”</button>
            </form>
          </details>
        </div>
      </div>
    </Layout>,
  )
})

sequenceTemplatesAdmin.post(`${BASE}/:slug/edit`, async (c) => {
  const slug = c.req.param('slug')
  const form = await c.req.formData()
  const input = readTemplateForm(form)
  const steps = [...(input.steps ?? [])]

  const [op, arg] = String(form.get('op') ?? 'save').split(':')
  const i = Number(arg)
  const valid = Number.isInteger(i) && i >= 0 && i < steps.length
  let anchor = ''

  if (op === 'add') {
    steps.push(blankTemplateStep(steps.length + 1))
    anchor = `#mail-${steps.length}`
  } else if (op === 'remove' && valid) {
    steps.splice(i, 1)
    anchor = '#mails'
  } else if ((op === 'up' || op === 'down') && valid) {
    const j = op === 'up' ? i - 1 : i + 1
    if (j >= 0 && j < steps.length) {
      ;[steps[i], steps[j]] = [steps[j]!, steps[i]!]
      anchor = `#mail-${j + 1}`
    }
  }

  const result = await updateTemplate(getDb(c.env), slug, { ...input, steps })
  if (!result.ok) return c.redirect(flashTo(`${BASE}/${slug}/edit`, result.reason, 'warn'))

  if (op === 'save') return c.redirect(flashTo(`${BASE}/${slug}`, 'Template saved.'))
  return c.redirect(`${flashTo(`${BASE}/${slug}/edit`, 'Saved.')}${anchor}`)
})

// ─────────────────────────────────────────────────── duplicate, delete

sequenceTemplatesAdmin.post(`${BASE}/:slug/duplicate`, async (c) => {
  const slug = c.req.param('slug')
  const result = await duplicateTemplate(getDb(c.env), slug)
  if (!result.ok) return c.redirect(flashTo(`${BASE}/${slug}`, result.reason, 'warn'))
  return c.redirect(flashTo(`${BASE}/${result.slug}/edit`, 'Duplicated. This copy is yours to change.'))
})

sequenceTemplatesAdmin.post(`${BASE}/:slug/delete`, async (c) => {
  const db = getDb(c.env)
  const slug = c.req.param('slug')
  const t = await getTemplate(db, slug)
  const result = await deleteTemplate(db, slug)
  if (!result.ok) return c.redirect(flashTo(BASE, result.reason, 'warn'))
  return c.redirect(flashTo(BASE, `Deleted “${t?.name ?? slug}”.`))
})


/** What to put in the brief, as a placeholder the writer reads before typing. */
const BRIEF_PLACEHOLDER = [
  'What are you offering, and what does it cost?',
  'Who is it for, and what are they stuck on?',
  'Why do you care about this? The story behind it, in a few lines.',
  'Links, dates and your name for the sign-off, if you have them.',
].join('\n')

/**
 * Draft a freshly created sequence from its template and the brief, and say
 * how it went in a flash the sequence page can show.
 */
async function draftInto(
  env: Env,
  slug: string,
  sequenceId: number,
  brief: string,
  name: string,
): Promise<{ msg: string; kind?: 'warn' }> {
  const db = getDb(env)
  const template = await getTemplate(db, slug)
  if (!template) return { msg: 'Created, paused. The template vanished before it could be drafted.', kind: 'warn' }

  const result = await draftSequence(env, db, { template, brief, sequenceName: name || template.name })
  if (!result.ok) {
    return {
      msg: `Created, paused, but not drafted: ${result.reason} The template's placeholders are in place instead.`,
      kind: 'warn',
    }
  }
  await writeDraftIntoSequence(db, sequenceId, result.mails)
  const cost = `$${result.costUsd.toFixed(2)}`
  const missed = result.skipped
    ? ` ${result.skipped} ${result.skipped === 1 ? 'mail' : 'mails'} could not be drafted and kept the template text.`
    : ''
  return {
    msg: `Created, paused, and drafted with ${modelLabel(modelFor(env, 'sequence'))} (${cost}). Every mail opens with an [[ AI draft ]] line: rewrite the mail in your own words, then delete that line. It can't go live until you do.${missed}`,
  }
}
