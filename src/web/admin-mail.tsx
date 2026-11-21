import { asc, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import {
  broadcastStats,
  createBroadcast,
  reviseSentBroadcast,
  resumeBroadcast,
  resumeOutlook,
  startBroadcast,
} from '../core/broadcasts.ts'
import { fromAddressStanding } from '../core/domains.ts'
import { listCampaigns } from '../core/campaigns.ts'
import { storeMedia } from '../core/media.ts'
import { setPostTags, tagSlug, tagsForPost } from '../core/post-tags.ts'
import {
  clearFeatureImage,
  postPath,
  publishPost,
  setFeatureImage,
  setPostFeatured,
  uniqueSlug,
  unpublishPost,
} from '../core/posts.ts'
import { ACCESS_LEVELS, LEVEL_LABEL, isAccessLevel } from '../core/member-access.ts'
import { postPlainText } from '../core/render-web.ts'
import { searchPhotos, triggerDownload, unsplashConfigured } from '../core/unsplash.ts'
import { aiReady, modelLabel } from '../core/ai/openrouter.ts'
import { type Target, latestDone, reviewOf } from '../core/council.ts'
import { resolveAi } from '../core/ai/settings.ts'
import { getVoice, voiceSummary } from '../core/ai/ghostwriter-voice.ts'
import { countSegment, describeRule, listSegments } from '../core/segments.ts'
import {
  type SequenceTrigger,
  addStep,
  createSequence,
  deleteStep,
  enroll,
  getSequence,
  listSequences,
  removeExit,
  reorderSteps,
  sequenceFlow,
  sequenceStats,
  setExit,
  setSequenceActive,
  stepsFor,
  storedWindow,
  tickSequences,
  updateSequence,
  updateStep,
} from '../core/sequences.ts'
import { findPlaceholders } from '../core/sequence-templates/index.ts'
import { clock, parseClock, timeZones } from '../core/send-window.ts'
import { getTimeZone, setTimeZone } from '../core/site-settings.ts'
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
import { refuse } from './audit.ts'
import {
  CampaignPicker,
  type ComposeAi,
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

/** The composer's AI buttons, or null to hide them when no key is set up to pay. */
async function composeAi(env: Env, db: Db, context: string): Promise<ComposeAi | null> {
  const ai = await resolveAi(env, db)
  if (!ai.ready) return null
  return {
    subjectModel: modelLabel(ai.models.subject),
    cleanupModel: modelLabel(ai.models.cleanup),
    ghostModel: modelLabel(ai.models.ghostwriter),
    ghostVoice: voiceSummary(await getVoice(db)),
    context,
  }
}

// ───────────────────────────────────────────────── the reader council

interface CouncilGlance {
  verdict: string | null
  split: 'divides' | 'safe' | null
}

/** What the side column says about the council: null hides it (AI off). */
async function councilSide(env: Env, db: Db, target: Target): Promise<CouncilGlance | null> {
  if (!(await aiReady(env, db))) return null
  const last = await latestDone(db, target)
  const review = last ? reviewOf(last) : null
  return { verdict: review?.verdict ?? null, split: review?.split ?? null }
}

/**
 * "Ask the council" in an editor's side column. A named submit in the
 * composer's form: the draft is saved first, then the review desk opens. It
 * never calls a model by itself; the desk has the button that does.
 */
const CouncilSide: FC<{ review: CouncilGlance | null }> = ({ review }) =>
  review ? (
    <div class="side-sec" data-test="council-side">
      <h3>Reader council</h3>
      <p class="faint" style="margin:0 0 10px">
        A fan, a skeptic and someone in between read your draft, then an editor says what to keep and what to cut.
        Advice only.
      </p>
      {review.verdict ? (
        <p style="margin:0 0 10px">
          <span class={review.split === 'divides' ? 'pill ok' : 'pill warn'}>
            {review.split === 'divides' ? 'Divides the room' : 'Plays it safe'}
          </span>{' '}
          <span class="faint">{review.verdict}</span>
        </p>
      ) : null}
      <button class="btn sm" name="council" value="1" data-test="ask-council">
        {review.verdict ? 'Open the review' : 'Ask the council'}
      </button>
    </div>
  ) : null

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
      slop
      ai={await composeAi(c.env, db, 'a newsletter broadcast to the list')}
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
          <WebPanel env={c.env} b={null} topics={[]} mode="draft" />
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
      <Excerpt />
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
 * The line under the subject. One field, three jobs: the grey lead under the
 * mail's title, the inbox preview text, and the card copy on the web. It sits
 * under the headline because that is where it reads.
 */
const Excerpt = ({ value }: { value?: string | null }) => (
  <div class="compose-dek">
    <label class="hide-vis" for="excerpt">
      Excerpt
    </label>
    <textarea
      class="dek"
      id="excerpt"
      name="excerpt"
      rows={1}
      placeholder="Excerpt: the line under the title, the inbox preview, and the web card"
    >
      {value ?? ''}
    </textarea>
  </div>
)

/**
 * The web fields the composer carries, written as a patch — and only the ones
 * the form actually had on it, so a page without the panel can't blank them.
 *
 * Topics are the exception that is opt-in: every topic typed becomes a row, so
 * the timed save (which fires mid-word) must not write them. The panel posts
 * them on its own once the field is left, and every full save writes them too.
 */
async function savePostFields(
  db: Db,
  id: number,
  form: FormData,
  opts: { topics: boolean },
): Promise<void> {
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) return

  const patch: Partial<typeof broadcasts.$inferInsert> = {}
  if (form.has('excerpt')) {
    patch.excerpt = String(form.get('excerpt')).replace(/\s+/g, ' ').trim() || null
  }
  // Says the email-or-web choice was on the page. A radio set always posts its
  // pick, but a form without one posts nothing, which must mean "leave it".
  if (form.has('publish_on_send_shown')) {
    patch.publishOnSend = String(form.get('publish_on_send') ?? '') !== ''
  }
  if (form.has('web_panel')) {
    patch.featured = form.has('featured')
    const level = form.get('access_level')
    if (isAccessLevel(level)) patch.accessLevel = level
    const slug = String(form.get('slug') ?? '').trim()
    if (slug) {
      if (slug !== b.slug) patch.slug = await uniqueSlug(db, id, slug)
    } else if (!b.publishedAt) {
      // Blank means "derive it from the subject when it goes up". A live post
      // keeps its URL: blanking the box is not a reason to break shared links.
      patch.slug = null
    }
  }
  if (Object.keys(patch).length) await db.update(broadcasts).set(patch).where(eq(broadcasts.id, id))

  if (opts.topics && form.has('topics')) await setPostTags(db, id, readTopics(form))
}

function readTopics(form: FormData): string[] {
  return String(form.get('topics') ?? form.get('tags') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** A fetch from the side panel wants an answer, not a page. */
function wantsJson(accept: string | undefined): boolean {
  return (accept ?? '').includes('application/json')
}

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
  await savePostFields(db, id, form, { topics: true })

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
    await savePostFields(db, id, form, { topics: false })
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
  await savePostFields(db, id, form, { topics: false })

  return c.json({ ok: true, id, url: `/broadcasts/${id}`, action: `/broadcasts/${id}/edit` })
})

/** Unsplash results for the side panel's picker, as JSON. */
mail.get('/photos/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (!unsplashConfigured(c.env)) return c.json({ ok: false, reason: 'Unsplash is not set up.' }, 404)
  if (!q) return c.json({ ok: true, photos: [] })
  try {
    const page = Math.min(20, Math.max(1, Number(c.req.query('page')) || 1))
    return c.json({ ok: true, photos: await searchPhotos(c.env, q, page) })
  } catch (err) {
    return c.json({ ok: false, reason: err instanceof Error ? err.message : 'Unsplash search failed.' }, 502)
  }
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
  const topics = (await tagsForPost(db, id)).map((t) => t.name)

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
        slop
        ai={await composeAi(c.env, db, 'a newsletter broadcast to the list')}
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
            {/* A submit in the composer's own form, like the preview button:
                the draft is saved first, so what's confirmed and sent is what's
                on screen. It never sends; it opens the confirmation screen. */}
            <button class="btn accent" name="send" value="1">
              Send…
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
            <WebPanel env={c.env} b={b} topics={topics} mode="draft" />
            <CouncilSide review={await councilSide(c.env, db, { kind: 'broadcast', id })} />
          </>
        }
        foot={
          <>
            <FootNote msg={c.req.query('flash')} kind={c.req.query('kind')} />
            <PreviewButton to={previewAddress(c.env)} />
            <button class="btn primary">Save</button>
          </>
        }
      >
        <Subject value={b.subject} />
        <Excerpt value={b.excerpt} />
        <RichEditor json={b.bodyJson} md={b.bodyMd} bare footer={broadcastFooter} />
      </ComposeLayout>,
    )
  }

  // Only a finished send can be corrected: while it is scheduled or going out,
  // the body on this row is still what the queue will mail. A cancelled send is
  // finished too — part of it went out, and its web page is live.
  const revisable = b.status === 'sent' || b.status === 'cancelled'
  const locked = b.status === 'sending' || b.status === 'scheduled'
  const asMailed = b.revisedAt !== null && c.req.query('as') === 'mailed'
  // A sent broadcast opens straight into the editor. The as-mailed copy is a
  // record, so it stays read-only.
  const revising = revisable && !asMailed
  const shown = asMailed
    ? { json: b.originalBodyJson, md: b.originalBodyMd ?? '' }
    : { json: b.bodyJson, md: b.bodyMd }

  // Sent mail opens in the same composer a draft does: headline subject, the
  // paper sheet, the dial and the settings down the right. Only what differs is
  // different. There is no autosave and no send: every save rewrites a live
  // page, so it happens when the Save button is pressed and not before.
  const save = revising ? <button class="btn primary">Save changes</button> : null
  // A cancelled send can be picked up where it stopped. A link, not a submit:
  // it opens its own confirmation screen and never sends from here.
  const resume =
    b.status === 'cancelled' && !asMailed ? (
      <a class="btn accent" href={`/broadcasts/${id}/resume`}>
        Resume sending…
      </a>
    ) : null
  const back = asMailed ? (
    <a class="btn" href={`/broadcasts/${id}`}>
      Back to editing
    </a>
  ) : null

  return c.html(
    <ComposeLayout
      title={b.subject}
      nav="bc"
      action={revising ? `/broadcasts/${id}/revise` : `/broadcasts/${id}`}
      slop
      ai={revising ? await composeAi(c.env, db, 'a newsletter broadcast that has already been sent') : null}
      recordId={id}
      back="/broadcasts"
      backLabel="Back to broadcasts"
      heading={b.subject || 'Untitled'}
      sub={
        <>
          {statusPill(b.status)}{' '}
          {locked
            ? 'editing unlocks when the send finishes: the queue is still mailing this text'
            : asMailed
              ? 'as it was mailed'
              : 'saving never sends it again'}
        </>
      }
      actions={
        save || resume ? (
          <>
            {resume}
            {save}
          </>
        ) : (
          back
        )
      }
      side={
        <>
          <div class="side-sec">
            <h3>Sent to</h3>
            <p style="margin:0">
              {describeRule(b.segment ?? {}, choices.allTags)} · {audienceSize}{' '}
              {audienceSize === 1 ? 'person' : 'people'}
            </p>
            {b.sentAt ? <p class="faint" style="margin:8px 0 0">Sent {fmtDate(b.sentAt)}</p> : null}
            {segName ? (
              <p class="faint" style="margin:8px 0 0">
                From segment <a href={`/segments/${b.segmentId}`}>{segName}</a>
              </p>
            ) : null}
            {campaign ? (
              <p class="faint" style="margin:8px 0 0">
                Campaign <a href={`/campaigns/${campaign.id}`}>{campaign.name}</a>
              </p>
            ) : null}
          </div>
          <WebPanel env={c.env} b={b} topics={topics} mode={revising ? 'sent' : 'locked'} />
          {/* A sent broadcast can still be mailed to its author, one copy, as many
              times as they like: that is how a change to the email template gets
              looked at in a real inbox. `formaction`, so it never saves the
              editor's contents on the way: a save here rewrites a live page. */}
          <div class="side-sec">
            <h3>Preview</h3>
            <button
              class="btn sm"
              type="submit"
              formaction={`/broadcasts/${id}/preview`}
              formnovalidate
              title={`Sends the saved version, with today's template, to ${previewAddress(c.env)}. Not counted in the numbers.`}
            >
              Send a preview
            </button>
            <p class="faint" style="margin:8px 0 0">One copy to {previewAddress(c.env)}.</p>
          </div>
          {asMailed ? (
            <div class="side-sec">
              <p class="faint" style="margin:0">
                As it went out. <a href={`/broadcasts/${id}`}>Back to the current version</a>
              </p>
            </div>
          ) : b.revisedAt ? (
            <div class="side-sec">
              <p class="faint" style="margin:0">
                Edited {fmtDate(b.revisedAt)} · <a href={`/broadcasts/${id}?as=mailed`}>show as mailed</a>
              </p>
            </div>
          ) : null}
        </>
      }
      foot={
        <>
          <FootNote msg={c.req.query('flash')} kind={c.req.query('kind')} />
          {save ?? back}
        </>
      }
    >
      {/* The numbers lead: they are what a sent broadcast has that a draft doesn't. */}
      <div class="compose-stats">
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
            {stats.machineOpened > 0 ? (
              <div class="h" title="Apple Mail Privacy Protection and other prefetchers fetch the pixel whether or not anyone reads the mail. Left out of Opened.">
                + {stats.machineOpened} machine opens, not counted
              </div>
            ) : null}
          </div>
          <div class="stat">
            <div class="n">{stats.clicked}</div>
            <div class="l">Clicked</div>
            {stats.opened > 0 ? (
              <div class="h">{((stats.clicked / stats.opened) * 100).toFixed(2)}% of readers</div>
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
          <p class="faint" style="margin:20px 0 0">
            Totals carried over from Kit. There are no per-recipient records behind them, so
            nothing here can be opened up, and rates are over recipients, which Kit already
            reports net of bounces.
          </p>
        ) : null}
      </div>

      {asMailed ? (
        <>
          <div class="compose-subject">
            <div class="subj" role="heading" aria-level={2}>
              {b.originalSubject || b.subject}
            </div>
          </div>
          <MailReader
            json={shown.json}
            md={shown.md}
            fallback={previewHtml(shown.json, shown.md)}
            footer={broadcastFooter}
          />
        </>
      ) : (
        <>
          <Subject value={b.subject} />
          <Excerpt value={b.excerpt} />
          <RichEditor json={b.bodyJson} md={b.bodyMd} bare footer={broadcastFooter} />
        </>
      )}
    </ComposeLayout>,
  )
})

