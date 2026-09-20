// STORY-021 — The preference center reads clearly to a person
// SPEC 2a.2–2a.4, 9.3
//
// The server suite already proves the *rules* hold. This proves the page a
// stranger actually meets leads them to the narrow choice — because a correct
// backend behind a page that reads "Unsubscribe?" is still an ESP that loses
// people from everything at once.
import { expect, test } from '@playwright/test'

/**
 * Walk in the way a person does: from the operator's view of a subscriber,
 * through the link that opens their preference centre. It also means no test
 * here needs to know a token.
 */
async function preferenceUrlFor(page: import('@playwright/test').Page, email: string) {
  await page.goto('/subscribers')
  await page.getByRole('link', { name: email }).first().click()
  const link = page.getByRole('link', { name: /preference center/i })
  const href = await link.getAttribute('href')
  if (!href) throw new Error(`No preference link on the page for ${email}`)
  return href
}

test.describe('The preference center, as a reader meets it', () => {
  test('arriving from a series, the narrow choice is the prominent one', async ({ page }) => {
    const prefs = await preferenceUrlFor(page, 'ada@example.com')

    // The seed enrolls everybody in the launch runway, so a link from one of
    // its emails carries that scope.
    await page.goto(`${prefs}?scope=sequence:2`)

    await expect(page.getByRole('heading', { name: 'Your email preferences' })).toBeVisible()
    await expect(page.getByText('ada@example.com')).toBeVisible()

    // The series they came from is called out and sorted to the top.
    await expect(page.getByText('You came here from this one')).toBeVisible()
    const primary = page.getByRole('button', { name: 'Stop just this series' })
    await expect(primary).toBeVisible()

    // "Leave everything" exists, one deliberate step away, and is not the
    // control the eye lands on: it is not the accented one.
    const nuclear = page.getByRole('button', { name: 'Unsubscribe from everything' })
    await expect(nuclear).toBeVisible()
    await expect(primary).toHaveClass(/accent/)
    await expect(nuclear).not.toHaveClass(/accent/)
  })

  test('leaving one series says plainly that nothing else changed', async ({ page }) => {
    const prefs = await preferenceUrlFor(page, 'grace@example.com')
    await page.goto(`${prefs}?scope=sequence:2`)

    await page.getByRole('button', { name: 'Stop just this series' }).click()

    await expect(page.getByText(/removed from that series/i)).toBeVisible()
    await expect(page.getByText(/Everything else is untouched/i)).toBeVisible()

    // The newsletter is still on, and says so by offering to unsubscribe from
    // it rather than to resubscribe.
    await expect(page.getByRole('button', { name: 'Unsubscribe', exact: true })).toBeVisible()

    // And the series they left now offers a way back in.
    await expect(page.getByRole('button', { name: 'Rejoin' })).toBeVisible()
  })

  test('the operator’s view agrees: still active, still on the list', async ({ page }) => {
    const prefs = await preferenceUrlFor(page, 'katherine@example.com')
    await page.goto(`${prefs}?scope=sequence:2`)
    await page.getByRole('button', { name: 'Stop just this series' }).click()
    await expect(page.getByText(/removed from that series/i)).toBeVisible()

    await page.goto('/subscribers')
    const row = page.locator('tr', { hasText: 'katherine@example.com' })
    await expect(row).toContainText('active')
  })

  test('the whole flow works with JavaScript switched off', async ({ browser, page }) => {
    // SPEC 9.3 / 2a.4. Plenty of mail clients and privacy setups open links in
    // a stripped-down browser, and this page is reached from mail by
    // definition. It is server-rendered forms all the way down.
    const prefs = await preferenceUrlFor(page, 'margaret@example.com')

    const context = await browser.newContext({ javaScriptEnabled: false })
    const noJs = await context.newPage()
    await noJs.goto(`${prefs}?scope=sequence:2`)

    await expect(noJs.getByRole('heading', { name: 'Your email preferences' })).toBeVisible()
    await noJs.getByRole('button', { name: 'Stop just this series' }).click()
    await expect(noJs.getByText(/Everything else is untouched/i)).toBeVisible()

    await context.close()
  })

  test('an unknown token gives a neutral page and no data', async ({ page }) => {
    const response = await page.goto('/p/definitely-not-a-real-token')

    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Link not recognized' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('@example.com')
  })
})
