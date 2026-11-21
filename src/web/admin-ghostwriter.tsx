import { Hono } from 'hono'
import type { FC } from 'hono/jsx'
import {
  DRAFT_STOPS,
  INFLUENCES,
  LENGTHS,
  PITCHES,
  STRUCTURES,
  getVoice,
  saveVoice,
  voiceSummary,
} from '../core/ai/ghostwriter-voice.ts'
import { aiReady, modelFor, modelLabel } from '../core/ai/openrouter.ts'
import {
  type TakeWithMails,
  getTake,
  keepMyMail,
  listTakes,
  startTake,
  takeState,
  toRead,
  undoTakeMail,
  useRestOfTake,
  useTakeMail,
} from '../core/ai/takes.ts'
import { getSequence } from '../core/sequences.ts'
import { getDb } from '../db/index.ts'
import type { SequenceTakeMail } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { Flash, Layout } from './layout.tsx'

/**
 * The Ghostwriter's screens. Thin: every rule is in `core/ai/ghostwriter-voice.ts`
 * and `core/ai/takes.ts`.
 *
 * - `/ghostwriter`: the voice. Sliders, length, structure, the draft dial, the
 *   pitch, and whether to read the operator's own sent mail.
 * - `/sequences/:id/takes`: numbered takes beside a sequence, and `/:n` to read
 *   one mail by mail. Nothing on these pages sends, activates or publishes;
 *   "Use this mail" copies words into a step of a paused sequence, and that is
 *   the only way a take's words reach a step.
 *
 * Model output is shown as text. JSX escapes it; there is no `raw` here.
 */
export const ghostwriterAdmin = new Hono<{ Bindings: Env }>()

const go = (to: string, msg: string, warn = false) =>
  `${to}${to.includes('?') ? '&' : '?'}flash=${encodeURIComponent(msg)}${warn ? '&kind=warn' : ''}`

/* ─────────────────────────────────────────────────────────── the voice */

