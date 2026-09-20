import { asc, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import {
  broadcastStats,
  createBroadcast,
  reviseSentBroadcast,
  startBroadcast,
} from '../core/broadcasts.ts'
import { listCampaigns } from '../core/campaigns.ts'
import { storeMedia } from '../core/media.ts'
import { clearFeatureImage, publishPost, setFeatureImage, unpublishPost } from '../core/posts.ts'
import { aiScanConfigured, scanDoc } from '../core/ai-scan.ts'
import { type Photo, searchPhotos, triggerDownload, unsplashConfigured } from '../core/unsplash.ts'
import { countSegment, describeRule, listSegments } from '../core/segments.ts'
import {
  type SequenceTrigger,
  addStep,
  createSequence,
  deleteStep,
  enroll,
  getSequence,
  reorderSteps,
  sequenceStats,
  setSequenceActive,
  stepsFor,
  tickSequences,
  updateSequence,
  updateStep,
} from '../core/sequences.ts'
import { findPlaceholders } from '../core/sequence-templates/index.ts'
import { BROADCAST_SCOPE_LABEL, footerPreviewHtml, previewHtml } from '../core/render.ts'
import { type PreviewTarget, previewAddress, sendPreview } from '../core/sending.ts'
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
  ComposeLayout,
  EditorHint,
  Flash,
  Layout,
  MailReader,
  RichEditor,
  fmtDate,
  readCampaignId,
  readEditorBody,
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
          Custom: {describeRule(rule ?? {}, choices.allTags)}
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

/** Every broadcast carries the same consent footer, so it is computed once. */
const broadcastFooter = footerPreviewHtml({ kind: 'broadcast' }, BROADCAST_SCOPE_LABEL)

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
    <ComposeLayout
      title="New broadcast"
      nav="bc"
      action="/broadcasts"
      autosave="/broadcasts/autosave"
      scan={aiScanConfigured(c.env)}
      preview="/broadcasts/preview"
      back="/broadcasts"
      backLabel="Back to broadcasts"
      heading="New broadcast"
      sub={<>{statusPill('draft')} nothing is sent until you say so</>}
      actions={<button class="btn primary">Save draft</button>}
      side={
        <>
          <div class="side-sec">
            <AudiencePicker choices={choices} value="" />
          </div>
          {allCampaigns.length > 0 ? (
            <div class="side-sec">
              <CampaignPicker all={allCampaigns} value={null} />
            </div>
          ) : null}
          <div class="side-sec">
            <h3>Writing</h3>
            <EditorHint />
          </div>
        </>
      }
      foot={
        <>
          <PreviewButton to={previewAddress(c.env)} />
          <button class="btn primary">Save draft</button>
        </>
      }
    >
      <Subject />
      <RichEditor bare footer={broadcastFooter} />
    </ComposeLayout>,
  )
})

/**
 * The result of the last save or preview, alongside the Save button — Kit's
 * "Saved" tell. A refusal ("not a subscriber") has to look different from a
 * confirmation, or a preview that never left reads as one that did.
 */
const FootNote = ({ msg, kind }: { msg?: string; kind?: string }) =>
  msg ? <span class={kind === 'warn' ? 'foot-warn' : 'faint'}>{msg}</span> : null

/**
 * Save the draft, then mail one copy to the operator's own address.
 *
 * A submit button inside the composer's form, not a link and not a second form:
 * that is what makes the preview show the words currently on screen. The address
 * is printed next to it because "where did that go?" should never be a question
 * about something that puts mail on the wire.
 */
const PreviewButton = ({ to }: { to: string }) => (
  <button class="btn" name="preview" value="1" data-to={to} title={`Sends one copy to ${to}`}>
    Send a preview
  </button>
)

/** The one field that sets like a headline, because it reads like one. */
const Subject = ({ value }: { value?: string }) => (
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

/**
 * Did the operator press "Send a preview" rather than "Save"?
 *
 * The preview button is a submit inside the composer's own form, so the draft
 * is written first and the copy that lands is the one on screen — not whatever
 * was saved last time. A button's value only rides along when it is the button
 * that was clicked.
 */
function wantsPreview(form: FormData): boolean {
  return String(form.get('preview') ?? '') === '1'
}

/** Sends the preview and turns the outcome into a redirect query string. */
async function previewFlash(env: Env, db: Db, target: PreviewTarget): Promise<string> {
  const result = await sendPreview(env, db, target, previewAddress(env))
  return result.ok
    ? `?flash=${encodeURIComponent(`Preview sent to ${result.to}.`)}`
    : `?flash=${encodeURIComponent(`No preview sent. ${result.reason}`)}&kind=warn`
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

  const subject = String(form.get('subject') ?? 'Untitled')
  const id = await createBroadcast(db, {
    subject,
    ...readEditorBody(form),
    ...audience,
    campaignId: readCampaignId(form),
  })

  const q = wantsPreview(form)
    ? await previewFlash(c.env, db, { kind: 'broadcast', broadcastId: id, subject })
    : ''
  return c.redirect(`/broadcasts/${id}${q}`)
})

/**
 * ⭐ The timed save. Writes a draft and nothing else.
 *
 * It creates the row on the first call for a new broadcast, updates it after
 * that, and refuses outright the moment a broadcast leaves `draft` — a send in
 * flight must never have its audience or body moved under it. It cannot send,
 * schedule or cancel: the only verb here is "write down what is on screen".
 */
mail.post('/broadcasts/autosave', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const { segs } = await audienceChoices(db)
  const subject = String(form.get('subject') ?? '')
  const rawId = String(form.get('id') ?? '').trim()

  if (!rawId) {
    const audience = resolveAudience(String(form.get('audience') ?? ''), segs, {
      segment: {},
      segmentId: null,
    })
    const id = await createBroadcast(db, {
      subject: subject || 'Untitled',
      ...readEditorBody(form),
      ...audience,
      campaignId: readCampaignId(form),
    })
    return c.json({ ok: true, id, url: `/broadcasts/${id}`, action: `/broadcasts/${id}/edit` })
  }

  const id = Number(rawId)
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) return c.json({ ok: false, reason: 'that broadcast is gone' }, 404)
  if (b.status !== 'draft') return c.json({ ok: false, reason: 'only drafts can be edited' }, 409)

  const audience = resolveAudience(String(form.get('audience') ?? ''), segs, {
    segment: b.segment ?? {},
    segmentId: b.segmentId,
  })
  await db
    .update(broadcasts)
    .set({
      subject,
      ...readEditorBody(form),
      ...audience,
      campaignId: readCampaignId(form),
    })
    .where(eq(broadcasts.id, id))

  return c.json({ ok: true, id, url: `/broadcasts/${id}`, action: `/broadcasts/${id}/edit` })
})

