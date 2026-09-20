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

Ten rules. Every one exists because violating it is silent, irreversible, and
lands in a stranger's inbox.

1. **Consent is scoped, never blanket.** Leaving one sequence takes a person off
   *that sequence*. It never touches the newsletter, other sequences, or
   transactional mail. See [Consent](#-consent--the-whole-point).
2. **A narrow consent action never escalates to a wider one.** Only an explicit
   "unsubscribe from everything", a hard bounce, or a spam complaint may write a
   `suppressions` row.
3. **`unsubscribed` only ever moves one way.** No import, sync, backfill, or
   merge may return somebody to `active` (SPEC 1.2). Only the person can, from
   the preference center.
4. **Suppression is checked immediately before the provider call**, never at
   enqueue time. A queue can deliver minutes later; consent can change in
   between.
5. **Bulk writes never go through `upsertSubscriber()`.** It fires
   `enrollOnSubscribe()`, so importing N people into a live `subscribe` sequence
   mails all N. Use direct SQL (`scripts/import-kit.ts`) or pass
   `triggerSubscribeSequences: false`.
6. **Imported and backfilled content arrives inert.** Broadcasts land
   `status: 'sent'` with `sent_at` set; sequences land `is_active: 0`. The
   minutely tick only claims `sending` or `scheduled`-and-due, and every
   enrollment path gates on `isActive`. Activation is a separate deliberate act.
7. **Nothing observable may exist only in a log line.** Workers logs retain 3–7
   days. If someone could ask "what happened?" next quarter, it is a row in D1 —
   `mcp_calls`, `sync_runs`, `events`, `stripe_events`, `messages.suppressed_reason`,
   `tag_rules.applied_count`.
8. **Money is integer cents.** Never a float, anywhere, for any reason. A refund
   *flips* the existing `sales` row to `status: 'refunded'` — it never adds an
   offsetting negative row, so any revenue sum must filter on status.
9. **Sent history is immutable.** A broadcast copies its segment rule at create
   time; message bodies for broadcast/sequence mail live on the source row;
   a sale's campaign is frozen at ingest. Editing a segment, a template, or an
   attribution model must never rewrite what already went out.
10. **`EMAIL_PROVIDER=console` is the kill switch** and the correct default for
    anything experimental. It renders to the in-app Outbox instead of the wire.

> 💡 **If you are unsure whether a change can send mail, assume it can, and ask.**
> An unsent mail costs nothing. An unwanted one costs a subscriber and a sender
> reputation that took years to build.

---

## 🗺 System shape

One Cloudflare Worker. Three entry points, one D1 database, one outbound port.

```
                         ┌──────────────────────────────────────────┐
   Cloudflare Access ────┤  Kōlea Worker  (src/worker.tsx)          │
   (operator only)       │                                          │
   list.example.com ─────┤  fetch()      admin console (Hono + JSX) │
   your apps ────────────┤               POST /api/send  (bearer)   │
   your checkout ────────┤               POST /api/sales (bearer)   │
   your website's form ──┤               POST /f/:slug   (public)   │
   provider webhooks ────┤               POST /webhooks/:provider   │
   every email opened ───┤               GET  /t/open, /t/click     │
   every reader ─────────┤               GET  /p/:token  (prefs)    │
   agents (MCP) ─────────┤               ALL  /mcp/:secret          │
                         │                                          │
   a.example.com ────────┤  fetch()      the public site (web/site) │
   every reader ─────────┤               GET / · /:slug · /feed.xml │
                         │                                          │
   Cron  */1 * * * * ────┤  scheduled()  sequence tick + broadcasts │
   Cron  17 9 * * * ─────┤               Stripe reconcile + catalog │
                         │                                          │
   Queue big-mailer-send ┤  queue()      render → consent → send    │
   Queue …-dlq ──────────┤               mark failed (never sends)  │
                         └───────────┬──────────────────────────────┘
                                     │
              ┌──────────────┬───────┴────────┬──────────────┐
              ▼              ▼                ▼              ▼
             D1            R2 MEDIA     EmailProvider    Stripe REST
      (system of record)  (image bytes)  (port → Resend)  (read-only)
```

**Two hostnames, two apps, one Worker.** `fetch` splits on the request host
*before* either router runs: `SITE_URL`'s host gets the public site app, every
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

`src/` — ~23k lines of TypeScript. Grouped by what you'd be changing.

### Composition root

| File | Responsibility |
|---|---|
| `worker.tsx` | Wires `fetch` / `scheduled` / `queue`. **Hostname dispatch happens first** — `SITE_URL`'s host goes to the public site app, everything else to the admin app. Within the admin app, route mount **order matters**: public routes and MCP mount *before* `requireOperator`. 248 lines, no domain logic. |
| `types.ts` | The `Env` interface — every binding and var, each commented with what breaks without it. **Read this before touching config.** |

### `core/` — the domain. All rules live here, exactly once.

| File | Responsibility | Touch it when |
|---|---|---|
| ⭐ `consent.ts` | Scoped consent: the three levels, the preference-center actions, `canSend` checks. | Anything about who may receive what. **Read the whole file first.** |
| `sending.ts` | Render → consent re-check → provider call → record. Preview sends. | The send path, or preview safety. |
| `broadcasts.ts` | Materialize recipients (cursored), enqueue, status machine. | Broadcast lifecycle. |
| `sequences.ts` | Steps, enrollment, the minutely tick, day-delay math, chaining to a next sequence, tag exits. | Drip logic, and how people leave it. |
| `segments.ts` | `SegmentRule` → SQL. `resolveSegment` and `countSegment` share one WHERE builder so the shown count can't drift from the actual audience. | Audience predicates. |
| `subscribers.ts` | `upsertSubscriber` (⚠️ fires sequences), tags on create. | Person creation. Mind invariant 5. |
| `tagging.ts` | Tag CRUD, merge, and the event→tag rule engine. Sits on the open/click hot path — must stay cheap and must never throw. | Auto-tagging. |
| `campaigns.ts` | Campaigns and the `attributions` touch ledger. | Attribution. |
| `sales.ts` | `recordSale`, refunds, revenue rollups. | Money. |
| `events.ts` | `recordEvent` — the single funnel for opens, clicks, and provider events. | Tracking. |
| `render.ts` | Body precedence (`body_json` wins, `body_md` fallback), merge tags, footer. | What a message says. |
| `render-doc.ts` | TipTap JSON → **email** HTML. Hand-written walker: inlines every style, emits nested tables for buttons. | Email-client rendering bugs. |
| `render-web.ts` | TipTap JSON → **web** HTML, for the public site. A sibling of `render-doc.ts`, not a mode of it: classes instead of inlined styles, no click tracking, no consent footer, merge tags resolve to neutral copy. | How a *post* reads. |
| `posts.ts` | Publishing: a post is a broadcast with `published_at`. Slugs, excerpts, featured images, search, the feed's rows. Never writes `status`, the segment, or the send cursor. | The public site's data. |
| `media.ts` | `storeMedia` / `deleteMedia` — the R2 upload path and its type allowlist, in one place because two screens upload. | Image uploads. |
| `unsplash.ts` | Stock photo search for featured images. Hotlinks, never rehosts; pings the download endpoint only on an actual pick. | The photo picker. |
| `md-to-doc.ts` | Markdown → TipTap JSON, on load only. Never a bulk migration. | Legacy content. |
| `forms.ts` | Hosted `POST /f/:slug` signup endpoints. | Signup. |
| `insights.ts` | Dashboard numbers. Each query is scope-annotated; the scoping matters more than any figure. | Dashboard. |
| `purchases.ts` · `purchase-stats-sql.ts` | **Read-only** commerce mirror from Neon. Nothing here writes a purchase. | Purchase segmentation. |
| `segment-ideas.ts` | Proposed segments derived from purchase history. | Store suggestions. |
| `stripe-webhook.ts` | ⭐ The live money path. Signature verify → `stripe_events` dedupe → sale. | Stripe realtime. |
| `stripe.ts` | The nightly *reconcile* — safety net, not primary path. | Stripe catch-up. |
| `stripe-catalog.ts` | Mirrors Stripe products/prices. ⚠️ **Not** `offers` (that's Neon's). | Catalog. |
| `stripe-client.ts` | The slice of Stripe's REST API we speak, over plain `fetch`. No SDK. | Stripe transport. |
| `api-keys.ts` · `ids.ts` | Key minting (hash-only storage), token generation, email normalization. | Auth primitives. |

### The edges

| Dir | Responsibility | Boundary |
|---|---|---|
| `web/` | Admin console **and** the public site. Hono + JSX, server-rendered, ~zero client JS. `layout.tsx` holds the whole "Abyssal" design system; `prefs.tsx` is ⭐ the public preference center; ⭐ `site.tsx` is the public blog (its own Hono app + its own stylesheet, dispatched by hostname); `auth.ts` verifies the Access JWT properly. | Calls `core/`. **Never** a provider or raw D1 query. |
| `api/` | `/api/send`, `/api/sales`, `/f/:slug`, `/webhooks/:provider`, `/t/*`, media. | HTTP shape only. Delegates to `core/`. |
| `mcp/` | The whole mailer as **103 agent-callable tools**, 4 resources, 4 prompts. | Same boundary as `web/`: thin wrappers, no domain logic. |
| `providers/` | `EmailProvider` port + `console` and `resend` adapters. | Adapter. Only `core/` calls it. |
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
query tool for analytics questions no fixed tool anticipates.

---

## 🗃 Data model

**37 tables, all `STRICT`.** Conventions: snake_case columns under camelCase TS
keys, plural tables, `id` surrogate key, NOT NULL FKs with explicit `onDelete`,
`text` + CHECK for enums, `integer` epoch-ms timestamps set by the app. This is
the `sqlite-dev` convention set, so the schema stays Postgres-portable — D1 *is*
SQLite.

✅ **D1 enforces foreign keys** (verified empirically 2026-08-07). Every
`ON DELETE` is real and `core/` does not reimplement cascade cleanup. Corollary:
an FK value taken from user input must be validated before insert or it surfaces
as a 500 — see `leaveSequence`, reachable from the public preference center.

### The tables, by cluster

**Audience** — `subscribers`, `tags`, `subscriber_tags`, `segments`, `tag_rules`

**Mail** — `broadcasts`, `sequences`, `sequence_steps`, `sequence_enrollments`,
⭐ `sequence_optouts`, `sequence_exits`, `messages`, `events`, `suppressions`, `dev_outbox`, `media`

**Growth & money** — `campaigns`, ⭐ `attributions`, `forms`, `form_tags`,
`sales`, `sale_items`

**Commerce mirror (read-only, from Neon)** — `offers`, `offer_products`,
`purchases`, `purchase_stats`

**Stripe mirror** — `stripe_events`, `stripe_products`, `stripe_prices`

**Operations** — `api_keys`, `mcp_calls`, `preflight_tokens`, `sync_runs`

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
| `purchases` vs `sales` | Same thing | **Never sum them together.** `sales` = revenue attributed to mail this system sent. `purchases` = ten years of storefront history with no attribution. 21,403 buyers vs 13,766 subscribers. |
| `purchases.email` (not subscriber_id) | Denormalized | Forcing a subscriber row would fabricate ~8k people who never opted in — at `active`, they'd receive the next broadcast. |
| `offers` vs `stripe_products` | Redundant catalogs | Two catalogs, two owners (Neon storefront vs Stripe). They are *allowed* to disagree. Reconciling is a human question, not a UNIQUE index. |
| `purchase_stats` | Cache that could drift | Rebuilt **wholesale** every sync, never incremented. A counter that drifts is worse than no counter. |
| `stripe_events.id` = Stripe's `evt_…` | Weird PK | The natural key *is* the idempotency guard. Stripe retries for three days. |
| `stripe_events.status = 'ignored'` | A failure | First-class outcome. We subscribe to more types than we act on, and a silently discarded event must be distinguishable from a lost one. |
| `preflight_tokens` in D1 | Should be in memory | The Worker is stateless. The preview and the send are two unrelated HTTP requests. |

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
   > bought 400 recipients a minute; spending the whole D1 budget on the oldest
   > live send clears ~8,000. One operator, so they queue behind each other anyway.
3. Queue consumer takes a batch (≤100). Per message: **re-check suppression**,
   render, call the provider, record `provider_message_id`, set `status='sent'`.
   Per-message `ack()`/`retry()` — one bad address never re-sends the other 99.
4. Provider webhooks POST delivery/bounce/complaint → `events` rows; hard bounces
   and complaints write `suppressions`.
5. Open pixel and click redirect write `events` and 302 onward. `recordEvent`
   also runs tag rules, which can start a `tag_added` sequence. That chain is
   intentional.
6. Exhausted retries land in `big-mailer-dlq`, whose handler **has no send path** —
   it marks the message `failed` so a give-up is a row, not a vanished message.

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
target sequence. A single-step series can finish 200 people in one tick, and
`enroll()` per person would exhaust the D1 budget.

### Transactional

`POST /api/send` with a `send`- or `admin`-scoped bearer key. Creates the
subscriber quietly if absent (`source: 'transactional'`,
`triggerSubscribeSequences: false`) so the send is attributable but the person is
never marketed to. `idempotency_key` replays the original result instead of
sending twice.

### Money

**Live path:** `POST /webhooks/stripe` → verify signature (fails closed with 503
if `STRIPE_WEBHOOK_SECRET` is unset) → `stripe_events` insert dedupes the
retry → `recordSale` → `sale_items`.
**Safety net:** the 09:17 UTC cron walks the same charges again and catches what
the webhook missed, then syncs the catalog. Both are independently
try/caught — a catalog outage must not stop the reconcile that books money — and
both record a `sync_runs` row so a silent no-op is distinguishable from a silent
failure.

---

## 🤖 The MCP surface

`ALL /mcp/<MCP_PATH_SECRET>` — **103 tools**, 4 resources, 4 prompts. Mounted
*ahead of* the Cloudflare Access gate in `worker.tsx`, because an agent has no
browser to complete an Access login in. It authenticates itself instead.

**Three gates, cheapest first:**

1. **Path secret** — constant-time compare (`safeEqual`). A miss returns **404,
   not 403**: a URL nobody guessed should look like nothing is there. Unset
   `MCP_PATH_SECRET` means the endpoint doesn't exist.
2. **Bearer key** — `api_keys.scope = 'admin'`. Transactional `send` keys cannot
   reach MCP, and `send` is the default scope for exactly that reason.
3. **Per-tool guards** — preflight tokens, `MCP_ALLOW_SEND` as a global kill
   switch (`"false"` in production), `confirm_*` echo arguments on tools that
   destroy history.

**Every call writes an `mcp_calls` row, including refusals.**

**⭐ Preflight is the thing between a hallucinated tool call and eight thousand
inboxes.** `broadcast_send` refuses without a token from `broadcast_preflight`;
`sequence_activate` refuses without one from `sequence_preflight`. The token is
single-use, expires in 10 minutes, and carries a `digest` of the previewed
subject + body + audience — so any edit invalidates it. A `confirm: true` flag
was rejected: an agent satisfies it in the same breath as the mistake.

Registries live in `mcp/tools/*.ts`, one per domain (audience 10, tags 10,
segments 6, broadcasts 12, sequences 18, campaigns 9, forms 6, posts 4, sales 7,
stripe 7, deliverability 7, ops 7). `mcp/kit.ts` holds `defineTool`, the `ok`/`fail`
helpers, `clampLimit`, and the audit write.

Resources are `kolea://conventions`, `kolea://merge-tags`, `kolea://schema`,
`kolea://stats/overview`. **An agent should read `kolea://conventions` before
touching consent** — it states the asymmetry plainly, which is cheaper than
catching it in every tool description.

---

## ⚠️ Platform limits, and the patterns they force

| Limit | Consequence in this codebase |
|---|---|
| **D1: 1,000 queries per Worker invocation** | Everything that loops over people is paged. Broadcasts materialize across ticks with a cursor. Segment predicates hit pre-aggregated `purchase_stats` rather than summing 31k `purchases` rows. |
| **D1: single-threaded writes** | Tracking events are written per-event and kept narrow, not aggregated on write. |
| **Queues: batches of 100** | `sendBatch()` chunk size, and the queue consumer's page size. |
| **Queues autoscale to 250 consumers** | Pinned to `max_concurrency: 6`. One batch = one provider request, so batch concurrency **is** the request rate. Unpinned, it buries Resend's 10 req/s limit under 429s, burns all three retries, and dead-letters perfectly good mail. Six batches of 100 ≈ 600 emails/sec of headroom. |
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
| Add an MCP tool | `defineTool` in the right `mcp/tools/*.ts`. Zod input schema, `annotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint`), a `description` written for a model. Irreversible? It needs a preflight. |
| Add an admin screen | A route file in `web/`, mounted in `worker.tsx` **after** `requireOperator`, using `Layout` from `web/layout.tsx`. |
| Add a public endpoint | Mount **before** `app.use('*', requireOperator)` and carry its own auth. Then add a Cloudflare Access **Bypass** app for the path (see [INSTALL](INSTALL.md)). |
| Add a page to the public site | A route on the `site` app in `web/site.tsx`. It is a *separate* Hono app reached by hostname, so it never passes through `requireOperator` and needs no Bypass app. ⚠️ Register fixed paths **above** `/:slug`, which matches anything. |
| Change how a *post* reads | `core/render-web.ts` — classes and a real stylesheet, not inlined styles. Do not reach for `render-doc.ts`: email and web agree on nothing, and merging them puts an unsubscribe footer on a public page. |
| Serve a path the assets layer already owns | Add it to `assets.run_worker_first` in `wrangler.jsonc`. Static assets are served ahead of the Worker on **every** hostname, so a file like `robots.txt` cannot answer differently per host without this. |
| Add an email provider | One file in `providers/` implementing `EmailProvider` (`name`, `send`, `sendBatch`, `parseWebhook`), plus a branch in `providerFor()` in `core/sending.ts`. Nothing in `core/` may name a vendor. Skipping `parseWebhook` means bounces never suppress. |
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
  have ever sent** — permanently, for mail already delivered. `/t`, `/f`, `/p`,
  `/d`, `/media`, `/api`, `/webhooks`, `/mcp` each need a Bypass app.
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
  verified against live JWKS.
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
bun run typecheck   # three passes: Worker, browser bundle, scripts
bun run dev         # :8787, EMAIL_PROVIDER=console — nothing leaves the machine
bun run smoke       # 33 real-Chromium checks against the editor; needs dev running
```

There is **no server-side test suite yet**. [`SPEC.md`](SPEC.md) is written as
numbered, testable requirements shaped to feed the `bdd-specs` skill — making it
executable is the highest-value contribution available.

**Per CLAUDE.md: do not report something as fixed if you have not compiled it.**

---

## 📌 Key decisions

| Decision | Why | Rejected |
|---|---|---|
| **Cloudflare Workers + D1** | D1 *is* SQLite, so the schema stays Postgres-portable. Cheap, no servers. | Fly.io/VPS + local SQLite — real disk, but ops and cost we don't need. |
| **Hono + JSX for the UI** | Runs *as* the Worker, no adapter, server-rendered. | Next.js via `@opennextjs/cloudflare` — community adapter, Node-runtime middleware unsupported, large surface for little gain. |
| **Queues for fan-out** | 5k msg/sec, 100-message batches, per-message ack/retry, DLQ. Exactly the shape of a broadcast. | Looping sends in one invocation — dies on CPU/query limits, isn't resumable. |
| **Provider as a port; Resend first** | Deliverability is risk #1; the escape hatch must be cheap. | SES first (cheaper, but SNS wiring up front); Cloudflare Email Service (no extra vendor, but unpublished bulk limits — can't bet risk #1 on it). |
| **Cloudflare Access for auth** | One operator. Zero auth code, no secrets to hold. | Password/magic-link — code and secrets for one user. |
| **Materialize `messages` first** | Resumable, auditable, idempotent across retries. | Lazy recipient resolution — a mid-broadcast crash becomes unrecoverable. |
| **Suppression keyed by email** | Transactional and bounced addresses may have no subscriber row. | A `subscribers.status` flag — silently misses them. |
| **MCP inside the same Worker, stateless** | Ships and deploys with the app; MCP 2026-07-28 dropped session state, so a Worker is the natural shape. | A separate MCP process proxying the HTTP API — another deploy target, a second copy of every rule. |
| **Preflight tokens for irreversible sends** | An agent can be wrong in one tool call. The token binds a send to a preview a person read, dies on any edit, is single-use. | A `confirm: true` flag — satisfied in the same breath as the mistake. |
| **Hand-written email HTML renderer** | No DOM in workerd; and *email* HTML needs inlined styles and table buttons, which generic serialization won't produce. | `@tiptap/html` + happy-dom. |
| **A post is a broadcast with `published_at`** | One write becomes one send and one page. The piece is written once. | A separate `posts` table — a second content lifecycle, and everything authored twice. |
| **Hostname dispatch for the public site** | Two apps that never share a router, so a reader's request cannot enter the one guarded by `requireOperator` and Access. | A `/blog` path prefix on the admin host — one more Bypass app, permanent `/blog` in every URL, and public pages living inside the guarded router. |
| **A second renderer for the web, not a flag on the email one** | Email and web agree on nothing: tracking, footers, merge tags, `<details>`, iframes. Flags multiply, and the failure mode is an unsubscribe link on a public page. | `renderDoc(doc, { web: true })`. |
| **Unsplash photos are hotlinked, never copied into R2** | Rehosting is faster to serve and breaks the photographer's view counts, which is what the API is given away for. Credit is stored on the row so it renders offline from the API, years later. | Mirroring the bytes into R2 on pick. |
| **Mirror commerce data into D1** | Segment evaluation runs in-Worker under a query cap and can't reach Postgres at send time. | Live cross-database queries. |

---

## 🚫 Not building (YAGNI)

Visual builder, multi-tenancy, self-run SMTP (all explicit `PROJECT.md` outs),
plus: A/B testing, link-tracking domains, per-subscriber send-time optimization,
read replicas, D1 sharding. Volume is 5k–25k weekly — none earn their keep yet.

**Do not add any of these speculatively.** If a change starts to require one,
that's a conversation, not a commit.
