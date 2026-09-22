import type { Editor } from '@tiptap/core'
import { type Band, RULES, findSlop } from '../slop/index.ts'
import type { LocatedHit, SlopState } from './extensions/slop-lint.ts'

/**
 * The slop dial, and the to-do list under it.
 *
 * The reading is ours (`src/slop/`), free, and live. It moves as you type, and
 * every point of it is a phrase underlined in the draft with a reason attached.
 * Nothing leaves the browser.
 *
 * It lives at the head of the composer's right-hand panel, above who the mail
 * goes to — always there, never behind a button. Views with no side panel (a
 * sent broadcast, the read-only "as mailed" sheet) carry it under the toolbar
 * or at the head of the sheet instead.
 *
 * ⭐ The list is the point. The common way to write a newsletter now is to have
 * a model draft it, paste that in, and rewrite. A score tells that writer they
 * have a problem; a list tells them what to do about it. So every kind of tell
 * in the draft becomes one job, worst first, and a click walks the draft from
 * one occurrence to the next. When the last one is gone the job ticks itself
 * off and stays on the list, done — the rewrite has somewhere to get to.
 *
 * A big paste starts a fresh list and marks where the score began, so the
 * number that matters is the distance travelled.
 *
 * It is a coach, not a gate. A clean draft saves untouched; a sloppy one is
 * held until the writer has seen the number and chosen — once. The same words
 * are never questioned twice. Autosave is never held at all, and it wrote the
 * draft long before Save was clicked, so nothing is at risk while they decide.
 */

const STORE = 'bm-slop'

/** A paste this long is a draft arriving, not a quote being dropped in. */
const PASTE_WORDS = 60

/** The top of the `clean` band: where the list is trying to get the draft to. */
const GOAL = 15

const BANDS: Record<Band, string> = {
  clean: 'Reads like a person wrote it',
  some: 'Some slop in here',
  heavy: 'Heavy slop',
}

/** The whole reason the dial exists, said once, where it will be read. */
const REMINDER = 'People who read slop just turn it off.'

/** One line on the to-do list: every occurrence of one kind of tell. */
interface Task {
  rule: string
  fix: string
  why: string
  weight: number
  /** Where they are, in document order. Empty for a whole-document note. */
  hits: LocatedHit[]
  /** Still to do. A note counts as one; a finished job is zero. */
  count: number
  /** Set for a tell in the subject line: where it is in the field's value. */
  subject?: { start: number; end: number }[]
}

/**
 * The rules that make sense on one line of subject: phrases and punctuation.
 * Rules about openings, closings and paragraph shape are about a body, and on
 * a subject they would only ever misfire.
 */
const SUBJECT_OFF = RULES.filter((r) => 'find' in r || ('zone' in r && r.zone)).map((r) => r.id)

function subjectTasks(value: string): Task[] {
  if (!value.trim()) return []
  const report = findSlop([{ text: value, kind: 'paragraph' }], { disable: SUBJECT_OFF })
  const byRule = new Map<string, Task>()
  for (const h of report.hits) {
    const id = `subject:${h.rule}`
    const t = byRule.get(id) ?? {
      rule: id,
      fix: `In the subject: ${h.fix.charAt(0).toLowerCase()}${h.fix.slice(1)}`,
      why: h.why,
      weight: h.weight,
      hits: [],
      count: 0,
      subject: [],
    }
    t.subject!.push({ start: h.start, end: h.end })
    t.count++
    byRule.set(id, t)
  }
  return [...byRule.values()]
}

export interface SlopPanel {
  onReport(state: SlopState): void
}

/**
 * `form` is the composer's form: Save hangs off it, and its side panel is where
 * the dial prefers to live. Leave it out for a read-only view — the dial reads,
 * and holds nothing.
 */