/** The URL segment a topic name will get — for showing the URL before it exists. */
function topicSlug(name: string | undefined): string | null {
  return name ? tagSlug(name) || null : null
}

/**
 * ⭐ The web half of a broadcast, in the composer's side panel: whether it goes
 * on the site at all, the featured image, the topics, and the URL.
 *
 * It used to be a screen of its own, reached by a link, which made the picture
 * and the card copy an errand run after the writing. Now it sits beside the
 * writing, and the excerpt sits under the subject.
 *
 * The featured image is the one part that is not a form field: it is uploaded or
 * picked from Unsplash by `client/web-panel.ts`, which saves it the moment it is
 * chosen. Everything else rides in the composer's own form and is saved with it.
 *
 * `mode` is what the broadcast is: a `draft` chooses email-and-web or email
 * only, and goes up when it sends; `sent` mail that is being revised publishes
 * or comes down through its own Save; `locked` (mid-send, or the as-mailed
 * copy) has no Save, so its buttons post straight to the publish routes.
 */
const WebPanel: FC<{
  env: Env
  b: Broadcast | null
  topics: string[]
  mode: 'draft' | 'sent' | 'locked'
}> = ({ env, b, topics, mode }) => {
  if (!env.SITE_URL) return null
  const origin = env.SITE_URL.replace(/\/$/, '')
  const live = Boolean(b?.publishedAt)
  const path = postPath(b?.slug || 'from-the-subject', topicSlug(topics[0]))
  const url = `${origin}${path}`
  const stock = unsplashConfigured(env)

  return (
    <div
      class="side-sec web-sec"
      data-web-panel
      data-unsplash={stock ? '1' : undefined}
    >
      <h3>Web</h3>
      <input type="hidden" name="web_panel" value="1" />

      {mode === 'draft' ? (
        <>
          {/* A broadcast is a post unless it's something you'd rather not have
              a public URL for — a sales push, a note to one segment. */}
          <input type="hidden" name="publish_on_send_shown" value="1" />
          <div class="seg2" role="radiogroup" aria-label="Where this goes">
            <label>
              <input type="radio" name="publish_on_send" value="on" checked={b ? b.publishOnSend : true} />
              <span>Email + web</span>
            </label>
            <label>
              <input type="radio" name="publish_on_send" value="" checked={b ? !b.publishOnSend : false} />
              <span>Email only</span>
            </label>
          </div>
          <p class="faint web-note">
            {live ? (
              <>
                Already live at <a href={url}>{url}</a>
              </>
            ) : (
              <>
                <span class="web-when">Goes up at {path} when it sends.</span>
                <span class="web-never">No web page. It only goes to inboxes.</span>
              </>
            )}
          </p>
        </>
      ) : (
        <div class="web-status">
          {live ? (
            <p style="margin:0">
              <span class="pill ok">Live</span> <a href={url}>{path}</a>
            </p>
          ) : (
            <p class="faint" style="margin:0">
              Not on the web.
            </p>
          )}
          <div class="web-acts">
            {mode === 'sent' ? (
              // Through the composer's own Save, so an edit in the body goes up
              // with it rather than being dropped on the way.
              <button class="btn sm" name="web" value={live ? 'unpublish' : 'publish'}>
                {live ? 'Take down' : 'Publish'}
              </button>
            ) : (
              <>
                <button class="btn sm" formaction={`/broadcasts/${b?.id}/publish`} formnovalidate>
                  {live ? 'Update' : 'Publish'}
                </button>
                {live ? (
                  <button class="btn sm" formaction={`/broadcasts/${b?.id}/unpublish`} formnovalidate>
                    Take down
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}

      <div class="web-only">
        <FeaturedImage b={b} stock={stock} />

        <div class="field">
          <label for="topics">Topics</label>
          <input
            type="text"
            id="topics"
            name="topics"
            value={topics.join(', ')}
            placeholder="AI, Databases"
            autocomplete="off"
            data-topics
          />
        </div>

        <label class="web-check">
          <input type="checkbox" name="featured" checked={b?.featured ?? false} />
          <span>Feature it on the front page</span>
        </label>

        {/* On the web only: the mail still goes to its whole segment. A members
            or Premium post shows everyone else the title, the written excerpt
            and a way to sign in or upgrade. */}
        <div class="field">
          <label for="access_level">Who can read it</label>
          <select id="access_level" name="access_level">
            {ACCESS_LEVELS.map((level) => (
              <option value={level} selected={(b?.accessLevel ?? 'public') === level}>
                {LEVEL_LABEL[level]}
              </option>
            ))}
          </select>
        </div>

        <details class="web-slug">
          <summary>URL</summary>
          <input
            type="text"
            name="slug"
            value={b?.slug ?? ''}
            placeholder="from the subject"
            autocomplete="off"
            aria-label="URL slug"
          />
          {live ? <p class="faint">Changing it breaks links people have shared.</p> : null}
        </details>
      </div>
    </div>
  )
}

/**
 * The picture that fronts the post — on the card, in the share preview, and at
 * the top of the page. Rendered here; driven by `client/web-panel.ts`.
 *
 * None of these controls has a `name`: they are not part of the composer's
 * form, and the file and the search box must never ride along with a save.
 */
const FeaturedImage: FC<{ b: Broadcast | null; stock: boolean }> = ({ b, stock }) => (
  <div class="fi" data-fi>
    <div class="fi-frame" data-fi-frame>
      {b?.featureImage ? <img src={b.featureImage} alt="" /> : <span>No featured image</span>}
    </div>
    <p class="fi-credit" data-fi-credit hidden={!b?.featureImageCredit}>
      {b?.featureImageCredit ? (
        <>
          Photo by{' '}
          <a href={b.featureImageCreditUrl ?? '#'} target="_blank" rel="noopener">
            {b.featureImageCredit}
          </a>{' '}
          on Unsplash
        </>
      ) : null}
    </p>
    <div class="fi-acts">
      <button type="button" class="btn sm" data-fi-upload>
        Upload
      </button>
      <button type="button" class="btn sm" data-fi-clear hidden={!b?.featureImage}>
        Remove
      </button>
      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden data-fi-file />
    </div>
    {stock ? (
      <>
        <input type="search" class="fi-q" placeholder="Search Unsplash" autocomplete="off" data-fi-q />
        <div class="fi-grid" data-fi-results />
      </>
    ) : null}
    <p class="fi-note" data-fi-note hidden />
  </div>
)

/** What a panel request gets back: the image as it now stands. */
function imageJson(b: Pick<Broadcast, 'featureImage' | 'featureImageCredit' | 'featureImageCreditUrl'> | undefined) {
  return {
    ok: true,
    image: b?.featureImage
      ? { url: b.featureImage, credit: b.featureImageCredit, creditUrl: b.featureImageCreditUrl }
      : null,
  }
}

async function currentImage(db: Db, id: number) {
  return await db
    .select({
      featureImage: broadcasts.featureImage,
      featureImageCredit: broadcasts.featureImageCredit,
      featureImageCreditUrl: broadcasts.featureImageCreditUrl,
    })
    .from(broadcasts)
    .where(eq(broadcasts.id, id))
    .get()
}

/** The old publishing screen. Everything on it lives in the composer now. */
mail.get('/broadcasts/:id/publishing', (c) => c.redirect(`/broadcasts/${c.req.param('id')}`))

mail.post('/broadcasts/:id/feature-image/upload', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const json = wantsJson(c.req.header('accept'))
  const refuse = (message: string) =>
    json
      ? c.json({ ok: false, reason: message }, 422)
      : c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent(message)}&kind=warn`)

  if (!(await currentImage(db, id))) return c.notFound()
  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return refuse('Pick a file first.')

  const stored = await storeMedia(c.env, db, file)
  if (!stored.ok) return refuse(stored.message)

  // An uploaded image is the operator's own, so no credit line.
  await setFeatureImage(db, id, { url: stored.url })
  return json ? c.json(imageJson(await currentImage(db, id))) : c.redirect(`/broadcasts/${id}?flash=Featured image set.`)
})

mail.post('/broadcasts/:id/feature-image/unsplash', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const json = wantsJson(c.req.header('accept'))
  const form = await c.req.formData()

  if (!(await currentImage(db, id))) return c.notFound()
  const url = String(form.get('url') ?? '')
  // Only Unsplash's own CDN. The field is posted by a browser, so it is not
  // trustworthy just because we rendered it a moment ago.
  if (!/^https:\/\/images\.unsplash\.com\//.test(url)) {
    return json
      ? c.json({ ok: false, reason: "That isn't an Unsplash image." }, 422)
      : c.redirect(`/broadcasts/${id}?flash=That isn't an Unsplash image.&kind=warn`)
  }

  await setFeatureImage(db, id, {
    url,
    credit: String(form.get('credit') ?? '').trim() || null,
    creditUrl: String(form.get('credit_url') ?? '').trim() || null,
  })

  // Required by the API guidelines, and only ever on an actual pick.
  c.executionCtx.waitUntil(triggerDownload(c.env, String(form.get('download_location') ?? '')))

  return json ? c.json(imageJson(await currentImage(db, id))) : c.redirect(`/broadcasts/${id}?flash=Featured image set.`)
})

mail.post('/broadcasts/:id/feature-image/clear', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  await clearFeatureImage(db, id)
  return wantsJson(c.req.header('accept'))
    ? c.json(imageJson(undefined))
    : c.redirect(`/broadcasts/${id}?flash=Featured image removed.`)
})

/**
 * Topics, saved when the field is left. The timed save skips them (a topic
 * typed half-way is a row nobody wanted), so this is what keeps them from
 * living only in the browser.
 */
mail.post('/broadcasts/:id/topics', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  if (!(await currentImage(db, id))) return c.json({ ok: false, reason: 'that broadcast is gone' }, 404)
  const tags = await setPostTags(db, id, readTopics(await c.req.formData()))
  return c.json({ ok: true, topics: tags.map((t) => t.name), primary: tags[0]?.slug ?? null })
})

