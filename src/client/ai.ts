import type { Editor, JSONContent } from '@tiptap/core'
import { readSlop } from './extensions/slop-lint.ts'

/**
 * The composer's writing help: subject suggestions, and "Clean this up".
 *
 * Only mounts when the page says OpenRouter is configured (`data-ai` on the
 * form). All the model work happens on the server (`core/ai/`); this file asks,
 * shows, and applies, and nothing it does can send mail.
 *
 * Two rules:
 *
 * - **Nothing lands without a click.** Subjects are offered as a list and one
 *   is only filled in when the writer picks it. A clean-up replaces the draft
 *   in the editor as a single change, so ⌘Z (or the Undo button beside the
 *   result) puts every word back.
 * - **The editor is frozen while a clean-up is out.** Anything typed during
 *   the round trip would be overwritten by the answer, so the writer is told
 *   to wait rather than allowed to lose a sentence.
 */

interface Spend {
  spent: number
  budget: number
}

type Refusal = { ok: false; reason: string; spend?: Spend }

interface SubjectsAnswer {
  ok: true
  ideas: { subject: string; angle: string }[]
  costUsd: number
  spend: Spend
}

interface CleanupAnswer {
  ok: true
  doc: JSONContent
  before: number
  after: number
  costUsd: number
  spend: Spend
}

export function attachAi(form: HTMLFormElement, editor: Editor): void {
  if (!form.dataset.ai) return
  wireSubjects(form, editor)
  wireCleanup(form, editor)
}

/* ─────────────────────────────────────────────────────────── subjects */

function wireSubjects(form: HTMLFormElement, editor: Editor): void {
  const input = form.querySelector<HTMLInputElement>('input[name="subject"]')
  const wrap = input?.closest<HTMLElement>('.compose-subject')
  if (!input || !wrap) return

  const bar = document.createElement('div')
  bar.className = 'bm-ai-subj'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'bm-ai-link'
  button.textContent = 'Suggest a subject'
  button.title = `Reads the draft and suggests subject lines (${form.dataset.aiSubjectModel ?? 'AI'})`
  bar.append(button)

  const pop = document.createElement('div')
  pop.className = 'bm-ai-pop'
  pop.hidden = true
  wrap.append(bar, pop)

  const close = () => {
    pop.hidden = true
    pop.replaceChildren()
  }

  button.addEventListener('click', async () => {
    button.disabled = true
    button.textContent = 'Reading the draft…'
    pop.hidden = false
    pop.replaceChildren(line('Thinking up a few honest ways to say it…', 'bm-ai-meta'))

    const answer = await post<SubjectsAnswer>('/ai/subjects', {
      doc: editor.getJSON(),
      subject: input.value,
      context: form.dataset.aiContext ?? '',
    })
    button.disabled = false
    button.textContent = 'Suggest more'

    if (!answer.ok) {
      pop.replaceChildren(line(answer.reason, 'bm-ai-meta bad'), dismiss(close))
      return
    }

    const list = document.createElement('ul')
    for (const idea of answer.ideas) {
      const li = document.createElement('li')
      const pick = document.createElement('button')
      pick.type = 'button'
      const s = document.createElement('b')
      s.textContent = idea.subject
      const a = document.createElement('span')
      a.textContent = idea.angle
      pick.append(s, a)
      pick.addEventListener('click', () => {
        input.value = idea.subject
        // The composer listens for input on the form: this is what marks the
        // draft dirty and gets the new subject autosaved.
        input.dispatchEvent(new Event('input', { bubbles: true }))
        close()
        button.textContent = 'Suggest a subject'
        input.focus()
      })
      li.append(pick)
      list.append(li)
    }
    pop.replaceChildren(
      list,
      line(`${form.dataset.aiSubjectModel ?? 'AI'} · ${cost(answer.costUsd)} · ${spent(answer.spend)}`, 'bm-ai-meta'),
      dismiss(close),
    )
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) close()
  })
}

/* ─────────────────────────────────────────────────────────── clean-up */

