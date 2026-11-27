# ✅ PLAN — Kōlea

> Owner: `/plan`. This file was filled in by the build on 2026-08-07 rather than by `/plan`,
> so it records what actually got built instead of a forecast. Re-run `/plan` to slice the
> remaining work properly.

## Built and verified locally

- [x] Project scaffold — Bun, Wrangler, Hono + JSX, Drizzle, D1
- [x] Schema + migration (13 tables), Postgres-portable per `sqlite-dev`
- [x] ⭐ Scoped consent: `sequence_optouts` / `subscribers.status` / `suppressions`
- [x] ⭐ Preference center — token-only, no JS, narrow action is the prominent one
- [x] ⭐ RFC 8058 one-click unsubscribe scoped to the sending series
- [x] Subscribers: add, search, detail, per-scope consent view, tags
- [x] CSV import — updates in place, never resurrects an unsubscribe
- [x] Broadcasts: draft, edit, segment by tag, send, stats
- [x] Sequences: steps, triggers (subscribe / tag_added / manual), enrollment, tick
- [x] Send pipeline — materialized `messages`, idempotency keys, consent re-checked at send
- [x] Cloudflare Queues fan-out with per-message ack/retry; inline fallback when unbound
- [x] Cron handler — sequence ticks + scheduled broadcast pages
- [x] `EmailProvider` port + `console` (local Outbox) and Resend adapters
- [x] Transactional `POST /api/send` — bearer auth, idempotency, suppression-aware, no footer
- [x] Open/click tracking + Resend webhook handling with signature verification
- [x] Outbox screen rendering real sent HTML in an iframe
- [x] Seed + reset for a playable local demo

## Verified by hand against a running server

- [x] Leaving one series keeps the subscriber `active`, unsuppressed, and on the newsletter
- [x] A broadcast sent afterwards still reaches them
- [x] Global unsubscribe suppresses and cancels all enrollments
- [x] Transactional: 401 unauthenticated, 400 malformed, 202 valid, replayed key returns the original
- [x] Transactional mail carries no unsubscribe footer; sequence mail carries a scoped one
- [x] Open pixel and click redirect record events; the redirect survives a tracking failure
- [x] D1 foreign keys are enforced; a stale sequence id is a no-op, not a 500

## Editor (2026-08-08)

- [x] TipTap v3 vanilla, bundled to a static asset, loaded only on compose screens
- [x] Block-style editing — MIT drag handle + node-range multi-block selection
- [x] Slash command menu (custom, over `@tiptap/suggestion`) — 16 block types
- [x] Bubble menu; becomes a URL + colour picker when a CTA button is selected
- [x] Custom `emailButton` node → nested-table CTA in email
- [x] Custom `mergeTag` node → personalization that can't be misspelled
- [x] Image upload to R2 on drop/paste/pick, with a MIME allowlist
- [x] Code blocks with syntax highlighting (15 curated languages)
- [x] Tables, task lists, toggles, YouTube, highlight, text align, typography
- [x] Hand-written TipTap-JSON → email-HTML renderer (inlined styles, table buttons)
- [x] Markdown → document conversion on load, so legacy bodies can't be erased
- [x] Per-step sequence editing + deletion
- [x] Delays in days (first step 0, later steps 1), clamped 0–365
- [x] Local `Fast-forward the clock` so day-scale sequences are testable
- [x] Browser smoke test, 33 checks (`bun run smoke`)
- [x] Cloudflare Access JWT verified properly — signature, `alg`, audience, issuer,
      `exp`/`nbf` against live JWKS; fails closed when unconfigured (`src/web/auth.ts`)

## Tests (2026-09-20)

- [x] `docs/STORIES.md` sliced from SPEC — 23 stories across 8 epics, Given/When/Then
- [x] Server-side suite, `tests/specs/` — 20 Features, one per story, `bun test`
- [x] A faithful `D1Database` over `bun:sqlite`, running the real `migrations/*.sql`,
      so specs exercise production SQL, foreign keys and Drizzle codecs
- [x] Every Feature drives a deployed entry point — `fetch`, `scheduled` or `queue`
- [x] Browser suite, `tests/ui/` — Playwright against its own `wrangler dev` + its own D1
- [x] `bun run typecheck` covers the tests too (fourth pass)
- [ ] Commerce, Stripe and revenue attribution have no specs yet — their own epic
- [ ] Non-functional targets (SPEC 9.1, 9.5) need a load harness, not a spec file

## The November feature set (2026-11-21)

