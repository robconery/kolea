/**
 * Browser smoke test for the composer.
 *
 * The editor is the one part of Kōlea that can't be verified from the
 * server side — a bad extension option or a renamed command fails silently in
 * the browser and the field just never saves. This drives a real Chromium
 * against a running dev server.
 *
 *   bun run dev            # in one terminal
 *   bun run smoke          # in another
 *
 * Uses the Chromium that Playwright already caches; no browser download.
 */
import { chromium } from 'playwright-core'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'

const BASE = process.env.BASE_URL ?? 'http://localhost:8787'

function findChromium() {
  const cache = `${homedir()}/Library/Caches/ms-playwright`
  const dir = readdirSync(cache)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .pop()
  if (!dir) throw new Error('No cached Playwright Chromium found.')
  // Layout differs by version/arch; try the known ones.
  const candidates = [
    `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${cache}/${dir}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
  ]
  return candidates.find((p) => {
    try {
      readdirSync(p.slice(0, p.lastIndexOf('/')))
      return true
    } catch {
      return false
    }
  })
}

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

const browser = await chromium.launch({ executablePath: findChromium() })
const page = await browser.newPage()

const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`)
})

await page.goto(`${BASE}/broadcasts/new`, { waitUntil: 'networkidle' })
await page.waitForSelector('.bm-prose', { timeout: 10000 })

const pm = page.locator('.bm-prose')
const json = () => page.inputValue('input[name="body_json"]')

/**
 * Put the caret at the very end of the document.
 *
 * Deliberately clicks the FIRST paragraph rather than the editor box: a click on
 * the box centre can land on an atom node (button, image), leaving a NodeSelection
 * that the next insert would replace.
 */
const caretToEnd = async () => {
  await page.locator('.bm-prose > *').first().click()
  await page.keyboard.press('Control+End')
  await page.waitForTimeout(120)
}

check('editor mounts', true)
check('toolbar rendered', (await page.locator('.bm-tb').count()) > 10)

// ── typing syncs to the hidden field
await pm.click()
await page.keyboard.type('Hello from the smoke test')
await page.waitForTimeout(200)
check('hidden field receives TipTap JSON', (await json()).startsWith('{"type":"doc"'))
check('typed text lands in the doc', (await json()).includes('Hello from the smoke test'))

// ── marks
await page.keyboard.press('Shift+Home')
await page.locator('.bm-tb[title^="Bold"]').click()
await page.waitForTimeout(150)
check('bold mark applied', (await json()).includes('"type":"bold"'))
check('bubble menu shows on selection', await page.locator('.bm-bubble-row').first().isVisible())

// ── slash menu
await caretToEnd()
await page.keyboard.press('Enter')
await page.keyboard.type('/')
await page.waitForTimeout(350)
check('slash menu opens', await page.locator('.bm-menu').isVisible())
const total = await page.locator('.bm-menu-item').count()
check('slash menu populated', total > 8, `${total} items`)

await page.keyboard.type('head')
await page.waitForTimeout(250)
const filtered = await page.locator('.bm-menu-item').count()
check('slash menu filters', filtered > 0 && filtered < total, `${filtered} of ${total}`)
await page.keyboard.press('Enter')
await page.waitForTimeout(200)
check('heading inserted via slash', (await json()).includes('"type":"heading"'))

// ── merge tags
await page.keyboard.type('Hi @')
await page.waitForTimeout(350)
check('merge-tag menu opens on @', await page.locator('.bm-menu').isVisible())
await page.keyboard.press('Enter')
await page.waitForTimeout(200)
check('merge tag node inserted', (await json()).includes('"type":"mergeTag"'))
check('merge chip renders', (await page.locator('.bm-merge').count()) > 0)

// ── CTA button
await page.keyboard.press('Enter')
await page.keyboard.type('/button')
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
await page.waitForTimeout(250)
check('emailButton inserted', (await json()).includes('"type":"emailButton"'))
check('button node view renders', (await page.locator('.bm-button').count()) > 0)
check(
  'bubble menu switches to the URL field',
  await page.locator('.bm-bubble-link .bm-bb-input').isVisible(),
)
await page.locator('.bm-bubble-link .bm-bb-input').fill('https://example.com/buy')
await page.waitForTimeout(200)
check('button href saved', (await json()).includes('https://example.com/buy'))