/**
 * The AI-text dial, for every composer that has one. It reads the posted form
 * rather than a saved row, so the score is for the words on screen — including
 * a draft that has never been saved. Writes nothing.
 */
mail.post('/ai-scan', async (c) => {
  const { bodyJson, bodyMd } = readEditorBody(await c.req.formData())
  return c.json(await scanDoc(c.env, bodyJson, bodyMd))
})

/** One copy to the operator's own address, answered in JSON for the dialog. */
mail.post('/broadcasts/preview', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const b = await db
    .select()
    .from(broadcasts)
    .where(eq(broadcasts.id, Number(form.get('id'))))
    .get()
  if (!b) return c.json({ ok: false, reason: 'that broadcast is gone' }, 404)

  const result = await sendPreview(
    c.env,
    db,
    { kind: 'broadcast', broadcastId: b.id, subject: b.subject },
    previewAddress(c.env),
  )
  return result.ok
    ? c.json({ ok: true, to: result.to })
    : c.json({ ok: false, reason: result.reason }, 422)
})

mail.get('/broadcasts/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) return c.notFound()

  const stats = await broadcastStats(db, id)
  // Bounces never reached a human, so every rate on this page is over this and
  // never over `delivered` — provider delivered-webhook coverage is partial.
  const reached = Math.max(0, stats.recipients - stats.bounced)
  const audienceSize = await countSegment(db, b.segment ?? {})
  const choices = await audienceChoices(db)
  const allCampaigns = await listCampaigns(db)
  const editable = b.status === 'draft'
  const segName = choices.segs.find((s) => s.id === b.segmentId)?.name
  const campaign = allCampaigns.find((x) => x.id === b.campaignId)

  // A draft is a thing you write, so it opens in the composer. Anything past
  // draft is a thing that happened, so it stays a report — numbers, and the
  // mail exactly as it went out.
  if (editable) {
    return c.html(
      <ComposeLayout
        title={b.subject}
        nav="bc"
        action={`/broadcasts/${id}/edit`}
        autosave="/broadcasts/autosave"
        scan={aiScanConfigured(c.env)}
        preview="/broadcasts/preview"
        recordId={id}
        back="/broadcasts"
        backLabel="Back to broadcasts"
        heading={b.subject || 'Untitled'}
        sub={
          <>
            {statusPill(b.status)} {describeRule(b.segment ?? {}, choices.allTags)} · {audienceSize}{' '}
            {audienceSize === 1 ? 'person' : 'people'}
          </>
        }
        actions={
          <>
            <button class="btn accent" form="send-now">
              Send now
            </button>
            <button class="btn primary">Save</button>
          </>
        }
        side={
          <>
            <div class="side-sec">
              <AudiencePicker choices={choices} value={currentChoice(b)} rule={b.segment ?? {}} />
              {segName ? (
                <p class="faint" style="margin:8px 0 0">
                  Copied from segment <a href={`/segments/${b.segmentId}`}>{segName}</a>
                </p>
              ) : null}
            </div>
            {allCampaigns.length > 0 ? (
              <div class="side-sec">
                <CampaignPicker all={allCampaigns} value={b.campaignId} />
                {campaign ? (
                  <p class="faint" style="margin:8px 0 0">
                    <a href={`/campaigns/${campaign.id}`}>Open {campaign.name} →</a>
                  </p>
                ) : null}
              </div>
            ) : null}
            {c.env.SITE_URL ? (
              <div class="side-sec">
                <h3>Web</h3>
                {/* Checked by default, and the box is the whole decision: a
                    broadcast is a post unless it's something you'd rather not
                    have a public URL — a sales push, a note to one segment. */}
                <label style="text-transform:none;letter-spacing:0;font-size:13px;color:var(--muted);display:flex;gap:9px;align-items:flex-start;margin:0">
                  <input
                    type="checkbox"
                    name="publish_on_send"
                    checked={b.publishOnSend}
                    style="width:auto;margin-top:3px"
                  />
                  <span>Publish to the web when this sends</span>
                </label>
                <p class="faint" style="margin:10px 0 0">
                  {b.publishedAt ? 'Published' : 'Not published yet'} ·{' '}
                  <a href={`/broadcasts/${id}/publishing`}>Publishing →</a>
                </p>
              </div>
            ) : null}
            <div class="side-sec">
              <h3>Writing</h3>
              <EditorHint />
            </div>
          </>
        }
        foot={
          <>
            <FootNote msg={c.req.query('flash')} kind={c.req.query('kind')} />
            <PreviewButton to={previewAddress(c.env)} />
            <button class="btn primary">Save</button>
          </>
        }
        // Sending posts somewhere else, so it is its own form reached by id —
        // forms cannot nest.
        extra={<form id="send-now" method="post" action={`/broadcasts/${id}/send`} hidden />}
      >
        <Subject value={b.subject} />
        <RichEditor json={b.bodyJson} md={b.bodyMd} bare footer={broadcastFooter} />
      </ComposeLayout>,
    )
  }

  // Only a finished send can be corrected: while it is scheduled or going out,
  // the body on this row is still what the queue will mail.
  const revisable = b.status === 'sent'
  const asMailed = b.revisedAt !== null && c.req.query('as') === 'mailed'
  // A sent broadcast opens straight into the editor. The as-mailed copy is a
  // record, so it stays read-only.
  const revising = revisable && !asMailed
  const shown = asMailed
    ? { json: b.originalBodyJson, md: b.originalBodyMd ?? '' }
    : { json: b.bodyJson, md: b.bodyMd }

  return c.html(
    <Layout title={b.subject} nav="bc" editor>
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
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

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
                {reached > 0 ? (
                  <div class="h">{((stats.opened / reached) * 100).toFixed(1)}% of reached</div>
                ) : null}
              </div>
              <div class="stat">
                <div class="n">{stats.clicked}</div>
                <div class="l">Clicked</div>
                {stats.opened > 0 ? (
                  <div class="h">
                    {((stats.clicked / stats.opened) * 100).toFixed(2)}% of readers
                  </div>
                ) : null}
              </div>
              <div class="stat">
                <div class="n">{stats.unsubscribed}</div>
                <div class="l">Unsubscribed</div>
                {reached > 0 ? (
                  <div class="h">{((stats.unsubscribed / reached) * 100).toFixed(2)}% of reached</div>
                ) : null}
              </div>
              {stats.source === 'live' ? (
                <>
                  <div class="stat">
                    <div class="n">{stats.suppressed}</div>
                    <div class="l">Skipped</div>
                  </div>
                  <div class="stat">
                    <div class="n">{stats.failed}</div>
                    <div class="l">Failed</div>
                  </div>
                </>
              ) : null}
            </div>
            {stats.source === 'imported' ? (
              <p class="faint" style="margin:26px 0 0">
                Totals carried over from Kit. There are no per-recipient records behind them, so
                nothing here can be opened up — and rates are over recipients, which Kit already
                reports net of bounces.
              </p>
            ) : null}
        </div>
      </div>

      <WebStatus env={c.env} b={b} />

      {revising ? (
        // A plain form with an explicit save — no autosave. Every save here
        // rewrites a live page, so it happens when you say so and not before.
        <form class="card" method="post" action={`/broadcasts/${id}/revise`}>
          <div class="card-h">
            <h2>Content</h2>
            {b.revisedAt ? (
              <span class="faint">
                Edited {fmtDate(b.revisedAt)} ·{' '}
                <a href={`/broadcasts/${id}?as=mailed`}>show as mailed</a>
              </span>
            ) : null}
            <div class="actions">
              <button class="btn primary">Save changes</button>
            </div>
          </div>
          <div class="card-b">
            <div class="note">
              <strong>This already went out, and saving won't send it again.</strong> The change
              shows up on the web page and here. The copy as it was mailed is kept.
            </div>
            <Subject value={b.subject} />
            <RichEditor json={b.bodyJson} md={b.bodyMd} bare inline footer={broadcastFooter} />
          </div>
        </form>
      ) : (
        <div class="card">
          <div class="card-h">
            <h2>Content</h2>
            {asMailed ? (
              <span class="faint">
                As mailed · <a href={`/broadcasts/${id}`}>back to editing</a>
              </span>
            ) : null}
          </div>
          <div class="card-b">
            {asMailed ? (
              <p class="faint" style="margin:0 0 18px">
                Subject as mailed: <strong>{b.originalSubject}</strong>
              </p>
            ) : null}
            <MailReader
              json={shown.json}
              md={shown.md}
              fallback={previewHtml(shown.json, shown.md)}
              footer={broadcastFooter}
            />
          </div>
        </div>
      )}
    </Layout>,
  )
})