export function attachSlopPanel(host: HTMLElement, editor: Editor, form?: HTMLFormElement | null): SlopPanel {
  const strip = document.createElement('div')
  strip.className = 'bm-scan'
  strip.innerHTML = STRIP

  const side = form?.querySelector<HTMLElement>('[data-slop-panel]')
  const bar = host.querySelector<HTMLElement>('.bm-toolbar')
  if (side) {
    strip.classList.add('side')
    side.append(strip)
  } else if (bar) bar.after(strip)
  else host.prepend(strip)

  const q = <T extends Element>(sel: string) => strip.querySelector<T>(sel) as T
  const els = {
    arc: q<SVGPathElement>('[data-arc]'),
    needle: q<SVGGElement>('[data-needle]'),
    num: q<HTMLElement>('[data-num]'),
    verdict: q<HTMLElement>('[data-verdict]'),
    detail: q<HTMLElement>('[data-detail]'),
    tasks: q<HTMLOListElement>('[data-tasks]'),
    prompt: q<HTMLButtonElement>('[data-prompt]'),
    acts: q<HTMLElement>('[data-acts]'),
  }

  let current: SlopState | null = null
  /** Every job this draft has had since it arrived, so a finished one can stay, ticked. */
  const seen = new Map<string, Task>()
  /** The score the draft arrived with. */
  let began: number | null = null
  /** The job that is open, showing its reason. */
  let open: string | null = null
  /** Which occurrence each job's next click goes to. */
  const cursor = new Map<string, number>()
  let pasted = false

  // The subject is read too: it is the first line anyone sees, and an em-dash
  // there is the loudest tell in the whole mail. The reader has no underline to
  // draw in a text field, so its tells go on the list and a click selects them.
  const subjectInput = form?.querySelector<HTMLInputElement>('input[name="subject"]') ?? null
  let subject: Task[] = subjectInput ? subjectTasks(subjectInput.value) : []
  let subjectTimer = 0
  subjectInput?.addEventListener('input', () => {
    window.clearTimeout(subjectTimer)
    subjectTimer = window.setTimeout(() => {
      subject = subjectTasks(subjectInput.value)
      for (const t of subject) seen.set(t.rule, t)
      renderTasks()
    }, 250)
  })

  const textKey = () => hash(`${subjectInput?.value ?? ''}\n${editor.getText()}`)

  // A draft arriving: the next reading is a new start, with a new list.
  editor.on('transaction', ({ transaction: tr }) => {
    if (tr.getMeta('uiEvent') !== 'paste' || !tr.docChanged) return
    const before = tr.before.textContent.split(/\s+/).filter(Boolean).length
    const after = tr.doc.textContent.split(/\s+/).filter(Boolean).length
    if (after - before >= PASTE_WORDS) pasted = true
  })

  /** Open jobs, worst first, then the finished ones. */
  const renderTasks = () => {
    const tasks = [...subject, ...(current ? tasksOf(current) : [])].sort(
      (a, b) => b.weight * b.count - a.weight * a.count,
    )
    const live = new Set(tasks.map((t) => t.rule))
    const done = [...seen.values()].filter((t) => !live.has(t.rule)).map((t) => ({ ...t, hits: [], count: 0 }))
    if (!open || !live.has(open)) open = tasks[0]?.rule ?? null
    els.tasks.replaceChildren(...[...tasks, ...done].map(taskRow))
    els.prompt.hidden = tasks.length === 0
  }

  const taskRow = (t: Task): HTMLLIElement => {
    const li = document.createElement('li')
    const finished = t.count === 0
    li.className = finished ? 'done' : t.rule === open ? 'open' : ''

    const b = document.createElement('button')
    b.type = 'button'
    b.disabled = finished
    const box = document.createElement('i')
    box.setAttribute('aria-hidden', 'true')
    const text = document.createElement('span')
    text.textContent = t.fix
    b.append(box, text)
    if (!finished && (t.hits.length > 0 || (t.subject?.length ?? 0) > 0)) {
      const n = document.createElement('b')
      n.textContent = String(t.count)
      b.title = `${t.count} in the draft. Click to go to the next one.`
      b.append(n)
    }
    // Colour never carries it alone: a finished job says so in words too.
    if (finished) b.setAttribute('aria-label', `Done: ${t.fix}`)
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () => {
      open = t.rule
      const i = (cursor.get(t.rule) ?? 0) % Math.max(t.subject?.length ?? t.hits.length, 1)
      cursor.set(t.rule, i + 1)
      renderTasks()
      if (t.subject && subjectInput) {
        const at = t.subject[i]
        subjectInput.focus()
        if (at) subjectInput.setSelectionRange(at.start, at.end)
        return
      }
      const hit = t.hits[i]
      if (hit) select(editor, hit)
    })
    li.append(b)

    if (t.rule === open && !finished) {
      const why = document.createElement('p')
      why.textContent = t.why
      li.append(why)
    }
    return li
  }

  const paint = (state: SlopState) => {
    current = state
    const { report } = state
    const empty = report.words === 0

    if (pasted || empty) {
      seen.clear()
      cursor.clear()
      began = null
      open = null
      pasted = false
    }
    if (began === null && !empty) began = report.score
    for (const t of [...subject, ...tasksOf(state)]) seen.set(t.rule, t)

    strip.dataset.band = empty ? '' : report.band
    setDial(els, empty ? null : report.score)
    els.verdict.textContent = empty ? 'Nothing to read yet' : BANDS[report.band]
    els.detail.textContent = empty
      ? 'Write, or paste a draft in, and the dial follows along.'
      : progress(report.score, report.words, began)
    els.acts.hidden = true
    renderTasks()
  }

  els.prompt.addEventListener('click', () => {
    if (!current) return
    void copy(promptFor([...subject, ...tasksOf(current)])).then((ok) => {
      els.prompt.textContent = ok ? 'Copied. Paste it with your draft.' : 'Could not copy'
      setTimeout(() => (els.prompt.textContent = PROMPT_LABEL), 2600)
    })
  })

  wireTooltip(editor)
  if (!form) return { onReport: paint }

  /* ──────────────────────────────────────────────────────────── on Save */

  /**
   * Save, clicked. A named submitter is something else — the preview button —
   * and has its own life.
   */
  let cleared = false
  form.addEventListener('submit', (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null
    if (cleared || submitter?.name || !current) return
    // A tell in the subject holds Save just as a sloppy body does.
    if (current.report.band === 'clean' && subject.length === 0) return

    // Saved anyway once already: these words are not questioned again.
    const key = textKey()
    if (accepted() === key) return

    e.preventDefault()
    strip.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    els.acts.hidden = false
    q<HTMLButtonElement>('[data-save]').onclick = () => {
      accept(key)
      cleared = true
      form.requestSubmit(submitter ?? undefined)
    }
    q<HTMLButtonElement>('[data-keep]').onclick = () => {
      els.acts.hidden = true
      const first = current?.hits[0]
      if (first) select(editor, first)
      else editor.commands.focus()
    }
  })

  return { onReport: paint }
}

