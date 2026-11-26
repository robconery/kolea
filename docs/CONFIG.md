# ⚙️ Configuration, commands and making it yours

## ⚙️ Configuration reference

Every setting Kōlea reads. **Vars** go in your `wrangler.jsonc`, which is gitignored and
made from [`wrangler.template.jsonc`](../wrangler.template.jsonc) by `bun run setup`
(local) or `/onboard` (production). **Secrets** go in
Cloudflare with `bunx wrangler secret put NAME --env production`, and locally in
`.dev.vars`.

| Name | Kind | What it does | If unset |
|---|---|---|---|
| `EMAIL_PROVIDER` | var | `resend` sends for real. `console` renders into the Outbox | Required |
| `FROM_EMAIL` / `FROM_NAME` | var | The From line on every mail | Required |
| `PUBLIC_URL` | var | ⚠️ The admin host, baked into every link and image at send time | Required. Wrong = broken mail forever |
| `PREVIEW_EMAIL` | var | The only address a test send may reach | Falls back to `FROM_EMAIL` |
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` | var | Who the Access login is and which app it's for | The admin refuses everyone, you included |
| `DEV_AUTH_BYPASS` | var | `true` skips the login. Local only | Login required (correct) |
| `MCP_ALLOW_SEND` | var | `true` lets agents put mail on the wire | Agents can draft but not send |
| `SITE_URL` | var | The public site's host | No public site |
| `SITE_TITLE` / `SITE_TAGLINE` / `SITE_AUTHOR` | var | Site masthead, until the Profile screen says otherwise | Blank / `FROM_NAME` |
| `SITE_FORM_SLUG` | var | The form the site's subscribe box posts to | No subscribe box |
| `POSTAL_ADDRESS` | secret | Your mailing address, printed in the footer of broadcasts and sequence mail | The line is left out |
| `ACCOUNT_URL` | var | Where a buyer manages what they own. Fills `{{account_url}}` in purchase mail | `{{account_url}}` is empty and purchase mail has no dashboard link |
| `RESEND_API_KEY` | secret | Sending | `resend` can't send |
| `RESEND_WEBHOOK_SECRET` | secret | Verifies bounce and complaint webhooks | ⚠️ Bounces never suppress |
| `MCP_PATH_SECRET` | secret | The unguessable part of the MCP URL | MCP is off (404) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | secret | Revenue attribution | Money screens stay empty; `/webhooks/stripe` returns 503 |
| `UNSPLASH_ACCESS_KEY` | secret | Stock photos when publishing | Picker hidden; uploads still work |
| `OPENROUTER_KEY` | secret | AI writing help | Every AI button hidden |
| `AI_MONTHLY_BUDGET_USD` / `AI_MODEL_*` | var | AI spend cap and model choice | $10, default models |

---

## ▶️ Commands

| | |
|---|---|
| `/onboard` | In Claude Code: the guided setup, local or production. Resumable |
| `bun scripts/onboard.ts` | The steps `/onboard` runs, one by one (`status` shows where you are) |
| `bun run setup` | First run: a local-only `wrangler.jsonc`, a `.dev.vars`, and local migrations |
| `bun run dev` | Build the client bundle, then serve on :8787 |
| `bun run watch:client` | Rebuild the editor bundle on change (alongside `dev`) |
| `bun run test` | The server-side suite: `docs/SPEC.md`, executable |
| `bun run test:ui` | Browser tests (Playwright). Starts its own server on :8788 |
| `bun run test:all` | Typecheck, then both suites |
| `bun run smoke` | Deeper browser smoke test of the editor. Needs `dev` running |
| `bun scripts/seed-analytics-demo.ts` | Fill the analytics screens with local demo data (`--clean` to undo) |
| `bun run screenshots` | Re-shoot `docs/img/` from a throwaway local instance with demo data |
| `bun run db:migrate` | Apply migrations to local D1 |
| `bun run db:generate` | Generate a migration after editing `src/db/schema.ts` |
| `bun run db:studio` | Drizzle Studio against the local database |
| `bun run typecheck` | Worker, browser bundle, scripts and tests, separately |
| `bun run deploy` | Build, then `wrangler deploy --env production`. Read [INSTALL](INSTALL.md) first |

---

## 🗂 What's in here

```
src/
  worker.tsx      fetch + scheduled + queue handlers, and the hostname split
                  between the admin app and the public site
  core/           domain logic: consent, sending, sequences, segments, publishing,
                  rendering, scoring (signal.ts) and measurement (analytics.ts)
  db/             Drizzle schema and the D1 client
  web/            server-rendered admin console (Hono + JSX, no frontend framework),
                  the five read-only analytics screens, the reader's preference
                  center, and site.tsx (the public blog)
  api/            transactional send API, signup forms, media upload, bearer-key auth
  mcp/            MCP server: tools, resources and prompts for agents
  providers/      EmailProvider port + console and Resend adapters
  client/         the only browser JS in the project: the TipTap editor bundle