/**
 * One line on the broadcast report: is this thing on the web, and where.
 *
 * The controls themselves live on their own page. They have to work for drafts
 * too, and a draft opens in the composer — which is one full-page form, and
 * forms cannot nest.
 */
const WebStatus: FC<{ env: Env; b: Broadcast }> = ({ env, b }) => {
  if (!env.SITE_URL) return null
  const url = b.slug ? `${env.SITE_URL.replace(/\/$/, '')}/${b.slug}` : ''

  return (
    <div class="card">
      <div class="card-h">
        <h2>Web</h2>
        <a class="btn" href={`/broadcasts/${b.id}/publishing`}>
          {b.publishedAt ? 'Manage' : 'Publish'}
        </a>
      </div>
      <div class="card-b">
        {b.publishedAt ? (
          <p style="margin:0">
            Published {fmtDate(b.publishedAt)} at <a href={url}>{url}</a>
          </p>
        ) : (
          <p class="faint" style="margin:0">
            Not on the public site. Publishing sends nothing — it puts this piece on a page.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * The publishing screen: the featured image and the post's URL and card copy.
 *
 * Deliberately its own page rather than a panel on the broadcast. It works the
 * same whatever state the broadcast is in — draft, sent, or imported from Kit —
 * and it holds four separate forms, which no composer screen could.
 */
mail.get('/broadcasts/:id/publishing', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) return c.notFound()
  if (!c.env.SITE_URL) {
    return c.redirect(`/broadcasts/${id}?flash=No public site is configured.&kind=warn`)
  }

  // The Unsplash picker is a GET round trip, not a fetch: `?photo_q=` re-renders
  // this page with results. No JavaScript, and the search survives a refresh
  // because it is in the URL.
  const photoQuery = (c.req.query('photo_q') ?? '').trim()
  let photos: Photo[] = []
  let photoError: string | null = null
  if (photoQuery && unsplashConfigured(c.env)) {
    try {
      photos = await searchPhotos(c.env, photoQuery)
    } catch (err) {
      photoError = err instanceof Error ? err.message : 'Unsplash search failed.'
    }
  }

  return c.html(
    <Layout title={`Publishing · ${b.subject}`} nav="bc">
      <div class="head">
        <div>
          <h1>Publishing</h1>
          <div class="sub">
            <a href={`/broadcasts/${id}`}>← {b.subject || 'Untitled'}</a> · {statusPill(b.status)}
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <FeatureImage env={c.env} b={b} photos={photos} query={photoQuery} photoError={photoError} />
      <Publishing env={c.env} b={b} />
    </Layout>,
  )
})

/**
 * Picking the picture that fronts the post — on the card, in the OG preview, and
 * at the top of the page.
 *
 * Three plain HTML forms, no JavaScript. Upload posts a file; the Unsplash
 * search is a GET that re-renders this page with results; choosing one posts the
 * photo's fields back. They are siblings rather than one form because forms
 * cannot nest, and the publish form sits right below them.
 */
const FeatureImage: FC<{
  env: Env
  b: Broadcast
  photos: Photo[]
  query: string
  photoError: string | null
}> = ({ env, b, photos, query, photoError }) => {
  if (!env.SITE_URL) return null
  const stock = unsplashConfigured(env)

  return (
    <div class="card">
      <div class="card-h">
        <h2>Featured image</h2>
        {b.featureImage ? (
          <form method="post" action={`/broadcasts/${b.id}/feature-image/clear`}>
            <button class="btn">Remove</button>
          </form>
        ) : null}
      </div>
      <div class="card-b">
        {b.featureImage ? (
          <figure style="margin:0 0 22px">
            <img
              src={b.featureImage}
              alt=""
              style="width:100%;max-height:320px;object-fit:cover;border-radius:12px;display:block"
            />
            {b.featureImageCredit ? (
              <figcaption class="faint" style="margin-top:9px;font-size:12.5px">
                Photo by{' '}
                <a href={b.featureImageCreditUrl ?? '#'} target="_blank" rel="noopener">
                  {b.featureImageCredit}
                </a>{' '}
                on Unsplash — shown under the image on the post.
              </figcaption>
            ) : null}
          </figure>
        ) : (
          <p class="faint" style="margin:0 0 22px">
            No image set. The post falls back to the first image in the body, and to a text-only
            card if there isn't one.
          </p>
        )}

        <h3>Upload</h3>
        <form
          method="post"
          action={`/broadcasts/${b.id}/feature-image/upload`}
          enctype="multipart/form-data"
          style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 28px"
        >
          <input type="file" name="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" required />
          <button class="btn primary">Upload</button>
        </form>

        <h3>Unsplash</h3>
        {stock ? (
          <>
            <form
              method="get"
              action={`/broadcasts/${b.id}/publishing`}
              style="display:flex;gap:10px;margin:0 0 18px;flex-wrap:wrap"
            >
              <input
                type="text"
                name="photo_q"
                value={query}
                placeholder="ocean, shorebird, empty desk…"
                style="flex:1;min-width:200px"
              />
              <button class="btn">Search</button>
            </form>

            {photoError ? <p class="faint">{photoError}</p> : null}
            {query && !photoError && photos.length === 0 ? (
              <p class="faint">Nothing found for “{query}”.</p>
            ) : null}

            <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
              {photos.map((p) => (
                // One form per photo: the button IS the choice, and every field
                // it needs travels with it. Nothing is held in a session between
                // the search and the pick.
                <form method="post" action={`/broadcasts/${b.id}/feature-image/unsplash`}>
                  <input type="hidden" name="url" value={p.url} />
                  <input type="hidden" name="credit" value={p.credit} />
                  <input type="hidden" name="credit_url" value={p.creditUrl} />
                  <input type="hidden" name="download_location" value={p.downloadLocation} />
                  <button
                    type="submit"
                    title={p.alt || `Photo by ${p.credit}`}
                    style={`display:block;width:100%;padding:0;border:1px solid rgba(148,190,255,.16);border-radius:10px;overflow:hidden;cursor:pointer;background:${p.color ?? 'transparent'}`}
                  >
                    <img
                      src={p.thumbUrl}
                      alt={p.alt}
                      loading="lazy"
                      style="width:100%;aspect-ratio:3/2;object-fit:cover;display:block"
                    />
                    <span
                      style="display:block;padding:7px 9px;font-size:11.5px;text-align:left;background:rgba(3,10,26,.82);color:#9db2d4"
                    >
                      {p.credit}
                    </span>
                  </button>
                </form>
              ))}
            </div>
          </>
        ) : (
          <p class="faint" style="margin:0">
            Set the <code>UNSPLASH_ACCESS_KEY</code> secret to search stock photos here. Upload
            works without it.
          </p>
        )}
      </div>
    </div>
  )
}

mail.post('/broadcasts/:id/feature-image/upload', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))

  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return c.redirect(`/broadcasts/${id}/publishing?flash=Pick a file first.&kind=warn`)
  }

  const stored = await storeMedia(c.env, db, file)
  if (!stored.ok) {
    return c.redirect(`/broadcasts/${id}/publishing?flash=${encodeURIComponent(stored.message)}&kind=warn`)
  }

  // An uploaded image is the operator's own, so no credit line.
  await setFeatureImage(db, id, { url: stored.url })
  return c.redirect(`/broadcasts/${id}/publishing?flash=Featured image set.`)
})

