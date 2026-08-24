/**
 * Everything in the composer that isn't the editor itself: keeping the draft
 * saved while you write, and telling you what happened when you send a preview.
 *
 * The rule this file exists to enforce: *nothing you typed is ever only in the
 * browser*. A shut laptop, a closed tab, a wandering afternoon — none of them
 * should cost you a paragraph. So the draft is written on a timer, and again on
 * the way out — the parting shot goes by `sendBeacon`, which survives an unload
 * that would kill a `fetch`. No "are you sure?" prompt: the answer is always
 * yes, and the save has already happened.
 *
 * Autosave only ever writes drafts. It cannot send, cannot schedule, and the
 * server refuses it outright on anything past `draft` — the Send button is the
 * only thing in this application that puts mail on the wire.
 */

/** Quiet-fingers delay: how long after the last keystroke a save fires. */
const IDLE_MS = 2000
/** …and the longest we'll go mid-flow without one, however fast you type. */
const MAX_MS = 6000

interface Composer {
  form: HTMLFormElement
  /** Flushes the editor document into the hidden field before we read the form. */
  sync: () => void
  status: HTMLElement | null
  idleTimer: number | null
  deadline: number | null
  inFlight: Promise<void> | null
  dirty: boolean
}

let composer: Composer | null = null

export function attachComposer(form: HTMLFormElement, sync: () => void): void {
  if (!form.dataset.autosave) return

  composer = {
    form,
    sync,
    status: document.querySelector<HTMLElement>('[data-save-state]'),
    idleTimer: null,
    deadline: null,
    inFlight: null,
    dirty: false,
  }

  // The sidebar settings and the subject count as changes too — an audience you
  // picked and never saved is just as lost as a paragraph.
  form.addEventListener('input', markDirty)
  form.addEventListener('change', markDirty)

  // A save the moment the page goes away. `sendBeacon` survives the unload that
  // a `fetch` would not, which is the whole point of having it here.
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beacon()
  })
  addEventListener('pagehide', beacon)

  // Save is a plain submit; only stop the timer so it can't race the navigation.
  form.addEventListener('submit', () => {
    clearTimers()
    if (composer) composer.dirty = false
  })

  wirePreview(form)
  setStatus('')
}

/** Something changed. Save soon, and no later than `MAX_MS` from the first edit. */
export function markDirty(): void {
  const c = composer
  if (!c) return
  c.dirty = true
  setStatus('Unsaved')

  const now = Date.now()
  if (c.deadline === null) c.deadline = now + MAX_MS
  if (c.idleTimer !== null) clearTimeout(c.idleTimer)
  c.idleTimer = window.setTimeout(() => void save(), Math.max(0, Math.min(IDLE_MS, c.deadline - now)))
}

function clearTimers(): void {
  const c = composer
  if (!c) return
  if (c.idleTimer !== null) clearTimeout(c.idleTimer)
  c.idleTimer = null
  c.deadline = null
}

/**
 * Write the draft now and resolve once it has landed.
 *
 * Saves are serialised rather than cancelled: if one is in flight the next
 * waits for it, so two requests can never race to write the same row and the
 * older one can never win.
 */
export function save(): Promise<void> {
  const c = composer
  if (!c) return Promise.resolve()
  if (c.inFlight) return c.inFlight.then(() => (c.dirty ? save() : undefined))

  clearTimers()
  c.sync()
  const body = new FormData(c.form)
  c.dirty = false
  setStatus('Saving…')

  const run = fetch(c.form.dataset.autosave as string, { method: 'POST', body })
    .then(async (res) => {
      const data = (await res.json().catch(() => null)) as SaveResponse | SaveRefusal | null
      if (!res.ok || !data?.ok) {
        c.dirty = true
        const reason = data && !data.ok ? data.reason : ''
        setStatus(reason ? `Not saved — ${reason}` : 'Not saved — will retry', true)
        return
      }
      adoptRecord(c.form, data)
      setStatus(`Saved ${clock()}`)
    })
    .catch(() => {
      // Offline, or the Worker blinked. The draft is still in the editor and
      // still marked dirty, so the next keystroke or the beacon will retry it.
      c.dirty = true
      setStatus('Not saved — will retry', true)
    })
    .finally(() => {
      c.inFlight = null
    })

  c.inFlight = run
  return run
}

/** The server's "no": a draft that has left draft, or a row that is gone. */
interface SaveRefusal {
  ok: false
  reason: string
}

