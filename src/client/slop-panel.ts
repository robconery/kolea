import type { Editor } from '@tiptap/core'
import type { Band, Category } from '../slop/index.ts'
import type { LocatedHit, SlopState } from './extensions/slop-lint.ts'

/**
 * The slop dial.
 *
 * The reading is ours (`src/slop/`), free, and live. It is on the dial, it
 * moves as you type, and every point of it is a phrase underlined in the draft
 * with a reason attached. Nothing leaves the browser.
 *
 * It is a coach, not a gate. A clean draft saves untouched; a sloppy one is
 * held until the writer has seen the number and chosen — once. The same words
 * are never questioned twice. Autosave is never held at all, and it wrote the
 * draft long before Save was clicked, so nothing is at risk while they decide.
 */

const STORE = 'bm-slop'
const OPEN = 'bm-slop-open'
const SHOWN = 8

const BANDS: Record<Band, string> = {
  clean: 'Reads like a person wrote it',
  some: 'Some slop in here',
  heavy: 'Heavy slop',
}

const CATEGORIES: Record<Category, [one: string, many: string]> = {
  punctuation: ['em-dash', 'em-dashes'],
  'lead-in': ['lead-in', 'lead-ins'],
  frame: ['stock frame', 'stock frames'],
  'mic-drop': ['mic drop', 'mic drops'],
  filler: ['filler phrase', 'filler phrases'],
  vocabulary: ['model word', 'model words'],
  flourish: ['flourish', 'flourishes'],
  structure: ['structural tell', 'structural tells'],
  rhythm: ['rhythm tell', 'rhythm tells'],
}

/** The whole reason the dial exists, said once, where it will be read. */
const REMINDER = 'People who read slop just turn it off.'

export interface SlopPanel {
  onReport(state: SlopState): void
}

export function attachSlopPanel(
  host: HTMLElement,
  form: HTMLFormElement,
  editor: Editor,
): SlopPanel | null {
  const bar = host.querySelector<HTMLElement>('.bm-toolbar')
  if (!form.dataset.slop || !bar) return null

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'bm-tb bm-scan-btn'
  button.innerHTML = `${GAUGE_ICON}<span>Slop</span><b data-chip>–</b>`
  button.addEventListener('mousedown', (e) => e.preventDefault())
  bar.append(button)

  const strip = document.createElement('div')
  strip.className = 'bm-scan'
  strip.hidden = !wasOpen()
  strip.innerHTML = STRIP
  bar.after(strip)

  const q = <T extends Element>(sel: string) => strip.querySelector<T>(sel) as T
  const els = {
    chip: button.querySelector<HTMLElement>('[data-chip]') as HTMLElement,
    arc: q<SVGPathElement>('[data-arc]'),
    needle: q<SVGGElement>('[data-needle]'),
    num: q<HTMLElement>('[data-num]'),
    verdict: q<HTMLElement>('[data-verdict]'),
    detail: q<HTMLElement>('[data-detail]'),
    hits: q<HTMLOListElement>('[data-hits]'),
    acts: q<HTMLElement>('[data-acts]'),
  }

  let current: SlopState | null = null

  const textKey = () => hash(editor.getText())

  const setOpen = (open: boolean) => {
    strip.hidden = !open
    button.classList.toggle('on', open)
    try {
      localStorage.setItem(OPEN, open ? '1' : '0')
    } catch {
      // Storage off. The strip still opens; it just won't remember.
    }
  }
  button.classList.toggle('on', !strip.hidden)
  button.addEventListener('click', () => setOpen(strip.hidden))

  /* ─────────────────────────────────────────────────────── the slop reading */

  const paint = (state: SlopState) => {
    current = state
    const { report, hits } = state
    const empty = report.words === 0

    strip.dataset.band = empty ? '' : report.band
    button.dataset.band = empty ? '' : report.band
    button.title = empty
      ? `Slop check. ${REMINDER}`
      : `Slop score ${report.score}: ${BANDS[report.band].toLowerCase()}. ${REMINDER}`
    els.chip.textContent = empty ? '–' : String(report.score)
    setDial(els, empty ? null : report.score)

    els.verdict.textContent = empty ? 'Nothing to read yet' : BANDS[report.band]
    els.detail.textContent = empty ? 'Start writing and the dial follows along.' : summarize(state)

    els.hits.replaceChildren(
      ...hits.slice(0, SHOWN).map((h) => hitRow(h, editor)),
      ...report.notes.map((n) => noteRow(n.label, n.why)),
    )
    if (hits.length > SHOWN) {
      els.hits.append(noteRow(`and ${hits.length - SHOWN} more`, 'Every one is underlined in the draft. Hover it to see why.'))
    }
  }

  wireTooltip(editor)

  /* ──────────────────────────────────────────────────────────── on Save */

  /**
   * Save, clicked. A named submitter is something else — the preview button —
   * and has its own life.
   */
  let cleared = false
  form.addEventListener('submit', (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null
    if (cleared || submitter?.name || !current) return
    if (current.report.band === 'clean') return

    // Saved anyway once already: these words are not questioned again.
    const key = textKey()
    if (accepted() === key) return

    e.preventDefault()
    setOpen(true)
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

/* ─────────────────────────────────────────────────────────────── rendering */

function summarize({ report }: SlopState): string {
  const total = report.hits.length + report.notes.length
  if (total === 0) return `Nothing flagged in ${report.words.toLocaleString()} words.`
  const parts = (Object.entries(report.counts) as [Category, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${n} ${CATEGORIES[c][n === 1 ? 0 : 1]}`)
  const tells = `${total} ${total === 1 ? 'tell' : 'tells'} in ${report.words.toLocaleString()} words`
  return parts.length ? `${tells}: ${parts.join(' · ')}.` : `${tells}.`
}

function hitRow(hit: LocatedHit, editor: Editor): HTMLLIElement {
  const li = document.createElement('li')
  const b = document.createElement('button')
  b.type = 'button'
  b.title = hit.why
  const label = document.createElement('span')
  label.textContent = hit.label
  const quote = document.createElement('q')
  quote.textContent = hit.text.length > 46 ? `${hit.text.slice(0, 44)}…` : hit.text
  b.append(label, quote)
  b.addEventListener('click', () => select(editor, hit))
  li.append(b)
  return li
}

function noteRow(label: string, why: string): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'note'
  li.title = why
  li.textContent = label
  return li
}

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

const GAUGE_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-6"/></svg>'

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
  '<ol class="bm-scan-hits" data-hits></ol>' +
  '<div class="bm-scan-acts" data-acts hidden>' +
  '<button type="button" class="bm-scan-act primary" data-keep>Keep writing</button>' +
  '<button type="button" class="bm-scan-act" data-save>Save anyway</button>' +
  '</div>' +
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

function wasOpen(): boolean {
  try {
    return localStorage.getItem(OPEN) === '1'
  } catch {
    return false
  }
}

/** djb2. Identity of a text, not security. */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${s.length}:${h}`
}
