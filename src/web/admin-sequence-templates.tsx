import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import { listCampaigns } from '../core/campaigns.ts'
import {
  FAMILY_LABEL,
  SEQUENCE_TEMPLATES,
  type SequenceTemplate,
  createSequenceFromTemplate,
  getSequenceTemplate,
  templateSchedule,
} from '../core/sequence-templates/index.ts'
import type { SequenceTrigger } from '../core/sequences.ts'
import { listTags } from '../core/tagging.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { CampaignPicker, Eyebrow, Flash, Layout, readCampaignId } from './layout.tsx'

/**
 * "Create from template": a gallery of proven sequence shapes and a page per
 * shape that shows the whole plan before anything is made.
 *
 * ⚠️ Mounted AHEAD of `mail` in `worker.tsx`. `mail` owns `/sequences/:id`,
 * which would otherwise read "templates" as an id and 404.
 *
 * Nothing on these screens can send. Creating from a template writes a paused
 * sequence, and core refuses to activate it while scaffolding remains.
 */
export const sequenceTemplatesAdmin = new Hono<{ Bindings: Env }>()

const TRIGGER_LABEL: Record<SequenceTrigger, string> = {
  subscribe: 'Starts on subscribe',
  tag_added: 'Starts on a tag',
  manual: 'Manual enrollment',
}

function span(t: SequenceTemplate): { days: number[]; total: number } {
  const days = templateSchedule(t)
  return { days, total: days[days.length - 1] ?? 0 }
}

function lengthLabel(t: SequenceTemplate): string {
  const { total } = span(t)
  const mails = `${t.steps.length} mails`
  return total === 0 ? mails : `${mails} over ${total + 1} days`
}

/** One dot per mail, placed on the day it lands. Decorative: the words carry it. */
const Rhythm: FC<{ t: SequenceTemplate }> = ({ t }) => {
  const { days, total } = span(t)
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
    {text.split(/(\[\[[^\]]*\]\])/g).map((part) =>
      part.startsWith('[[') ? <mark class="ph">{part}</mark> : part,
    )}
  </>
)

sequenceTemplatesAdmin.get('/sequences/templates', (c) => {
  return c.html(
    <Layout title="Sequence templates" nav="seq">
      <div class="head">
        <div>
          <Eyebrow>Create from template</Eyebrow>
          <h1>Pick a shape</h1>
          <div class="sub">
            {SEQUENCE_TEMPLATES.length} sequences that have earned their keep: how many mails, how
            far apart, and what each one is for. You get a paused draft with every step written as
            scaffolding. The words are yours to replace.
          </div>
        </div>
        <div class="actions">
          <a class="btn" href="/sequences/new">
            Start blank
          </a>
        </div>
      </div>

      <div class="tpl-grid">
        {SEQUENCE_TEMPLATES.map((t) => (
          <a class="tpl" href={`/sequences/templates/${t.slug}`}>
            <Eyebrow>{t.source}</Eyebrow>
            <h2>
              {t.name} <span aria-hidden="true">→</span>
            </h2>
            <p>{t.tagline}</p>
            <Rhythm t={t} />
            <div class="tpl-meta">
              <span>{lengthLabel(t)}</span>
              <span>{FAMILY_LABEL[t.family]}</span>
              <span>{TRIGGER_LABEL[t.suggestedTrigger]}</span>
            </div>
          </a>
        ))}
      </div>
    </Layout>,
  )
})

sequenceTemplatesAdmin.get('/sequences/templates/:slug', async (c) => {
  const t = getSequenceTemplate(c.req.param('slug'))
  if (!t) return c.notFound()

  const db = getDb(c.env)
  const [allTags, allCampaigns] = await Promise.all([listTags(db), listCampaigns(db)])
  const { days } = span(t)

  return c.html(
    <Layout title={t.name} nav="seq">
      <div class="head">
        <div>
          <Eyebrow>{t.source}</Eyebrow>
          <h1>{t.name}</h1>
          <div class="sub">{t.tagline}</div>
        </div>
        <div class="actions">
          <a class="btn" href="/sequences/templates">
            All templates
          </a>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="bento">
        <div class="card col-7">
          <div class="card-h">
            <h2>The plan</h2>
            <span class="faint">{lengthLabel(t)}</span>
          </div>
          <div class="card-b">
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
                    <p>{s.purpose}</p>
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
          </div>
        </div>

        <div class="card col-5">
          <div class="card-h">
            <h2>Why it works</h2>
          </div>
          <div class="card-b">
            {t.description.split(/\n\s*\n/).map((para) => (
              <p style="color:var(--muted);line-height:1.65;max-width:56ch">{para}</p>
            ))}

            <h3 style="margin:30px 0 14px">Good for</h3>
            <ul class="tpl-list">
              {t.bestFor.map((b) => (
                <li>{b}</li>
              ))}
            </ul>

            <h3 style="margin:0 0 14px">Have ready</h3>
            <ul class="tpl-list">
              {t.needs.map((n) => (
                <li>{n}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Make it yours</h2>
        </div>
        <div class="card-b">
          <div class="note">
            This creates a <strong>paused</strong> sequence with {t.steps.length} draft steps.
            Nobody is enrolled and nothing is sent. Every part you need to rewrite is marked{' '}
            <mark class="ph">[[ like this ]]</mark>, and the sequence will refuse to go live until
            all of them are gone.
          </div>
          <form method="post" action={`/sequences/templates/${t.slug}`}>
            <div class="field">
              <label>Name</label>
              <input type="text" name="name" value={t.defaultName} required />
            </div>
            <div class="field">
              <label>Description (shown to subscribers)</label>
              <input type="text" name="description" value={t.defaultDescription} />
            </div>
            <div class="row">
              <div class="field">
                <label>Trigger</label>
                <select name="trigger">
                  {(
                    [
                      ['subscribe', 'When someone subscribes'],
                      ['tag_added', 'When a tag is added'],
                      ['manual', 'Manual only'],
                    ] as const
                  ).map(([value, label]) => (
                    <option value={value} selected={value === t.suggestedTrigger}>
                      {label}
                      {value === t.suggestedTrigger ? ' (suggested)' : ''}
                    </option>
                  ))}
                </select>
                <div class="faint" style="margin-top:8px">
                  {t.triggerHint}
                </div>
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
            <button class="btn primary">Create paused sequence</button>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

sequenceTemplatesAdmin.post('/sequences/templates/:slug', async (c) => {
  const slug = c.req.param('slug')
  const db = getDb(c.env)
  const form = await c.req.formData()
  const triggerTagId = String(form.get('triggerTagId') ?? '')
  const trigger = String(form.get('trigger') ?? '')

  const result = await createSequenceFromTemplate(db, slug, {
    name: String(form.get('name') ?? ''),
    description: String(form.get('description') ?? ''),
    ...(trigger === 'subscribe' || trigger === 'tag_added' || trigger === 'manual'
      ? { trigger }
      : {}),
    triggerTagId: triggerTagId ? Number(triggerTagId) : null,
    campaignId: readCampaignId(form),
  })

  if (!result.ok) {
    return c.redirect(
      `/sequences/templates/${slug}?flash=${encodeURIComponent(result.reason)}&kind=warn`,
    )
  }
  const flash = 'Created, paused. Rewrite every [[ placeholder ]] before taking it live.'
  return c.redirect(`/sequences/${result.id}?flash=${encodeURIComponent(flash)}`)
})