mail.post('/broadcasts/:id/feature-image/unsplash', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()

  const url = String(form.get('url') ?? '')
  // Only Unsplash's own CDN, and only from this form. The field is posted by a
  // browser, so it is not trustworthy just because we rendered it a moment ago.
  if (!/^https:\/\/images\.unsplash\.com\//.test(url)) {
    return c.redirect(`/broadcasts/${id}/publishing?flash=That isn't an Unsplash image.&kind=warn`)
  }

  await setFeatureImage(db, id, {
    url,
    credit: String(form.get('credit') ?? '').trim() || null,
    creditUrl: String(form.get('credit_url') ?? '').trim() || null,
  })

  // Required by the API guidelines, and only ever on an actual pick.
  c.executionCtx.waitUntil(triggerDownload(c.env, String(form.get('download_location') ?? '')))

  return c.redirect(`/broadcasts/${id}?flash=Featured image set.`)
})

mail.post('/broadcasts/:id/feature-image/clear', async (c) => {
  const id = Number(c.req.param('id'))
  await clearFeatureImage(getDb(c.env), id)
  return c.redirect(`/broadcasts/${id}/publishing?flash=Featured image removed.`)
})

/**
 * Put this broadcast on the public site, or take it down.
 *
 * Lives on the report view — the screen for mail that has already happened —
 * rather than in the composer. Writing and publishing are separate acts here on
 * purpose: the piece goes to the list first, and the web page is a second,
 * deliberate decision made afterwards. (MCP can publish anything at any point;
 * this is the screen, not the rule.)
 */