/** Publish (or refresh) the post from the fields on the form. */
async function publishFromForm(db: Db, id: number, form: FormData): Promise<string> {
  const level = form.get('access_level')
  const post = await publishPost(db, id, {
    slug: String(form.get('slug') ?? '').trim() || null,
    excerpt: String(form.get('excerpt') ?? '').trim() || null,
    ...(isAccessLevel(level) ? { accessLevel: level } : {}),
  })
  await setPostFeatured(db, id, form.get('featured') !== null)
  const tags = await setPostTags(db, id, readTopics(form))
  return postPath(post.slug, tags[0]?.slug)
}

mail.post('/broadcasts/:id/publish', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const path = await publishFromForm(db, id, await c.req.formData())
  return c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent(`Published at ${path}`)}`)
})

mail.post('/broadcasts/:id/unpublish', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  await unpublishPost(db, id)
  // The slug is kept, so putting it back restores the same URL.
  return c.redirect(`/broadcasts/${id}?flash=Taken down.&kind=warn`)
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
    })
    .where(eq(broadcasts.id, id))
  await savePostFields(db, id, form, { topics: true })

  if (wantsPreview(form)) {
    return c.redirect(
      `/broadcasts/${id}${await previewFlash(c.env, db, { kind: 'broadcast', broadcastId: id, subject })}`,
    )
  }
  if (String(form.get('send') ?? '') === '1') return c.redirect(`/broadcasts/${id}/send`)
  // "Ask the council" is a submit in this form, so the council reads what is on screen.
  if (String(form.get('council') ?? '') === '1') return c.redirect(`/broadcasts/${id}/council`)
  return c.redirect(`/broadcasts/${id}?flash=Saved.`)
})

/**
 * Mail one preview of a broadcast that has already gone out (or is going out):
 * the saved version, rendered with the current template, to the operator only.
 * Drafts preview from their own composer, which saves first.
 *
 * Nothing on the form is read. The button lives inside the sent-mail editor,
 * and reading the editor here would mean previewing text that isn't saved, or
 * saving it, which rewrites the live page. Neither belongs behind "preview".
 */
mail.post('/broadcasts/:id/preview', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) return c.notFound()
  if (b.status === 'draft') {
    return c.redirect(
      `/broadcasts/${id}?flash=${encodeURIComponent('Use "Send a preview" in the composer: it saves the draft first.')}&kind=warn`,
    )
  }
  return c.redirect(
    `/broadcasts/${id}${await previewFlash(c.env, db, { kind: 'broadcast', broadcastId: id, subject: b.subject })}`,
  )
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
  await savePostFields(db, id, form, { topics: true })

  // Publish and Take down in the side panel are this form's submits, so the
  // edit on screen goes up (or is kept) along with the decision.
  const web = String(form.get('web') ?? '')
  if (web === 'publish') {
    const path = await publishFromForm(db, id, form)
    return c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent(`Saved and published at ${path}. Nothing was sent.`)}`)
  }
  if (web === 'unpublish') {
    await unpublishPost(db, id)
    return c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent('Saved and taken down. Nothing was sent.')}&kind=warn`)
  }
  return c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent('Saved. Nothing was sent.')}`)
})