interface SaveResponse {
  ok: true
  /** The row that was written — new on the first save of a new draft. */
  id: number
  /** Where this draft lives, so a reload after an accident finds it. */
  url: string
  /** Where the Save button should post from now on. */
  action: string
}

/**
 * The first autosave of a brand-new draft creates the row. From that moment the
 * page is editing something that exists, so the form has to stop posting to the
 * "create" route — otherwise pressing Save would file a second copy — and the
 * address bar has to name the draft, so a reload lands on it rather than on an
 * empty composer.
 */
function adoptRecord(form: HTMLFormElement, data: SaveResponse): void {
  if (form.dataset.recordId === String(data.id)) return
  form.dataset.recordId = String(data.id)
  form.action = data.action
  const id = form.querySelector<HTMLInputElement>('input[name="id"]')
  if (id) id.value = String(data.id)
  history.replaceState(null, '', data.url)
}

function beacon(): void {
  const c = composer
  if (!c?.dirty) return
  c.sync()
  navigator.sendBeacon(c.form.dataset.autosave as string, new FormData(c.form))
  c.dirty = false
}

function setStatus(text: string, bad = false): void {
  const el = composer?.status
  // Called on every keystroke, so it writes to the DOM only when the words
  // actually change.
  if (!el || el.textContent === text) return
  el.textContent = text
  el.classList.toggle('bad', bad)
}

function clock(): string {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/* ─────────────────────────────────────────────────────── the preview dialog */

/**
 * Sending a preview is the one button here that reaches the outside world, and
 * a page that merely blinks gives you no idea whether it did. So it opens a
 * dialog, says who it is sending to, and stays open until the send has actually
 * come back — landed or refused.
 *
 * Without JavaScript the button is still a plain submit that saves and sends;
 * this only takes over when it can do better.
 */
function wirePreview(form: HTMLFormElement): void {
  const button = form.querySelector<HTMLButtonElement>('button[name="preview"]')
  const url = form.dataset.preview
  if (!button || !url) return

  button.addEventListener('click', (e) => {
    e.preventDefault()
    void runPreview(form, button, url)
  })
}

async function runPreview(
  form: HTMLFormElement,
  button: HTMLButtonElement,
  url: string,
): Promise<void> {
  const to = button.dataset.to ?? 'your own address'
  const dialog = openDialog('Sending a preview', `One copy, on its way to ${to}.`, true)

  // The preview must show what is on screen, so the draft goes first.
  await save()
  const id = form.dataset.recordId
  if (!id) {
    fillDialog(dialog, "Couldn't send", 'The draft has not saved yet, so there is nothing to send.', true)
    return
  }

  try {
    const body = new FormData()
    body.set('id', id)
    const res = await fetch(url, { method: 'POST', body })
    const data = (await res.json().catch(() => null)) as
      | { ok: true; to: string }
      | { ok: false; reason: string }
      | null

    if (data?.ok) {
      fillDialog(dialog, 'Preview sent', `One copy is on its way to ${data.to}. Nobody else was mailed.`)
    } else {
      fillDialog(dialog, 'Nothing was sent', data?.reason ?? 'The send failed. Nothing left the building.', true)
    }
  } catch {
    fillDialog(dialog, 'Nothing was sent', 'The request never reached the server. Nothing left the building.', true)
  }
}

function openDialog(title: string, body: string, busy = false): HTMLDialogElement {
  let dialog = document.querySelector<HTMLDialogElement>('.bm-modal')
  if (!dialog) {
    dialog = document.createElement('dialog')
    dialog.className = 'bm-modal'
    dialog.innerHTML =
      '<div class="bm-modal-in"><h2 data-title></h2><p data-body></p>' +
      '<div class="bm-modal-foot"><button type="button" class="btn primary" data-close>Close</button></div></div>'
    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog?.close())
    document.body.append(dialog)
  }
  fillDialog(dialog, title, body, false, busy)
  if (!dialog.open) dialog.showModal()
  return dialog
}

function fillDialog(
  dialog: HTMLDialogElement,
  title: string,
  body: string,
  bad = false,
  busy = false,
): void {
  const t = dialog.querySelector('[data-title]')
  const b = dialog.querySelector('[data-body]')
  if (t) t.textContent = title
  if (b) b.textContent = body
  dialog.classList.toggle('bad', bad)
  dialog.classList.toggle('busy', busy)
  // Nothing to close while the send is still out; the button appears with the
  // answer, so a dialog can't be dismissed into ambiguity.
  dialog.querySelector<HTMLElement>('[data-close]')?.toggleAttribute('hidden', busy)
}
