// STORY-022 — The composer saves what I wrote
// SPEC 3.1
//
// The editor is the one part of Kōlea that cannot be verified from the server
// side: TipTap is the only browser JavaScript in the project, and a renamed
// extension option fails *silently* — the hidden field simply never receives
// the document and the draft saves empty. Nothing on the server can tell the
// difference between "they wrote nothing" and "the editor broke".
//
// `scripts/smoke-editor.mjs` exercises the editor's blocks in depth (33
// checks). This covers the contract that matters to the rest of the system:
// what is on screen is what gets stored, and what gets stored comes back.
import { expect, test } from '@playwright/test'

test.describe('The composer', () => {
  test('syncs what is typed into the hidden document field', async ({ page }) => {
    await page.goto('/broadcasts/new')
    await page.waitForSelector('.bm-prose')

    await page.locator('.bm-prose').click()
    await page.keyboard.type('The editor is wired to the form.')

    await expect
      .poll(() => page.inputValue('input[name="body_json"]'), { timeout: 5000 })
      .toContain('The editor is wired to the form.')
  })

  test('stores TipTap JSON, not a string of HTML', async ({ page }) => {
    await page.goto('/broadcasts/new')
    await page.waitForSelector('.bm-prose')
    await page.locator('.bm-prose').click()
    await page.keyboard.type('Structured, not serialized.')

    await expect
      .poll(() => page.inputValue('input[name="body_json"]'), { timeout: 5000 })
      .toMatch(/^\{"type":"doc"/)
  })

  test('a saved draft comes back with its body intact', async ({ page }) => {
    const subject = `Draft written by a browser ${Date.now()}`

    await page.goto('/broadcasts/new')
    await page.waitForSelector('.bm-prose')
    await page.locator('.bm-prose').click()
    await page.keyboard.type('This sentence has to survive a round trip.')
    await page.fill('#subject', subject)

    // The page offers Save in both the header and the footer bar; either does.
    await page.getByRole('button', { name: 'Save draft' }).first().click()

    // Landed on the broadcast's own page…
    await expect(page).toHaveURL(/\/broadcasts\/\d+/)
    await expect(page.locator('#subject')).toHaveValue(subject)

    // …and reopening it shows the words back, from the database this time.
    await page.reload()
    await page.waitForSelector('.bm-prose')
    await expect(page.locator('.bm-prose')).toContainText(
      'This sentence has to survive a round trip.',
    )
  })

  test('the draft appears on the broadcast list as a draft', async ({ page }) => {
    const subject = `Listed draft ${Date.now()}`

    await page.goto('/broadcasts/new')
    await page.waitForSelector('.bm-prose')
    await page.locator('.bm-prose').click()
    await page.keyboard.type('Body text.')
    await page.fill('#subject', subject)
    // The page offers Save in both the header and the footer bar; either does.
    await page.getByRole('button', { name: 'Save draft' }).first().click()
    await expect(page).toHaveURL(/\/broadcasts\/\d+/)

    await page.goto('/broadcasts')
    const row = page.locator('tr', { hasText: subject })
    await expect(row).toContainText('draft')
  })

  test('the editor loads without throwing anything at the console', async ({ page }) => {
    // A TipTap extension that fails to register logs and then quietly does
    // nothing. Treating that as a test failure is the only way to notice.
    const problems: string[] = []
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console: ${message.text()}`)
    })

    await page.goto('/broadcasts/new')
    await page.waitForSelector('.bm-prose')
    await page.locator('.bm-prose').click()
    await page.keyboard.type('Hello')

    expect(problems).toEqual([])
  })
})
