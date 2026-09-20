// STORY-023 — The sequence editor says where people go
// SPEC 6.19, 6.13, 6.15
//
// This screen is the answer to "what happens to somebody in this series?", and
// it has to answer on one page: where finishers go, which tags pull people out
// and where each leads, the endings that always apply, and which sequences
// feed into this one. Every one of those is a separate query in the domain; if
// the page silently stops rendering one of them, the operator's mental model
// of their own automation quietly goes wrong.
import { expect, test } from '@playwright/test'

/** The seed builds these two. */
const ONBOARDING = 'Ruby onboarding'
const LAUNCH = 'Workshop launch runway'

async function openSequence(page: import('@playwright/test').Page, name: string) {
  await page.goto('/sequences')
  await page.getByRole('link', { name }).first().click()
  await expect(page.getByRole('heading', { name: /Leaving, and what happens next/ })).toBeVisible()
}

test.describe('The sequence editor', () => {
  test('states the endings that no setting can switch off', async ({ page }) => {
    await openSequence(page, ONBOARDING)

    const always = page.locator('.card', { hasText: 'Leaving, and what happens next' })
    await expect(always).toContainText('They leave this series from the footer link')
    await expect(always).toContainText('They unsubscribe from everything')
    await expect(always).toContainText('hard-bounces')

    // ⭐ And the one people get wrong, said out loud on the screen.
    await expect(always).toContainText('Unsubscribing from the newsletter does')
    await expect(always).toContainText('not')
  })

  test('says an exit is not an unsubscribe', async ({ page }) => {
    await openSequence(page, ONBOARDING)
    await expect(page.getByText('An exit is not an unsubscribe')).toBeVisible()
  })

  test('records where finishers go, and shows it on both screens', async ({ page }) => {
    // Point onboarding at the launch runway…
    await openSequence(page, ONBOARDING)
    await page
      .locator('form[action$="/next"]')
      .getByRole('combobox')
      .selectOption({ label: LAUNCH })
    await page.locator('form[action$="/next"]').getByRole('button', { name: 'Save' }).click()

    await openSequence(page, ONBOARDING)
    await expect(
      page.locator('form[action$="/next"]').getByRole('combobox'),
    ).toHaveValue(/\d+/)

    // …and the runway now says people arrive from onboarding.
    await openSequence(page, LAUNCH)
    await expect(page.getByText(/People arrive here from/)).toBeVisible()
    await expect(page.getByText(/People arrive here from/)).toContainText(ONBOARDING)
    await expect(page.getByText(/People arrive here from/)).toContainText('on finishing')
  })

  test('lists each exit tag and where it leads', async ({ page }) => {
    await openSequence(page, LAUNCH)

    // Before: nothing configured, and the page says so in plain words rather
    // than showing an empty table.
    await expect(page.getByText('No exits configured')).toBeVisible()

    // Selected by control name rather than by label: the editor's labels are
    // not associated with their controls (no `for`, no nesting), so `getByLabel`
    // finds nothing. Worth fixing in the markup one day — noted, not papered over.
    const addExit = page.locator('form[action$="/exits"]')
    await addExit.locator('select[name="tagId"]').selectOption({ label: 'customer' })
    await addExit
      .locator('select[name="thenSequenceId"]')
      .selectOption({ label: `add them to ${ONBOARDING}` })
    await addExit.getByRole('button', { name: 'Add exit' }).click()

    // After: the tag, and where it sends them.
    const exits = page.locator('table', { hasText: 'When they get' })
    await expect(exits).toContainText('customer')
    await expect(exits).toContainText('add them to')
    await expect(exits).toContainText(ONBOARDING)

    // And the target screen reports the new feeder, labelled as an exit rather
    // than as a finish — they are different routes in and read differently.
    await openSequence(page, ONBOARDING)
    await expect(page.getByText(/People arrive here from/)).toContainText('on an exit')
  })

  test('refuses a tag that both starts and ends the same sequence', async ({ page }) => {
    // The seed's Ruby onboarding is triggered by the `ruby` tag. Making that
    // same tag an exit would build a series nobody can ever enter.
    await openSequence(page, ONBOARDING)

    const addExit = page.locator('form[action$="/exits"]')
    await addExit.locator('select[name="tagId"]').selectOption({ label: 'ruby' })
    await addExit.getByRole('button', { name: 'Add exit' }).click()

    await expect(page.getByText(/cannot also end it/)).toBeVisible()
  })
})