function wireCleanup(form: HTMLFormElement, editor: Editor): void {
  const side = form.querySelector<HTMLElement>('[data-slop-panel]')
  if (!side) return

  const box = document.createElement('div')
  box.className = 'bm-ai-clean'
  const button = document.createElement('button')
  button.type = 'button'
  // The admin's primary button, so it wears the same beam as Save.
  button.className = 'btn primary'
  button.textContent = 'Clean this up'
  const note = line(
    `Rewrites the prose with ${form.dataset.aiCleanupModel ?? 'AI'} to take the slop out. Images, buttons, quotes and code stay put, and ⌘Z undoes it.`,
    'bm-ai-note',
  )
  const result = document.createElement('div')
  result.className = 'bm-ai-result'
  result.setAttribute('role', 'status')
  box.append(button, note, result)
  side.append(box)

  button.addEventListener('mousedown', (e) => e.preventDefault())
  button.addEventListener('click', async () => {
    if (editor.isEmpty) {
      result.replaceChildren(line('Write something first.', 'bad'))
      return
    }
    const host = editor.view.dom.closest<HTMLElement>('.bm-editor-host')
    const model = form.dataset.aiCleanupModel ?? 'the model'
    const words = editor.getText().split(/\s+/).filter(Boolean).length
    // Read now rather than counted off the underlines, which trail typing by a
    // beat: a click straight after a keystroke would report the wrong number.
    const report = readSlop(editor.state.doc).report
    const tells = report.hits.length + report.notes.length

    button.disabled = true
    button.textContent = 'Cleaning up…'
    result.replaceChildren()
    editor.setEditable(false)
    box.classList.add('busy')
    const veil = host ? openVeil(host, model, words, tells) : null

    const answer = await post<CleanupAnswer>('/ai/cleanup', { doc: editor.getJSON() })

    const release = () => {
      editor.setEditable(true)
      box.classList.remove('busy')
      button.disabled = false
      button.textContent = 'Clean this up'
    }

    if (!answer.ok) {
      release()
      if (veil) veil.fail(answer.reason)
      result.replaceChildren(line(answer.reason, 'bad'))
      return
    }

    const apply = () => {
      // One transaction over the whole document: one change in the history,
      // so one undo restores the writer's own version exactly.
      const next = editor.schema.nodeFromJSON(answer.doc)
      const { tr } = editor.state
      tr.replaceWith(0, tr.doc.content.size, next.content)
      editor.view.dispatch(tr)
    }
    // The new words go in under the veil, so it lifts on the finished draft.
    if (veil) await veil.finish(answer.before, answer.after, apply)
    else apply()
    release()

    const undo = document.createElement('button')
    undo.type = 'button'
    undo.className = 'bm-ai-link'
    undo.textContent = 'Undo, give me mine back'
    undo.addEventListener('mousedown', (e) => e.preventDefault())
    undo.addEventListener('click', () => {
      editor.chain().focus().undo().run()
      result.replaceChildren(line('Your version is back.'))
    })

    const moved =
      answer.after < answer.before
        ? `Slop ${answer.before} → ${answer.after}.`
        : `Slop ${answer.before} → ${answer.after}. It didn't help much; you may want yours back.`
    result.replaceChildren(
      line(`${moved} Read it through: it's your name on it.`),
      undo,
      line(`${cost(answer.costUsd)} · ${spent(answer.spend)}`, 'bm-ai-meta'),
    )
  })
}

/* ─────────────────────────────────────────────────────────── the veil */

interface Veil {
  /** Tick the last steps, swap the words in underneath, and lift. */
  finish(before: number, after: number, apply: () => void): Promise<void>
  /** Say what went wrong and wait to be dismissed. The draft is untouched. */
  fail(reason: string): void
}

/**
 * The overlay over the draft while a clean-up is out.
 *
 * It only says what is true. OpenRouter doesn't report progress mid-answer,
 * so the steps are the real phases of the job: the first two carry real
 * numbers read from the draft, and "Rewriting" ticks only when the answer
 * arrives. The bar eases toward the end on the clock and is only filled by
 * the answer itself, never by a timer.
 */