/* ────────────────────────────────────────────────────────────── the list */

/**
 * One job per kind of tell, worst first. "Worst" is what it costs the score —
 * weight times how many — so the top of the list is always the biggest win
 * available, and a writer with five minutes knows where to spend them.
 */
function tasksOf({ report, hits }: SlopState): Task[] {
  const byRule = new Map<string, Task>()
  for (const h of hits) {
    const t = byRule.get(h.rule) ?? { rule: h.rule, fix: h.fix, why: h.why, weight: h.weight, hits: [], count: 0 }
    t.hits.push(h)
    t.count++
    byRule.set(h.rule, t)
  }
  for (const n of report.notes) {
    byRule.set(n.rule, { rule: n.rule, fix: n.fix, why: n.why, weight: n.weight, hits: [], count: 1 })
  }
  return [...byRule.values()].sort((a, b) => b.weight * b.count - a.weight * a.count)
}

function progress(score: number, words: number, began: number | null): string {
  const size = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`
  if (score < GOAL) {
    return began !== null && began >= GOAL ? `Started at ${began}. Clean now, across ${size}.` : `Nothing much to fix in ${size}.`
  }
  const from = began !== null && began !== score ? `Started at ${began}. ` : ''
  return `${from}Work the list to get under ${GOAL}.`
}

const PROMPT_LABEL = 'Copy a clean-up prompt'

/**
 * For the writer who would rather send the draft back to the model that wrote
 * it. The prompt names this draft's actual tells, so the model is told what to
 * stop doing rather than asked, vaguely, to "sound more human".
 */
function promptFor(tasks: Task[]): string {
  const jobs = tasks.map((t) => {
    const examples = [...new Set(t.hits.map((h) => `"${h.text}"`))].slice(0, 3).join(', ')
    return `- ${t.fix}. ${t.why}${examples ? ` Found here: ${examples}.` : ''}`
  })
  return [
    'Rewrite the draft below so it reads like one person talking to another.',
    'Keep my meaning, my facts, my structure and my voice. Do not add anything, and do not make it longer.',
    'Use plain statements. If a phrase could be deleted and the reader would lose nothing but a flourish, delete it.',
    '',
    'Fix these specific problems:',
    ...jobs,
    '',
    'Do not replace one stock phrase with another. No em-dashes anywhere.',
    '',
    'The draft:',
    '',
  ].join('\n')
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/* ─────────────────────────────────────────────────────────────── rendering */

function select(editor: Editor, hit: LocatedHit): void {
  // The draft may have shrunk since this reading; never select past its end.
  const max = editor.state.doc.content.size
  editor
    .chain()
    .focus()
    .setTextSelection({ from: Math.min(hit.from, max), to: Math.min(hit.to, max) })
    .scrollIntoView()
    .run()
}

/** One floating note for every underline: what it is, and what to do instead. */
function wireTooltip(editor: Editor): void {
  const tip = document.createElement('div')
  tip.className = 'bm-slop-tip'
  tip.hidden = true
  tip.innerHTML = '<b></b><span></span>'
  document.body.append(tip)

  const dom = editor.view.dom
  dom.addEventListener('mouseover', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.bm-slop')
    if (!el) return
    ;(tip.firstChild as HTMLElement).textContent = el.dataset.slopLabel ?? ''
    ;(tip.lastChild as HTMLElement).textContent = el.dataset.slopWhy ?? ''
    tip.hidden = false
    const r = el.getBoundingClientRect()
    const w = tip.offsetWidth
    const left = Math.max(12, Math.min(r.left, innerWidth - w - 12))
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(r.bottom + 8)}px)`
  })
  dom.addEventListener('mouseout', (e) => {
    if ((e.target as HTMLElement).closest('.bm-slop')) tip.hidden = true
  })
  addEventListener('scroll', () => (tip.hidden = true), true)
  // Fixing the tell deletes the underline the pointer was resting on, and a
  // removed element never fires mouseout. So any edit, keystroke or blur puts
  // the note away too; hovering the next underline brings it back.
  editor.on('transaction', ({ transaction }) => {
    if (transaction.docChanged) tip.hidden = true
  })
  dom.addEventListener('keydown', () => (tip.hidden = true))
  // The reader redraws its underlines as it re-reads, which swaps the element
  // under the pointer; moving off the new one lands on plain text and never
  // counts as leaving an underline. So the rule is simply: pointer not on an
  // underline, no note.
  dom.addEventListener('mousemove', (e) => {
    if (!tip.hidden && !(e.target as HTMLElement).closest('.bm-slop')) tip.hidden = true
  })
  dom.addEventListener('mouseleave', () => (tip.hidden = true))
  editor.on('blur', () => (tip.hidden = true))
}

