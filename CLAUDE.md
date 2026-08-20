# big-mailer

Self-hosted email for Rob's own lists and apps — broadcasts, transactional sends, and drip
sequences in one service, replacing a paid ESP so the list and engagement data stay owned.

Single operator. Not multi-tenant, no visual builder, no self-run SMTP. See `docs/PROJECT.md`.

Domain: email marketing / transactional email.

## 📚 Docs & Ownership

One doc, one owner. Never write a doc you don't own.

| Doc | Owner |
|---|---|
| `CLAUDE.md` | `/init` |
| `docs/PROJECT.md` | `/explore` |
| `docs/ARCHITECTURE.md` | `/design` |
| `docs/SPEC.md` | `/design` |
| `docs/STORIES.md` | `/plan` |
| `docs/PLAN.md` | `/plan` |
| `docs/MEMORY.md` | `/document` (appended by all phases) |
| `README.md` | `/document` |

## 🔁 Phase commands

`/explore` → `/design` → `/plan` → `/build-loop` → `/document`

## 🛠 Stack

- Language: TypeScript
- Runtime: Cloudflare Workers (single Worker: `fetch` + `scheduled` + `queue` handlers)
- Web: Hono + JSX, server-rendered. **Not Next.js.**
- Data: Cloudflare D1 (SQLite) via Drizzle — follow the `sqlite-dev` skill's conventions
- Async: Cloudflare Queues (send fan-out) + Cron Triggers (scheduling, sequence ticks)
- Mail: pluggable `EmailProvider` port; Resend is the first adapter
- Auth: Cloudflare Access (no app-level login)
- Package manager: Bun

## ▶️ Commands

- Install: `bun install`
- Dev: `bun run dev` (builds the client bundle, then `wrangler dev` on :8787)
- Typecheck: `bun run typecheck` — Worker and browser bundle, separately
- Migrations: `bun run db:generate` (drizzle-kit) → `bun run db:migrate`
- Smoke test: `bun run smoke` — real Chromium against the editor; needs `dev` running
- Deploy: `bun run deploy`. **Always `--env production`** — top-level vars carry
  `DEV_AUTH_BYPASS=true`
- Server-side tests: none yet. `docs/SPEC.md` is written to be made executable

## ⚠️ Platform limits that bite

- D1: **1,000 queries per Worker invocation**, 10 GB/db, single-threaded writes
- Queues: batches of 100, 5k msg/sec
- Workers logs retain 3–7 days — **anything observable must be a row in D1, not a log line**

## 🚨 Real people are on the other end

There are ~13.7k real addresses in production. Every one of them can be spammed by a
careless write. These are hard rules, not preferences.

- **Never send without an explicit, current instruction to send.** Not "it would be
  useful to test the send path" — an actual request, for that specific mail, right now.
  A test send goes to Rob's own address and nowhere else.
- **Bulk imports never go through `upsertSubscriber()`.** It fires `enrollOnSubscribe()`,
  so importing N people into a live `subscribe` sequence mails all N of them. Import as
  direct SQL (see `scripts/import-kit.ts`), or pass
  `triggerSubscribeSequences: false`.
- **Imported/backfilled content is inert on arrival.** Broadcasts land as
  `status: 'sent'` with `sent_at` set — the minutely tick only claims `sending` or
  `scheduled`-and-due, so anything else is untouchable. Sequences land as
  `is_active: 0` — every enrollment path gates on `isActive`. Activating is a separate,
  deliberate act by Rob.
- **`EMAIL_PROVIDER=console` is the kill switch.** It renders to the in-app Outbox
  instead of the wire. Prefer it for anything experimental.
- **`unsubscribed` is permanent.** No import, sync, or backfill may return somebody to
  `active` (SPEC 1.2). Consent only ever moves one way without the person asking.
- **When in doubt, don't.** Ask. An unsent mail costs nothing; an unwanted one costs a
  subscriber and a sender reputation that took years to build.

## Rules

- DO NOT REPORT SOMETHING IS FIXED IF YOU HAVEN'T COMPILED THE APP
- DO NOT SEARCH node_modules for answers. GO ONLINE.
- Use emoji for markdown documents for readability.
- Never install a package by editing the manifest, always use a package install tool, such as `npm install`, `bun install`, etc.
