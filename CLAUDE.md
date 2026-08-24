# 🐦 Kōlea

Self-hosted email — broadcasts, transactional sends, and drip sequences in one Cloudflare
Worker, replacing a paid ESP so the list and engagement data stay owned.

Named for the Pacific golden plover: three thousand miles of open ocean, nonstop, and it
lands in the same yard every year. Delivery, and the same address, every time.

Single operator. Not multi-tenant, no visual builder, no self-run SMTP. See `docs/PROJECT.md`.

Domain: email marketing / transactional email.

> Cloudflare resources (Worker, D1, queues) are still named `big-mailer`. That is
> deliberate — they are bound to live production data. Kōlea is the brand, `big-mailer`
> is the infrastructure. Don't "fix" the mismatch without a cutover plan.

## 📚 Docs — read before you write

`docs/` is the reference set. **One doc, one owner. Never write a doc you don't own.**

| Doc | What's in it | Read it when | Owner |
|---|---|---|---|
| `docs/ARCHITECTURE.md` | ⭐ **The agent's reference.** Invariants, system shape, code map, data model, lifecycles, MCP surface, platform limits, recipes, traps. | **Before changing any code.** Start here. | `/design` |
| `docs/SPEC.md` | Numbered, testable behavioral requirements. The reference for *intended* behavior. | Before changing behavior. Code disagreeing with SPEC is a bug report, not a licence to edit SPEC. | `/design` |
| `docs/MEMORY.md` | Decision log — what was chosen, what was rejected, and why. | Before "improving" something odd. The odd thing is usually load-bearing. | `/document` (appended by all phases) |
| `docs/INSTALL.md` | Local setup, full production deploy, integrations, troubleshooting. | Setup, deploy, or config questions. | `/document` |
| `docs/PROJECT.md` | The problem, who it's for, what's explicitly out of scope. | Before proposing a feature. | `/explore` |
| `docs/PLAN.md` | What's built, what's verified, what isn't. | Picking up work. | `/plan` |
| `docs/STORIES.md` | Backlog. Currently thin — the build went SPEC → code. | `/plan` runs. | `/plan` |
| `README.md` | The public front door. | Changing the pitch or the install steps. | `/document` |
| `CLAUDE.md` | This file. | `/init` runs. | `/init` |

**`src/db/schema.ts` is the truth about the data.** It carries dense comments explaining
*why* each column is shaped the way it is. Read it in full before any data change — several
shapes in there look wrong and are load-bearing.

## 🔁 Phase commands

`/explore` → `/design` → `/plan` → `/build-loop` → `/document`

## 🛠 Stack

- Language: TypeScript
- Runtime: Cloudflare Workers (single Worker: `fetch` + `scheduled` + `queue` handlers)
- Web: Hono + JSX, server-rendered. **Not Next.js.**
- Data: Cloudflare D1 (SQLite) via Drizzle — follow the `sqlite-dev` skill's conventions
- Async: Cloudflare Queues (send fan-out) + Cron Triggers (scheduling, sequence ticks)
- Mail: pluggable `EmailProvider` port; Resend is the first adapter
- Editor: TipTap v3, vanilla — the only browser JS in the project
- Agents: MCP server in the same Worker — 96 tools, 4 resources, 4 prompts
- Auth: Cloudflare Access (no app-level login)
- Package manager: Bun

## 🧭 Layering

```
web/  api/  mcp/     ← may import core/, never providers/ or db/ directly
       ↓
     core/           ← the domain. Every rule lives here exactly once
       ↓
  db/  providers/    ← import nothing above them
```

If an MCP tool needs logic the admin UI already had, pull it down into `core/` first.
Two implementations of one rule is how consent gets broken.

## ▶️ Commands

- Install: `bun install`
- Dev: `bun run dev` (builds the client bundle, then `wrangler dev` on :8787)
- Typecheck: `bun run typecheck` — Worker, browser bundle, and scripts, separately
- Migrations: `bun run db:generate` (drizzle-kit) → `bun run db:migrate`. Never hand-write one
- Smoke test: `bun run smoke` — real Chromium against the editor; needs `dev` running
- Deploy: `bun run deploy`. **Always `--env production`** — top-level vars carry
  `DEV_AUTH_BYPASS=true`
- Server-side tests: none yet. `docs/SPEC.md` is written to be made executable

## ⚠️ Platform limits that bite

- D1: **1,000 queries per Worker invocation**, 10 GB/db, single-threaded writes
- Queues: batches of 100, 5k msg/sec — `max_concurrency` pinned to 6, because one batch
  is one provider request, so batch concurrency *is* the request rate
- Workers logs retain 3–7 days — **anything observable must be a row in D1, not a log line**
- No DOM in `workerd` — and `src/client/` needs its own tsconfig, because workerd's
  `Response`/`Headers` shadow the DOM ones and silently resolve the wrong overloads
- Wrangler environments do **not** inherit bindings — every one is repeated under
  `env.production`, or production deploys with `env.DB === undefined`

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
- **Consent is scoped, never blanket.** Leaving one sequence never touches the newsletter
  or any other sequence. Do not trust your priors about how ESPs work — the full model
  is in `docs/ARCHITECTURE.md`, and assuming the usual shape is the most damaging
  mistake available here.
- **When in doubt, don't.** Ask. An unsent mail costs nothing; an unwanted one costs a
  subscriber and a sender reputation that took years to build.

## Rules

- DO NOT REPORT SOMETHING IS FIXED IF YOU HAVEN'T COMPILED THE APP
- DO NOT SEARCH node_modules for answers. GO ONLINE.
- Use emoji for markdown documents for readability.
- Never install a package by editing the manifest, always use a package install tool, such as `npm install`, `bun install`, etc.
