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

## Rules

- DO NOT REPORT SOMETHING IS FIXED IF YOU HAVEN'T COMPILED THE APP
- DO NOT SEARCH node_modules for answers. GO ONLINE.
- Use emoji for markdown documents for readability.
- Get to the point, be terse, do not over explain. Tokens are water, we're in the desert. Use emoji instead of prose if you can.
- Never install a package by editing the manifest, always use a package install tool, such as `npm install`, `bun install`, etc.