/**
 * The confirmation screen: the last stop before real inboxes. It names the
 * audience and its size as of now, shows how the piece opens, and warns when
 * it looks unfinished. The send route below refuses anything that didn't come
 * through here, so a stray click can never mail the list.
 */
mail.get('/broadcasts/:id/send', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) return c.notFound()
  if (b.status !== 'draft') {
    return c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent(`This broadcast is ${b.status}; only a draft can be sent.`)}&kind=warn`)
  }

  const choices = await audienceChoices(db)
  const audienceSize = await countSegment(db, b.segment ?? {})
  const text = postPlainText({ json: b.bodyJson, md: b.bodyMd })
  const words = text ? text.split(/\s+/).length : 0
  const opening = text.split(/\s+/).slice(0, 60).join(' ')

  const blockers: string[] = []
  if (!b.subject.trim()) blockers.push('It has no subject.')
  if (words === 0) blockers.push('It has no body.')
  if (audienceSize === 0) blockers.push('Nobody is in the audience.')
  const warnings: string[] = []
  if (words > 0 && words < 150) warnings.push(`It's short: ${words} words. Is it finished?`)
  if (/\b(TODO|TK|XXX|lorem ipsum)\b/i.test(`${b.subject} ${text}`)) warnings.push('It contains a placeholder (TODO, TK, XXX or lorem ipsum).')
  // An unverified From domain warns and does not block: the domain may well
  // have been verified at the provider long before the Sending domains screen
  // existed.
  const standing = await fromAddressStanding(c.env, db)
  if (standing.domain && standing.status !== 'verified') {
    warnings.push(
      standing.status === 'unknown'
        ? `It comes from ${c.env.FROM_EMAIL}, and ${standing.domain} isn't set up under Sending domains, so nothing here has checked its DNS.`
        : `It comes from ${c.env.FROM_EMAIL}, and ${standing.domain} is ${standing.status} under Sending domains. Mail from it may land in spam or be refused.`,
    )
  }

  const people = `${audienceSize.toLocaleString('en-US')} ${audienceSize === 1 ? 'person' : 'people'}`

  return c.html(
    <Layout title={`Send · ${b.subject}`} nav="bc">
      <div class="head">
        <div>
          <h1>Send this broadcast?</h1>
          <div class="sub">
            <a href={`/broadcasts/${id}`}>← Back to editing</a>
          </div>
        </div>
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />
      <div class="card">
        <div class="card-b">
          <p style="margin:0 0 6px;font-size:22px;line-height:1.35">
            You are about to send <strong>“{b.subject || 'Untitled'}”</strong> to <strong>{people}</strong>.
          </p>
          <p class="faint" style="margin:0 0 22px">
            {describeRule(b.segment ?? {}, choices.allTags)} · counted just now. Once it starts, mail that has gone
            out can't be recalled.
          </p>

          <div class="field">
            <label>How it opens</label>
            <p style="margin:6px 0 0;max-width:70ch;line-height:1.6">
              {opening || <span class="faint">(empty)</span>}
              {words > 60 ? '…' : ''}
            </p>
            <p class="faint" style="margin:8px 0 0">{words.toLocaleString('en-US')} words</p>
          </div>

          {blockers.length ? (
            <div class="flash warn" style="margin:0 0 20px">
              <strong>Can't send yet.</strong> {blockers.join(' ')}
            </div>
          ) : null}
          {warnings.length ? (
            <div class="flash warn" style="margin:0 0 20px">
              <strong>Check before sending.</strong> {warnings.join(' ')}
            </div>
          ) : null}

          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <a class="btn" href={`/broadcasts/${id}`}>
              Back to editing
            </a>
            {blockers.length ? null : (
              <form method="post" action={`/broadcasts/${id}/send`} style="display:inline">
                <input type="hidden" name="confirm" value="send" />
                <input type="hidden" name="expected" value={String(audienceSize)} />
                <button class="btn accent">Send to {people}</button>
              </form>
            )}
          </div>
        </div>
      </div>
    </Layout>,
  )
})