const Publishing: FC<{ env: Env; b: Broadcast }> = ({ env, b }) => {
  // No public site configured means nothing to publish to, so the card would be
  // a button that does nothing visible.
  if (!env.SITE_URL) return null
  const origin = env.SITE_URL.replace(/\/$/, '')
  const live = Boolean(b.publishedAt)
  const url = b.slug ? `${origin}/${b.slug}` : ''

  return (
    <div class="card">
      <div class="card-h">
        <h2>{live ? 'Published' : 'Publish to the web'}</h2>
        {live ? (
          <form method="post" action={`/broadcasts/${b.id}/unpublish`}>
            <button class="btn">Take down</button>
          </form>
        ) : null}
      </div>
      <div class="card-b">
        {live ? (
          <p style="margin:0 0 18px">
            Live at <a href={url}>{url}</a> · published {fmtDate(b.publishedAt)}
          </p>
        ) : (
          <p class="faint" style="margin:0 0 18px">
            Goes up at <code>{origin}/{b.slug || 'slug-from-the-subject'}</code>. Nothing is mailed
            and nothing about the send changes.
          </p>
        )}

        <form method="post" action={`/broadcasts/${b.id}/publish`} class="stack">
          <label>
            <span>URL slug</span>
            <input type="text" name="slug" value={b.slug ?? ''} placeholder="derived from the subject" />
          </label>
          <p class="faint" style="margin:-8px 0 4px;font-size:12.5px">
            Leave as-is once it's live — changing it breaks every link anyone has shared.
          </p>
          <label>
            <span>Excerpt</span>
            <textarea name="excerpt" rows={3} placeholder="derived from the first lines of the body">
              {b.excerpt ?? ''}
            </textarea>
          </label>
          <div>
            <button class="btn primary">{live ? 'Update' : 'Publish'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

mail.post('/broadcasts/:id/publish', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()

  const post = await publishPost(db, id, {
    slug: String(form.get('slug') ?? '').trim() || null,
    excerpt: String(form.get('excerpt') ?? '').trim() || null,
  })

  return c.redirect(
    `/broadcasts/${id}/publishing?flash=${encodeURIComponent(`Published at /${post.slug}`)}`,
  )
})

mail.post('/broadcasts/:id/unpublish', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  await unpublishPost(db, id)
  // The slug is kept, so putting it back restores the same URL.
  return c.redirect(`/broadcasts/${id}/publishing?flash=Taken down.&kind=warn`)
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

  const subject = String(form.get('subject') ?? '')
  await db
    .update(broadcasts)
    .set({
      subject,
      ...readEditorBody(form),
      ...audience,
      campaignId: readCampaignId(form),
      // Only the full-form save writes this. Autosave posts a subset, and an
      // unchecked checkbox posts nothing at all — so reading it there would
      // silently switch publishing off every few seconds while you typed.
      publishOnSend: form.get('publish_on_send') !== null,
    })
    .where(eq(broadcasts.id, id))

  if (wantsPreview(form)) {
    return c.redirect(
      `/broadcasts/${id}${await previewFlash(c.env, db, { kind: 'broadcast', broadcastId: id, subject })}`,
    )
  }
  return c.redirect(`/broadcasts/${id}?flash=Saved.`)
})

/**
 * Correct a sent broadcast. Writes the subject and body and nothing else — see
 * `reviseSentBroadcast` for why that can never put anything in an inbox.
 */
mail.post('/broadcasts/:id/revise', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()

  const result = await reviseSentBroadcast(db, id, {
    subject: String(form.get('subject') ?? '').trim(),
    ...readEditorBody(form),
  })
  if (!result.ok) {
    return c.redirect(
      `/broadcasts/${id}?flash=${encodeURIComponent(`Not saved: ${result.reason}.`)}&kind=warn`,
    )
  }
  return c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent('Saved. Nothing was sent.')}`)
})

mail.post('/broadcasts/:id/send', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const n = await startBroadcast(c.env, db, id)
  return c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent(`Queued ${n} message(s).`)}`)
})

// ───────────────────────────────────────────────── sequences

type SequenceRow = Awaited<ReturnType<typeof sequenceListRows>>[number]

async function sequenceListRows(db: Db) {
  // Newest first — the sequence being worked on is almost always the last one
  // made. `createdAt`, not `id`, because imported Kit sequences were backfilled
  // in whatever order the export listed them.
  const rows = await db.select().from(sequences).orderBy(desc(sequences.createdAt)).all()
  return await Promise.all(rows.map(async (s) => ({ ...s, stats: await sequenceStats(db, s.id) })))
}