migrations/       drizzle-kit generated, applied by wrangler
scripts/          onboard.ts (what /onboard and `bun run setup` run), the demo
                  seeds, the screenshot script, and the browser smoke test
.claude/skills/   onboard/ (the /onboard interview), plus the conventions agents follow here
wrangler.template.jsonc   the only config in the repo; your wrangler.jsonc is made from it
tests/            specs/    the behavioral spec, executable (bun:test)
                  ui/       browser tests against a real server (Playwright)
                  support/  a D1 implementation over bun:sqlite, and factories
docs/             install guide, tour, architecture, spec, stories, and the screenshots
```

`bun run typecheck` covers the Worker, the browser bundle, the scripts and the
tests separately, and is clean.

---

## 💳 Stripe → campaign attribution

Set `STRIPE_SECRET_KEY` (restricted, read-only on charges/refunds/customers) and
`STRIPE_WEBHOOK_SECRET`, then point a Stripe webhook at `/webhooks/stripe`. A charge
becomes an attributed sale within seconds, credited to the buyer's last attribution
touch or to `metadata.campaign` when the charge carries one.

A daily cron at 09:17 UTC walks the same charges again as a safety net. Everything is
idempotent on the Stripe charge id, so re-runs and overlapping backfills are harmless.

`stripe_sync_preview` dry-runs it, `sales_unattributed` is the worklist of what the
heuristic couldn't place, and `sync_runs_list` proves the nightly job is actually
running.

---

## 🔧 Make it yours

**Swapping the mail provider is one file.** Resend is the first adapter, not a
dependency. Nothing in `core/` names a vendor, anywhere. That's deliberate:
deliverability is the risk most likely to sink a self-hosted mailer, so the
escape hatch had to be cheap. If Resend's reputation goes sideways, or you'd
rather be on SES because you're already in AWS, the diff is one adapter.

The whole port is four members:

```ts
export interface EmailProvider {
  readonly name: string
  send(email: OutgoingEmail): Promise<SendResult>
  /** Providers rate-limit on API *requests*. This is the difference between a
      15,000-email broadcast taking 25 minutes and taking seconds. */
  sendBatch(emails: OutgoingEmail[]): Promise<SendResult[]>
  /** Verify + parse a provider webhook. Returns [] if it isn't ours to handle. */
  parseWebhook(request: Request, secret?: string): Promise<ProviderEvent[]>
}
```

Three steps to add **Amazon SES**, **Mailgun**, **Postmark**, **Cloudflare Email
Service**, or anything else with an HTTP API:

1. Write `src/providers/ses.ts` implementing the interface above. Copy
   `resend.ts`: it's the reference.
2. Add a branch to `providerFor()` in `src/core/sending.ts` (it's three lines).
3. Set `EMAIL_PROVIDER=ses` and push whatever key it needs with
   `wrangler secret put`.

That's it. Broadcasts, sequences, transactional sends, consent, suppression and
tracking all keep working untouched, because none of them know a provider exists.

> ### 🤖 Or just ask Claude Code to write it
>
> The port is small enough, and `resend.ts` is a close enough template, that this
> is genuinely a single prompt:
>
> > *Read `src/providers/types.ts` and `src/providers/resend.ts`, then write*
> > *`src/providers/ses.ts` implementing `EmailProvider` against the Amazon SES*
> > *v2 API. Wire it into `providerFor()` in `src/core/sending.ts` and add the*
> > *env vars to `src/types.ts`. Map SES bounce and complaint notifications onto*
> > *`ProviderEvent`.*
>
> Then check it with `bun run typecheck`, run it with `EMAIL_PROVIDER=console`
> first, and read the Outbox before you point it at a real key.

⚠️ **Don't skip `parseWebhook`.** It's what turns hard bounces and spam
complaints into `suppressions` rows. An adapter that only sends will happily
keep mailing dead addresses and people who reported you, and your sending
reputation degrades silently. That is the slow way to lose deliverability for your
whole domain. Soft bounces must *not* suppress; that's what `hardBounce` on
`ProviderEvent` is for.

### Other things worth changing

| Want to change | Look at |
|---|---|
| The look | `src/web/layout.tsx`: the whole design system is one file of CSS tokens |
| What an email looks like on the wire | `src/core/render-doc.ts`: the hand-written TipTap → email-HTML walker |
| What a published post looks like | `src/core/render-web.ts` for the body, `src/web/site.tsx` for the page and its stylesheet |
| Editor blocks | `src/client/extensions/` for the node, **and** a matching branch in `render-doc.ts`, or it renders as nothing in email |
| Who a segment can target | `SegmentRule` in `src/db/schema.ts`, resolved in `src/core/segments.ts` |
| What agents can do | `src/mcp/tools/*.ts`. They are thin wrappers, so add the rule to `core/` first |
| How a send is scored | `ANCHORS` and `WEIGHTS` in `src/core/signal.ts`. The anchors are what a good rate looks like *on your list* |
| What the analytics screens measure | `src/core/analytics.ts`. The pages are dumb and just draw what it returns |

📖 [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) has a full "where to add things"
table, plus the invariants you must not break while doing it.

---

## 🧪 Tests

```bash
bun run test        # the server-side suite. No server, no network, a few seconds
bun run test:ui     # the browser tests. Starts its own server on :8788
bun run typecheck   # Worker, browser bundle, scripts, tests: four passes
bun run test:all    # all of the above, in that order
```

**The suite is [`docs/SPEC.md`](SPEC.md) made executable.** Every test traces
back to a numbered requirement through a story in
[`docs/STORIES.md`](STORIES.md), and each spec file is one story:

```
Feature      one file, one user story
  Scenario   one situation; arranges all its data once, in beforeAll
    it()     exactly one assertion
```

Happy paths first and exhaustively, failure cases segregated into their own
blocks below them, and **every Feature drives a deployed entry point**
(`worker.fetch`, `worker.scheduled` or `worker.queue`) rather than an internal
function underneath it. Mocks define test reality; only the entry point defines
production reality.

### Almost nothing is mocked

`tests/support/d1.ts` is a working `D1Database` on top of `bun:sqlite` (foreign
keys enforced, `last_row_id` populated, bound values coerced the way the D1 wire
does it) and the tests apply the real `migrations/*.sql`. D1 *is* SQLite, so a
spec runs the production SQL, the production Drizzle codecs, the real routers and
the real renderer. The only fakes are at the platform edge: R2 in memory, no queue
binding (so `dispatch()` takes the inline fallback it already has for
`wrangler dev`), and `EMAIL_PROVIDER=console`.

> ⚠️ **Nothing in the suite can reach the wire.** The console provider is
> hard-coded in `createWorld()`; mail lands in `dev_outbox` and the spec reads it
> back. A production database holds real people, and exactly one thing
> stands between a test run and all of them.

The browser tests run a real `wrangler dev` on port 8788 with a database of its
own under `.wrangler/ui-test-state`, reset and reseeded per run, so they never
touch your ordinary dev data. They cover the three things a server-side test
structurally cannot reach: whether the preference page leads a reader to the
narrow choice (with JavaScript off, too), whether the TipTap composer actually
persists what it shows, and whether the sequence editor states the whole flow on
one screen.

📖 [`tests/README.md`](../tests/README.md): the conventions, the harness, and the
places where a spec deliberately records behaviour that diverges from SPEC.

---

[Back to the README](../README.md)
