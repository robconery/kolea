// SPEC 5.15 — fixing a link in a sent broadcast, as an operator does it
//
// "Fix a link" sits inside the sent-mail composer's form and posts with
// `formaction`, so it never saves the editor. Only a browser can show that the
// composer's own script lets that submit through and that the button posts the
// two fields it owns: the server-side suite posts the form by hand.
import { expect, test } from '@playwright/test'

test.describe('Fixing a link after sending', () => {
  test('the operator picks a link, types the new one, and the page says it is fixed', async ({ page }) => {
    await page.goto('/broadcasts')
    await page.getByRole('link', { name: 'What I learned rewriting my mailer' }).first().click()

    const section = page.locator('[data-test="fix-link"]')
    await expect(section).toContainText('https://example.com/post')

    await section.locator('select[name="fix_from"]').selectOption('https://example.com/post')
    await section.locator('input[name="fix_to"]').fill('https://example.com/blog/rewriting')
    await section.getByRole('button', { name: 'Fix link' }).click()

    await expect(page.locator('[data-test="fix-link"]')).toContainText('→ https://example.com/blog/rewriting')
  })
})
