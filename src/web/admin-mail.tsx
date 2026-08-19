import { asc, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { broadcastStats, createBroadcast, startBroadcast } from '../core/broadcasts.ts'
import { listCampaigns } from '../core/campaigns.ts'
import { countSegment, describeRule, listSegments } from '../core/segments.ts'
import {
  type SequenceTrigger,
  addStep,
  createSequence,
  deleteStep,
  enroll,
  sequenceStats,
  setSequenceActive,
  tickSequences,
  updateStep,
} from '../core/sequences.ts'
import { previewHtml } from '../core/render.ts'
import { type Db, getDb } from '../db/index.ts'
import type { Broadcast, DocNode, Segment, SegmentRule, Tag } from '../db/schema.ts'
import {
  broadcasts,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  subscribers,
  tags,
} from '../db/schema.ts'
import type { Env } from '../types.ts'
import {
  CampaignPicker,
  Flash,
  Layout,
  RichEditor,
  fmtDate,
  readCampaignId,
  statusPill,
} from './layout.tsx'

export const mail = new Hono<{ Bindings: Env }>()

// ───────────────────────────────────────────────── audience picking

interface Choices {
  allTags: Tag[]
  segs: Segment[]
}

async function audienceChoices(db: Db): Promise<Choices> {
  const [allTags, segs] = await Promise.all([
    db.select().from(tags).orderBy(asc(tags.name)).all(),
    listSegments(db),
  ])
  return { allTags, segs }
}

/**
 * Which option is currently selected. A rule that isn't expressible as one of
 * the options (two tags, a date window) reports `keep`, so re-saving the form
 * can't silently flatten it.
 */
function currentChoice(b: Pick<Broadcast, 'segment' | 'segmentId'>): string {
  if (b.segmentId) return `seg:${b.segmentId}`
  const rule = b.segment ?? {}
  const keys = Object.keys(rule)
  if (keys.length === 0) return ''
  if (keys.length === 1 && rule.includeTagIds?.length === 1) return `tag:${rule.includeTagIds[0]}`
  return 'keep'
}

/** Resolve a picked option into the rule to store. `keep` leaves it untouched. */
function resolveAudience(
  value: string,
  segs: Segment[],
  current: { segment: SegmentRule; segmentId: number | null },
): { segment: SegmentRule; segmentId: number | null } {
  if (value === 'keep') return current
  if (value.startsWith('seg:')) {
    const seg = segs.find((s) => s.id === Number(value.slice(4)))
    // Copied, not referenced — see the comment on `broadcasts.segment`.
    if (seg) return { segment: seg.rule, segmentId: seg.id }
  }
  if (value.startsWith('tag:')) {
    return { segment: { includeTagIds: [Number(value.slice(4))] }, segmentId: null }
  }
  return { segment: {}, segmentId: null }
}

const AudiencePicker = ({
  choices,
  value,
  rule,
}: {
  choices: Choices
  value: string
  rule?: SegmentRule
}) => (
  <div class="field">
    <label>Who gets this</label>
    <select name="audience">
      {value === 'keep' ? (
        <option value="keep" selected>
          Custom — {describeRule(rule ?? {}, choices.allTags)}
        </option>
      ) : null}
      <option value="" selected={value === ''}>
        Everyone active
      </option>
      {choices.segs.map((s) => (
        <option value={`seg:${s.id}`} selected={value === `seg:${s.id}`}>
          Segment: {s.name}
        </option>
      ))}
      {choices.allTags.map((t) => (
        <option value={`tag:${t.id}`} selected={value === `tag:${t.id}`}>
          Tagged: {t.name}
        </option>
      ))}
    </select>
    <p class="faint" style="margin:6px 0 0">
      A segment's rule is copied onto the broadcast when you pick it, so editing the segment later
      never changes what an already-sent broadcast targeted. <a href="/segments">Manage segments →</a>
    </p>
  </div>
)

// ───────────────────────────────────────────────── broadcasts

mail.get('/broadcasts', async (c) => {
  const db = getDb(c.env)
  const rows = await db.select().from(broadcasts).orderBy(desc(broadcasts.id)).all()
  const allTags = await db.select().from(tags).orderBy(asc(tags.name)).all()

  return c.html(
    <Layout title="Broadcasts" nav="bc">
      <div class="head">
        <div>
          <h1>Broadcasts</h1>
          <div class="sub">One-off sends to a segment of the list.</div>
        </div>
        <div class="actions">
          <a class="btn primary" href="/broadcasts/new">
            New broadcast
          </a>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} />

      <div class="card">
        <div class="card-b flush">
          {rows.length === 0 ? (
            <div class="empty">
              <p>No broadcasts yet.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Audience</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr>
                    <td>
                      <a href={`/broadcasts/${b.id}`} style="font-weight:500">
                        {b.subject}
                      </a>
                    </td>
                    <td class="faint">{describeRule(b.segment ?? {}, allTags)}</td>
                    <td>{statusPill(b.status)}</td>
                    <td class="faint">{fmtDate(b.createdAt)}</td>
                    <td class="faint">{fmtDate(b.sentAt)}</td>
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

mail.get('/broadcasts/new', async (c) => {
  const db = getDb(c.env)
  const choices = await audienceChoices(db)
  const allCampaigns = await listCampaigns(db)

  return c.html(
    <Layout title="New broadcast" nav="bc" editor>
      <div class="head">
        <h1>New broadcast</h1>
      </div>
      <div class="card">
        <div class="card-b">
          <form method="post" action="/broadcasts">
            <div class="field">
              <label>Subject</label>
              <input type="text" name="subject" required />
            </div>
            <RichEditor />
            <AudiencePicker choices={choices} value="" />
            <CampaignPicker all={allCampaigns} value={null} />
            <button class="btn primary">Save draft</button>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

/**
 * Read a body from a form: rich document if the editor posted one, markdown
 * otherwise (the `<noscript>` path, or a legacy form).
 */
function readBody(form: FormData): { bodyJson: DocNode | null; bodyMd: string } {
  const raw = String(form.get('body_json') ?? '').trim()
  const md = String(form.get('body_md_fallback') ?? form.get('body') ?? '')
  if (!raw) return { bodyJson: null, bodyMd: md }
  try {
    return { bodyJson: JSON.parse(raw) as DocNode, bodyMd: md }
  } catch {
    // Never lose someone's writing to a parse error.
    return { bodyJson: null, bodyMd: md || raw }
  }
}

/** "immediately" / "+1 day" / "+3 days" */
function formatDelay(days: number): string {
  if (days === 0) return 'immediately'
  return `+${days} day${days === 1 ? '' : 's'}`
}

mail.post('/broadcasts', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const { segs } = await audienceChoices(db)
  const audience = resolveAudience(String(form.get('audience') ?? ''), segs, {
    segment: {},
    segmentId: null,
  })

  const id = await createBroadcast(db, {
    subject: String(form.get('subject') ?? 'Untitled'),
    ...readBody(form),
    ...audience,
    campaignId: readCampaignId(form),
  })

  return c.redirect(`/broadcasts/${id}`)
})

mail.get('/broadcasts/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) return c.notFound()

  const stats = await broadcastStats(db, id)
  const audienceSize = await countSegment(db, b.segment ?? {})
  const choices = await audienceChoices(db)
  const allCampaigns = await listCampaigns(db)
  const editable = b.status === 'draft'
  const segName = choices.segs.find((s) => s.id === b.segmentId)?.name
  const campaign = allCampaigns.find((x) => x.id === b.campaignId)

  return c.html(
    <Layout title={b.subject} nav="bc" editor={editable}>
      <div class="head">
        <div>
          <h1>{b.subject}</h1>
          <div class="sub">
            {statusPill(b.status)} · {describeRule(b.segment ?? {}, choices.allTags)} ·{' '}
            {audienceSize} {audienceSize === 1 ? 'person' : 'people'}
            {segName ? (
              <>
                {' '}
                · from segment{' '}
                <a href={`/segments/${b.segmentId}`}>{segName}</a>
              </>
            ) : null}
            {campaign ? (
              <>
                {' '}
                · campaign <a href={`/campaigns/${campaign.id}`}>{campaign.name}</a>
              </>
            ) : null}
          </div>
        </div>
        <div class="actions">
          {editable ? (
            <form method="post" action={`/broadcasts/${id}/send`}>
              <button class="btn accent">Send now</button>
            </form>
          ) : null}
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      {b.status !== 'draft' ? (
        <div class="card">
          <div class="card-b flush">
            <div class="stats">
              <div class="stat">
                <div class="n">{stats.recipients}</div>
                <div class="l">Recipients</div>
              </div>
              <div class="stat hi">
                <div class="n">{stats.sent}</div>
                <div class="l">Sent</div>
              </div>
              <div class="stat">
                <div class="n">{stats.opened}</div>
                <div class="l">Opened</div>
              </div>
              <div class="stat">
                <div class="n">{stats.clicked}</div>
                <div class="l">Clicked</div>
              </div>
              <div class="stat">
                <div class="n">{stats.suppressed}</div>
                <div class="l">Skipped</div>
              </div>
              <div class="stat">
                <div class="n">{stats.failed}</div>
                <div class="l">Failed</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div class="card">
        <div class="card-h">
          <h2>{editable ? 'Edit' : 'Content'}</h2>
        </div>
        <div class="card-b">
          {editable ? (
            <form method="post" action={`/broadcasts/${id}/edit`}>
              <div class="field">
                <label>Subject</label>
                <input type="text" name="subject" value={b.subject} required />
              </div>
              <RichEditor json={b.bodyJson} md={b.bodyMd} />
              <AudiencePicker choices={choices} value={currentChoice(b)} rule={b.segment ?? {}} />
              <CampaignPicker all={allCampaigns} value={b.campaignId} />
              <button class="btn primary">Save</button>
            </form>
          ) : (
            <div
              class="mailview"
              style="padding:0"
              dangerouslySetInnerHTML={{ __html: previewHtml(b.bodyJson, b.bodyMd) }}
            />
          )}
        </div>
      </div>
    </Layout>,
  )
})

mail.post('/broadcasts/:id/edit', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) return c.notFound()
  // Editing a broadcast that's already going out would change who it reaches
  // halfway through the send.
  if (b.status !== 'draft') return c.redirect(`/broadcasts/${id}?flash=Only drafts can be edited.&kind=warn`)

  const form = await c.req.formData()
  const { segs } = await audienceChoices(db)
  const audience = resolveAudience(String(form.get('audience') ?? ''), segs, {
    segment: b.segment ?? {},
    segmentId: b.segmentId,
  })

  await db
    .update(broadcasts)
    .set({
      subject: String(form.get('subject') ?? ''),
      ...readBody(form),
      ...audience,
      campaignId: readCampaignId(form),
    })
    .where(eq(broadcasts.id, id))
  return c.redirect(`/broadcasts/${id}?flash=Saved.`)
})

mail.post('/broadcasts/:id/send', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const n = await startBroadcast(c.env, db, id)
  return c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent(`Queued ${n} message(s).`)}`)
})

// ───────────────────────────────────────────────── sequences

mail.get('/sequences', async (c) => {
  const db = getDb(c.env)
  const rows = await db.select().from(sequences).orderBy(desc(sequences.id)).all()
  const withStats = await Promise.all(
    rows.map(async (s) => ({ ...s, stats: await sequenceStats(db, s.id) })),
  )

  return c.html(
    <Layout title="Sequences" nav="seq">
      <div class="head">
        <div>
          <h1>Sequences</h1>
          <div class="sub">Drip series. People can leave one without leaving the list.</div>
        </div>
        <div class="actions">
          <form method="post" action="/sequences/tick">
            <button class="btn">Run now</button>
          </form>
          <a class="btn primary" href="/sequences/new">
            New sequence
          </a>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} />

      <div class="card">
        <div class="card-b flush">
          {withStats.length === 0 ? (
            <div class="empty">
              <p>No sequences yet.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Sequence</th>
                  <th>Trigger</th>
                  <th class="num">Steps</th>
                  <th class="num">Active</th>
                  <th class="num">Left it</th>
                  <th>Live</th>
                </tr>
              </thead>
              <tbody>
                {withStats.map((s) => (
                  <tr>
                    <td>
                      <a href={`/sequences/${s.id}`} style="font-weight:500">
                        {s.name}
                      </a>
                      <div class="faint">{s.description}</div>
                    </td>
                    <td>
                      <span class="pill">{s.trigger}</span>
                    </td>
                    <td class="num">{s.stats.steps}</td>
                    <td class="num">{s.stats.active}</td>
                    <td class="num">{s.stats.optedOut}</td>
                    <td>{s.isActive ? <span class="pill ok">live</span> : <span class="pill">off</span>}</td>
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

mail.get('/sequences/new', async (c) => {
  const db = getDb(c.env)
  const allTags = await db.select().from(tags).orderBy(asc(tags.name)).all()
  const allCampaigns = await listCampaigns(db)

  return c.html(
    <Layout title="New sequence" nav="seq">
      <div class="head">
        <h1>New sequence</h1>
      </div>
      <div class="card">
        <div class="card-b">
          <div class="note">
            The <strong>name</strong> and <strong>description</strong> are shown to subscribers in
            their preference center — write them so a reader recognizes what they'd be leaving.
          </div>
          <form method="post" action="/sequences">
            <div class="field">
              <label>Name</label>
              <input type="text" name="name" placeholder="Ruby onboarding" required />
            </div>
            <div class="field">
              <label>Description (shown to subscribers)</label>
              <input type="text" name="description" placeholder="A 5-part intro to the course" />
            </div>
            <div class="row">
              <div class="field">
                <label>Trigger</label>
                <select name="trigger">
                  <option value="subscribe">When someone subscribes</option>
                  <option value="tag_added">When a tag is added</option>
                  <option value="manual">Manual only</option>
                </select>
              </div>
              <div class="field">
                <label>Trigger tag (for "tag added")</label>
                <select name="triggerTagId">
                  <option value="">—</option>
                  {allTags.map((t) => (
                    <option value={String(t.id)}>{t.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <CampaignPicker
              all={allCampaigns}
              value={null}
              hint="Clicks on this series count as a touch for the campaign."
            />
            <button class="btn primary">Create</button>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

mail.post('/sequences', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const name = String(form.get('name') ?? 'Untitled')
  const triggerTagId = String(form.get('triggerTagId') ?? '')

  const id = await createSequence(db, {
    name,
    description: String(form.get('description') ?? '') || null,
    trigger: String(form.get('trigger') ?? 'manual') as SequenceTrigger,
    triggerTagId: triggerTagId ? Number(triggerTagId) : null,
    campaignId: readCampaignId(form),
  })

  return c.redirect(`/sequences/${id}`)
})

mail.get('/sequences/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const s = await db.select().from(sequences).where(eq(sequences.id, id)).get()
  if (!s) return c.notFound()

  const steps = await db
    .select()
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, id))
    .orderBy(asc(sequenceSteps.position))
    .all()

  const stats = await sequenceStats(db, id)

  const enrolled = await db
    .select({
      email: subscribers.email,
      name: subscribers.name,
      status: sequenceEnrollments.status,
      nextRunAt: sequenceEnrollments.nextRunAt,
    })
    .from(sequenceEnrollments)
    .innerJoin(subscribers, eq(subscribers.id, sequenceEnrollments.subscriberId))
    .where(eq(sequenceEnrollments.sequenceId, id))
    .limit(50)
    .all()

  return c.html(
    <Layout title={s.name} nav="seq" editor>
      <div class="head">
        <div>
          <h1>{s.name}</h1>
          <div class="sub">{s.description}</div>
        </div>
        <div class="actions">
          <form method="post" action={`/sequences/${id}/toggle`}>
            <button class={s.isActive ? 'btn' : 'btn accent'}>
              {s.isActive ? 'Pause' : 'Go live'}
            </button>
          </form>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} />

      <div class="card">
        <div class="card-b flush">
          <div class="stats">
            <div class="stat">
              <div class="n">{stats.steps}</div>
              <div class="l">Steps</div>
            </div>
            <div class="stat hi">
              <div class="n">{stats.active}</div>
              <div class="l">Receiving</div>
            </div>
            <div class="stat">
              <div class="n">{stats.completed}</div>
              <div class="l">Finished</div>
            </div>
            <div class="stat">
              <div class="n">{stats.optedOut}</div>
              <div class="l">Left this series</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Steps</h2>
        </div>
        <div class="card-b flush">
          {steps.length === 0 ? (
            <div class="empty">
              <p>No steps yet — add the first one below.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th class="num">#</th>
                  <th>Subject</th>
                  <th>Delay</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {steps.map((st) => (
                  <tr>
                    <td class="num">{st.position}</td>
                    <td>{st.subject}</td>
                    <td class="faint">
                      {formatDelay(st.delayDays)}
                    </td>
                    <td style="text-align:right">
                      <a class="btn sm" href={`/sequences/${id}/steps/${st.id}`}>
                        Edit
                      </a>
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
          <h2>Add a step</h2>
        </div>
        <div class="card-b">
          <form method="post" action={`/sequences/${id}/steps`}>
            <div class="row">
              <div class="field">
                <label>Subject</label>
                <input type="text" name="subject" required />
              </div>
              <div class="field">
                <label>Delay after previous step (days)</label>
                {/* First step defaults to 0 — a welcome email should arrive on
                    signup, not a day later. Everything after it defaults to 1. */}
                <input
                  type="number"
                  name="delay"
                  value={steps.length === 0 ? '0' : '1'}
                  min="0"
                  max="365"
                />
                <p class="faint" style="margin:6px 0 0">
                  {steps.length === 0
                    ? '0 = sent as soon as someone joins this sequence.'
                    : '0 = sent immediately after the previous step.'}
                </p>
              </div>
            </div>
            <RichEditor />
            <button class="btn primary">Add step</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Enrollments</h2>
          <div class="actions">
            <form method="post" action={`/sequences/${id}/enroll-all`}>
              <button class="btn sm">Enroll every active subscriber</button>
            </form>
          </div>
        </div>
        <div class="card-b flush">
          {enrolled.length === 0 ? (
            <div class="empty">
              <p>Nobody enrolled yet.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Status</th>
                  <th>Next step due</th>
                </tr>
              </thead>
              <tbody>
                {enrolled.map((e) => (
                  <tr>
                    <td>
                      <div>{e.name ?? '—'}</div>
                      <div class="faint mono">{e.email}</div>
                    </td>
                    <td>{statusPill(e.status)}</td>
                    <td class="faint">{fmtDate(e.nextRunAt)}</td>
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

mail.post('/sequences/:id/steps', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()

  // The delay default depends on the position, which `addStep` computes — so it
  // takes the raw field and normalizes once it knows where the step landed.
  const raw = form.get('delay')
  await addStep(db, id, {
    subject: String(form.get('subject') ?? ''),
    ...readBody(form),
    ...(raw !== null && String(raw).trim() !== '' ? { delayDays: Number(raw) } : {}),
  })

  return c.redirect(`/sequences/${id}?flash=Step added.`)
})

mail.get('/sequences/:id/steps/:stepId', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const stepId = Number(c.req.param('stepId'))

  const step = await db.select().from(sequenceSteps).where(eq(sequenceSteps.id, stepId)).get()
  if (!step || step.sequenceId !== id) return c.notFound()
  const seq = await db.select().from(sequences).where(eq(sequences.id, id)).get()

  return c.html(
    <Layout title={`Step ${step.position}`} nav="seq" editor>
      <div class="head">
        <div>
          <h1>
            Step {step.position} · {seq?.name}
          </h1>
          <div class="sub">
            Editing a step never re-sends it to anyone who already received it.
          </div>
        </div>
        <div class="actions">
          <a class="btn" href={`/sequences/${id}`}>
            Back to sequence
          </a>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} />

      <div class="card">
        <div class="card-b">
          <form method="post" action={`/sequences/${id}/steps/${stepId}`}>
            <div class="row">
              <div class="field">
                <label>Subject</label>
                <input type="text" name="subject" value={step.subject} required />
              </div>
              <div class="field">
                <label>Delay after previous step (days)</label>
                <input type="number" name="delay" value={String(step.delayDays)} min="0" max="365" />
                <p class="faint" style="margin:6px 0 0">
                  {step.position === 1
                    ? '0 = sent as soon as someone joins this sequence.'
                    : '0 = sent immediately after the previous step.'}
                </p>
              </div>
            </div>
            <RichEditor json={step.bodyJson} md={step.bodyMd} />
            <button class="btn primary">Save step</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Danger zone</h2>
        </div>
        <div class="card-b">
          <form method="post" action={`/sequences/${id}/steps/${stepId}/delete`}>
            <button class="btn danger">Delete this step</button>
            <span class="faint" style="margin-left:10px">
              Enrollments pointing at it advance to the next step.
            </span>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

mail.post('/sequences/:id/steps/:stepId', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const stepId = Number(c.req.param('stepId'))
  const form = await c.req.formData()

  // `updateStep` reads the stored position to pick the fallback delay when the
  // field arrives empty, so an empty field is simply not sent.
  const raw = form.get('delay')
  const result = await updateStep(db, stepId, {
    subject: String(form.get('subject') ?? ''),
    ...readBody(form),
    ...(raw !== null && String(raw).trim() !== '' ? { delayDays: Number(raw) } : {}),
  })
  if (!result.ok) return c.notFound()

  return c.redirect(`/sequences/${id}/steps/${stepId}?flash=Saved.`)
})

mail.post('/sequences/:id/steps/:stepId/delete', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const stepId = Number(c.req.param('stepId'))

  await deleteStep(db, stepId)

  return c.redirect(`/sequences/${id}?flash=Step deleted.`)
})

mail.post('/sequences/:id/toggle', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const s = await db.select().from(sequences).where(eq(sequences.id, id)).get()
  if (!s) return c.notFound()

  const result = await setSequenceActive(db, id, !s.isActive)
  if (!result.ok) {
    return c.redirect(`/sequences/${id}?flash=${encodeURIComponent(result.reason!)}&kind=warn`)
  }
  return c.redirect(`/sequences/${id}?flash=${s.isActive ? 'Paused.' : 'Live.'}`)
})

mail.post('/sequences/:id/enroll-all', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const active = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(eq(subscribers.status, 'active'))
    .limit(500)
    .all()

  let n = 0
  for (const s of active) {
    // `enroll` refuses anyone who previously left this series — a standing
    // preference, not something an operator bulk action may override.
    if ((await enroll(db, id, s.id)) === 'enrolled') n++
  }
  return c.redirect(`/sequences/${id}?flash=${encodeURIComponent(`Enrolled ${n}.`)}`)
})

mail.post('/sequences/tick', async (c) => {
  const db = getDb(c.env)
  const n = await tickSequences(c.env, db)
  return c.redirect(`/sequences?flash=${encodeURIComponent(`Sent ${n} message(s).`)}`)
})