Built and specced, **not yet run in production**. Everything below came in with
migration `0030_amusing_quasar.sql`, which only creates tables and adds columns and
indexes. Nothing here needs a new binding, queue or cron schedule. The behaviour is
covered by spec files in `tests/specs/`: 36 new ones, 71 in all. The requirements are
the ones appended to SPEC sections 1 to 9, and sections 10 to 16. The onboarding
script's Access changes have no spec.

### Mail and sending

- [x] Double opt-in per form: a throttled confirmation mail, a link that changes nothing
      until its button is pressed, tags and sequences only after the click
- [x] Mailgun adapter beside Resend (`EMAIL_PROVIDER=mailgun`) and its signed webhook
- [x] Sending domains screen: the DNS records, checks on the cron, one-click Cloudflare DNS
- [x] Custom tracking host (`TRACKING_HOST`), append-only
- [x] Machine opens flagged and kept out of reader counts and tag rules
- [x] A send window per sequence, in the install's time zone
- [x] Stored transactional templates: `POST /api/send` with `template` + `variables`
- [x] Undelivered screen and "send again", with "check before sending" for mail that
      may already have gone
- [x] ⭐ The send claim (`messages.claimed_at`): two consumers holding one row send it once
- [x] The stranded sweep: untouched queued rows after 10 minutes, touched ones after 2 hours
- [x] A broadcast's audience fixed when the send starts (`broadcasts.audience_upper_id`)
- [x] One D1 query budget shared by the minutely cron's jobs

### Audience

- [x] Importers for Kit, Ghost, Mailchimp and Drip: the list and past mail, one page per
      minutely tick, resumable. Imported people are never enrolled or mailed, past mail
      lands `sent` and unpublished, sequences land off
- [x] Typed custom fields, segment conditions on them, `{{key|fallback}}` merge tags
- [x] List clean-up: pick groups, download a backup, confirm, delete in pages

### Site, members and money

- [x] Reader sign-in on the site by emailed link, and `members` / `premium` posts
- [x] Premium as a Stripe subscription, granted only by the signed webhook
- [x] Offer pages that start a Stripe Checkout, with the converting post recorded
- [x] Testimonials: `{{testimonial_link}}`, a public form, a wall
- [x] Topics and the media library as screens of their own
- [x] Past sales imported from a CSV

### Writing help

- [x] Ghostwriter with a tuned voice, and sequence takes reviewed mail by mail
- [x] Reader council reviews of a draft
- [x] Launch Studio: seven steps to a campaign and a paused sequence
- [x] Settings → AI: which key pays (the install's, or your own OpenRouter, Anthropic or
      OpenAI key) and which model each helper uses

### API, agents and operating it

- [x] REST API at `/api/v1` with an OpenAPI document and `read` / `send` / `admin` keys
- [x] Signed outbound webhooks, retried on the cron, with a delivery log
- [x] MCP by URL with OAuth 2.1 and PKCE at `/mcp`, read-only by default, and a
      Connected apps screen
- [x] API keys and the two agent switches on System → Agents & keys, both off by default.
      `MCP_ALLOW_SEND` no longer turns sending on: `"false"` only forces it off
- [x] MCP server at 144 tools, 4 resources, 4 prompts
- [x] Logs page (and `log_search` / `log_types`), and an audit trail of console and key writes
- [x] Team roles `owner` / `admin` / `writer` on the Cloudflare Access identity
- [x] First-run checklist
- [x] `scripts/onboard.ts access` creates 13 Access Bypass apps instead of 8, adding
      `/mcp`, `/.well-known/*`, `/oauth/register`, `/oauth/token`, `/oauth/revoke`

### Left out of this feature set, on purpose or for later

- [ ] Importers do not bring drafts or scheduled mail, Ghost post tags as topics, or
      Mailchimp and Drip automations. Kit sequences arrive without their triggers
- [ ] No Stripe Billing Portal for Premium: a member cannot manage or cancel the
      subscription from the site
- [ ] No invitation email for team members. Inviting writes the role; the person still
      has to be let through the Access policy and told to come
- [ ] Mail rendered while `EMAIL_PROVIDER=console` cannot be released to the wire later
- [ ] No `field_*` MCP tools: custom field definitions are managed in the console only
- [ ] Launch Studio, importers and the team have no MCP tools. The two agent switches
      have none on purpose
- [ ] REST v1 leaves out CSV import, sequence step editing, campaigns, webhooks and
      suppressions
- [ ] None of it has been run against production traffic or a production-sized list

## Not done

- [ ] Image alt-text / link editing from the bubble menu
- [ ] Orphan-media sweep (uploads removed from a draft stay in R2)
- [ ] Scheduled-broadcast UI (the model, the cron path and MCP support it; the admin has no date picker)
