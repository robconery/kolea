# 🧪 The test suite

Two suites, one idea: **every test is accountable to a numbered requirement**.

| Suite | Runner | What it is for | Command |
|---|---|---|---|
| `tests/specs/` | `bun:test` | Every behavioural rule in [`docs/SPEC.md`](../docs/SPEC.md), against the real Worker and a real SQLite database. | `bun test` |
| `tests/ui/` | Playwright + Chromium | The three things a server-side test structurally cannot reach: the page a reader meets, the TipTap composer, and the sequence editor's flow screen. | `bun run test:ui` |

```bash
bun run typecheck   # four passes — Worker, browser bundle, scripts, tests
bun test            # the server-side suite (fast; no server needed)
bun run test:ui     # browser tests (starts its own wrangler dev)
bun run test:all    # all three, in that order
```

---

## 📐 The shape of a spec, and why

The suite follows the project's `bdd-specs` conventions. Three nested blocks,
outermost first:

```
Feature      ← one per file, from one story in docs/STORIES.md
  Scenario   ← one situation; arranges ALL its data in beforeAll
    it()     ← exactly ONE assertion
```

Four rules follow from that, and they are worth stating because they are what
make a failure useful:

1. **One assertion per `it`.** A red test names precisely what broke, rather
   than stopping at the first of five things it was checking.
2. **Happy path first, exhaustively; sad paths in their own Scenario blocks.**
   Read a file top to bottom and you learn the intended behaviour before you
   learn how it fails.
3. **Every Feature drives a deployed entry point at least once** —
   `worker.fetch`, `worker.scheduled` or `worker.queue` — not an internal
   function underneath it. Unit-level scenarios are welcome *as well*, never
   *instead*: mocks define test reality, and only the entry point defines
   production reality.
4. **Scenario names read as sentences about people**, not about functions.
   "a reader leaves one series", not "leaveSequence()".

Each file's header comment names the story and the SPEC clauses it covers. A
⭐ on an assertion means it is guarding one of the [invariants](../docs/ARCHITECTURE.md#-the-invariants) —
the rules whose violation is silent, irreversible, and lands in a stranger's
inbox.

## 🔌 What is real, and what is faked

Almost nothing is faked, which is the point.

| Thing | In the suite | Why |
|---|---|---|
| The domain (`src/core/`) | **Real** | It is what is being tested. |
| The routers, JSX, renderer | **Real** | Reached through `worker.fetch`. |
| D1 | **Real SQL** — `bun:sqlite` behind a faithful `D1Database` (`support/d1.ts`) | D1 *is* SQLite. Foreign keys on, `last_row_id` populated, bound values coerced the way the D1 wire does it. |
| Migrations | **The real ones**, from `migrations/*.sql` | A migration that is wrong is wrong here too. |
| Email | `EMAIL_PROVIDER=console` | The project's kill switch. Mail lands in `dev_outbox`, and a spec reads it with `world.outbox()`. |
| Queues | **Unbound** | `dispatch()` then sends inline — that fallback is production code, not a test hook. `worker.queue` is still driven directly, with `sendBatchOf()`. |
| R2, static assets | In-memory / 404 | Bytes and CDN. No rule lives there. |

> ⚠️ **Nothing in this suite can reach the wire.** `createWorld()` hard-codes
> the console provider. Two specs set `RESEND_API_KEY` because the *webhook*
> route refuses to parse without one — they never set `EMAIL_PROVIDER=resend`,
> and no test should. There are ~13.7k real addresses in the production
> database and exactly one thing between a test run and all of them.

## 🧱 The harness

| File | What it gives you |
|---|---|
| `support/world.ts` | `createWorld()` → a migrated database, a full `Env`, and `fetch` / `post` / `tick` / `settle` / `outbox` / `mailTo`. |
| `support/d1.ts` | The `D1Database` implementation over `bun:sqlite`. |
| `support/migrate.ts` | Applies `migrations/*.sql`, split on Drizzle's `--> statement-breakpoint`. |
| `support/factories.ts` | `aPerson`, `aSequence`, `aBroadcast`, `tag`, `makeDue`, `enrollmentOf`, `reload`. Each goes through a production `core/` function. |
| `support/svix.ts` | Signs a Resend webhook, so the signature check is exercised for real. |

Two helpers write *time* rather than state, and only because delays are in
whole days: `makeDue()` and `backdate()`. The application has the same thing —
"Fast-forward the clock" on the dashboard.

`world.settle()` exists because `POST /api/send` deliberately answers before
the provider does (SPEC 7.5). A spec that wants the mail to have gone says so.

## 🖥 The browser tests

`tests/ui/` runs against a **real `wrangler dev`** on port 8788 with its own D1
under `.wrangler/ui-test-state`, reset and reseeded before every run. It will
not touch the database behind your ordinary `bun run dev`.

They are pinned to the Playwright version whose Chromium is already cached
locally, so running them downloads nothing. After a Playwright upgrade:
`bunx playwright install chromium`.

`scripts/smoke-editor.mjs` (`bun run smoke`) still exists and goes deeper on the
editor's individual blocks — 33 checks against a dev server you start yourself.
`tests/ui/composer.spec.ts` covers the narrower contract that the rest of the
system depends on: what is on screen is what gets stored.

## ➕ Adding a test

1. Find or write the story in [`docs/STORIES.md`](../docs/STORIES.md). One
   story, one Feature, one file.
2. Name the file after the behaviour in kebab-case
   (`leaving-one-series.spec.ts`), and put the story id in the header comment —
   that comment is the only place the id appears.
3. Happy-path Scenarios first. Sad paths below, in their own blocks.
4. One assertion per `it`. If you want another, write another `it`.
5. Make sure one Scenario drives the deployed entry point.
6. `bun test && bun run typecheck`.

## 🧭 Known divergences, recorded on purpose

A spec that documents surprising real behaviour is more useful than one that
quietly asserts what we wish were true. Where the two differ, the test says so
in a comment and names the SPEC clause, so the disagreement is visible instead
of forgotten:

- **`sending-a-broadcast.spec.ts`** — a send that materializes its last
  recipient leaves the broadcast `sending`; the *next* pass (the minutely cron)
  marks it `sent`. SPEC 3.7 reads as though the first pass should close it.
- **`sending-a-broadcast.spec.ts`** — someone who joins *while a send is still
  in flight* is picked up by a later page of that same send, because recipients
  are materialized behind a cursor over `subscribers.id`. SPEC 3.5 says
  recipients are resolved once, at dispatch. At 13.7k subscribers the window is
  minutes wide, so this is real. It may well be the *nicer* behaviour — but
  SPEC and the code should agree either way.
