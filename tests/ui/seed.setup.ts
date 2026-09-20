/**
 * Put the UI suite's database into a known state before anything runs.
 *
 * `/dev/reset` and `/dev/seed` are the app's own local-only endpoints (they
 * refuse unless `DEV_AUTH_BYPASS` is on), so this is not test scaffolding
 * bolted onto production — it is the same two buttons the dashboard offers.
 *
 * ⚠️ It resets whatever database the server under test is using. The Playwright
 * config points that at `.wrangler/ui-test-state`, which exists for exactly
 * this reason; if you point BASE_URL at something else, it will wipe that.
 */
import type { FullConfig } from '@playwright/test'

export default async function seed(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:8788'

  if (!baseURL.includes('localhost') && !baseURL.includes('127.0.0.1')) {
    throw new Error(`Refusing to reset a non-local server: ${baseURL}`)
  }

  const post = async (path: string) => {
    const response = await fetch(`${baseURL}${path}`, { method: 'POST', redirect: 'manual' })
    if (response.status >= 400) {
      throw new Error(`${path} answered ${response.status}: ${await response.text()}`)
    }
  }

  await post('/dev/reset')
  await post('/dev/seed')
}
