/**
 * The featured image and topics in the composer's Web panel (`WebPanel` in
 * `web/admin-mail.tsx`).
 *
 * The image is chosen, not typed, so it is saved the moment it is chosen —
 * upload, Unsplash pick, or remove — and the composer's timed save never
 * carries it. The Unsplash search runs as you type and never leaves the page.
 * Topics save when the field is left, because the timed save skips them.
 *
 * On a brand-new draft there is no row to hang an image on yet, so the first
 * thing any of these does is make the composer save, which creates one.
 */
import { save } from './composer.ts'

interface Image {
  url: string
  credit: string | null
  creditUrl: string | null
}

interface Photo {
  thumbUrl: string
  url: string
  alt: string
  credit: string
  creditUrl: string
  downloadLocation: string
  color: string | null
}

type Answer<T> = ({ ok: true } & T) | { ok: false; reason: string }

/** Quiet-fingers delay before a search goes out. */
const SEARCH_MS = 450

export function attachWebPanel(form: HTMLFormElement): void {
  const panel = form.querySelector<HTMLElement>('[data-web-panel]')
  const fi = panel?.querySelector<HTMLElement>('[data-fi]')
  if (!panel || !fi) return

  const frame = fi.querySelector<HTMLElement>('[data-fi-frame]')
  const credit = fi.querySelector<HTMLElement>('[data-fi-credit]')
  const note = fi.querySelector<HTMLElement>('[data-fi-note]')
  const clear = fi.querySelector<HTMLButtonElement>('[data-fi-clear]')
  const upload = fi.querySelector<HTMLButtonElement>('[data-fi-upload]')
  const file = fi.querySelector<HTMLInputElement>('[data-fi-file]')
  const q = fi.querySelector<HTMLInputElement>('[data-fi-q]')
  const results = fi.querySelector<HTMLElement>('[data-fi-results]')

  /** The row's id, saving a new draft into existence first if it has none. */
  async function recordId(): Promise<string | null> {
    if (!form.dataset.recordId) await save()
    return form.dataset.recordId ?? null
  }

  function say(text: string, bad = false): void {
    if (!note) return
    note.textContent = text
    note.hidden = !text
    note.classList.toggle('bad', bad)
  }

  function show(image: Image | null): void {
    if (frame) {
      frame.replaceChildren()
      if (image) {
        const img = document.createElement('img')
        img.src = image.url
        img.alt = ''
        frame.append(img)
      } else {
        const empty = document.createElement('span')
        empty.textContent = 'No featured image'
        frame.append(empty)
      }
    }
    if (credit) {
      credit.replaceChildren()
      if (image?.credit) {
        const a = document.createElement('a')
        a.href = image.creditUrl ?? '#'
        a.target = '_blank'
        a.rel = 'noopener'
        a.textContent = image.credit
        credit.append('Photo by ', a, ' on Unsplash')
      }
      credit.hidden = !image?.credit
    }
    if (clear) clear.hidden = !image
  }

  /** One image request: busy while it runs, the new image or a reason after. */
  async function imageRequest(path: string, body: FormData, done: string): Promise<boolean> {
    const id = await recordId()
    if (!id) {
      say('The draft has not saved yet. Try again in a moment.', true)
      return false
    }
    fi?.classList.add('busy')
    say('')
    try {
      const res = await fetch(`/broadcasts/${id}/feature-image/${path}`, {
        method: 'POST',
        body,
        headers: { Accept: 'application/json' },
      })
      const data = (await res.json().catch(() => null)) as Answer<{ image: Image | null }> | null
      if (!data?.ok) {
        say(data?.reason ?? 'That did not save.', true)
        return false
      }
      show(data.image)
      say(done)
      return true
    } catch {
      say('The request never reached the server.', true)
      return false
    } finally {
      fi?.classList.remove('busy')
    }
  }

  // ── upload

  upload?.addEventListener('click', () => file?.click())
  file?.addEventListener('change', (e) => {
    // Not part of the composer's form: keep it from marking the draft dirty.
    e.stopPropagation()
    const picked = file.files?.[0]
    if (!picked) return
    const body = new FormData()
    body.set('file', picked)
    void imageRequest('upload', body, 'Uploaded.').finally(() => {
      file.value = ''
    })
  })

  clear?.addEventListener('click', () => {
    void imageRequest('clear', new FormData(), 'Removed.')
  })

  // ── Unsplash

  if (q && results) {
    let timer: number | null = null
    let asked = ''
    let page = 1
    // Only the newest search may draw: a slow answer to "oce" must not land on
    // top of the answer to "ocean".
    let seq = 0

    const run = async (query: string, more = false): Promise<void> => {
      const mine = ++seq
      page = more ? page + 1 : 1
      asked = query
      if (!query) {
        results.replaceChildren()
        say('')
        return
      }
      if (!more) say('Searching…')
      try {
        const res = await fetch(`/photos/search?q=${encodeURIComponent(query)}&page=${page}`, {
          headers: { Accept: 'application/json' },
        })
        const data = (await res.json().catch(() => null)) as Answer<{ photos: Photo[] }> | null
        if (mine !== seq) return
        if (!data?.ok) {
          say(data?.reason ?? 'Unsplash search failed.', true)
          return
        }
        drawPhotos(data.photos, more)
        say(data.photos.length || more ? '' : `Nothing found for “${query}”.`)
      } catch {
        if (mine === seq) say('Unsplash search failed.', true)
      }
    }

    const drawPhotos = (photos: Photo[], more: boolean): void => {
      if (!more) results.replaceChildren()
      results.querySelector('.fi-more')?.remove()
      for (const p of photos) {
        const b = document.createElement('button')
        b.type = 'button'
        b.title = p.alt ? `${p.alt} · ${p.credit}` : `Photo by ${p.credit}`
        if (p.color) b.style.background = p.color
        const img = document.createElement('img')
        img.src = p.thumbUrl
        img.alt = p.alt
        img.loading = 'lazy'
        b.append(img)
        b.addEventListener('click', () => void pick(p))
        results.append(b)
      }
      // Twelve at a time, which is what one Unsplash page holds.
      if (photos.length >= 12) {
        const more = document.createElement('button')
        more.type = 'button'
        more.className = 'btn sm fi-more'
        more.textContent = 'More'
        more.addEventListener('click', () => void run(asked, true))
        results.append(more)
      }
    }

    const pick = async (p: Photo): Promise<void> => {
      const body = new FormData()
      body.set('url', p.url)
      body.set('credit', p.credit)
      body.set('credit_url', p.creditUrl)
      body.set('download_location', p.downloadLocation)
      await imageRequest('unsplash', body, 'Featured image set.')
    }

    // The search box is not part of the draft, so none of its typing may mark
    // the draft dirty — and Enter searches rather than submitting the composer.
    q.addEventListener('input', (e) => {
      e.stopPropagation()
      if (timer !== null) clearTimeout(timer)
      const query = q.value.trim()
      timer = window.setTimeout(() => {
        if (query !== asked) void run(query)
      }, SEARCH_MS)
    })
    q.addEventListener('change', (e) => e.stopPropagation())
    q.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      if (timer !== null) clearTimeout(timer)
      void run(q.value.trim())
    })
  }

  // ── topics

  const topics = panel.querySelector<HTMLInputElement>('[data-topics]')
  topics?.addEventListener('change', async () => {
    const id = await recordId()
    if (!id) return
    const body = new FormData()
    body.set('topics', topics.value)
    await fetch(`/broadcasts/${id}/topics`, { method: 'POST', body }).catch(() => undefined)
  })
}
