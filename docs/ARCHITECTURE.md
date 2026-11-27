# 🏗 ARCHITECTURE — Kōlea

> **Owner:** `/design`. **Audience: an LLM about to change this code**, Claude Code first.
>
> Read this before writing anything. It is a map plus a list of the things that
> look wrong and are not, and the things that look fine and will mail eight
> thousand people by accident.

---

## 🚦 Read this first

Five minutes of reading order, in priority:

| # | Read | Why |
|---|---|---|
| 1 | **[The invariants](#-the-invariants)** below | Break one of these and real people get real mail. Non-negotiable. |
| 2 | `CLAUDE.md` (repo root) | Operational rules and the send-safety policy. |
| 3 | **[Code map](#-code-map)** below | Where the thing you're changing lives. |
| 4 | [`SPEC.md`](SPEC.md) | Numbered behavioral requirements. **The reference for intended behavior.** When code and SPEC disagree, that's a bug report, not a licence to edit SPEC. |

**Source-of-truth precedence.** `src/db/schema.ts` is the truth about the
database — it carries dense comments explaining *why* each column is shaped the
way it is, and it is worth reading in full before any data change. This document
describes intent and structure; where they differ, the code is right and this doc
is stale. Fix the doc.

**Do not trust your priors about email software.** The consent model here is
deliberately unlike every ESP you were trained on. Assuming the usual shape is
the single most damaging mistake available in this codebase.

---

## ⛔ The invariants

Fifteen rules. Every one exists because violating it is silent, irreversible, and
lands in a stranger's inbox.

1. **Consent is scoped, never blanket.** Leaving one sequence takes a person off
   *that sequence*. It never touches the newsletter, other sequences, or
   transactional mail. See [Consent](#-consent--the-whole-point).
2. **A narrow consent action never escalates to a wider one.** Only an explicit
   "unsubscribe from everything", a hard bounce, or a spam complaint may write a
   `suppressions` row.
   One reason is not global: a list clean-up leaves `pruned` on the address of
   a deleted leaver. It blocks broadcasts and nothing else. See
   [Consent](#-consent--the-whole-point).
3. **`unsubscribed` only ever moves one way.** No import, sync, backfill, or
   merge may return somebody to `active` (SPEC 1.2). Only the person can, from
   the preference center.
4. **Suppression is checked immediately before the provider call**, never at
   enqueue time. A queue can deliver minutes later; consent can change in
   between.
5. **Bulk writes never go through `upsertSubscriber()`.** It fires
   `enrollOnSubscribe()`, so importing N people into a live `subscribe` sequence
   mails all N. Use direct SQL or pass
   `triggerSubscribeSequences: false`. The in-app importers write through
   `core/importers/writer.ts`, which calls neither it nor `addTags()`.
6. **Imported and backfilled content arrives inert.** Broadcasts land
   `status: 'sent'` with `sent_at` set; sequences land `is_active: 0`. The
   minutely tick only claims `sending` or `scheduled`-and-due, and every
   enrollment path gates on `isActive`. Activation is a separate deliberate act.
7. **Nothing observable may exist only in a log line.** Workers logs retain 3–7
   days. If someone could ask "what happened?" next quarter, it is a row in D1 —
   `mcp_calls`, `sync_runs`, `events`, `stripe_events`, `messages.suppressed_reason`,
   `tag_rules.applied_count`, `audit_entries`, `webhook_deliveries`, `import_runs`,
   `list_prunes`.
8. **Money is integer cents.** Never a float, anywhere, for any reason. A refund
   *flips* the existing `sales` row to `status: 'refunded'` — it never adds an
   offsetting negative row, so any revenue sum must filter on status.
9. **Sent history is immutable.** A broadcast copies its segment rule at create
   time; message bodies for broadcast/sequence mail live on the source row;
   a sale's campaign is frozen at ingest. Editing a segment, a template, or an
   attribution model must never rewrite what already went out.
10. **`EMAIL_PROVIDER=console` is the kill switch** and the correct default for
    anything experimental. It renders to the in-app Outbox instead of the wire.
11. **A row is claimed before it is sent.** `sendMessages` takes
    `messages.claimed_at` in one conditional UPDATE, and only the rows that
    update matched go to the provider. Anything that puts a row back to
    `queued` clears the claim in the same write. A row the provider accepted
    keeps its claim until it is written `sent`.
12. **An import never moves anybody toward more mail.** For somebody already
    on the list consent may only narrow: no import returns them to `active`, a
    local suppression wins, and an opt-out arrives no wider and no narrower
    than the other tool gave it. A new person arrives with the status the
    other tool recorded, and a state it cannot read imports nobody. Nobody is
    enrolled, tagged through `addTags()`, or mailed. Past mail lands `sent` and
    unpublished, sequences land `manual` and off.
13. **The agent switches have no MCP tool and no API endpoint.** "Agents may
    send mail" and "agents may make sensitive changes" are rows only the
    console screen writes. Both start off. `MCP_ALLOW_SEND="false"` can force
    sending off. No value of it turns sending on.
14. **Signing in and paying are not consent.** A member is the `subscribers`
    row. Nothing in the member, Premium or store code changes an existing
    subscriber's status or writes a suppression or an opt-out, and a buyer the
    list has never seen is created `pending`.
15. **Nothing a model writes becomes mail without a person.** The helpers
    return drafts and reviews. A take sits beside its sequence, reaches a step
    only by a click on a paused sequence, and carries a `[[ … ]]` placeholder
    that `setSequenceActive` refuses to go live with.

> 💡 **If you are unsure whether a change can send mail, assume it can, and ask.**
> An unsent mail costs nothing. An unwanted one costs a subscriber and a sender
> reputation that took years to build.

---

## 🗺 System shape

One Cloudflare Worker. Three entry points, one D1 database, one mail port.

```
                         ┌──────────────────────────────────────────┐
   Cloudflare Access ────┤  Kōlea Worker  (src/worker.tsx)          │
   (the team only)       │                                          │
   list.example.com ─────┤  fetch()      admin console (Hono + JSX) │
   your apps ────────────┤               POST /api/send  (bearer)   │
   your programs ────────┤               ALL  /api/v1/*  (bearer)   │
   your checkout ────────┤               POST /api/sales (bearer)   │
   your website's form ──┤               POST /f/:slug   (public)   │
   provider webhooks ────┤               POST /webhooks/:provider   │
   every email opened ───┤               GET  /t/open, /t/click     │
   every reader ─────────┤               GET  /p/:token  (prefs)    │
   agents (MCP, key) ────┤               ALL  /mcp/:secret          │
   agents (MCP, OAuth) ──┤               ALL  /mcp                  │
                         │                                          │
   a.example.com ────────┤  fetch()      the public site (web/site) │
   every reader ─────────┤               GET / · /:slug · /feed.xml │
   members and buyers ───┤               sign-in · Premium · /offers│
                         │                                          │
   links.example.com ────┤  fetch()      /t/open, /t/click only     │
                         │                                          │
   Cron  */1 * * * * ────┤  scheduled()  sequence tick + broadcasts │
                         │               then domain checks, hooks, │
                         │               one import page, takes     │
   Cron  17 9 * * * ─────┤               Stripe reconcile + catalog │
                         │                                          │
   Queue kolea-send ─────┤  queue()      claim → consent → send     │
   Queue …-dlq ──────────┤               mark failed (never sends)  │
                         └───────────┬──────────────────────────────┘
                                     │
              ┌──────────────┬───────┴────────┬───────────────┐
              ▼              ▼                ▼               ▼
             D1            R2 MEDIA     EmailProvider     Stripe REST
      (system of record)  (image bytes) (Resend, Mailgun) (+ Checkout)
```

The Worker also calls out, each through a port in `providers/` or a thin client
in `core/`: the operator's webhook endpoints, another tool's API during an
import, DNS-over-HTTPS and the Cloudflare DNS API for sending domains, and a
model provider for the writing help.

**Three hostnames, three apps, one Worker.** `fetch` splits on the request host
*before* any router runs. A `TRACKING_HOST` host gets the two tracking routes
and a 404 for everything else. `SITE_URL`'s host gets the public site app. Every
other host gets the admin app. They never share a router. The admin app puts
`requireOperator` on `*`, so a reader's request must never enter it — and a
future admin route must never be exposed by being registered above a line. See
[Key decisions](#-key-decisions).

**Everything durable is in D1.** R2 holds image bytes only; `media` rows are the
catalogue. Stripe and the Neon storefront are mirrored *into* D1 because segment
evaluation runs inside the Worker under a hard query budget and cannot reach
across the network at send time.

---

## 📂 Code map

`src/` — ~80k lines of TypeScript. Grouped by what you'd be changing.

### Composition root

| File | Responsibility |
|---|---|
| `worker.tsx` | Wires `fetch` / `scheduled` / `queue`. **Hostname dispatch happens first**: a `TRACKING_HOST` host goes to the tracking app, `SITE_URL`'s host to the public site app, everything else to the admin app. Within the admin app, route mount **order matters**: public routes, the REST API, both MCP doors and the OAuth endpoints mount *before* `requireOperator`. After it come `sameOriginWrites`, `auditWrites('operator')` and `requireRole`, in that order, then every console router. `scheduled` shares one `QueryBudget` across the minutely jobs. `consumeBatch` is the queue consumer. About 590 lines, no domain logic. |
| `types.ts` | The `Env` interface — every binding and var, each commented with what breaks without it. **Read this before touching config.** |

### `core/` — the domain. All rules live here, exactly once.

| File | Responsibility | Touch it when |
|---|---|---|
| ⭐ `consent.ts` | Scoped consent: the three levels, the preference-center actions, `canSend` checks. | Anything about who may receive what. **Read the whole file first.** |
| `sending.ts` | ⭐ Claim → consent re-check → render → provider call → record. `claimForSending`, `recordResults`, `releaseClaims`, `CLAIM_LEASE_MS`. `providerFor`, `providerReadiness` and `webhookReaderFor` are the only places an adapter is named. Preview sends. | The send path, or preview safety. Mind invariant 11. |
| `broadcasts.ts` | Materialize recipients (cursored, under `audience_upper_id`), enqueue, status machine. `closeIfFinished` closes a send and sweeps stranded rows. `CRON_PAGES`, `QUERIES_PER_PAGE`. | Broadcast lifecycle. |
| `sequences.ts` | Steps, enrollment, the minutely tick (sized by the `QueryBudget`), day-delay math, the send window hold, chaining to a next sequence, tag exits. `recordTickFailure`. | Drip logic, and how people leave it. |
| `send-window.ts` | Pure. A sequence's send hours in the install's time zone: `checkWindow`, `windowOpen`, `nextWindowOpen`. Daylight saving goes through `Intl`. | When a due step may go. |
| `send-preflight.ts` · `preflight.ts` | The two irreversible acts (send a broadcast, take a sequence live) and the preview each must follow. One implementation for MCP and the REST API. `preflight.ts` holds the token and its digest. | Preflight rules. |
| `undelivered.ts` | Failed mail that never went, listed, and the one way to send it again. "Check before sending" for mail that may have gone. | The Undelivered screen. |
| `query-budget.ts` | ⭐ `QueryBudget`: D1's per-invocation cap, shared out across one cron tick. | Adding work to the minutely cron. |
| `segments.ts` | `SegmentRule` → SQL. `resolveSegment` and `countSegment` share one WHERE builder so the shown count can't drift from the actual audience. Custom-field conditions compile here and fail closed. `audienceUpperBound` freezes a broadcast's audience. | Audience predicates. |
| `subscribers.ts` · `subscriber-reads.ts` | `upsertSubscriber` (⚠️ fires sequences), tags on create, `importCsv`. The reads every door shares never select `unsub_token`. | Person creation. Mind invariant 5. |
| `fields.ts` | Custom fields: definitions in `custom_fields`, values in `subscribers.attributes`. The only writer of values, and it casts each one against a definition first. | Typed facts about a person. |
| `cleanup.ts` | List clean-up: plan groups, back up exactly those people, delete in pages, leave the right marker behind. | Pruning the list. |
| `importers/` | `runs.ts` is the run lifecycle, one page per cron tick. ⭐ `writer.ts` is the one set of write rules for every tool. `html.ts` turns another tool's mail HTML into Markdown. | Bringing a list over. Mind invariant 12. |
| `tagging.ts` | Tag CRUD, merge, and the event→tag rule engine. Sits on the open/click hot path — must stay cheap and must never throw. | Auto-tagging. |
| `campaigns.ts` | Campaigns and the `attributions` touch ledger. | Attribution. |
| `sales.ts` · `sale-import.ts` | `recordSale`, refunds, revenue rollups. `sale-import.ts` books past sales from a CSV: no mail, no automation, no inferred attribution. | Money. |
| `events.ts` · `machine-opens.ts` | `recordEvent` — the single funnel for opens, clicks, and provider events. `recordOpen` asks `classifyOpen` (pure) whether a pixel hit was a machine. `markRefused` flips mail the provider took and then refused to `failed`. | Tracking. |
| `tracking-host.ts` | Where the pixel and tracked links point: `TRACKING_HOST`, or `PUBLIC_URL`. Hosts are append-only. | The tracking hostname. |
| `domains.ts` | Sending domains: the records a domain needs, the DNS check, the status transitions, one-click Cloudflare DNS. | Domain setup. |
| `transactional.ts` | ⭐ Every rule of `POST /api/send`: a whole mail or a stored template with `{{variables}}`, filled at accept time and copied onto the message. | Transactional mail. |
| `render.ts` | Body precedence (`body_json` wins, `body_md` fallback), merge tags (`{{key\|fallback}}` for custom fields), footer. | What a message says. |
| `render-doc.ts` | TipTap JSON → **email** HTML. Hand-written walker: inlines every style, emits nested tables for buttons. | Email-client rendering bugs. |
| `render-web.ts` | TipTap JSON → **web** HTML, for the public site. A sibling of `render-doc.ts`, not a mode of it: classes instead of inlined styles, no click tracking, no consent footer, merge tags resolve to neutral copy. | How a *post* reads. |
| `posts.ts` · `post-tags.ts` | Publishing: a post is a broadcast with `published_at`. Slugs, excerpts, featured images, search, the feed's rows, and what a gated post may derive from its body (`setPostAccess`). Never writes `status`, the segment, or the send cursor. `post-tags.ts` holds topics: `listTopics`, `updateTopic`. | The public site's data. |
| `members.ts` · `member-access.ts` | ⭐ Reader sign-in by emailed link, sessions, sign-out. `member-access.ts` is the one pure decision of who reads what: `public`, `members`, `premium`. | Signing in on the site. Mind invariant 14. |
| `premium.ts` · `premium-lifecycle.ts` · `premium-billing.ts` | The one paid level. Access comes only from the signed webhook. `premium-lifecycle.ts` is the status transition table, pure. `premium-billing.ts` is the payment port and its fake. | Paid membership. |
| `store.ts` | Offer pages that start a Stripe Checkout. The `store_checkouts` row is written before Stripe is asked, and the money goes through `recordSale`. | Selling from the site. |
| `testimonials.ts` | A reader's testimonial through their own link. The person owns `may_publish`, the operator owns `status`. | The testimonial wall. |
| `media.ts` | `storeMedia` / `deleteMedia` — the R2 upload path and its type allowlist, in one place because two screens upload. `listMedia` pages the library, `mediaUsage` finds what still shows an image. | Image uploads and the library. |
| `unsplash.ts` | Stock photo search for featured images. Hotlinks, never rehosts; pings the download endpoint only on an actual pick. | The photo picker. |
| `md-to-doc.ts` | Markdown → TipTap JSON, on load only. Never a bulk migration. | Legacy content. |
| `forms.ts` | Hosted `POST /f/:slug` signup endpoints. ⭐ Double opt-in: `submitPending`, the confirmation throttle, `confirmSignup`. Failed replies and their resend. | Signup. |
| `insights.ts` | Dashboard numbers. Each query is scope-annotated; the scoping matters more than any figure. | Dashboard. |
| `purchases.ts` · `purchase-stats-sql.ts` | **Read-only** commerce mirror from Neon. Nothing here writes a purchase. | Purchase segmentation. |
| `segment-ideas.ts` | Proposed segments derived from purchase history. | Store suggestions. |
| `stripe-webhook.ts` | ⭐ The live money path. Signature verify → `stripe_events` dedupe → sale. | Stripe realtime. |
| `stripe.ts` | The nightly *reconcile* — safety net, not primary path. | Stripe catch-up. |
| `stripe-catalog.ts` | Mirrors Stripe products/prices. ⚠️ **Not** `offers` (that's Neon's). | Catalog. |
| `stripe-client.ts` | The slice of Stripe's REST API we speak, over plain `fetch`. No SDK. Reads, plus creating Checkout sessions for the store and for Premium. | Stripe transport. |
| `api-keys.ts` · `ids.ts` | Key minting (hash-only storage), the `send` / `read` / `admin` scopes, the REST rate limit (`takeRateSlot`), token generation, email normalization. | Auth primitives. |
| `agents.ts` | ⭐ The two agent switches. `agentSendAllowed` and `agentSensitiveAllowed` are the only answers to "may an agent do this now?". | What an agent may do. Mind invariant 13. |
| `oauth.ts` | MCP by URL: client registration, the consent code with PKCE, access and refresh tokens, rotation, revocation. | Adding Kōlea to an agent by URL. |
| `team.ts` | ⭐ Who is on the team and in which role: `resolveMember`, `invite`, the last-owner rule. Identity stays with Cloudflare Access. | Roles. |
| `audit.ts` · `event-log.ts` | `audit.ts` records console and key writes into `audit_entries`. `event-log.ts` is the Logs page: a read model over the tables the facts already live in, not a table of its own. | Who did what, and what happened. |
| `webhooks.ts` | ⭐ Outbound webhooks. `emitWebhook` writes a row and never touches the network. `deliverDueWebhooks` POSTs from the cron, signed, with backoff. `checkWebhookUrl` is the URL policy. | Telling other systems. |
| `onboarding.ts` | The first-run checklist. Progress is derived from real state. Sends nothing, activates nothing. | The Get set up screen. |
| `health.ts` · `overview.ts` | "Is mail moving?" as a few indexed counts, and the whole mailer at a glance. Shared by MCP and the REST API. | Status reads. |
| `ai/` | The writing help. `settings.ts` decides which key pays and which model each helper uses (`resolveAi`). `keys.ts` encrypts stored keys. `catalogue.ts` is the helpers, models and list prices. `guard.ts` fences what goes to a model and cleans what comes back. `ghostwriter.ts` and `ghostwriter-voice.ts` write one mail in a tuned voice. `takes.ts` writes a sequence's mails beside it, on the cron. | Anything a model touches. Mind invariant 15. |
| `council.ts` | The reader council: three readers and an editor review a draft. Advisory, and no subscriber data reaches the model. | Draft reviews. |
| `launches/` | Launch Studio. `steps.ts` is the pure transition between its seven steps. `index.ts` writes the launch row, a campaign, a tag and a paused sequence. | The launch walk-through. |

### The edges

| Dir | Responsibility | Boundary |
|---|---|---|
| `web/` | Admin console **and** the public site. Hono + JSX, server-rendered, ~zero client JS. `layout.tsx` holds the whole design system; `prefs.tsx` is ⭐ the public preference center; ⭐ `site.tsx` is the public blog (its own Hono app + its own stylesheet, dispatched by hostname), with `site-members.ts` for sign-in and Premium; `auth.ts` verifies the Access JWT properly and finds the person on the team. ⭐ `roles.ts` is the one table of which route needs which role. `audit.ts` is the one middleware that writes the audit trail. `same-origin.ts` refuses cross-site writes. `admin-connect.tsx` holds the OAuth consent page. One `admin-*.tsx` file per screen. | Calls `core/`. **Never** a provider or raw D1 query. |
| `api/` | `/api/send`, `/api/sales`, `/f/:slug`, `/webhooks/:provider`, `/t/*`, media. `v1/` is the REST API: `kit.ts` holds the key, rate and scope checks and the two envelopes, `index.ts` the send gate and the OpenAPI document. `oauth.ts` is the public half of MCP by URL. | HTTP shape only. Delegates to `core/`. |
| `mcp/` | The whole mailer as **144 agent-callable tools**, 4 resources, 4 prompts, behind two doors. | Same boundary as `web/`: thin wrappers, no domain logic. |
| `providers/` | `EmailProvider` port + `console`, `resend` and `mailgun` adapters. Also the smaller ports: `importers/` (Kit, Ghost, Mailchimp, Drip), `ai/` (OpenRouter, Anthropic, OpenAI, a fake), `dns.ts`, `cloudflare-dns.ts`, `resend-domains.ts`, `webhooks.ts`. | Adapter. Only `core/` calls it. |
| `db/` | Drizzle schema + D1 client. | Only `core/` imports it. |
| `client/` | The only browser JS: the TipTap editor bundle and the chart runtime. Separate tsconfig — **workerd's `Response`/`Headers` shadow the DOM ones**, so the two must never share one. | Built by `bun run build:client` into `public/`. |

### Layering rule

```
web/  api/  mcp/          ← may import core/, may not import providers/ or db/ directly
        ↓
      core/               ← may import db/ and the provider PORT
        ↓
   db/   providers/       ← import nothing above them
```

If an MCP tool needs logic the admin UI already had, **pull it down into `core/`
first**. There must be exactly one implementation of every rule. The deliberate
exception is `mcp/sql.ts` — a SELECT-only, single-statement, 500-row-capped
query tool for analytics questions no fixed tool anticipates. It refuses any
statement that names a table or column holding credentials or tokens
(`SECRET_IDENTIFIERS`): a new table of that kind must be added there.

---

## 🗃 Data model

**82 tables.** Conventions: snake_case columns under camelCase TS
keys, plural tables, `id` surrogate key, NOT NULL FKs with explicit `onDelete`,
`text` + CHECK for enums, `integer` epoch-ms timestamps set by the app. This is
the `sqlite-dev` convention set, so the schema stays Postgres-portable — D1 *is*
SQLite.

✅ **D1 enforces foreign keys** (verified empirically 2026-08-07). Every
`ON DELETE` is real and `core/` does not reimplement cascade cleanup. Corollary:
an FK value taken from user input must be validated before insert or it surfaces
as a 500 — see `leaveSequence`, reachable from the public preference center.

### The tables, by cluster

**Audience**: `subscribers`, `tags`, `subscriber_tags`, `segments`, `tag_rules`,
`custom_fields`, `activities`, `list_prunes`, `import_runs`

**Mail**: `broadcasts`, `sequences`, `sequence_steps`, `sequence_enrollments`,
⭐ `sequence_optouts`, `sequence_exits`, `sequence_templates`, `messages`, `events`,
`suppressions`, `transactional_templates`, `purchase_templates`, `sending_domains`,
`dev_outbox`, `media`

**Growth & money**: `campaigns`, ⭐ `attributions`, `forms`, `form_tags`,
`form_views`, ⭐ `form_confirmations`, `download_grants`, `sales`, `sale_items`,
`conversion_kinds`, `conversions`, `goals`, `launches`, `testimonials`

**Store**: `store_offers`, ⭐ `store_checkouts`

**Members & Premium**: `member_sign_in_links`, `member_sessions`,
`premium_settings`, ⭐ `premium_checkouts`, `member_subscriptions`

**Public site**: `post_tags`, `broadcast_post_tags`, `themes`, `theme_files`,
`site_settings`, `page_views`

**Commerce mirror (read-only, from Neon)**: `offers`, `offer_products`,
`purchases`, `purchase_stats`

**Stripe mirror**: `stripe_events`, `stripe_products`, `stripe_prices`

**Writing help**: `ai_calls`, `ai_settings`, `ai_keys`, `ghostwriter_voices`,
`sequence_takes`, `sequence_take_mails`, `council_audience`, `council_reviews`

**Agents & API**: `api_keys`, `api_rate_windows`, `mcp_calls`, `preflight_tokens`,
⭐ `agent_settings`, `oauth_clients`, `oauth_grants`, `oauth_codes`, `oauth_tokens`,
`webhook_endpoints`, ⭐ `webhook_deliveries`

**Operations**: `sync_runs`, ⭐ `audit_entries`, ⭐ `team_members`,
`onboarding`, `onboarding_steps`

Migration `0030_amusing_quasar.sql` added 34 of these tables and 14 columns. It
only creates tables and adds columns and indexes.

### The non-obvious ones

These are the shapes that get "fixed" by someone who didn't read the comment.

| Table / column | Looks like | Actually |
|---|---|---|
| `subscribers.status = 'unsubscribed'` | Global opt-out | **Broadcast-scoped only.** Sequence sends deliberately ignore it. |
| `suppressions.email` | Should be a `subscriber_id` FK | Keyed by **address**. Bounced and transactional addresses often have no subscriber row; a status flag would silently miss them. |
| `broadcasts.segment` (json) | Duplicates `segment_id` | The *truth* at send time. `segment_id` is provenance only. Editing a saved segment must not rewrite who a sent broadcast reached. |
| `broadcasts.published_at` | Part of the send lifecycle | **Orthogonal to it.** Null means "mail and nothing else". A sent broadcast can go up months later, come down, and go back up, and none of that touches `status`. Nothing is ever published in bulk. |
| `broadcasts.slug` nullable + UNIQUE | Nulls would collide | SQLite treats NULLs as *distinct* in a unique index, so every unpublished broadcast keeps a null slug. Unpublishing keeps the slug so re-publishing restores the same URL. |
| `broadcasts.search_text` | Duplicates the body | The body flattened to prose, written on publish. Site search reads this and never `body_json`: `LIKE` over a JSON blob matches attribute names and hex colours as happily as prose. |
| `broadcasts.cursor_subscriber_id` | Odd bookkeeping | D1's 1,000-query cap means a large broadcast materializes across several cron ticks, resuming here. |
| `sequence_exits` vs `sequence_optouts` | Two ways to say "left" | **Opposite meanings.** An opt-out is the person's standing choice and only they can undo it. An exit is operator automation ("got tag X"): it cancels the enrollment, logs `exit_tag`, and writes no consent record. Never implement one with the other. |
| `sequences.next_sequence_id` | FK with `ON DELETE SET NULL` | The live column is **NO ACTION**. It arrived by `ALTER TABLE`, and SQLite cannot attach a delete action that way. `deleteSequence` clears the pointers itself. Read once, when the last step is sent — never swept. |
| `messages.body_md` nullable | Inconsistent | Transactional only. Broadcast/sequence bodies live on the source row so editing a template can't rewrite history. |
| `attributions.source_id` NOT NULL default 0 | Should be nullable | SQLite (and Postgres) treat NULLs as *distinct* in a unique index — nullable would break dedupe of `manual` touches. |
| `purchases` vs `sales` | Same thing | **Never sum them together.** `sales` = revenue attributed to mail this system sent. `purchases` = the storefront's whole history with no attribution. Buyers and subscribers are different sets of people. |
| `purchases.email` (not subscriber_id) | Denormalized | Forcing a subscriber row would fabricate ~8k people who never opted in — at `active`, they'd receive the next broadcast. |
| `offers` vs `stripe_products` | Redundant catalogs | Two catalogs, two owners (Neon storefront vs Stripe). They are *allowed* to disagree. Reconciling is a human question, not a UNIQUE index. |
| `purchase_stats` | Cache that could drift | Rebuilt **wholesale** every sync, never incremented. A counter that drifts is worse than no counter. |
| `stripe_events.id` = Stripe's `evt_…` | Weird PK | The natural key *is* the idempotency guard. Stripe retries for three days. |
| `stripe_events.status = 'ignored'` | A failure | First-class outcome. We subscribe to more types than we act on, and a silently discarded event must be distinguishable from a lost one. |
| `preflight_tokens` in D1 | Should be in memory | The Worker is stateless. The preview and the send are two unrelated HTTP requests. |
| `messages.claimed_at` | A timestamp nobody reads | ⭐ The send claim. Set in one conditional UPDATE before the provider call, cleared with every recorded result and by a batch that throws. Kept only on mail the provider took whose row is not yet `sent`. Older than `CLAIM_LEASE_MS` (10 minutes) it is free again. |
| `broadcasts.audience_upper_id` | A cached count | The audience, frozen when the send starts: the highest subscriber id the segment matched. `subscribers.id` is AUTOINCREMENT, so nobody created later can land at or below it. The rule is still evaluated live on each page under the bound. Null means not yet frozen, 0 an empty audience. |
| `broadcasts.access_level` | A publishing status | Who may read the post on the web: `public`, `members`, `premium`. It also changes what publishing derives. A gated body never feeds an excerpt, a featured image or `search_text`. |
| `broadcasts.imported_source_id` · `sequences.imported_source_id` | Provenance only | With `imported_from`, the unique key that stops a second import run copying the same mail twice. NULLs are distinct, so rows written here are untouched. |
| `events.machine` | Belongs in `meta` | A column because every reader count filters on it. Only ever true for `open`. The row is still written, so the share of opens that are machines can be shown. |
| `forms.double_opt_in` default `false` | New forms are single opt-in | The column default keeps existing forms as they were. `createForm` writes `true` unless told otherwise, so a new form asks for confirmation. |
| `form_confirmations` | Could be an HMAC | A row, so it can expire and records when somebody asked and when they confirmed. How many mails it caused is counted from `messages` (`kind = 'confirmation'`), not stored here. |
| `messages.kind = 'confirmation'` | Same as `transactional` | No footer and no tracking, like transactional, but blocked by any off-everything suppression. A stranger can cause this mail by typing an address. |
| `messages.template_slug` | Should be an FK | A slug on purpose. Deleting a template must leave the record of which one produced the mail. The filled body is already on the message. |
| `transactional_templates.slug` | Should follow a rename | Set once. Another application has it hard-coded. |
| `custom_fields` | Holds the values | Definitions only. Values stay in `subscribers.attributes`, keyed by `key`. A values table would cost a join per condition in every segment count. `key` never changes after creation. |
| `suppressions.reason = 'pruned'` | A global suppression | ⭐ Broadcast-scoped. The marker a clean-up leaves for somebody it deleted after they left the newsletter. It does not block sequences, transactional mail or a confirmation, and the person signing up again clears it. |
| `list_prunes.subscriber_ids` | Should be addresses | Ids, so the snapshot does not outlive the people as a list of addresses. The delete re-checks every id against the group rules as it goes. |
| `import_runs.credentials` | A stored secret | The other tool's API key, set to NULL the moment the run reaches any terminal status. Never selected by a screen (`importRunColumns`). |
| `sequences.send_window_start` / `_end` | Two independent settings | Both set or both null, never equal. Minutes after local midnight in `site_settings.time_zone`, which is one zone for the install. `core/send-window.ts` checks every write. |
| `agent_settings` | Config that belongs in env | One row (`id = 1`). No row reads as both switches off. No MCP tool or API endpoint writes it. |
| `api_keys.scope` | Three levels of one ladder | `admin` satisfies everything. `send` and `read` satisfy only themselves: neither grows into the other. |
| `oauth_grants` | Deletable on disconnect | Revoked, never deleted. `mcp_calls.oauth_grant_id` points here. `access` defaults to `read`. |
| `mcp_calls.api_key_id` / `oauth_grant_id` | Both should be set | A call carries one or the other. They are the two doors into the same tools. |
| `webhook_endpoints.secret` | Should be hashed like a key | Stored readable, because it must sign every delivery. Shown once. Screens and tools show `secret_prefix` only. |
| `webhook_deliveries` | A log beside a queue | The row is the queue and the log. `payload` is frozen at emit time. `next_attempt_at` is also the claim. |
| `team_members` | Needs a `status` column | State is read from the stamps (`invited_at`, `joined_at`, `removed_at`) so it cannot disagree with them. No passwords, codes or sessions live here. Removed rows are kept. |
| `audit_entries` vs `mcp_calls` | One should hold both | Two tables, three kinds of actor. Console and key writes go to `audit_entries`, agent calls to `mcp_calls`. The Logs page reads both, so nothing is written twice. |
| `store_offers` vs `stripe_products` | A `for_sale` flag would do | The catalog is a mirror the sync overwrites. "On sale here" is the operator's fact, so it has its own table. |
| `store_checkouts` · `premium_checkouts` | Written after Stripe answers | ⭐ Written **before** Stripe is asked. The row's `token` rides in the session metadata, and the webhook trusts the row only when the session id matches too. |
| `member_subscriptions` | One row per member | One row per subscription. `canceled` is final and a returning member gets a new row. A partial unique index allows at most one non-canceled row per subscriber. |
| `member_sign_in_links.token_hash` | The token | A SHA-256. The token is never stored, not here and not on the `messages` row. It rides in memory for the one send (`SendOptions.extras`). |
| `onboarding_steps` | Missing a `done` outcome | Progress is derived from real state. The table holds only "later" and the site's explicit no. |
| `ai_keys.ciphertext` | A stored API key | AES-GCM under a key derived from `AI_KEY_ENCRYPTION_SECRET`, with the provider name as associated data. Without the secret nothing is stored. |
| `sync_runs` kind `sequence_tick` | A row a minute | Only a **failed** minutely sequence tick writes one. |

---

## ⭐ Consent — the whole point

Kōlea exists because Kit (and every other ESP) treats unsubscribe as one switch.
Someone finishes your onboarding series, clicks "unsubscribe" to stop *that*, and
quietly leaves your newsletter forever.

**Three independent scopes. A narrow choice never escalates to a wide one.**

| Scope | Stored as | Stops | Does **not** stop |
|---|---|---|---|
| **Sequence** | `sequence_optouts` row | That one series | Broadcasts, other sequences, transactional |
| **Broadcast** | `subscribers.status = 'unsubscribed'` | The newsletter | Sequences, transactional |
| **Global** | `suppressions` row (by address) | Everything marketing | Transactional, unless the reason is `hard_bounce` or `complaint` |

**The check each send performs:**

- **Broadcast** → global suppression → `status = 'active'`
- **Sequence** → global suppression → sequence opt-out → not `bounced`/`complained`.
  It **does not** check `status = 'unsubscribed'`.
- **Transactional** → global suppression *only if* `hard_bounce` or `complaint`.
  A receipt isn't marketing, and an unsubscribed customer still needs their download.
- **Confirmation** (double opt-in) → any off-everything suppression → not
  `bounced`/`complained`. It ignores `unsubscribed`, like transactional mail,
  but it is stricter on suppression: it is the one mail a stranger can cause.

**`pruned` is not a fourth scope.** A list clean-up that deletes somebody who
had left the newsletter leaves a `suppressions` row with reason `pruned` on
their address. It carries their broadcast-scoped choice past the deletion and
nothing wider: it blocks broadcasts and makes a later import bring them back
`unsubscribed`. A sequence they join, a receipt and a confirmation still reach
them. Signing up again themselves clears it (`clearPrunedMarker`).

**Not consent.** Signing in on the site, paying for Premium, buying from the
store and a provider-side unsubscribe write no suppression. The last one is
applied as a newsletter unsubscribe only (`applyProviderUnsubscribe`).

**Standing preferences.** Leaving a sequence is permanent from the operator's
side: `sequence_enroll` refuses anyone who opted out and no operator action
overrides it. Only the subscriber can rejoin, from the preference center.

**The preference center** (`/p/:token`, `web/prefs.tsx`) is keyed by
`subscribers.unsub_token` — a stable, unguessable, per-subscriber column rather
than an HMAC. It survives content changes, is revocable by rotating one row,
needs no key management in the Worker, and the page is idempotent, so replay
isn't a threat worth cryptography. `?scope=sequence:<id>` or `?scope=broadcast`
names where the reader came from, and the page pre-selects the **narrowest**
action matching their intent. "Unsubscribe from everything" is a distinct,
deliberate choice.

---

## 🔄 Lifecycles

### A broadcast

1. Operator composes (TipTap → `body_json`), picks a segment, schedules.
   → `broadcasts` row, `status='scheduled'`. **The segment rule is copied inline.**
2. Minutely cron. `scheduled()` takes **one** due broadcast (oldest first),
   resolves the segment page by page, writes one `messages` row per recipient
   (`status='queued'`), enqueues in `sendBatch()` chunks of 100, advances
   `cursor_subscriber_id`.
   > One broadcast per tick, several pages deep. Five-at-a-time × one page each
   > bought 400 recipients a minute; spending the D1 budget on the oldest live
   > send clears ~6,000 on the cron (`CRON_PAGES` = 3, beside the sequence
   > tick) and ~8,000 from the console's Send. One operator, so they queue
   > behind each other anyway.

   ⭐ **The audience is fixed on the first page.** `dispatchBroadcastPage` writes
   `audience_upper_id`, the highest subscriber id the segment matches, and every
   later page stops at it. Somebody who joins mid-send is never reached. The
   rule is still evaluated on each page under the bound, so a person who already
   existed and is tagged into the segment mid-send is reached, and anybody who
   left is not.
3. Queue consumer (`consumeBatch` → `sendMessages`) takes a batch (≤100).
   ⭐ First it **claims**: one conditional UPDATE sets `claimed_at` on the rows
   that are still `queued` and carry no live claim, and only the rows that
   update returned go on. A row another consumer holds comes back as a
   retryable failure, so its queue message waits and tries again. Then per
   message: **re-check suppression**, render, call the provider, record
   `provider_message_id`, set `status='sent'`.
   Per-message `ack()`/`retry()` — one bad address never re-sends the other 99.
   Every retry waits (`core/backoff.ts`): 15s doubling to five minutes with
   jitter, never sooner than the provider's `retry-after`. A batch that throws
   is retried the same way, with the error written on its rows.
   The provider's results are written in **one** `db.batch` round trip, and
   that same write clears each row's claim: a `sent` row is finished, and a
   retryable failure goes back to `queued` free for the queue's retry. A batch
   that throws anywhere releases the claims it took at once (`releaseClaims`,
   and `recordAttemptError` in the consumer), so the retry 15 seconds later can
   claim them. If the database is what failed, the claim simply runs out after
   `CLAIM_LEASE_MS` (10 minutes).
   If the result write fails after the provider accepted, `sendMessages` throws
   `UnrecordedSendError` and the consumer puts the acceptance back on the queue
   as record-only jobs (`SendJob.accepted`) instead of retrying the send. Those
   rows **keep** their claim until the record-only job writes them `sent`, so a
   send job redelivered in between is told to wait and sends nobody a second
   copy. A record-only job never sends, on either queue. The
   Resend adapter also sends an `Idempotency-Key` (a digest of the message ids
   and the request body), which covers a redelivery of the same batch but not
   the same messages regrouped.
4. Provider webhooks POST delivery/bounce/complaint → `events` rows; hard bounces
   and complaints write `suppressions`.
5. Open pixel and click redirect write `events` and 302 onward. `recordEvent`
   also runs tag rules, which can start a `tag_added` sequence. That chain is
   intentional.
6. Exhausted retries land in `kolea-dlq`, whose handler **has no send path** —
   it marks the message `failed` so a give-up is a row, not a vanished message.
   The row keeps the last attempt's error after the give-up, so it says why.
   Failed mail that the provider never accepted is listed on the Undelivered
   screen and can be sent again (`core/undelivered.ts`).
7. `closeIfFinished` sets the broadcast `sent` once the walk is over and no row
   is still `queued`. It runs in the pass that reaches the last recipient, and
   again on each later tick while mail is still in the queue.
   ⭐ **The stranded sweep.** A queued row can be left with nothing coming for
   it: a page that died between inserting its rows and `dispatch`, or a retry
   that was lost. Left alone it holds the broadcast in `sending`, and every
   later broadcast behind it. So `closeIfFinished` hands such rows to the queue
   again, 500 a pass:

   | The row | Handed over after | Why that long |
   |---|---|---|
   | Never touched: no error, no claim, no provider id | 10 minutes (`STRANDED_AFTER_MS`, the claim lease) | Nobody can still be working on it. |
   | Touched: it carries an error or a claim | 2 hours (`ABANDONED_AFTER_MS`) | A touched row has a job somewhere on the queue. Two hours is longer than both queues' retry schedules back to back. |
   | Has a `provider_message_id` | Never | The provider took it. |

   Handing a row over twice is harmless: the claim lets one consumer send it.

> **Why materialize up front?** Writing all 25k `messages` rows before sending
> makes a broadcast resumable after a crash, idempotent across queue retries, and
> auditable afterward. Resolving recipients lazily at send time is cheaper and
> turns any mid-broadcast failure into an unrecoverable mess.

### A sequence

Trigger (`subscribe` / `tag_added` / `manual`) → `sequence_enrollments` row with
`next_step_id` and `next_run_at`. The minutely `tickSequences` claims due
enrollments, checks consent, creates a message, and advances to the next step.
Delays are in **whole days** (clamped to a year); step 1 defaults to 0 (arrives
on join), later steps to 1. Every enrollment path gates on `sequences.is_active`.

**The send window.** A sequence may keep its mail to set hours
(`send_window_start` / `_end`), read in the install's one time zone
(`site_settings.time_zone`, UTC when unset). A step that comes due outside the
window is neither skipped nor sent early: the tick moves the enrollment's
`next_run_at` to the window's next opening, in one UPDATE per sequence, and the
tick that runs then sends it. The tick reads the clock from the cron's
`scheduledTime`, so a tick that starts late still judges the minute it was
meant for.

**Tick size.** One tick takes at most 120 due enrollments (`TICK_LIMIT`), at
about 7 D1 queries each. On the cron it takes fewer when a broadcast shares the
minute. The rest wait a minute.

**How an enrollment ends.** All of it lives in `core/sequences.ts` and
`core/consent.ts`, and every `cancelled` writes a `sequence_cancelled` activity
row with a `reason`, because the status column alone cannot tell a buyer from a bounce.

| Ending | Trigger | Status | Opt-out row? | Then |
|---|---|---|---|---|
| Finished | Tick sends the last step | `completed` | No | Enrolled in `next_sequence_id`, if set and active |
| Exit tag | `addTags` → `exitOnTag` matches a `sequence_exits` row | `cancelled` (`exit_tag`) | **No** | Enrolled in the exit's `then_sequence_id`, if set and active |
| Purchase | A sale recorded with `end_sequence` | `cancelled` (`purchase`) | **No** | Nothing |
| Opt-out | Footer link, preference center, `sequence_remove_person` | `cancelled` | **Yes** | Nothing |
| Global unsubscribe | Preference center | `cancelled`, every sequence | Suppression instead | Nothing |
| Bounce / complaint | Consent re-check at send time | `cancelled` (`suppressed`, `status:…`) | No | Nothing |
| Editing accident | Step or subscriber deleted mid-enrollment | `completed` (`no_next_step`, `step_or_person_gone`) | No | **Does not chain** |

`addTags` runs `exitOnTag` **before** `enrollOnTag`, so one tag can end the pitch
and start onboarding in that order. `enroll()` and the batched `enrollMany()`
apply identical refusals: target inactive, no steps, opted out, already enrolled
in any status, or holding one of the target's exit tags.

Chaining runs **once per tick, after the loop**, in a fixed number of queries per
target sequence. A single-step series can finish 120 people in one tick, and
`enroll()` per person would exhaust the D1 budget.

### Transactional

`POST /api/send` with a `send`- or `admin`-scoped bearer key. Creates the
subscriber quietly if absent (`pending`, `source: 'transactional'`,
`triggerSubscribeSequences: false`) so the send is attributable but the person is
never marketed to. `idempotency_key` replays the original result instead of
sending twice.

A request carries a whole mail (`subject` + `body`) or names a stored template
(`template: "<slug>"` + `variables`), never both. Variables are filled when the
request is accepted, as text, into a copy of the template's body. That copy and
the slug go on the `messages` row, so editing or deleting the template changes
nothing already accepted. A missing variable is a 422 that names every one, and
nothing is recorded or sent. Every rule is in `core/transactional.ts`.

### A signup that asks for confirmation

`POST /f/:slug` on a form with `double_opt_in`: `submitPending` creates a new
person `pending` and leaves an existing one exactly as they are. Nothing that
can start mail runs: no tags, no sequence, no reply, no campaign touch. One
`messages` row of kind `confirmation` goes down the ordinary send path, at most
one per address per form in 10 minutes and three per address in 24 hours.
`GET /f/:slug/confirm/:token` shows a page and changes nothing, because mail
scanners fetch every link. Only the button's POST runs `confirmSignup`:
`pending` becomes `active`, the subscribe sequences fire, then the form's tags,
sequence and reply. Somebody `unsubscribed` who confirms gets the tags, the
sequence and the file, and stays off the newsletter. The link lasts seven days.

### An import from another tool

1. Operator picks Kit, Ghost, Mailchimp or Drip on Imports and pastes a key.
   `startImport` checks what was typed, proves the key with one request, and
   writes an `import_runs` row. One run at a time.
2. Minutely cron. `advanceImports` takes a lease on the run, asks the adapter in
   `providers/importers/` for **one page** at `(phase, cursor)`, hands it to
   `core/importers/writer.ts`, and writes the next `(phase, cursor)` and the
   counts back. Nothing is held in memory, so a run survives a deploy. A minute
   with a broadcast to push reads no import page.
3. The writer inserts rows directly, never through `upsertSubscriber()` or
   `addTags()` (invariants 5 and 12). Three failed pages in a row fail the run.
   A wrong key fails it at once.
4. On any terminal status the stored key is set to NULL.

### An outbound webhook

`emitWebhook` is called from inside the consent functions, bounce handling,
`recordSale` and `publishPost`. It writes one `webhook_deliveries` row per
subscribed endpoint and never touches the network or throws. The minutely cron
(`deliverDueWebhooks`) claims due rows and POSTs them with a
`Kolea-Signature: t=…,v1=…` header. A failed try backs off (30 s, 2 min, 8 min,
capped at 6 hours) for up to 8 attempts, then the row is `failed` and keeps a
Redeliver button. 15 failed deliveries in a row switch the endpoint off with the
reason written on it. A bulk import emits nothing. Leaving one sequence is not
an `unsubscribed` event.

### A member, and Premium

A reader asks for a sign-in link on the site. Only an address that is already a
subscriber gets one, and the page answers the same either way. The link is
transactional mail, lasts 20 minutes and is single use. It opens a page whose
button signs in, so a scanner spends nothing. The session is a cookie holding
a token signed with `MEMBER_SESSION_SECRET`, and `member_sessions` holds only
its hash. `member-access.ts` then decides `full` or `teaser` for each post.

Premium is a Stripe subscription. `startPremiumCheckout` writes a
`premium_checkouts` row, then asks Stripe. Access comes **only** from the signature-verified
`checkout.session.completed`, matched to the row by token and session id. The
return page grants nothing. Later subscription events move the row through the
table in `premium-lifecycle.ts`, and an event older than the newest one applied
changes nothing.

### Money

**Live path:** `POST /webhooks/stripe` → verify signature (fails closed with 503
if `STRIPE_WEBHOOK_SECRET` is unset) → `stripe_events` insert dedupes the
retry → `recordSale` → `sale_items`.
**The store:** `POST /offers/:slug/buy` on the site names an offer slug, never
a price. `startCheckout` writes a `store_checkouts` row with the converting
post, then opens a payment-mode Checkout. The same `checkout.session.completed`
path books the sale and `completeStoreCheckout` marks the row. No mail is sent.
Each paid Premium invoice is a `sales` row by the same path.
**History:** `core/sale-import.ts` books past sales from a CSV, 100 lines an
upload, idempotent, with no mail, no automation and no inferred attribution.
**Safety net:** the 09:17 UTC cron walks the same charges again and catches what
the webhook missed, then syncs the catalog. Both are independently
try/caught — a catalog outage must not stop the reconcile that books money — and
both record a `sync_runs` row so a silent no-op is distinguishable from a silent
failure.

### The minutely tick

One Worker invocation, one D1 query budget (`core/query-budget.ts`). D1 counts
every statement of every job against the same 1,000, so the jobs share
`CRON_QUERY_BUDGET` (900, with 100 held back) in priority order. Each job
resumes next minute, so doing less is always safe and a dead tick is not.

| # | Job | What it takes |
|---|---|---|
| 1 | A due broadcast | Looked up first. If there is one it **reserves** 3 pages (`CRON_PAGES` × `QUERIES_PER_PAGE` = 690). |
| 2 | `tickSequences` | What fits of the rest: up to 120 enrollments on a quiet minute, about 27 beside a broadcast. Caught on its own. A throw becomes a `sync_runs` row (`recordTickFailure`) and the jobs below still run. |
| 3 | `sendBroadcastNow` | The pages reserved in 1. |
| 4 | `checkDueDomains` | One overdue sending-domain check. A few DNS lookups, never throws. |
| 5 | `deliverDueWebhooks` | What the budget has left, up to 20 deliveries. Often nothing in a send minute. |
| 6 | `advanceImports` | One page of a running import, only when no broadcast is due and at least 300 queries remain. |
| 7 | `advanceTakes` | A few model calls for the oldest Ghostwriter take, only when no broadcast is due. |

Mail outranks everything after it. No feature in this list needs a binding, a
queue or a cron schedule of its own.

---

## 🤖 The MCP surface

**144 tools**, 4 resources, 4 prompts, behind two doors. Both are mounted
*ahead of* the Cloudflare Access gate in `worker.tsx`, because an agent has no
browser session on the console. Each authenticates itself instead, and both
reach the same tools with the same per-tool guards.

| Door | Credential | Reaches |
|---|---|---|
| `ALL /mcp/<MCP_PATH_SECRET>` | Path secret, then an `admin`-scoped bearer key | Every tool. Never read-only. |
| `ALL /mcp` | An OAuth 2.1 access token (`core/oauth.ts`) | Read-only unless the operator ticked "Allow changes" when approving. |

**The key door, three gates, cheapest first:**

1. **Path secret** — constant-time compare (`safeEqual`). A miss returns **404,
   not 403**: a URL nobody guessed should look like nothing is there. Unset
   `MCP_PATH_SECRET` means the endpoint doesn't exist.
2. **Bearer key** — `api_keys.scope = 'admin'`. Transactional `send` keys and
   `read` keys cannot reach MCP, and `send` is the default scope for exactly
   that reason.
3. **Per-tool guards** — the two agent switches, preflight tokens, `confirm_*`
   echo arguments on tools that destroy history.

**The URL door.** The operator pastes `https://<admin host>/mcp` into an MCP
client. A 401 names the protected resource metadata, the client registers
itself (RFC 7591, a public client with no secret), and the operator approves it
on `/oauth/authorize`, which sits **behind** Access: that approval is the
authentication. The code is single use, lives two minutes and is bound to a
PKCE S256 challenge. Access tokens live an hour, refresh tokens thirty days
and rotate. A replayed code or refresh token revokes the whole grant. Grants
are listed and revoked on Connected apps. A read-only grant is enforced in one
place: `defineTool` refuses every tool not annotated `readOnlyHint: true`.

**⭐ The two switches** (`core/agents.ts`, System → Agents & keys). Both are
rows in `agent_settings`, both start off, and neither has an MCP tool.

| Switch | Off, these refuse |
|---|---|
| Agents may send mail | `broadcast_send`, `broadcast_send_test`, `broadcast_schedule`, `broadcast_resume`, `sequence_activate`, `sequence_tick`, `purchase_mail_send`, `form_resend_replies`, `undelivered_send_again`. The preflight tools still answer, with a warning. |
| Agents may make sensitive changes | `subscriber_delete`, `subscriber_import_csv`, `suppression_remove`, `sequence_rejoin_person`, `apikey_create`, `webhook_create`, `webhook_update`, `webhook_delete`. |

`MCP_ALLOW_SEND="false"` forces sending off whatever the row says. Any other
value, or none, defers to the row: the var can take sending away and can never
turn it on. The same two checks guard the REST API, because it takes the same
admin keys: `POST /api/v1/broadcasts/:id/send`, `/schedule`, `/resume` and
`/sequences/:id/activate` ask the send switch, and erasing a subscriber asks
the sensitive one.

**Every call writes an `mcp_calls` row, including refusals**, with the key or
the OAuth grant that made it.

**⭐ Preflight is the thing between a hallucinated tool call and eight thousand
inboxes.** `broadcast_send` refuses without a token from `broadcast_preflight`;
`sequence_activate` refuses without one from `sequence_preflight`. The token is
single-use, expires in 10 minutes, and carries a `digest` of the previewed
subject + body + audience — so any edit invalidates it. A `confirm: true` flag
was rejected: an agent satisfies it in the same breath as the mistake.
`broadcast_resume` needs a token from `broadcast_resume_preflight`, and
`undelivered_send_again` one from `undelivered_preflight`, on the same terms.
The rules live in `core/send-preflight.ts`, shared with the REST API.

Registries live in `mcp/tools/*.ts`, one per domain, 16 files and 144
`defineTool` calls: audience 11, tags 10, segments 6, broadcasts 15,
sequences 20, sequence-templates 6, campaigns 9, forms 7, posts 8 (posts,
members, topics), site 4 (site and themes), sales 12, transactional 5,
stripe 7, deliverability 10, ops 9 (stats, `db_query`, `health`, `log_search`,
`log_types`, the MCP audit, API keys), webhooks 5. `mcp/kit.ts` holds
`defineTool`, the `ok`/`fail` helpers, `clampLimit`, the read-only gate and the
audit write. There are no tools for custom field definitions, Launch Studio,
importers, the team or the agent switches.

Resources are `kolea://conventions`, `kolea://merge-tags` (which lists the
install's custom fields and their types), `kolea://schema`,
`kolea://stats/overview`. **An agent should read `kolea://conventions` before
touching consent** — it states the asymmetry plainly, which is cheaper than
catching it in every tool description. The four prompts are in `mcp/prompts.ts`.

---

## ⚠️ Platform limits, and the patterns they force

| Limit | Consequence in this codebase |
|---|---|
| **D1: 1,000 queries per Worker invocation** | Everything that loops over people is paged. Broadcasts materialize across ticks with a cursor. Segment predicates hit pre-aggregated `purchase_stats` rather than summing every `purchases` row. The minutely cron runs several jobs in one invocation, so they share one `QueryBudget` (see [The minutely tick](#the-minutely-tick)). Imports, clean-ups, Ghostwriter takes and webhook deliveries all advance a page at a time from a row that holds their place. |
| **D1: 100 bound parameters per statement** | Every `IN (…)` list and bulk insert is chunked, at 90 where a statement also binds fixed parameters. The test D1 (`tests/support/d1.ts`) refuses a 101st parameter and counts statements, so a spec fails the way production would. |
| **D1: single-threaded writes** | Tracking events are written per-event and kept narrow, not aggregated on write. |
| **Queues: batches of 100** | `sendBatch()` chunk size, and the queue consumer's page size. |
| **Queues autoscale to 250 consumers** | Pinned to `max_concurrency: 6`. One batch = one provider request, so batch concurrency **is** the request rate. Unpinned, it buries Resend's 10 req/s limit (per team, not per key) under 429s. Six batches of 100 ≈ 600 emails/sec of headroom. |
| **Queues retry immediately unless told to wait** | A retry with no delay meets the same failure, so a blip of a few seconds spends the whole budget and dead-letters good mail. The consumer sets `delaySeconds` on every retry (`core/backoff.ts`), `retry_delay: 30` covers an invocation that died before it could, and `max_retries: 12` makes the budget at least twenty minutes. |
| **Workers logs retain 3–7 days** | Invariant 7. Anything observable is a row. |
| **No DOM in workerd** | `render-doc.ts` is hand-written; TipTap's `generateHTML` needs happy-dom. This turned out better anyway — it emits *email* HTML (inlined styles, nested-table buttons), not web HTML. |
| **workerd globals shadow DOM globals** | `src/client/` has its own tsconfig. `bun run typecheck` runs three passes. Sharing one tsconfig silently resolves the wrong `Response`/`Headers` overloads. |
| **Wrangler envs don't inherit bindings** | Every binding is repeated under `env.production`. Omitting one deploys with `env.DB === undefined` at runtime. |

---

## 🧩 Recipes — where to add things

| You want to… | Do this |
|---|---|
| Add a domain rule | `core/` first, always. Then surface it in `web/` **and** `mcp/tools/` as thin wrappers. Never implement it twice. |
| Add a table or column | Edit `src/db/schema.ts` (with a comment explaining *why*, matching the file's density) → `bun run db:generate` → `bun run db:migrate`. Never hand-write a migration. |
| Add an MCP tool | `defineTool` in the right `mcp/tools/*.ts`. Zod input schema, `annotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint`), a `description` written for a model. ⚠️ `readOnlyHint: true` is what lets a read-only OAuth grant call it, so set it only on a tool that changes nothing. Irreversible? It needs a preflight. Puts mail on the wire? It asks `agentSendAllowed` first. Deletes people, hands out access or sends data out? It asks `agentSensitiveAllowed`. Then update the tool counts in this file, `MCP.md` and `CLAUDE.md`. |
| Add a REST endpoint | `endpoint()` in `api/v1/audience.ts`, `mail.ts` or `site.ts`. It files the route in `CATALOG`, so the OpenAPI document is generated from it. Name the key scope. A new path that sends belongs in the `SENDS` pattern in `api/v1/index.ts`. |
| Add an admin screen | A route file in `web/`, mounted in `worker.tsx` **after** `requireRole`, using `Layout` from `web/layout.tsx`. It needs `admin` until a rule in `web/roles.ts` says a writer may use it. Its writes are audited by `web/audit.ts` with no code in the handler. |
| Add a public endpoint | Mount **before** `app.use('*', requireOperator)` and carry its own auth. Then add a Cloudflare Access **Bypass** app for the path: a line in `BYPASS` in `scripts/onboard.ts` (see [INSTALL](INSTALL.md)). ⚠️ A path ending in `/*` does not cover the path itself. |
| Add a job to the minutely cron | In `scheduled` in `worker.tsx`, after the mail, in its own `try`. Give it a per-unit query cost and take `budget.fits(…)` units. Keep its place in a row so it resumes next minute. |
| Add an importer | One adapter in `providers/importers/` implementing `ImportSource` (`prepare`, `verify`, `phases`, `fetchPage`), registered in `importSources`. It turns the tool's JSON into `ImportedRecord`s and knows nothing about our tables. Every write rule stays in `core/importers/writer.ts`. |
| Add a webhook event | A name in `WEBHOOK_EVENTS` in `src/db/schema.ts`, then one `emitWebhook` call where the fact happens. Never emit from a bulk write, and never report a narrow consent change as a wide one. |
| Add a writing helper | A line in `HELPERS` in `core/ai/catalogue.ts`. Ask `resolveAi` for the key and model. Fence what goes in and clean what comes out with `core/ai/guard.ts`. Return a draft, never a send. |
| Add a table that holds a secret or a token | Also add its name to `SECRET_IDENTIFIERS` in `mcp/sql.ts`, or `db_query` can read it. |
| Add a page to the public site | A route on the `site` app in `web/site.tsx`. It is a *separate* Hono app reached by hostname, so it never passes through `requireOperator` and needs no Bypass app. ⚠️ Register fixed paths **above** `/:slug`, which matches anything. |
| Change how a *post* reads | `core/render-web.ts` — classes and a real stylesheet, not inlined styles. Do not reach for `render-doc.ts`: email and web agree on nothing, and merging them puts an unsubscribe footer on a public page. |
| Serve a path the assets layer already owns | Add it to `assets.run_worker_first` in `wrangler.jsonc`. Static assets are served ahead of the Worker on **every** hostname, so a file like `robots.txt` cannot answer differently per host without this. |
| Add an email provider | One file in `providers/` implementing `EmailProvider` (`name`, `send`, `sendBatch`, `parseWebhook`, and optionally `domains`), plus a branch in each of `providerFor()`, `providerReadiness()` and `webhookReaderFor()` in `core/sending.ts`, and its name in the `/webhooks/:provider` route pattern in `api/routes.ts`. Nothing else in `core/` may name a vendor. Skipping `parseWebhook` means bounces never suppress. A failure where the provider may already have the mail must come back with `outcomeUnknown`, so it is never retried blind. `providers/mailgun.ts` is the second adapter to copy from. |
| Add an editor block | `client/extensions/` for the TipTap node, **and** a matching branch in `core/render-doc.ts`, or it renders as nothing in email. Then extend `scripts/smoke-editor.mjs`. |
| Change email HTML | `core/render-doc.ts`. Inline every style (Gmail strips `<style>`). Buttons are nested tables (Outlook ignores padding on `<a>`). |
| Change how people leave a sequence, or where they go next | `exitSequence`, `exitOnTag`, `chainFinished` and `sequenceFlow` in `core/sequences.ts`. The editor card in `web/admin-mail.tsx` and `sequence_update` / `sequence_get` in MCP are thin wrappers over them. A new automatic ending also needs a line in the editor's "Always" list. |
| Change what a reader sees about consent | `web/prefs.tsx` + `core/consent.ts`. Re-read the invariants first. |

---

## 🕳 Traps

Things that have already gone wrong, or nearly did.

- **`upsertSubscriber()` sends mail.** Invariant 5. This is the single easiest
  way to mail thousands of people by accident.
- **A "preview" that takes an address is a send.** `core/sending.ts` hard-codes
  the preview destination to `PREVIEW_EMAIL ?? FROM_EMAIL` — never a form field,
  never a subscriber picked from a list.
- **`PUBLIC_URL` is baked into tracking links and image URLs at send time.** A
  wrong value ships permanently broken email. It cannot be fixed after delivery.
- **A bare `wrangler deploy` publishes an unauthenticated admin console.**
  Top-level vars carry `DEV_AUTH_BYPASS=true`. `bun run deploy` hard-codes
  `--env production`. Don't work around it.
- **A single Access Allow policy on the hostname breaks every tracking pixel you
  have ever sent** — permanently, for mail already delivered. Thirteen paths
  each need a Bypass app, and `scripts/onboard.ts access` creates them: `/t/*`,
  `/f/*`, `/p/*`, `/d/*`, `/media/*`, `/api/*`, `/webhooks/*`, `/mcp/*`, and for
  MCP by URL `/mcp`, `/.well-known/*`, `/oauth/register`, `/oauth/token`,
  `/oauth/revoke`.
- **A wildcard path in Access does not cover its parent.** `/mcp/*` never
  covered `/mcp`, which is where an agent added by URL connects, so `/mcp` has
  a Bypass of its own.
- **Never bypass `/oauth/authorize` or `/oauth/*`.** It is the operator's
  consent page. The Access login in front of it is the only authentication the
  whole OAuth flow has.
- **A tracking host is append-only.** `TRACKING_HOST` may list several hosts.
  The first is used for new mail and every one keeps answering. Removing a host
  that was ever used breaks the mail already sent with it. `PUBLIC_URL`'s host
  answers `/t/*` whatever the setting says. A tracking host must sit outside
  the Access app, and it serves the two tracking routes and nothing else.
- **`MCP_ALLOW_SEND` no longer turns sending on.** `"false"` forces it off.
  Anything else defers to the switch on System → Agents & keys, which starts
  off. An install that set the var to `"true"` to allow agent sending has to
  turn the switch on instead.
- **A claim left on a row blocks its retry for ten minutes.** Any new write
  that returns a message to `queued` must set `claimed_at` to NULL in the same
  statement, as `resumeBroadcast`, both "send again" paths and
  `recordAttemptError` do. The one exception is a row the provider accepted:
  clearing that claim is what would let a redelivered job send a second copy.
- **The stranded sweep must not learn to hurry.** Lowering `ABANDONED_AFTER_MS`
  below the queues' retry schedules hands over a row while its retry, or the
  record of a send the provider already took, is still on the queue.
- **A confirmation link's GET must change nothing.** Mail scanners fetch every
  link in a message. Only the button's POST confirms a signup, and the same
  holds for a member's sign-in link.
- **An importer must not call `upsertSubscriber()` or `addTags()`.** The first
  fires subscribe sequences, the second starts `tag_added` sequences and runs
  tag rules. `core/importers/writer.ts` inserts rows directly for that reason.
- **Mail rendered while `EMAIL_PROVIDER=console` cannot be released later.**
  The row reads `sent` with `provider = 'console'`, and nothing says whether
  it was a test or the kill switch. Undelivered counts it and never offers it.
- **A gated post's body must not leak through what publishing derives.** The
  excerpt, the featured image and `search_text` are never taken from a
  `members` or `premium` body, and lists, the feed and search always ask as
  an anonymous reader. A new exit for post content has to ask
  `core/member-access.ts` too.
- **A new console route is closed to writers by default.** `web/roles.ts`
  answers `admin` for anything it does not list. That is the safe direction:
  forgetting the table shows a writer a 403 and never lets a writer send.
- **Rotating `MEMBER_SESSION_SECRET` signs every member out, and rotating
  `AI_KEY_ENCRYPTION_SECRET` makes every stored model key unreadable.**
  `scripts/onboard.ts secrets` makes each one on the first push only.
- **An Access application matching `*.example.com` takes the public site down
  too.** The site is a *different hostname*, not a bypassed path, and that is the
  only thing keeping readers out of a login screen. Scope the Access app to the
  admin hostname exactly.
- **`public/robots.txt` is served on every hostname, ahead of the Worker.** It
  disallows everything — correct for the console, and it silently de-indexes the
  public site. `assets.run_worker_first` lists that path so each host answers for
  itself. The same trap waits for any other file added to `public/`.
- **Publishing is per-post and must stay that way.** The archive imported from a
  previous ESP is hundreds of `sent` broadcasts. There is no bulk publish in
  `core/posts.ts`, in the admin, or in MCP, on purpose.
- **`web/auth.ts` fails closed.** Missing `CF_ACCESS_TEAM_DOMAIN` or
  `CF_ACCESS_AUD` locks out everyone including you. That is the correct
  direction to fail. Presence of the `Cf-Access-Jwt-Assertion` header proves
  nothing — the signature, `alg`, audience, issuer, `exp` and `nbf` are all
  verified against live JWKS. Passing Access is not enough either: the address
  must be on the team (`core/team.ts`), or the answer is a 403. The first
  verified person to reach an install whose `team_members` table is empty
  becomes the owner, and that door then stays shut.
- **A sequence chain must never be swept.** `chainFinished` acts only on the
  people who were sent a last step *in this tick*. A query for "completed but
  not yet in the next sequence" looks like a harmless catch-up and would mail
  every historical finisher the moment an operator links an old sequence to a
  new one.
- **An exit is not an opt-out.** `exitSequence` cancels; `leaveSequence` records
  consent. `sequence_remove_person` is the consent one, so automation must never
  call it. See the table under *A sequence*.
- **`exitOnTag` is on the click hot path too**, through tag rules → `addTags`.
  It is one indexed lookup on `sequence_exits.tag_id` when nothing matches. Keep
  it that way.
- **Tag rules run on the open/click hot path.** `core/tagging.ts` must stay cheap
  and must never throw at its caller.
- **Renaming a TipTap extension option fails silently in the browser** and the
  body field just never saves. Nothing server-side catches it. That's what
  `bun run smoke` is for.

---

## ✅ Verifying a change

```bash
bun run typecheck   # four passes: Worker, browser bundle, scripts, tests
bun test            # the server-side suite — SPEC, executable
bun run test:ui     # Playwright; starts its own wrangler dev on :8788
bun run dev         # :8787, EMAIL_PROVIDER=console — nothing leaves the machine
bun run smoke       # 33 real-Chromium checks against the editor; needs dev running
```

**The suite is the executable form of [`SPEC.md`](SPEC.md).** `tests/specs/` runs
the real Worker (`fetch`, `scheduled`, `queue`) against the real migrations on a
SQLite-backed `D1Database`, with `EMAIL_PROVIDER=console` so nothing can reach the
wire; `tests/ui/` drives a real browser against a real `wrangler dev`. One Feature
per story in [`STORIES.md`](STORIES.md), and each file names the SPEC clauses it
covers. Read [`tests/README.md`](../tests/README.md) before adding to it — in
particular, every Feature has to drive a deployed entry point, not just an internal
function.

The outside world is faked at the ports, never on the wire: the other tools'
APIs (`Env.IMPORT_HTTP`), DNS (`DNS_RESOLVER=fake`), Cloudflare DNS
(`CLOUDFLARE_DNS=fake`), the model (`AI_PROVIDER=fake`), Premium billing
(`PREMIUM_BILLING=fake`) and webhook delivery (`WEBHOOK_TRANSPORT=fake`). None
of these is set in production.

The two divergences from SPEC that `tests/specs/sending-a-broadcast.spec.ts`
used to record are closed. A send closes in the pass that reaches its last
recipient when nothing is left queued (SPEC 3.7), and the audience is fixed
when the send starts (SPEC 3.5). The spec file asserts both.

**Per CLAUDE.md: do not report something as fixed if you have not compiled it.**

---

## 📌 Key decisions

| Decision | Why | Rejected |
|---|---|---|
| **Cloudflare Workers + D1** | D1 *is* SQLite, so the schema stays Postgres-portable. Cheap, no servers. | Fly.io/VPS + local SQLite — real disk, but ops and cost we don't need. |
| **Hono + JSX for the UI** | Runs *as* the Worker, no adapter, server-rendered. | Next.js via `@opennextjs/cloudflare` — community adapter, Node-runtime middleware unsupported, large surface for little gain. |
| **Queues for fan-out** | 5k msg/sec, 100-message batches, per-message ack/retry, DLQ. Exactly the shape of a broadcast. | Looping sends in one invocation — dies on CPU/query limits, isn't resumable. |
| **Provider as a port; Resend first** | Deliverability is risk #1; the escape hatch must be cheap. Mailgun is the second adapter: switching is configuration only (`EMAIL_PROVIDER` and the provider's own vars and secrets). | SES first (cheaper, but SNS wiring up front); Cloudflare Email Service (no extra vendor, but unpublished bulk limits — can't bet risk #1 on it). |
| **Cloudflare Access for auth** | One operator. Zero auth code, no secrets to hold. | Password/magic-link — code and secrets for one user. |
| **Team roles on top of the Access identity** | Access says who somebody is, `team_members` says what they may do. No passwords, codes or sessions are held for the console. | App-level sign-in for teammates: a second identity system beside the one Access already runs. |
| **A send claim as a column on `messages`** | Re-reading `queued` is not enough: two consumers that read the same row before either wrote `sent` would both send it. One conditional UPDATE decides, in the database that already holds the row. | Trusting queue delivery to be exactly-once, or the provider's idempotency key alone, which does not cover the same messages regrouped. |
| **Freeze the audience with an id bound** | `subscribers.id` is AUTOINCREMENT, so one integer fixes who existed when the send began, and the cursored walk keeps its D1 budget. | Materializing the whole audience in one invocation, which is what the cursor exists to avoid. |
| **One query budget for the cron** | Each job used to size itself as if it had the invocation alone, and a busy minute died partway with mail half sent. A slow tick is better than a dead one. | A separate cron or queue per job: more bindings for work that only needs what the minute has left. |
| **Agent switches in D1, not in config** | Flipping an env var meant a redeploy. A row the console writes is instant, and no key can reach it. The var stays as a hard off. | An MCP tool for the switch: it would hand the switch to the agent it exists to stop. |
| **OAuth for MCP in the same Worker, read-only by default** | Nobody copies a long-lived key. The operator's approval behind Access is the authentication. An agent reads text strangers wrote, so changing anything is something the operator ticks. | A separate authorization server, or scopes a client can ask its way into. |
| **The event log is a read model** | Every fact on the Logs page is already a row in the table that owns it. A second log table would be a second place to count the same fact, and it could disagree. | An `event_log` table written beside each change. |
| **The webhook delivery row is the queue** | It survives a restart, it is the delivery log, and a failed one keeps a Redeliver button. Emitting never touches the network, so a webhook cannot slow or break the consent change it reports. | POSTing inline, or a second Cloudflare Queue. |
| **Custom field values stay in `subscribers.attributes`** | A values table costs a join per condition in every segment count and a row per person per field on import. The definition row is what makes the blob trustworthy. | A `subscriber_field_values` table. |
| **A member is the subscriber row** | One person, one consent state, however they arrived. | A separate members table with its own email and its own idea of who is subscribed. |
| **Importers run a page per cron tick** | A run holds no state in memory, survives a deploy, and yields the minute to a broadcast. | One long request, which D1's query cap and a Worker's limits would cut off partway. |
| **Materialize `messages` first** | Resumable, auditable, idempotent across retries. | Lazy recipient resolution — a mid-broadcast crash becomes unrecoverable. |
| **Suppression keyed by email** | Transactional and bounced addresses may have no subscriber row. | A `subscribers.status` flag — silently misses them. |
| **MCP inside the same Worker, stateless** | Ships and deploys with the app; MCP 2026-07-28 dropped session state, so a Worker is the natural shape. | A separate MCP process proxying the HTTP API — another deploy target, a second copy of every rule. |
| **Preflight tokens for irreversible sends** | An agent can be wrong in one tool call. The token binds a send to a preview a person read, dies on any edit, is single-use. | A `confirm: true` flag — satisfied in the same breath as the mistake. |
| **Hand-written email HTML renderer** | No DOM in workerd; and *email* HTML needs inlined styles and table buttons, which generic serialization won't produce. | `@tiptap/html` + happy-dom. |
| **A post is a broadcast with `published_at`** | One write becomes one send and one page. The piece is written once. | A separate `posts` table — a second content lifecycle, and everything authored twice. |
| **Hostname dispatch for the public site and the tracking host** | Apps that never share a router, so a reader's request cannot enter the one guarded by `requireOperator` and Access. | A `/blog` path prefix on the admin host — one more Bypass app, permanent `/blog` in every URL, and public pages living inside the guarded router. |
| **A second renderer for the web, not a flag on the email one** | Email and web agree on nothing: tracking, footers, merge tags, `<details>`, iframes. Flags multiply, and the failure mode is an unsubscribe link on a public page. | `renderDoc(doc, { web: true })`. |
| **Unsplash photos are hotlinked, never copied into R2** | Rehosting is faster to serve and breaks the photographer's view counts, which is what the API is given away for. Credit is stored on the row so it renders offline from the API, years later. | Mirroring the bytes into R2 on pick. |
| **Mirror commerce data into D1** | Segment evaluation runs in-Worker under a query cap and can't reach Postgres at send time. | Live cross-database queries. |

---

## 🚫 Not building (YAGNI)

Visual builder, multi-tenancy, self-run SMTP (all explicit `PROJECT.md` outs),
plus: A/B testing, per-subscriber send-time optimization, read replicas, D1
sharding. Volume is 5k–25k weekly — none earn their keep yet. (A tracking
hostname was on this list and is built: `TRACKING_HOST`. A sequence's send
window is per sequence, not per subscriber.)

**Do not add any of these speculatively.** If a change starts to require one,
that's a conversation, not a commit.