/** Half a turn, left to right: 0 at nine o'clock, 100 at three. */
function setDial(
  els: { arc: SVGPathElement; needle: SVGGElement; num: HTMLElement },
  score: number | null,
): void {
  // A missing number is missing, not zero: no arc, the needle parked, a dash.
  els.arc.style.strokeDashoffset = String(100 - (score ?? 0))
  els.needle.style.transform = `rotate(${((score ?? 0) / 100) * 180}deg)`
  els.num.textContent = score === null ? '–' : String(score)
}

// The arc is drawn with `pathLength="100"`, so the score *is* the dash offset.
const ARC = 'M 12 66 A 54 54 0 0 1 120 66'
const STRIP =
  '<div class="bm-scan-dial">' +
  '<svg viewBox="0 0 132 76" aria-hidden="true">' +
  `<path class="bm-scan-track" d="${ARC}" pathLength="100"/>` +
  `<path class="bm-scan-arc" data-arc d="${ARC}" pathLength="100"/>` +
  '<g class="bm-scan-needle" data-needle><path d="M 66 66 L 24 66"/></g>' +
  '<circle class="bm-scan-hub" cx="66" cy="66" r="4"/>' +
  '</svg>' +
  '<div class="bm-scan-num"><b data-num>–</b><span>Slop score</span></div>' +
  '</div>' +
  '<div class="bm-scan-say">' +
  '<div class="bm-scan-band" data-verdict role="status"></div>' +
  '<p data-detail></p>' +
  `<p class="bm-scan-why">${REMINDER}</p>` +
  '<div class="bm-scan-acts" data-acts hidden>' +
  '<button type="button" class="bm-scan-act primary" data-keep>Keep writing</button>' +
  '<button type="button" class="bm-scan-act" data-save>Save anyway</button>' +
  '</div>' +
  '<ol class="bm-scan-tasks" data-tasks></ol>' +
  `<button type="button" class="bm-scan-act bm-scan-prompt" data-prompt hidden>${PROMPT_LABEL}</button>` +
  '</div>'

/* ───────────────────────────────────────────────────────────────── memory */

/** Remember, for this tab, the text the writer chose to save as it is. */
function accept(key: string): void {
  try {
    sessionStorage.setItem(STORE, key)
  } catch {
    // Private window, storage off. They may be asked once more after a reload.
  }
}

function accepted(): string | null {
  try {
    return sessionStorage.getItem(STORE)
  } catch {
    return null
  }
}

/** djb2. Identity of a text, not security. */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${s.length}:${h}`
}