/**
 * Resume a cancelled send: its own confirmation screen, saying plainly who
 * already has it (and won't get it again) and roughly who will.
 */
mail.get('/broadcasts/:id/resume', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) return c.notFound()
  if (b.status !== 'cancelled') {
    return c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent(`This broadcast is ${b.status}; only a cancelled send can be resumed.`)}&kind=warn`)
  }
  const choices = await audienceChoices(db)
  const outlook = (await resumeOutlook(db, id))!
  const { audience: audienceSize, alreadySent, remaining } = outlook
  const n = (x: number) => x.toLocaleString('en-US')

  return c.html(
    <Layout title={`Resume · ${b.subject}`} nav="bc">
      <div class="head">
        <div>
          <h1>Resume this send?</h1>
          <div class="sub">
            <a href={`/broadcasts/${id}`}>← Back to the broadcast</a>
          </div>
        </div>
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />
      <div class="card">
        <div class="card-b">
          <p style="margin:0 0 6px;font-size:22px;line-height:1.35">
            Resume <strong>“{b.subject || 'Untitled'}”</strong>: about <strong>{n(remaining)} more people</strong> will
            get it.
          </p>
          <p class="faint" style="margin:0 0 22px">
            {describeRule(b.segment ?? {}, choices.allTags)} · {n(audienceSize)} in the audience now.
          </p>
          <ul style="margin:0 0 22px;padding-left:18px;line-height:1.7">
            <li>
              <strong>{n(alreadySent)}</strong> already got it. They will not get it again: every person has one message
              per broadcast, and sent ones are never re-sent.
            </li>
            <li>It picks up after the last person reached, and anyone who joined since is included.</li>
            <li>
              Everyone from here on gets the <strong>current</strong> version
              {b.revisedAt ? ', with the correction you saved' : ''}.
            </li>
          </ul>
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <a class="btn" href={`/broadcasts/${id}`}>
              Not now
            </a>
            {remaining > 0 ? (
              <form method="post" action={`/broadcasts/${id}/resume`} style="display:inline">
                <input type="hidden" name="confirm" value="resume" />
                <button class="btn accent">Resume: send to about {n(remaining)} people</button>
              </form>
            ) : (
              <span class="faint">Everyone in the audience already has it.</span>
            )}
          </div>
        </div>
      </div>
    </Layout>,
  )
})

mail.post('/broadcasts/:id/resume', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  if (String(form.get('confirm') ?? '') !== 'resume') return c.redirect(`/broadcasts/${id}/resume`)
  const r = await resumeBroadcast(c.env, db, id)
  if (!r.ok) return c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent(`Not resumed: ${r.reason}.`)}&kind=warn`)
  return c.redirect(`/broadcasts/${id}?flash=${encodeURIComponent('Resumed. It continues where it stopped; nobody gets it twice.')}`)
})

