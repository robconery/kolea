import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests — the behaviours that only exist once HTML meets a browser.
 *
 * Run with `bun run test:ui`. The server-side suite (`bun test`) covers every
 * rule; these cover the three things it structurally cannot:
 *
 *  1. that the preference page reads clearly enough for a person to pick the
 *     narrow choice — and still works with JavaScript switched off,
 *  2. that the TipTap composer actually persists what it shows (a renamed
 *     extension option fails silently in the browser and the field just never
 *     saves — nothing server-side catches it),
 *  3. that the sequence editor states the whole flow on one screen (SPEC 6.19).
 *
 * ## Its own database, on its own port
 *
 * `--persist-to .wrangler/ui-test-state` gives this a D1 of its own, so a run
 * cannot touch whatever is in your ordinary `bun run dev` database — the suite
 * resets and reseeds on every run, and doing that to your working data would be
 * rude at best. Port 8788 for the same reason: 8787 is probably already yours.
 *
 * ## Browsers
 *
 * Pinned to the Playwright version whose Chromium is already in the local
 * cache, exactly like `scripts/smoke-editor.mjs` — no 150 MB download to run
 * the tests. If Playwright is ever upgraded, run `bunx playwright install
 * chromium` once.
 */
const PORT = 8788
const BASE_URL = `http://localhost:${PORT}`
const STATE = '.wrangler/ui-test-state'

export default defineConfig({
  testDir: './tests/ui',
  // Serial: every test drives one seeded database, and a second worker
  // rewriting it underneath would produce failures nobody could reproduce.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  globalSetup: './tests/ui/seed.setup.ts',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // `bunx wrangler`, never a bare `wrangler`: a stale global install talks to
    // a different local-state format and the D1 binding fails at runtime.
    command: `bun run build:client && bunx wrangler d1 migrations apply big-mailer --local --persist-to ${STATE} && bunx wrangler dev --port ${PORT} --persist-to ${STATE}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