ghostwriterAdmin.get('/ghostwriter', async (c) => {
  const db = getDb(c.env)
  const [voice, ready] = await Promise.all([getVoice(db), aiReady(c.env, db)])
  const model = modelLabel(await modelFor(c.env, db, 'ghostwriter'))

  return c.html(
    <Layout title="Ghostwriter" nav="ghost">
      <div class="head">
        <div>
          <h1>Ghostwriter</h1>
          <div class="sub">
            The voice it drafts in. It writes from the composer ("Ghostwriter" beside the draft) and as takes beside a
            sequence. It never sends, never activates, never publishes.
          </div>
        </div>
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />
      {ready ? (
        <div class="note">
          Drafts with <strong>{model}</strong>. Now: {voiceSummary(voice)}.
        </div>
      ) : (
        <div class="note warn">
          AI is off, so the Ghostwriter is too. Choose a key on <a href="/settings/ai">Settings, AI</a>. You can still
          set the voice.
        </div>
      )}

      <form method="post" action="/ghostwriter" data-test="voice-form">
        <div class="card">
          <div class="card-h">
            <h2>Influences</h2>
          </div>
          <div class="card-b">
            <p class="faint">
              0 is off, 5 is strong. The strongest sets the rhythm; the others season it. It borrows how they write,
              never what they wrote, and never names them.
            </p>
            {INFLUENCES.map((i) => (
              <div class="field">
                <label for={`v-${i.key}`}>
                  {i.label} <span class="faint">({i.name})</span>
                </label>
                <input
                  id={`v-${i.key}`}
                  type="range"
                  name={i.key}
                  min="0"
                  max="5"
                  step="1"
                  value={String(voice[i.key])}
                  oninput="this.nextElementSibling.textContent=this.value"
                />
                <output>{String(voice[i.key])}</output>
              </div>
            ))}
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            <h2>Shape</h2>
          </div>
          <div class="card-b">
            <div class="row">
              <div class="field">
                <label>Length of a single mail</label>
                <select name="length">
                  {LENGTHS.map((l) => (
                    <option value={l.key} selected={voice.length === l.key}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label>Structure</label>
                <select name="structure">
                  {STRUCTURES.map((s) => (
                    <option value={s.key} selected={voice.structure === s.key}>
                      {s.label}: {s.hint}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div class="field">
              <label>How finished</label>
              <select name="draft">
                {DRAFT_STOPS.map((d) => (
                  <option value={d.key} selected={voice.draft === d.key}>
                    {d.label}: {d.hint}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label>Pitch for sequence takes</label>
              <select name="pitch">
                {PITCHES.map((p) => (
                  <option value={p.key} selected={voice.pitch === p.key}>
                    {p.label}: {p.hint}
                  </option>
                ))}
              </select>
              <p class="faint">Credit, not endorsement. The approach is borrowed; nobody is named in the mail.</p>
            </div>
            <label style="display:flex;gap:8px;align-items:center;font-weight:400">
              <input type="checkbox" name="useMyMail" value="on" checked={voice.useMyMail} />
              Learn from my own writing: read my last two sent broadcasts so the draft sounds like me. Only mail I
              already sent; nothing a subscriber wrote.
            </label>
          </div>
        </div>

        <button class="btn primary" type="submit">
          Save the voice
        </button>
      </form>
    </Layout>,
  )
})

ghostwriterAdmin.post('/ghostwriter', async (c) => {
  const form = await c.req.parseBody()
  const r = await saveVoice(getDb(c.env), form as Record<string, unknown>)
  return c.redirect(r.ok ? go('/ghostwriter', 'Voice saved.') : go('/ghostwriter', r.reason, true))
})

/* ─────────────────────────────────────────────────────────── takes */

const STATE_LABEL = { writing: 'Writing', stopped: 'Stopped part way', done: 'Done', failed: 'Failed' }
const MAIL_LABEL: Record<SequenceTakeMail['status'], string> = {
  waiting: 'Waiting',
  writing: 'Writing',
  written: 'To read',
  failed: 'Failed',
  used: 'Used',
  kept: 'Kept mine',
}

function seqId(raw: string): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 0
}

ghostwriterAdmin.get('/sequences/:id/takes', async (c) => {
  const db = getDb(c.env)
  const id = seqId(c.req.param('id'))
  const seq = id ? await getSequence(db, id) : null
  if (!seq) return c.notFound()
  const [takes, ready, voice] = await Promise.all([listTakes(db, id), aiReady(c.env, db), getVoice(db)])
  const writing = takes.some((t) => takeState(t) === 'writing')

  return c.html(
    <Layout title={`Takes: ${seq.name}`} nav="seq">
      {writing ? <meta http-equiv="refresh" content="20" /> : null}
      <div class="head">
        <div>
          <h1>Ghostwriter takes</h1>
          <div class="sub">
            <a href={`/sequences/${id}`}>{seq.name}</a>. Each take writes every mail beside the sequence. Nothing
            changes until you use a mail, one at a time.
          </div>
        </div>
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      {ready ? (
        <div class="card">
          <div class="card-h">
            <h2>Start a take</h2>
          </div>
          <div class="card-b">
            <form method="post" action={`/sequences/${id}/takes`} data-test="take-form">
              <div class="field">
                <label>What the sequence is about</label>
                <input type="text" name="topic" maxlength={500} required />
              </div>
              <div class="field">
                <label>What it should do</label>
                <input type="text" name="goal" maxlength={1000} placeholder="Welcome new readers and earn a reply" />
              </div>
              <div class="field">
                <label>Your notes: facts, stories, links (it invents none of these)</label>
                <textarea name="notes" rows={5} maxlength={4000} />
              </div>
              <p class="faint">
                In your voice ({voiceSummary(voice)}), {DRAFT_LABEL(voice.draft)}, pitch:{' '}
                {PITCHES.find((p) => p.key === voice.pitch)?.label}. <a href="/ghostwriter">Change the voice</a>. It
                writes a few mails a minute in the background; this page refreshes itself.
              </p>
              <button class="btn primary" type="submit">
                Write a take
              </button>
            </form>
          </div>
        </div>
      ) : (
        <div class="note warn">
          AI is off. Choose a key on <a href="/settings/ai">Settings, AI</a> to write a take.
        </div>
      )}

      <div class="card">
        <div class="card-h">
          <h2>Takes</h2>
        </div>
        <div class="card-b flush">
          {takes.length === 0 ? (
            <div class="empty">
              <p>No takes yet.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Take</th>
                  <th>About</th>
                  <th>State</th>
                  <th>To read</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {takes.map((t) => (
                  <tr>
                    <td>
                      <a href={`/sequences/${id}/takes/${t.number}`}>Take {t.number}</a>
                    </td>
                    <td>{t.topic}</td>
                    <td>{STATE_LABEL[takeState(t)]}</td>
                    <td>{toRead(t)}</td>
                    <td>${t.costUsd.toFixed(2)}</td>
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

const DRAFT_LABEL = (d: string) => DRAFT_STOPS.find((x) => x.key === d)?.label.toLowerCase() ?? d

ghostwriterAdmin.post('/sequences/:id/takes', async (c) => {
  const db = getDb(c.env)
  const id = seqId(c.req.param('id'))
  if (!id) return c.notFound()
  const form = await c.req.parseBody()
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const r = await startTake(c.env, db, id, { topic: str(form.topic), goal: str(form.goal), notes: str(form.notes) })
  if (!r.ok) return c.redirect(go(`/sequences/${id}/takes`, r.reason, true))
  return c.redirect(
    go(`/sequences/${id}/takes/${r.take.number}`, `Take ${r.take.number} started. It writes over the next few minutes.`),
  )
})

/** A mail's words to read over: paragraphs of escaped text, placeholders marked. */
const Words: FC<{ md: string }> = ({ md }) => (
  <div class="take-words">
    {md
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((para) => (
        <p>
          {para
            .replace(/\*\*|__/g, '')
            .split(/(\[\[[\s\S]*?\]\])/)
            .map((part) =>
              part.startsWith('[[') ? (
                <mark>{part}</mark>
              ) : (
                part.split('\n').flatMap((line, i) => (i ? [<br />, line] : [line]))
              ),
            )}
        </p>
      ))}
  </div>
)

ghostwriterAdmin.get('/sequences/:id/takes/:n', async (c) => {
  const db = getDb(c.env)
  const id = seqId(c.req.param('id'))
  const seq = id ? await getSequence(db, id) : null
  const take: TakeWithMails | null = seq ? await getTake(db, id, Number(c.req.param('n'))) : null
  if (!seq || !take) return c.notFound()
  const state = takeState(take)
  const base = `/sequences/${id}/takes/${take.number}`

  return c.html(
    <Layout title={`Take ${take.number}: ${seq.name}`} nav="seq">
      {state === 'writing' ? <meta http-equiv="refresh" content="15" /> : null}
      <div class="head">
        <div>
          <h1>Take {take.number}</h1>
          <div class="sub">
            <a href={`/sequences/${id}`}>{seq.name}</a> · <a href={`/sequences/${id}/takes`}>all takes</a> ·{' '}
            {STATE_LABEL[state]} · ${take.costUsd.toFixed(2)}
          </div>
        </div>
        {toRead(take) > 0 && !seq.isActive ? (
          <div class="actions">
            <form method="post" action={`${base}/use-rest`}>
              <button class="btn">Use the rest ({toRead(take)})</button>
            </form>
          </div>
        ) : null}
      </div>
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />
      {seq.isActive ? (
        <div class="note warn">
          This sequence is live. Pause it to use a mail: ghostwritten mail opens with a note to read it over, and a
          live sequence would send it as it is.
        </div>
      ) : (
        <div class="note">
          Using a mail copies it into its step and keeps your words to put back. Every used mail starts with an{' '}
          <mark>[[ AI draft … ]]</mark> line, so the sequence cannot go live until you have read each one.
        </div>
      )}
      {take.failure ? <div class="note warn">{take.failure}</div> : null}
      {take.story ? (
        <p class="faint">
          <strong>The story:</strong> {take.story}
        </p>
      ) : state === 'writing' ? (
        <p class="faint">Planning the story first. This page refreshes itself.</p>
      ) : null}

      {take.mails.map((m) => (
        <div class="card" data-test={`take-mail-${m.position}`}>
          <div class="card-h">
            <h2>
              Mail {m.position}
              {m.subject ? `: ${m.subject}` : ''}
            </h2>
            <div class="actions">
              <span class="faint">{MAIL_LABEL[m.status]}</span>
              {m.status === 'written' ? (
                <>
                  <form method="post" action={`${base}/mails/${m.position}/use`}>
                    <button class="btn sm primary" disabled={seq.isActive}>
                      Use this mail
                    </button>
                  </form>
                  <form method="post" action={`${base}/mails/${m.position}/keep`}>
                    <button class="btn sm">Keep mine</button>
                  </form>
                </>
              ) : m.status === 'used' || m.status === 'kept' ? (
                <form method="post" action={`${base}/mails/${m.position}/undo`}>
                  <button class="btn sm" disabled={m.status === 'used' && seq.isActive}>
                    {m.status === 'used' ? 'Put mine back' : 'Read it again'}
                  </button>
                </form>
              ) : null}
            </div>
          </div>
          <div class="card-b">
            {m.bodyMd ? (
              <Words md={m.bodyMd} />
            ) : (
              <p class="faint">{m.status === 'failed' ? 'This mail could not be written.' : (m.plan ?? 'Not written yet.')}</p>
            )}
          </div>
        </div>
      ))}
    </Layout>,
  )
})

async function takeId(env: Env, id: number, n: number): Promise<number | null> {
  const take = await getTake(getDb(env), id, n)
  return take?.id ?? null
}

for (const action of ['use', 'keep', 'undo'] as const) {
  ghostwriterAdmin.post(`/sequences/:id/takes/:n/mails/:pos/${action}`, async (c) => {
    const id = seqId(c.req.param('id'))
    const n = Number(c.req.param('n'))
    const pos = Number(c.req.param('pos'))
    const tid = id ? await takeId(c.env, id, n) : null
    if (!tid || !Number.isInteger(pos)) return c.notFound()
    const db = getDb(c.env)
    const fn = action === 'use' ? useTakeMail : action === 'keep' ? keepMyMail : undoTakeMail
    const r = await fn(db, tid, pos)
    const back = `/sequences/${id}/takes/${n}`
    return c.redirect(r.ok ? go(back, r.message) : go(back, r.reason, true))
  })
}

ghostwriterAdmin.post('/sequences/:id/takes/:n/use-rest', async (c) => {
  const id = seqId(c.req.param('id'))
  const n = Number(c.req.param('n'))
  const tid = id ? await takeId(c.env, id, n) : null
  if (!tid) return c.notFound()
  const r = await useRestOfTake(getDb(c.env), tid)
  const back = `/sequences/${id}/takes/${n}`
  return c.redirect(r.ok ? go(back, r.message) : go(back, r.reason, true))
})