mail.post('/broadcasts/:id/send', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const b = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get()
  if (!b) return c.notFound()
  const form = await c.req.formData()

  // Only the confirmation screen's own button carries these. Anything else —
  // an old tab, a stray form, a double submit — goes back to that screen.
  if (String(form.get('confirm') ?? '') !== 'send') {
    // Looks like a plain redirect, so the audit trail is told it was a refusal.
    refuse(c, 'send was not confirmed on the confirmation screen')
    return c.redirect(`/broadcasts/${id}/send`)
  }

  // The audience can change between the screen and the click (people join,
  // leave, bounce). If it did, show the new number rather than send to it.
  const audienceSize = await countSegment(db, b.segment ?? {})
  if (String(form.get('expected') ?? '') !== String(audienceSize)) {
    return c.redirect(
      `/broadcasts/${id}/send?flash=${encodeURIComponent('The audience changed since you looked. Check the new count.')}&kind=warn`,
    )
  }

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
  const flow = (await sequenceFlow(db, id))!
  const otherSequences = (await listSequences(db)).filter((o) => o.id !== id)
  const zone = await getTimeZone(db)
  const window = storedWindow(s.sendWindowStart, s.sendWindowEnd)

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
          <h2>When it sends</h2>
        </div>
        <div class="card-b">
          <div class="note">
            {window ? (
              <>
                Steps go out between <strong>{clock(window.start)}</strong> and{' '}
                <strong>{clock(window.end)}</strong>, {zone}. A step that comes due outside that
                window waits for it to open; it is never skipped.
              </>
            ) : (
              <>
                Steps go out the minute they come due, day or night. Set a window to keep them to
                the hours you choose.
              </>
            )}
          </div>
          <form method="post" action={`/sequences/${id}/window`}>
            <div class="row">
              <div class="field">
                <label>From</label>
                <input type="time" name="start" value={window ? clock(window.start) : ''} />
              </div>
              <div class="field">
                <label>Until</label>
                <input type="time" name="end" value={window ? clock(window.end) : ''} />
              </div>
              <div class="field">
                <label>Your time zone (every sequence uses it)</label>
                <select name="timeZone">
                  {timeZones().map((z) => (
                    <option value={z} selected={z === zone}>
                      {z}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button class="btn primary">Save window</button>
            <p class="faint" style="margin:8px 0 0">
              Leave both times empty for no window. An end earlier than the start runs past
              midnight, e.g. 22:00 until 06:00.
            </p>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Steps</h2>
          <div class="actions">
            {steps.length > 0 ? (
              <a class="btn sm" href={`/sequences/${id}/takes`}>
                Ghostwriter takes
              </a>
            ) : null}
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

      {/* The other half of the trigger: the trigger says how people get in, this
          says how they get out and where they go. Configured exits are editable;
          the automatic ones are listed as facts, because they are consent and
          deliverability rules and no setting here can switch them off. */}
      <div class="card">
        <div class="card-h">
          <h2>Leaving, and what happens next</h2>
        </div>
        <div class="card-b">
          <form method="post" action={`/sequences/${id}/next`}>
            <div class="row" style="align-items:flex-end">
              <div class="field">
                <label>When someone finishes the last step, add them to</label>
                <select name="nextSequenceId">
                  <option value="">(nothing — the series just ends)</option>
                  {otherSequences.map((o) => (
                    <option value={String(o.id)} selected={o.id === s.nextSequenceId}>
                      {o.name}
                      {o.isActive ? '' : ' (paused)'}
                    </option>
                  ))}
                </select>
              </div>
              <div class="field" style="flex:0 0 auto">
                <button class="btn">Save</button>
              </div>
            </div>
          </form>
          {flow.next && !flow.next.isActive ? (
            <p class="faint" style="margin:0 0 12px">
              <strong>{flow.next.name}</strong> is paused, so finishers are not added to it. Nobody
              is enrolled retroactively when it goes live.
            </p>
          ) : null}
          <p class="faint" style="margin:0 0 16px">
            Applies to people who finish from now on. Anyone who left that series, is already in it,
            or holds one of its exit tags is skipped.
          </p>

          <label>Pulled out early when they get a tag</label>
          {flow.exits.length === 0 ? (
            <p class="faint" style="margin:4px 0 12px">
              No exits configured. A purchase or a link click can tag somebody, so a tag is how you
              say "stop pitching people who already bought".
            </p>
          ) : (
            <table style="margin:4px 0 12px">
              <thead>
                <tr>
                  <th>When they get</th>
                  <th>Then</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {flow.exits.map((x) => (
                  <tr>
                    <td>
                      <span class="pill">{x.tag}</span>
                    </td>
                    <td>
                      {x.then ? (
                        <span>
                          add them to <a href={`/sequences/${x.then.id}`}>{x.then.name}</a>
                          {x.then.isActive ? '' : ' (paused — nobody is added)'}
                        </span>
                      ) : (
                        <span class="faint">they just leave</span>
                      )}
                    </td>
                    <td style="text-align:right">
                      <form method="post" action={`/sequences/${id}/exits/${x.tagId}/delete`}>
                        <button class="btn sm">Remove</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form method="post" action={`/sequences/${id}/exits`}>
            <div class="row" style="align-items:flex-end">
              <div class="field">
                <label>When they get the tag</label>
                <select name="tagId" required>
                  <option value="">(pick a tag)</option>
                  {allTags.map((t) => (
                    <option value={String(t.id)}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label>Then</label>
                <select name="thenSequenceId">
                  <option value="">they just leave</option>
                  {otherSequences.map((o) => (
                    <option value={String(o.id)}>
                      add them to {o.name}
                      {o.isActive ? '' : ' (paused)'}
                    </option>
                  ))}
                </select>
              </div>
              <div class="field" style="flex:0 0 auto">
                <button class="btn">Add exit</button>
              </div>
            </div>
          </form>
          <p class="faint" style="margin:0 0 16px">
            An exit is not an unsubscribe. It stops this series for that person and records why. It
            also keeps anyone who already has the tag from being enrolled.
          </p>

          <label>Always, whatever is set above</label>
          <ul class="faint" style="margin:4px 0 0;padding-left:18px">
            <li>They leave this series from the footer link or their preference center.</li>
            <li>They unsubscribe from everything.</li>
            <li>Their address hard-bounces, or they mark a mail as spam.</li>
            <li>
              A sale is recorded with <span class="mono">end_sequence</span> naming this series.
            </li>
            <li>
              Unsubscribing from the newsletter does <strong>not</strong> pull anyone out.
            </li>
          </ul>

          {flow.feeders.length > 0 ? (
            <p class="faint" style="margin:16px 0 0">
              People arrive here from{' '}
              {flow.feeders.map((f, i) => (
                <span>
                  {i > 0 ? ', ' : ''}
                  <a href={`/sequences/${f.id}`}>{f.name}</a> (
                  {f.how === 'finished' ? 'on finishing' : 'on an exit'})
                </span>
              ))}
              , as well as from the trigger above.
            </p>
          ) : null}
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
      slop
      ai={await composeAi(c.env, db, `step ${count.length + 1} of the automated sequence "${seq.name}"`)}
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
      slop
      ai={await composeAi(c.env, db, `step ${step.position} of the automated sequence "${seq?.name ?? ''}"`)}
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
          <CouncilSide review={await councilSide(c.env, db, { kind: 'step', id: stepId })} />
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
  if (String(form.get('council') ?? '') === '1') return c.redirect(`/sequences/${id}/steps/${stepId}/council`)

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
    case 'has_exit_tag':
      return warn(`${email} already has one of this sequence's exit tags, so they were not enrolled.`)
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
mail.post('/sequences/:id/next', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const raw = String((await c.req.formData()).get('nextSequenceId') ?? '')
  const result = await updateSequence(db, id, { nextSequenceId: raw ? Number(raw) : null })
  if (!result.ok) {
    return c.redirect(`/sequences/${id}?flash=${encodeURIComponent(result.reason!)}&kind=warn`)
  }
  return c.redirect(`/sequences/${id}?flash=Saved.`)
})

mail.post('/sequences/:id/window', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const back = (msg: string, warn = false) =>
    c.redirect(`/sequences/${id}?flash=${encodeURIComponent(msg)}${warn ? '&kind=warn' : ''}`)

  const start = parseClock(String(form.get('start') ?? ''))
  const end = parseClock(String(form.get('end') ?? ''))
  if (start === 'invalid' || end === 'invalid') return back('Times must be HH:MM.', true)

  // The zone first: a window saved against a zone that then failed would read
  // in the wrong hours until somebody noticed.
  const zone = String(form.get('timeZone') ?? '').trim()
  if (zone) {
    const tz = await setTimeZone(db, zone)
    if (!tz.ok) return back(tz.reason!, true)
  }
  const result = await updateSequence(db, id, { sendWindow: { start, end } })
  if (!result.ok) return back(result.reason!, true)
  return back(start === null ? 'No send window: steps go out when due.' : 'Send window saved.')
})

mail.post('/sequences/:id/exits', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const tagId = Number(form.get('tagId') ?? 0)
  const then = String(form.get('thenSequenceId') ?? '')
  const result = await setExit(db, id, tagId, then ? Number(then) : null)
  if (!result.ok) {
    return c.redirect(`/sequences/${id}?flash=${encodeURIComponent(result.reason!)}&kind=warn`)
  }
  return c.redirect(`/sequences/${id}?flash=Exit saved.`)
})

mail.post('/sequences/:id/exits/:tagId/delete', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  await removeExit(db, id, Number(c.req.param('tagId')))
  return c.redirect(`/sequences/${id}?flash=Exit removed.`)
})

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
