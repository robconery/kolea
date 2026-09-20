import type { Editor } from '@tiptap/core'

/**
 * The AI-text dial.
 *
 * A button in the toolbar and a strip under it that says, in a number and in
 * words, how much of the draft reads as machine-written. It is a coach, not a
 * gate: it never stops a save it cannot explain, and anything that goes wrong
 * with the scan — no key, no network, a slow detector — lets the Save through
 * as though this file did not exist.
 *
 * It takes a reading at two moments, and only two:
 *
 *  - when the button is pressed, and
 *  - when Save is *clicked*. Never on autosave — that fires every few seconds,
 *    and a detector billed by the word should not be paid to read a sentence
 *    that is still being typed.
 *
 * A reading belongs to the exact text it was taken from. It is kept in
 * `sessionStorage` under a hash of that text, which is what lets it survive the
 * reload a Save causes, and what makes a second Save of unchanged words go
 * straight through instead of paying for the same answer twice.
 */

type Band = 'human' | 'mixed' | 'ai'

interface ScanResult {
  score: number
  band: Band
  headline: string
  ai: number
  assisted: number
  human: number
  words: number
}

type ScanOutcome = { ok: true; result: ScanResult } | { ok: false; reason: string }

const STORE = 'bm-ai-scan'

const BANDS: Record<Band, string> = {
  human: 'Reads like a person',
  mixed: 'Some of this reads like a machine',
  ai: 'Reads like a machine',
}

/** The whole reason the dial exists, said once, where it will be read. */
const REMINDER = 'People who read slop just turn it off.'

export function attachScan(host: HTMLElement, form: HTMLFormElement, editor: Editor, sync: () => void): void {
  const url = form.dataset.scan
  const bar = host.querySelector<HTMLElement>('.bm-toolbar')
  if (!url || !bar) return

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'bm-tb bm-scan-btn'
  button.title = `How much of this reads as AI-written? ${REMINDER}`
  button.innerHTML = `${GAUGE_ICON}<span>Scan for AI text</span>`
  bar.append(button)

  const strip = document.createElement('div')
  strip.className = 'bm-scan'
  strip.hidden = true
  strip.setAttribute('role', 'status')
  strip.innerHTML = STRIP
  bar.after(strip)

  const q = <T extends Element>(sel: string) => strip.querySelector<T>(sel) as T
  const els = {
    arc: q<SVGPathElement>('[data-arc]'),
    needle: q<SVGGElement>('[data-needle]'),
    num: q<HTMLElement>('[data-num]'),
    band: q<HTMLElement>('[data-verdict]'),
    detail: q<HTMLElement>('[data-detail]'),
    acts: q<HTMLElement>('[data-acts]'),
  }

  /** Hash of the text the strip is currently describing, or null if none. */
  let shown: string | null = null
  let busy = false

  const textHash = () => hash(editor.getText())

  const paint = (state: 'busy' | 'done' | 'refused', o?: ScanOutcome) => {
    strip.hidden = false
    strip.dataset.state = state
    strip.classList.remove('stale')
    els.acts.hidden = true

    if (state === 'busy') {
      delete strip.dataset.band
      setDial(els, null)
      els.band.textContent = 'Reading your draft…'
      els.detail.textContent = 'A few seconds.'
      return
    }
    if (!o?.ok) {
      delete strip.dataset.band
      setDial(els, null)
      els.band.textContent = 'No reading'
      els.detail.textContent = o?.reason ?? 'The scan failed.'
      return
    }
    const r = o.result
    strip.dataset.band = r.band
    setDial(els, r.score)
    els.band.textContent = BANDS[r.band]
    els.detail.textContent =
      `${pct(r.human)} human · ${pct(r.assisted)} AI-assisted · ${pct(r.ai)} AI, across ${r.words.toLocaleString()} words.` +
      (r.headline ? ` Detector says: ${r.headline}.` : '')
  }

  const scan = async (): Promise<ScanOutcome> => {
    busy = true
    button.disabled = true
    paint('busy')
    const key = textHash()
    let outcome: ScanOutcome
    try {
      sync()
      const res = await fetch(url, { method: 'POST', body: new FormData(form) })
      outcome = ((await res.json().catch(() => null)) as ScanOutcome | null) ?? {
        ok: false,
        reason: 'The scan failed.',
      }
    } catch {
      outcome = { ok: false, reason: 'The request never reached the server.' }
    }
    busy = false
    button.disabled = false
    shown = outcome.ok ? key : null
    if (outcome.ok) remember(key, outcome.result)
    paint(outcome.ok ? 'done' : 'refused', outcome)
    // The draft may have moved on while the detector was thinking.
    if (outcome.ok && textHash() !== key) strip.classList.add('stale')
    return outcome
  }

  button.addEventListener('click', () => void scan())

  // A reading describes the words it was taken from. Once they change it is
  // history, and it should look like history.
  editor.on('update', () => {
    if (shown !== null) strip.classList.toggle('stale', textHash() !== shown)
  })

  // Back from the reload a Save causes: if these are still the words that were
  // scanned, the reading is still true, so put it back.
  const kept = recall()
  if (kept && kept.key === textHash()) {
    shown = kept.key
    paint('done', { ok: true, result: kept.result })
  }

  if (!form.dataset.scanOnSave) return

  /**
   * Save, clicked. A named submitter is something else — the preview button —
   * and has its own life. Words that already have a reading go straight out.
   * Otherwise the save waits for the dial: a clean reading lets it through at
   * once, and anything else holds it until the writer has seen the number and
   * chosen. Autosave wrote the draft long before this, so nothing is at risk
   * while they decide.
   */
  let cleared = false
  form.addEventListener('submit', (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null
    if (cleared || busy || submitter?.name) return
    const key = textHash()
    if (recall()?.key === key) return

    e.preventDefault()
    const go = () => {
      cleared = true
      form.requestSubmit(submitter ?? undefined)
    }
    void scan().then((o) => {
      if (!o.ok || o.result.band === 'human') return go()
      strip.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      els.acts.hidden = false
      q<HTMLButtonElement>('[data-save]').onclick = go
      q<HTMLButtonElement>('[data-keep]').onclick = () => {
        els.acts.hidden = true
        editor.commands.focus()
      }
    })
  })
}

/* ──────────────────────────────────────────────────────────────── the dial */

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

const pct = (n: number) => `${Math.round(n * 100)}%`

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
  '<div class="bm-scan-num"><b data-num>–</b><span>AI score</span></div>' +
  '</div>' +
  '<div class="bm-scan-say">' +
  '<div class="bm-scan-band" data-verdict></div>' +
  '<p data-detail></p>' +
  `<p class="bm-scan-why">${REMINDER}</p>` +
  '<div class="bm-scan-acts" data-acts hidden>' +
  '<button type="button" class="bm-scan-act primary" data-keep>Keep writing</button>' +
  '<button type="button" class="bm-scan-act" data-save>Save anyway</button>' +
  '</div>' +
  '</div>'

/* ───────────────────────────────────────────────────────────────── memory */

function remember(key: string, result: ScanResult): void {
  try {
    sessionStorage.setItem(STORE, JSON.stringify({ key, result }))
  } catch {
    // Private window, storage off. The dial still works; it just forgets.
  }
}

function recall(): { key: string; result: ScanResult } | null {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? 'null') as { key: string; result: ScanResult } | null
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