function openVeil(host: HTMLElement, model: string, words: number, tells: number): Veil {
  const veil = document.createElement('div')
  veil.className = 'bm-ai-veil'
  veil.setAttribute('role', 'status')
  veil.setAttribute('aria-live', 'polite')

  const card = document.createElement('div')
  card.className = 'bm-ai-veil-card'
  const orb = document.createElement('div')
  orb.className = 'bm-ai-orb'
  orb.setAttribute('aria-hidden', 'true')
  const title = document.createElement('b')
  title.className = 'bm-ai-veil-title'
  title.textContent = 'Cleaning up your draft'

  const steps = [
    `Read ${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`,
    tells === 0 ? 'No tells found, tightening anyway' : `Found ${tells} ${tells === 1 ? 'tell' : 'tells'} to fix`,
    `Rewriting with ${model}`,
    'Putting images, buttons and quotes back',
    'Scoring the result',
  ]
  const list = document.createElement('ol')
  list.className = 'bm-ai-steps'
  const items = steps.map((text) => {
    const li = document.createElement('li')
    const tick = document.createElement('i')
    tick.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span')
    label.textContent = text
    li.append(tick, label)
    list.append(li)
    return { li, label }
  })

  const bar = document.createElement('div')
  bar.className = 'bm-ai-bar'
  const fill = document.createElement('i')
  bar.append(fill)
  const clock = document.createElement('span')
  clock.className = 'bm-ai-clock'

  card.append(orb, title, list, bar, clock)
  veil.append(card)
  host.classList.add('bm-ai-veiled')
  host.append(veil)
  requestAnimationFrame(() => veil.classList.add('in'))

  const state = (i: number, s: 'active' | 'done' | 'bad') => {
    const item = items[i]
    if (!item) return
    item.li.classList.remove('active', 'done', 'bad')
    item.li.classList.add(s)
  }
  state(0, 'active')

  const started = performance.now()
  // A typical rewrite lands in 8 to 15 seconds. The curve gets most of the way
  // there in that time and then crawls, so a slow answer never looks finished.
  const timer = window.setInterval(() => {
    const t = (performance.now() - started) / 1000
    fill.style.width = `${(90 * (1 - Math.exp(-t / 9))).toFixed(1)}%`
    clock.textContent = t < 20 ? `${Math.floor(t)}s` : `${Math.floor(t)}s · longer drafts take a minute`
  }, 250)
  const staged = [
    window.setTimeout(() => (state(0, 'done'), state(1, 'active')), 500),
    window.setTimeout(() => (state(1, 'done'), state(2, 'active')), 1200),
  ]

  const stop = () => {
    window.clearInterval(timer)
    for (const t of staged) window.clearTimeout(t)
  }
  const lift = () => {
    veil.classList.remove('in')
    veil.classList.add('out')
    host.classList.remove('bm-ai-veiled')
    window.setTimeout(() => veil.remove(), 450)
  }
  const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms))

  return {
    async finish(before, after, apply) {
      stop()
      for (const i of [0, 1, 2]) state(i, 'done')
      fill.style.width = '100%'
      state(3, 'active')
      await wait(350)
      apply()
      state(3, 'done')
      state(4, 'active')
      await wait(350)
      state(4, 'done')
      items[4]!.label.textContent = `Slop ${before} → ${after}`
      title.textContent = after < before ? 'Done. Read it through.' : 'Done, but it barely moved.'
      card.classList.add('done')
      await wait(1100)
      lift()
    },
    fail(reason) {
      stop()
      const at = items.findIndex((it) => it.li.classList.contains('active'))
      state(at < 0 ? 2 : at, 'bad')
      title.textContent = 'Nothing was changed'
      card.classList.add('failed')
      const why = line(reason, 'bm-ai-veil-why')
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'btn'
      close.textContent = 'Back to my draft'
      close.addEventListener('click', lift)
      card.append(why, close)
      close.focus()
    },
  }
}

/* ─────────────────────────────────────────────────────────── helpers */

async function post<T>(url: string, body: unknown): Promise<T | Refusal> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => null)) as (T & { ok: true }) | Refusal | null
    if (!data) return { ok: false, reason: `The server answered ${res.status} with nothing useful.` }
    return data
  } catch {
    return { ok: false, reason: 'The request never reached the server.' }
  }
}

function line(text: string, className = ''): HTMLParagraphElement {
  const p = document.createElement('p')
  if (className) p.className = className
  p.textContent = text
  return p
}

function dismiss(close: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'bm-ai-link'
  b.textContent = 'Dismiss'
  b.addEventListener('click', close)
  return b
}

function cost(usd: number): string {
  return usd < 0.01 ? 'under a cent' : `$${usd.toFixed(2)}`
}

function spent(s: Spend): string {
  return `$${s.spent.toFixed(2)} of $${s.budget.toFixed(0)} this month`
}