function SequenceTable({ rows }: { rows: SequenceRow[] }) {
  return (
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
        {rows.map((s) => (
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
  )
}

mail.get('/sequences', async (c) => {
  const db = getDb(c.env)
  const rows = await sequenceListRows(db)
  const live = rows.filter((s) => s.isActive)
  const off = rows.filter((s) => !s.isActive)

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
          <a class="btn" href="/sequences/new">
            New sequence
          </a>
          <a class="btn primary" href="/sequences/templates">
            Create from template
          </a>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} />

      <div class="card">
        <div class="card-b flush">
          {live.length === 0 ? (
            <div class="empty">
              <p>{rows.length === 0 ? 'No sequences yet.' : 'No live sequences.'}</p>
            </div>
          ) : (
            <SequenceTable rows={live} />
          )}
        </div>
      </div>

      {off.length > 0 && (
        <details style="margin-top:1rem">
          <summary class="faint" style="cursor:pointer">
            {off.length} inactive {off.length === 1 ? 'sequence' : 'sequences'}
          </summary>
          <div class="card" style="margin-top:.5rem">
            <div class="card-b flush">
              <SequenceTable rows={off} />
            </div>
          </div>
        </details>
      )}
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
        <div class="actions">
          <a class="btn" href="/sequences/templates">
            Create from template
          </a>
        </div>
      </div>
      <div class="card">
        <div class="card-b">
          <div class="note">
            The <strong>name</strong> and <strong>description</strong> are shown to subscribers in
            their preference center, so write them so a reader recognizes what they'd be leaving.
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
                  <option value="">(none)</option>
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
      subscriberId: subscribers.id,
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

  const allTags = await db.select().from(tags).orderBy(asc(tags.name)).all()
  const allCampaigns = await listCampaigns(db)

  return c.html(
    <Layout title={s.name} nav="seq">
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

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

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

      {/* Everything /sequences/new asked for, asked again — a sequence whose
          trigger can only be set once is a sequence you rebuild to change. */}
      <div class="card">
        <div class="card-h">
          <h2>Settings</h2>
        </div>
        <div class="card-b">
          <div class="note">
            The <strong>name</strong> and <strong>description</strong> are shown to subscribers in
            their preference center, so write them so a reader recognizes what they'd be leaving.
          </div>
          <form method="post" action={`/sequences/${id}`}>
            <div class="field">
              <label>Name</label>
              <input type="text" name="name" value={s.name} required />
            </div>
            <div class="field">
              <label>Description (shown to subscribers)</label>
              <input type="text" name="description" value={s.description ?? ''} />
            </div>
            <div class="row">
              <div class="field">
                <label>Trigger</label>
                <select name="trigger">
                  <option value="subscribe" selected={s.trigger === 'subscribe'}>
                    When someone subscribes
                  </option>
                  <option value="tag_added" selected={s.trigger === 'tag_added'}>
                    When a tag is added
                  </option>
                  <option value="manual" selected={s.trigger === 'manual'}>
                    Manual only
                  </option>
                </select>
              </div>
              <div class="field">
                <label>Trigger tag (for "tag added")</label>
                <select name="triggerTagId">
                  <option value="">(none)</option>
                  {allTags.map((t) => (
                    <option value={String(t.id)} selected={t.id === s.triggerTagId}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <CampaignPicker
              all={allCampaigns}
              value={s.campaignId}
              hint="Clicks on this series count as a touch for the campaign."
            />
            <button class="btn primary">Save settings</button>
            {s.isActive ? (
              <p class="faint" style="margin:8px 0 0">
                This sequence is live. Changing the trigger changes who gets enrolled from here on;
                it never touches anyone already in it.
              </p>
            ) : null}
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Steps</h2>
          <div class="actions">
            <a class="btn sm primary" href={`/sequences/${id}/steps/new`}>
              Add a step
            </a>
          </div>
        </div>
        <div class="card-b flush">
          {steps.length === 0 ? (
            <div class="empty">
              <p>No steps yet.</p>
              <p>
                <a href={`/sequences/${id}/steps/new`}>Write the first one →</a>
              </p>
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
                {steps.map((st, i) => {
                  const href = `/sequences/${id}/steps/${st.id}`
                  return (
                    <tr class="rowlink">
                      <td class="num">
                        <a href={href} tabindex={-1} aria-hidden="true">
                          {st.position}
                        </a>
                      </td>
                      <td>
                        <a class="rl" href={href}>
                          {st.subject}
                        </a>
                        {/* Template scaffolding left in this step. Core refuses
                            to activate while any remains, so say where it is. */}
                        {findPlaceholders(st).length > 0 && (
                          <>
                            {' '}
                            <span class="pill warn">{findPlaceholders(st).length} to fill in</span>
                          </>
                        )}
                      </td>
                      <td class="faint">
                        <a href={href} tabindex={-1} aria-hidden="true">
                          {formatDelay(st.delayDays)}
                        </a>
                      </td>
                      {/* Order is the one thing you can't fix from inside the
                          step editor, since a delay is relative to the step
                          before it. Two buttons beat retyping every delay. */}
                      <td style="width:1%;white-space:nowrap;text-align:right">
                        <form
                          method="post"
                          action={`/sequences/${id}/steps/reorder`}
                          style="display:inline"
                        >
                          <input type="hidden" name="stepId" value={String(st.id)} />
                          <button
                            class="btn sm"
                            name="dir"
                            value="up"
                            disabled={i === 0}
                            title="Move earlier"
                          >
                            ↑
                          </button>{' '}
                          <button
                            class="btn sm"
                            name="dir"
                            value="down"
                            disabled={i === steps.length - 1}
                            title="Move later"
                          >
                            ↓
                          </button>
                        </form>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Enrollments</h2>
          <div class="actions">
            <form
              method="post"
              action={`/sequences/${id}/enroll`}
              style="display:flex;gap:6px;align-items:center"
            >
              <input
                type="email"
                name="email"
                placeholder="email address"
                required
                style="width:200px;min-width:0"
              />
              <button class="btn sm">Enroll</button>
            </form>
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
                      <a href={`/subscribers/${e.subscriberId}`}>
                        <div>{e.name ?? '-'}</div>
                        <div class="faint mono">{e.email}</div>
                      </a>
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
  const subject = String(form.get('subject') ?? '')
  const added = await addStep(db, id, {
    subject,
    ...readEditorBody(form),
    ...(raw !== null && String(raw).trim() !== '' ? { delayDays: Number(raw) } : {}),
  })

  // A preview keeps you on the step you just wrote — you are still working on it.
  if (wantsPreview(form) && added.stepId) {
    const q = await previewFlash(c.env, db, {
      kind: 'sequence',
      stepId: added.stepId,
      sequenceId: id,
      subject,
    })
    return c.redirect(`/sequences/${id}/steps/${added.stepId}${q}`)
  }

  return c.redirect(`/sequences/${id}?flash=Step added.`)
})

/**
 * ⭐ The timed save for a sequence step. Same contract as the broadcast one:
 * creates on the first call, updates after that, writes nothing but the step.
 *
 * A step needs no draft check — a sequence step is never mid-flight the way a
 * broadcast is, and editing one has never re-sent it to anyone who already got
 * it. Whether the sequence is live is a separate, deliberate switch.
 */
mail.post('/sequences/:id/steps/autosave', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const subject = String(form.get('subject') ?? '')
  const raw = form.get('delay')
  const delay = raw !== null && String(raw).trim() !== '' ? { delayDays: Number(raw) } : {}
  const rawId = String(form.get('id') ?? '').trim()

  if (!rawId) {
    const added = await addStep(db, id, { subject, ...readEditorBody(form), ...delay })
    if (!added.ok || !added.stepId) {
      return c.json({ ok: false, reason: added.reason ?? 'could not add the step' }, 422)
    }
    return c.json({
      ok: true,
      id: added.stepId,
      url: `/sequences/${id}/steps/${added.stepId}`,
      action: `/sequences/${id}/steps/${added.stepId}`,
    })
  }

  const stepId = Number(rawId)
  const result = await updateStep(db, stepId, { subject, ...readEditorBody(form), ...delay })
  if (!result.ok) return c.json({ ok: false, reason: 'that step is gone' }, 404)

  return c.json({
    ok: true,
    id: stepId,
    url: `/sequences/${id}/steps/${stepId}`,
    action: `/sequences/${id}/steps/${stepId}`,
  })
})

/** One copy of a step to the operator's own address, answered for the dialog. */
mail.post('/sequences/:id/steps/preview', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const stepId = Number(form.get('id'))

  const step = await db.select().from(sequenceSteps).where(eq(sequenceSteps.id, stepId)).get()
  if (!step || step.sequenceId !== id) return c.json({ ok: false, reason: 'that step is gone' }, 404)

  const result = await sendPreview(
    c.env,
    db,
    { kind: 'sequence', stepId, sequenceId: id, subject: step.subject },
    previewAddress(c.env),
  )
  return result.ok
    ? c.json({ ok: true, to: result.to })
    : c.json({ ok: false, reason: result.reason }, 422)
})

/**
 * Writing a new step gets the same full-screen composer a broadcast does.
 * Registered ahead of `/:stepId` so "new" isn't read as an id.
 */
mail.get('/sequences/:id/steps/new', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const seq = await db.select().from(sequences).where(eq(sequences.id, id)).get()
  if (!seq) return c.notFound()

  const count = await db
    .select()
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, id))
    .orderBy(asc(sequenceSteps.position))
    .all()
  const first = count.length === 0

  return c.html(
    <ComposeLayout
      title={`New step · ${seq.name}`}
      nav="seq"
      action={`/sequences/${id}/steps`}
      autosave={`/sequences/${id}/steps/autosave`}
      scan={aiScanConfigured(c.env)}
      preview={`/sequences/${id}/steps/preview`}
      back={`/sequences/${id}`}
      backLabel="Back to sequence"
      heading={`Step ${count.length + 1} · ${seq.name}`}
      sub={
        <>
          {seq.isActive ? statusPill('active') : statusPill('draft')} nothing goes out until you
          save
        </>
      }
      actions={<button class="btn primary">Add step</button>}
      side={
        <>
          <div class="side-sec">
            <StepDelay value={first ? '0' : '1'} first={first} />
          </div>
          {!first && (
            <div class="side-sec">
              <h3>All steps</h3>
              <StepNav seqId={id} steps={count} current={null} />
            </div>
          )}
          <div class="side-sec">
            <h3>Writing</h3>
            <EditorHint />
          </div>
        </>
      }
      foot={
        <>
          <PreviewButton to={previewAddress(c.env)} />
          <button class="btn primary">Add step</button>
        </>
      }
    >
      <Subject />
      <RichEditor bare footer={footerPreviewHtml({ kind: 'sequence', sequenceId: id }, seq.name)} />
    </ComposeLayout>,
  )
})

/** How long after the previous step this one waits. */
const StepDelay = ({ value, first }: { value: string; first: boolean }) => (
  <div class="field">
    <label>Delay after previous step (days)</label>
    {/* The first step defaults to 0 — a welcome email should arrive on signup,
        not a day later. Everything after it defaults to 1. */}
    <input type="number" name="delay" value={value} min="0" max="365" />
    <p class="faint" style="margin:8px 0 0">
      {first
        ? '0 = sent as soon as someone joins this sequence.'
        : '0 = sent immediately after the previous step.'}
    </p>
  </div>
)

/**
 * The other steps in the sequence, so the composer is a place you can move
 * around in rather than a dead end you have to back out of.
 * `current` is the step being edited; `null` while writing a new one.
 */
const StepNav = ({
  seqId,
  steps,
  current,
}: {
  seqId: number
  steps: { id: number; position: number; subject: string; delayDays: number }[]
  current: number | null
}) => (
  <nav class="stepnav">
    <ol>
      {steps.map((st) => {
        const here = st.id === current
        const inner = (
          <>
            <span class="n">{st.position}</span>
            <span class="s">{st.subject || 'Untitled'}</span>
            <span class="d">{formatDelay(st.delayDays)}</span>
          </>
        )
        return (
          <li class={here ? 'here' : ''}>
            {here ? (
              <span aria-current="step">{inner}</span>
            ) : (
              <a href={`/sequences/${seqId}/steps/${st.id}`}>{inner}</a>
            )}
          </li>
        )
      })}
      {current === null && (
        <li class="here">
          <span aria-current="step">
            <span class="n">{steps.length + 1}</span>
            <span class="s">This step</span>
            <span class="d">new</span>
          </span>
        </li>
      )}
    </ol>
    {current !== null && (
      <a class="btn sm stepnav-add" href={`/sequences/${seqId}/steps/new`}>
        Add a step
      </a>
    )}
  </nav>
)

mail.get('/sequences/:id/steps/:stepId', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const stepId = Number(c.req.param('stepId'))

  const step = await db.select().from(sequenceSteps).where(eq(sequenceSteps.id, stepId)).get()
  if (!step || step.sequenceId !== id) return c.notFound()
  const seq = await db.select().from(sequences).where(eq(sequences.id, id)).get()

  // The whole run of steps, so the sidebar can jump straight to any of them.
  const siblings = await db
    .select()
    .from(sequenceSteps)
    .where(eq(sequenceSteps.sequenceId, id))
    .orderBy(asc(sequenceSteps.position))
    .all()

  return c.html(
    <ComposeLayout
      title={`Step ${step.position} · ${seq?.name ?? 'Sequence'}`}
      nav="seq"
      action={`/sequences/${id}/steps/${stepId}`}
      autosave={`/sequences/${id}/steps/autosave`}
      scan={aiScanConfigured(c.env)}
      preview={`/sequences/${id}/steps/preview`}
      recordId={stepId}
      back={`/sequences/${id}`}
      backLabel="Back to sequence"
      heading={`Step ${step.position} · ${seq?.name ?? ''}`}
      sub={<>Editing never re-sends this to anyone who already received it.</>}
      actions={<button class="btn primary">Save step</button>}
      side={
        <>
          <div class="side-sec">
            <StepDelay value={String(step.delayDays)} first={step.position === 1} />
          </div>
          <div class="side-sec">
            <h3>All steps</h3>
            <StepNav seqId={id} steps={siblings} current={stepId} />
          </div>
          <div class="side-sec">
            <h3>Writing</h3>
            <EditorHint />
          </div>
          <div class="side-sec">
            <h3>Danger zone</h3>
            <button class="btn danger" form="delete-step">
              Delete this step
            </button>
            <p class="faint" style="margin:10px 0 0">
              Enrollments pointing at it advance to the next step.
            </p>
          </div>
        </>
      }
      foot={
        <>
          <FootNote msg={c.req.query('flash')} kind={c.req.query('kind')} />
          <PreviewButton to={previewAddress(c.env)} />
          <button class="btn primary">Save step</button>
        </>
      }
      extra={
        <form id="delete-step" method="post" action={`/sequences/${id}/steps/${stepId}/delete`} hidden />
      }
    >
      <Subject value={step.subject} />
      <RichEditor
        json={step.bodyJson}
        md={step.bodyMd}
        bare
        footer={footerPreviewHtml({ kind: 'sequence', sequenceId: id }, seq?.name ?? '')}
      />
    </ComposeLayout>,
  )
})

/**
 * Move one step one place earlier or later. `reorderSteps` takes the full order.
 *
 * Declared above `/steps/:stepId` for the same reason the settings route is
 * declared below `/sequences/tick` — first match registered wins, so `reorder`
 * would otherwise arrive as a step id.
 */
mail.post('/sequences/:id/steps/reorder', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const stepId = Number(form.get('stepId'))
  const dir = String(form.get('dir') ?? '')

  const order = (await stepsFor(db, id)).map((st) => st.id)
  const from = order.indexOf(stepId)
  const to = dir === 'up' ? from - 1 : from + 1
  if (from < 0 || to < 0 || to >= order.length) return c.redirect(`/sequences/${id}`)

  order[from] = order[to]!
  order[to] = stepId

  const result = await reorderSteps(db, id, order)
  if (!result.ok) {
    return c.redirect(`/sequences/${id}?flash=${encodeURIComponent(result.reason!)}&kind=warn`)
  }
  return c.redirect(`/sequences/${id}?flash=Steps reordered.`)
})

mail.post('/sequences/:id/steps/:stepId', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const stepId = Number(c.req.param('stepId'))
  const form = await c.req.formData()

  // `updateStep` reads the stored position to pick the fallback delay when the
  // field arrives empty, so an empty field is simply not sent.
  const raw = form.get('delay')
  const subject = String(form.get('subject') ?? '')
  const result = await updateStep(db, stepId, {
    subject,
    ...readEditorBody(form),
    ...(raw !== null && String(raw).trim() !== '' ? { delayDays: Number(raw) } : {}),
  })
  if (!result.ok) return c.notFound()

  if (wantsPreview(form)) {
    const q = await previewFlash(c.env, db, {
      kind: 'sequence',
      stepId,
      sequenceId: id,
      subject,
    })
    return c.redirect(`/sequences/${id}/steps/${stepId}${q}`)
  }

  return c.redirect(`/sequences/${id}/steps/${stepId}?flash=Saved.`)
})

mail.post('/sequences/:id/steps/:stepId/delete', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const stepId = Number(c.req.param('stepId'))

  await deleteStep(db, stepId)

  return c.redirect(`/sequences/${id}?flash=Step deleted.`)
})

mail.post('/sequences/:id/enroll', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase()

  const who = await db
    .select({ id: subscribers.id, status: subscribers.status })
    .from(subscribers)
    .where(eq(subscribers.email, email))
    .get()

  const warn = (msg: string) =>
    c.redirect(`/sequences/${id}?flash=${encodeURIComponent(msg)}&kind=warn`)

  if (!who) return warn(`Nobody on the list has the address ${email}.`)
  // Enrolling an unsubscribed person would queue mail for somebody who asked to
  // stop hearing from us. `enroll` guards this series; status guards the list.
  if (who.status !== 'active') return warn(`${email} is ${who.status}, so they can't be enrolled.`)

  switch (await enroll(db, id, who.id)) {
    case 'enrolled':
      return c.redirect(`/sequences/${id}?flash=${encodeURIComponent(`Enrolled ${email}.`)}`)
    case 'already':
      return warn(`${email} is already in this sequence.`)
    case 'opted_out':
      return warn(`${email} left this series. Only they can rejoin, from the preference center.`)
    case 'no_steps':
      return warn('This sequence has no steps yet, so there is nothing to enroll anyone into.')
  }
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

/**
 * Edit the settings. Registered last on purpose: Hono matches in registration
 * order, so `/sequences/:id` declared any earlier would swallow the static
 * `/sequences/tick` above it.
 */
mail.post('/sequences/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const triggerTagId = String(form.get('triggerTagId') ?? '')

  const result = await updateSequence(db, id, {
    name: String(form.get('name') ?? '').trim() || 'Untitled',
    description: String(form.get('description') ?? '') || null,
    trigger: String(form.get('trigger') ?? 'manual') as SequenceTrigger,
    triggerTagId: triggerTagId ? Number(triggerTagId) : null,
    campaignId: readCampaignId(form),
  })
  if (!result.ok) {
    return c.redirect(`/sequences/${id}?flash=${encodeURIComponent(result.reason!)}&kind=warn`)
  }

  // A live `tag_added` sequence with no tag would enroll nobody and say nothing
  // about it, so it's worth a word here rather than a silent no-op later.
  const s = await getSequence(db, id)
  if (s?.isActive && s.trigger === 'tag_added' && !s.triggerTagId) {
    return c.redirect(
      `/sequences/${id}?flash=${encodeURIComponent('Saved, but this trigger has no tag — nobody will be enrolled until you pick one.')}&kind=warn`,
    )
  }
  return c.redirect(`/sequences/${id}?flash=Settings saved.`)
})