// ── table (toolbar: slash is intentionally inert inside code blocks)
await caretToEnd()
await page.locator('.bm-tb[title="Table"]').click()
await page.waitForTimeout(300)
check('table inserted', (await page.locator('.bm-prose table').count()) > 0)

// ── code block + syntax highlighting
await caretToEnd()
await page.locator('.bm-tb[title="Code block"]').click()
await page.waitForTimeout(150)
await page.keyboard.type('const x = 1; function hi() { return "yo" }')
await page.waitForTimeout(500)
check('code block created', (await page.locator('.bm-prose pre').count()) > 0)
check(
  'lowlight emits highlight tokens',
  (await page.locator('.bm-prose pre .hljs-keyword').count()) > 0,
)

// ── block-style affordances
await page.locator('.bm-prose p').first().hover()
await page.waitForTimeout(400)
check('drag handle appears on hover', await page.locator('.bm-drag').isVisible())
check('no word count in the composer', (await page.locator('.bm-count').count()) === 0)

// ── image upload through the real endpoint + R2
const uploaded = await page.evaluate(async () => {
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8Dwn4GBgYGJgYEBAA4TAv0Fs4kUAAAAAElFTkSuQmCC',
    ),
    (c) => c.charCodeAt(0),
  )
  const body = new FormData()
  body.append('file', new File([png], 'dot.png', { type: 'image/png' }))
  const res = await fetch('/api/media/upload', { method: 'POST', body })
  if (!res.ok) return { ok: false, status: res.status }
  return { ok: true, ...(await res.json()) }
})
check('upload endpoint returns a URL', uploaded.ok && String(uploaded.url).includes('/media/'), String(uploaded.url ?? uploaded.status))

if (uploaded.ok) {
  check('uploaded image is served back', (await page.request.get(uploaded.url)).ok())
}

// ── drop-to-upload: exercises FileHandler → uploadImage → setImage for real
await caretToEnd()
await page.keyboard.press('Enter')

const dataTransfer = await page.evaluateHandle(() => {
  const dt = new DataTransfer()
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8Dwn4GBgYGJgYEBAA4TAv0Fs4kUAAAAAElFTkSuQmCC',
    ),
    (c) => c.charCodeAt(0),
  )
  dt.items.add(new File([png], 'dropped.png', { type: 'image/png' }))
  return dt
})
const box = await pm.boundingBox()
await pm.dispatchEvent('drop', {
  dataTransfer,
  // Without coordinates FileHandler's posAtCoords lookup returns null and the
  // drop is silently ignored — the event must look like a real one.
  clientX: Math.round(box.x + 50),
  clientY: Math.round(box.y + 40),
  bubbles: true,
  cancelable: true,
})
// Upload is async: the image node only appears once the URL comes back.
await page
  .waitForFunction(() => document.querySelectorAll('.bm-prose img').length > 0, { timeout: 8000 })
  .catch(() => {})
check('dropped image uploads and inserts', (await page.locator('.bm-prose img').count()) > 0)
check('image node is in the document JSON', (await json()).includes('"type":"image"'))

// ── round-trip through the server
await page.fill('input[name="subject"]', 'Smoke test broadcast')
await page.click('button.primary')
await page.waitForLoadState('networkidle')
check('form saved and redirected', page.url().includes('/broadcasts/'), page.url())

await page.waitForSelector('.bm-prose', { timeout: 10000 })
const reloaded = await json()
for (const type of ['heading', 'emailButton', 'mergeTag', 'table', 'codeBlock', 'image']) {
  check(`${type} survives the round-trip`, reloaded.includes(`"type":"${type}"`))
}

await browser.close()

console.log('')
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`)
}
const failed = results.filter((r) => !r.ok)
console.log('')
if (errors.length) {
  console.log('JS errors:')
  for (const e of [...new Set(errors)]) console.log(`  ${e}`)
} else {
  console.log('No JS errors.')
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length || errors.length ? 1 : 0)
