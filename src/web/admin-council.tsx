import { type Context, Hono } from 'hono'
import type { FC } from 'hono/jsx'
import { modelLabel } from '../core/ai/catalogue.ts'
import { aiReady, modelFor } from '../core/ai/openrouter.ts'
import {
  type Block,
  type CouncilReview,
  DIAL_ORDER,
  DIAL_TITLES,
  type Note,
  STANCE_LABELS,
  type Target,
  anchoredDraft,
  audienceSummary,
  convene,
  dialOptions,
  getAudience,
  getReview,
  loadDraft,
  notesOf,
  reviewOf,
  reviewsFor,
  saveAudience,
  setNote,
  statusOf,
  targetOf,
} from '../core/council.ts'
import { getDb } from '../db/index.ts'
import type { CouncilReviewRow } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { Flash, Layout, fmtDate } from './layout.tsx'

/**
 * The review desk: the reader council's reading of one draft as a page of its
 * own, the draft on the left with the passages marked, the notes down the
 * margin beside it like comments in a shared document.
 *
 * Thin: every rule lives in `core/council.ts`. Everything a model wrote is
 * rendered as JSX text, which Hono escapes; nothing here uses raw HTML.
 * Advisory: no route here touches a draft or a send.
 */
export const councilAdmin = new Hono<{ Bindings: Env }>()

// Convening spends the AI budget. A cross-site form must not be able to.
councilAdmin.post('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (/\/council(\/|$)/.test(path) && c.req.header('sec-fetch-site') === 'cross-site') {
    return c.text('Cross-site request refused.', 403)
  }
  await next()
})

const deskUrl = (t: Target, seqId?: number) =>
  t.kind === 'broadcast' ? `/broadcasts/${t.id}/council` : `/sequences/${seqId}/steps/${t.id}/council`

async function stepTarget(c: { env: Env; req: { param(k: string): string } }) {
  const db = getDb(c.env)
  const seqId = Number(c.req.param('id'))
  const stepId = Number(c.req.param('stepId'))
  const draft = await loadDraft(db, { kind: 'step', id: stepId })
  if (!draft || draft.editUrl !== `/sequences/${seqId}/steps/${stepId}`) return null
  return { target: { kind: 'step', id: stepId } as Target, seqId }
}

/** Where a review's desk lives. */
async function urlOfRow(env: Env, row: CouncilReviewRow): Promise<string> {
  const t = targetOf(row)
  if (t.kind === 'broadcast') return `${deskUrl(t)}?review=${row.id}`
  const draft = await loadDraft(getDb(env), t)
  return `${draft?.editUrl ?? ''}/council?review=${row.id}`
}

function flashUrl(base: string, msg: string, warn = false): string {
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}flash=${encodeURIComponent(msg)}${warn ? '&kind=warn' : ''}`
}

// ───────────────────────────────────────────── routes

councilAdmin.get('/broadcasts/:id{[0-9]+}/council', async (c) => {
  const t: Target = { kind: 'broadcast', id: Number(c.req.param('id')) }
  return await desk(c, t, deskUrl(t))
})

councilAdmin.get('/sequences/:id{[0-9]+}/steps/:stepId{[0-9]+}/council', async (c) => {
  const found = await stepTarget(c)
  if (!found) return c.notFound()
  return await desk(c, found.target, deskUrl(found.target, found.seqId))
})

councilAdmin.post('/broadcasts/:id{[0-9]+}/council', async (c) => {
  const t: Target = { kind: 'broadcast', id: Number(c.req.param('id')) }
  return await convened(c, t, deskUrl(t))
})

councilAdmin.post('/sequences/:id{[0-9]+}/steps/:stepId{[0-9]+}/council', async (c) => {
  const found = await stepTarget(c)
  if (!found) return c.notFound()
  return await convened(c, found.target, deskUrl(found.target, found.seqId))
})

councilAdmin.post('/council/audience', async (c) => {
  const form = await c.req.formData()
  const back = String(form.get('back') ?? '')
  const safeBack = /^\/(broadcasts|sequences)\/[0-9/a-z]+\/council$/.test(back) ? back : '/broadcasts'
  const input = Object.fromEntries(DIAL_ORDER.map((d) => [d, form.get(d)]))
  const r = await saveAudience(getDb(c.env), input)
  return c.redirect(r.ok ? flashUrl(safeBack, 'Audience saved. The next review uses it.') : flashUrl(safeBack, r.reason, true))
})

councilAdmin.post('/council/:id{[0-9]+}/notes/:note', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const row = await getReview(db, id)
  if (!row) return c.notFound()
  const form = await c.req.formData()
  const ok = await setNote(db, id, c.req.param('note'), String(form.get('dismiss') ?? '') === '1')
  const url = await urlOfRow(c.env, row)
  return c.redirect(ok ? url : flashUrl(url, 'That note is not on this review.', true))
})

type Ctx = Context<{ Bindings: Env }, any>

async function convened(c: Ctx, t: Target, base: string) {
  const r = await convene(c.env, getDb(c.env), t)
  if (r.ok) return c.redirect(`${base}?review=${r.reviewId}`)
  if (!r.reviewId && r.reason === 'That draft does not exist.') return c.notFound()
  const to = r.reviewId ? `${base}?review=${r.reviewId}` : base
  return c.redirect(flashUrl(to, r.reason, true))
}

// ───────────────────────────────────────────── the desk

async function desk(c: Ctx, t: Target, base: string) {
  const db = getDb(c.env)
  const draft = await loadDraft(db, t)
  if (!draft) return c.notFound()
  const [rows, audience, ready] = await Promise.all([reviewsFor(db, t), getAudience(db), aiReady(c.env, db)])
  const model = ready ? modelLabel(await modelFor(c.env, db, 'council')) : null
  const wanted = Number(c.req.query('review') ?? 0)
  const row = (wanted ? rows.find((r) => r.id === wanted) : undefined) ?? rows[0]
  const now = new Date()
  const status = row ? statusOf(row, now) : null
  const review = row ? reviewOf(row) : null

  return c.html(
    <Layout title={`Council · ${draft.subject || 'Untitled'}`} nav={t.kind === 'broadcast' ? 'bc' : 'seq'}>
      <style>{CSS}</style>
      <div class="head">
        <div>
          <h1>Reader council</h1>
          <div class="sub">
            {draft.subject || 'Untitled'} · <a href={draft.editUrl}>Back to the draft</a>
          </div>
        </div>
        <div class="actions">
          {ready ? (
            <form method="post" action={base} style="margin:0">
              <button class="btn primary" data-test="convene">
                {row ? 'Ask the council again' : 'Ask the council'}
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="note" data-test="council-advisory">
        Advice only. The council reads the draft as it is saved, never changes it, and never holds or sends anything.
        {model ? ` One call to ${model}, counted against this month's AI budget.` : ''}
      </div>

      {!ready ? (
        <div class="note warn" data-test="council-off">
          AI is not set up, so the council cannot sit. Choose a key on <a href="/settings/ai">Settings, AI</a>.
        </div>
      ) : null}

      <AudienceForm audience={audience} back={base} />

      {!row ? (
        <div class="card" data-test="council-empty">
          <p style="margin:0">
            No review yet. The council reads what is saved, so save the draft first, then ask. It needs 120 words or
            more to say anything useful.
          </p>
        </div>
      ) : status === 'reading' ? (
        <div class="note" data-test="council-reading">
          The council is still reading this draft (started {fmtDate(row.createdAt)}). Reload in a moment.
        </div>
      ) : status === 'failed' ? (
        <div class="note warn" data-test="council-failed">
          This review did not finish: {row.error ?? 'the reading was interrupted.'} Nothing was changed.
        </div>
      ) : review ? (
        <ReviewDesk row={row} review={review} editUrl={draft.editUrl} />
      ) : null}

      {rows.length > 1 ? (
        <div class="card" style="margin-top:18px">
          <h3 style="margin-top:0">Earlier reviews</h3>
          <ul class="council-history">
            {rows.map((r) => (
              <li>
                {r.id === row?.id ? (
                  <strong>{fmtDate(r.createdAt)}</strong>
                ) : (
                  <a href={`${base}?review=${r.id}`}>{fmtDate(r.createdAt)}</a>
                )}{' '}
                <span class="faint">
                  · {statusOf(r, now) === 'done' ? verdictWord(reviewOf(r)) : statusOf(r, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Layout>,
  )
}

function verdictWord(r: CouncilReview | null): string {
  if (!r) return ''
  return r.split === 'divides' ? 'divides the room' : 'plays it safe'
}

const AudienceForm: FC<{ audience: Record<string, string>; back: string }> = ({ audience, back }) => (
  <details class="card council-audience" style="margin-bottom:18px">
    <summary>
      <strong>Your readers:</strong> <span class="faint">{audienceSummary(audience)}</span>
    </summary>
    <form method="post" action="/council/audience" class="council-dials">
      <input type="hidden" name="back" value={back} />
      {DIAL_ORDER.map((d) => (
        <label>
          {DIAL_TITLES[d]}
          <select name={d}>
            {dialOptions(d).map((o) => (
              <option value={o.value} selected={audience[d] === o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button class="btn sm">Save readers</button>
    </form>
    <p class="faint" style="margin:10px 0 0">
      These four choices are all the model hears about your audience. Nothing about your subscribers is sent.
    </p>
  </details>
)

const ReviewDesk: FC<{ row: CouncilReviewRow; review: CouncilReview; editUrl: string }> = ({ row, review, editUrl }) => {
  const blocks = anchoredDraft(row)
  const notes = notesOf(review)
  const resolved = row.resolved ?? {}
  const open = notes.filter((n) => resolved[n.id] !== 'dismissed')
  const dismissed = notes.filter((n) => resolved[n.id] === 'dismissed')
  return (
    <div data-test="council-review">
      <div class="card" style="margin-bottom:18px">
        <span class={review.split === 'divides' ? 'pill ok' : 'pill warn'} data-test="council-split">
          {review.split === 'divides' ? 'Divides the room' : 'Plays it safe'}
        </span>
        <p style="margin:10px 0 0" data-test="council-verdict">
          {review.verdict}
        </p>
        <p class="faint" style="margin:8px 0 0">
          Read {fmtDate(row.finishedAt ?? row.createdAt)} for {audienceSummary(row.audience)}
          {row.model ? ` · ${modelLabel(row.model)}` : ''} · ${row.costUsd.toFixed(3)}
        </p>
      </div>

      <div class="council-readers">
        {review.readers.map((r) => (
          <div class="card council-reader" data-test={`reader-${r.stance}`}>
            <div class="faint">{STANCE_LABELS[r.stance]}</div>
            <strong>{r.name}</strong> <span class={`pill ${r.feels === 'love' ? 'ok' : r.feels === 'hate' ? 'bad' : ''}`}>{r.feels}</span>
            <div class="faint" style="margin:4px 0 8px">{r.who}</div>
            <p style="margin:0">{r.reaction}</p>
          </div>
        ))}
      </div>

      <div class="council-desk">
        <article class="card council-paper" data-test="council-draft">
          <h2 style="margin-top:0">{row.draftSubject || 'Untitled'}</h2>
          {blocks.map((b) => (
            <DraftBlock block={b} />
          ))}
          <p class="faint" style="margin-top:16px">
            The draft as the council read it. Edit it in <a href={editUrl}>the composer</a>.
          </p>
        </article>
        <aside class="council-margin" data-test="council-margin">
          {open.length === 0 ? <p class="faint">No open notes.</p> : null}
          {open.map((n) => (
            <NoteCard note={n} reviewId={row.id} dismissed={false} />
          ))}
          {dismissed.length > 0 ? (
            <details>
              <summary class="faint">{dismissed.length} dismissed</summary>
              {dismissed.map((n) => (
                <NoteCard note={n} reviewId={row.id} dismissed />
              ))}
            </details>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

const DraftBlock: FC<{ block: Block }> = ({ block }) => {
  const runs = block.runs.map((r) =>
    r.mark ? (
      <mark id={`q-${r.mark.id}`} class={`council-mark ${r.mark.tone}`} data-note={r.mark.id}>
        {r.mark.tone === 'note' ? <a href={`#n-${r.mark.id}`}>{r.text}</a> : r.text}
      </mark>
    ) : (
      r.text
    ),
  )
  if (block.kind === 'heading') return <h3>{runs}</h3>
  return <p style={block.kind === 'list' ? 'white-space:pre-line' : undefined}>{runs}</p>
}

const NoteCard: FC<{ note: Note; reviewId: number; dismissed: boolean }> = ({ note, reviewId, dismissed }) => (
  <div class={`card council-note ${note.kind}${dismissed ? ' dismissed' : ''}`} id={`n-${note.id}`} data-note={note.id}>
    <div class="faint">{note.label}</div>
    {note.title ? <strong>{note.title}</strong> : null}
    {note.quote ? (
      <blockquote>
        <a href={`#q-${note.id}`}>“{note.quote}”</a>
      </blockquote>
    ) : null}
    <p style="margin:6px 0 8px">{note.body}</p>
    <form method="post" action={`/council/${reviewId}/notes/${encodeURIComponent(note.id)}`} style="margin:0">
      <input type="hidden" name="dismiss" value={dismissed ? '0' : '1'} />
      <button class="btn sm">{dismissed ? 'Open again' : 'Dismiss'}</button>
    </form>
  </div>
)

const CSS = `
.council-dials{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-top:12px}
.council-dials label{display:flex;flex-direction:column;gap:4px;font-size:13px}
.council-readers{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:18px}
.council-desk{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:18px;align-items:start}
@media (max-width:900px){.council-desk{grid-template-columns:1fr}}
.council-paper p,.council-paper h3{line-height:1.6}
.council-mark{padding:0 2px;border-radius:3px}
.council-mark.note{background:var(--caution-soft,#f6e7b0)}
.council-mark.note a{color:inherit}
.council-mark.praise{background:var(--accent-soft)}
.council-mark:target{outline:2px solid var(--accent)}
.council-margin{display:flex;flex-direction:column;gap:12px}
.council-note blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--line);font-style:italic}
.council-note:target{outline:2px solid var(--accent)}
.council-note.dismissed{opacity:.7}
.council-history{margin:0;padding-left:18px}
`
