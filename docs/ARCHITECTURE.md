# 🏗 ARCHITECTURE — big-mailer

> Owner: `/design`. Do not edit from other phases.
> Serves `docs/PROJECT.md`. Judged by: when this changes, how big is the diff?

## Overview

One Cloudflare Worker, three entry points, one D1 database.

```
                    ┌─────────────────────────────────────┐
  Cloudflare Access │            big-mailer Worker        │
  (operator only) ──┼─▶ fetch()    admin UI (Hono + JSX)  │
                    │              /api/send  (bearer key)│
  Big Admin ────────┼─▶            /webhooks/:provider    │
  & other apps      │              /t/open, /t/click      │
                    │              /unsubscribe/:token    │
                    │                                     │
  Cron Triggers ────┼─▶ scheduled() dispatch + seq ticks  │
                    │                                     │
  Queue ────────────┼─▶ queue()    send one message       │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────┴───────┐
                    ▼                      ▼
                   D1                 EmailProvider
             (system of record)      (port → Resend)
```

Every durable fact lives in D1. Workers logs retain 3–7 days, so **nothing
observable may exist only in logs** — events are rows.

## Components

| Component | Responsibility | Boundary |
|---|---|---|
| `web/` | Admin UI. Hono + JSX server-rendered HTML. | Reads/writes via `core/`. No provider or D1 calls. |
| `api/` | `/api/send` transactional endpoint, webhooks, tracking redirects, unsubscribe. | HTTP shape only. Delegates to `core/`. |
| `core/` | Domain: audiences, broadcasts, sequences, suppression, enqueueing. | Knows D1 + the provider **port**. Never HTTP. |
| `providers/` | `EmailProvider` implementations. | Adapter. Only `core/` calls it. |
| `db/` | Drizzle schema + migrations. | Only `core/` imports it. |
| `mcp/` | MCP server — the whole mailer as agent-callable tools. | Same boundary as `web/`: thin wrappers over `core/`, no domain logic of its own. |
| `worker.ts` | Wires `fetch` / `scheduled` / `queue` handlers. | Composition root. No logic. |

**The seam that matters:** `EmailProvider` is a port with two methods —
`send(message): ProviderResult` and `parseWebhook(request): Event[]`. Swapping
Resend for SES is a new file in `providers/` and one binding change. Nothing in
`core/` names a vendor. This is the hedge against the #1 risk (deliverability):
if Resend's reputation fails us, the diff is one adapter.

## Data flow — a broadcast

1. Operator composes, picks a segment, schedules. → `broadcasts` row, `status='scheduled'`.
2. Cron fires. `scheduled()` finds due broadcasts, resolves the segment to
   subscriber ids, writes one `messages` row per recipient (`status='queued'`),
   enqueues in `sendBatch()` chunks of 100.
3. Queue consumer receives a batch (≤100). For each: check suppression, render,
   call the provider, record `provider_message_id`, set `status='sent'`.
   Per-message `ack()`/`retry()` — one bad address never re-sends the other 99.
4. Provider webhooks POST delivery/bounce/complaint. → `events` rows; hard
   bounces and complaints write `suppressions`.
5. Open pixel and click redirect write `events` and 302 onward.

**Materialization is deliberate.** Writing all 25k `messages` rows up front (not
computing recipients lazily) means a send is resumable, auditable, and idempotent
after a crash — the queue can redeliver and the row already says `sent`.

## Database — Cloudflare D1

D1 *is* SQLite, so the `sqlite-dev` conventions apply as written and the schema
stays Postgres-portable. Deviations forced by the platform:

- Driver is `drizzle-orm/d1`, not `bun:sqlite`. No connection object to configure.
- **Pragmas are not ours to set.** D1 manages journal/sync; there is no per-connection
  pragma block.
- ✅ **D1 enforces foreign keys.** Confirmed empirically on 2026-08-07: inserting a
  `sequence_optouts` row with a non-existent `sequence_id` failed with
  `D1_ERROR: FOREIGN KEY constraint failed`. So every `ON DELETE` below is real, and
  `core/` does not need to reimplement cascade cleanup. The corollary: any FK value
  taken from user input must be validated before insert or it surfaces as a 500 —
  see `leaveSequence`, which is reachable from the public preference center.
- Local dev uses Miniflare's D1, not a hand-rolled SQLite file.

**Constraints that shape the design:** 10 GB/db; **1,000 queries per Worker
invocation**; writes are single-threaded. The query cap is why fan-out batches and
why the queue consumer handles ≤100 messages per invocation. Single-threaded writes
are why high-frequency tracking events are written per-event and kept narrow rather
than aggregated on write.

### Schema

All tables `STRICT`. Timestamps are `integer` epoch-ms, UTC, app-set. Booleans
`integer` + `CHECK (col IN (0,1))`. Enums `text` + `CHECK`.

```sql
create table subscribers (
  id              integer primary key,
  email           text    not null,           -- lowercased on write
  name            text,
  status          text    not null default 'active'
                    check (status in ('pending','active','unsubscribed','bounced','complained')),
  -- `unsubscribed` here means OFF BROADCASTS ONLY. It does not touch sequences.
  attributes      text    not null default '{}',   -- json document
  source          text,
  unsub_token     text    not null,           -- stable, per-subscriber, unguessable
  created_at      integer not null,
  confirmed_at    integer,
  unsubscribed_at integer
) strict;
create unique index subscribers_email_key on subscribers (email);
create unique index subscribers_unsub_token_key on subscribers (unsub_token);
create index subscribers_status_idx on subscribers (status);

create table tags (
  id         integer primary key,
  slug       text    not null,
  name       text    not null,
  created_at integer not null
) strict;
create unique index tags_slug_key on tags (slug);

create table subscriber_tags (               -- pure junction: compound pk, no id
  subscriber_id integer not null references subscribers (id) on delete cascade,
  tag_id        integer not null references tags (id)        on delete cascade,
  tagged_at     integer not null,
  primary key (subscriber_id, tag_id)
) strict;

create table broadcasts (
  id           integer primary key,
  subject      text    not null,
  body_md      text    not null,
  segment      text    not null default '{}',  -- json: tag/status filter
  status       text    not null default 'draft'
                 check (status in ('draft','scheduled','sending','sent','cancelled')),
  scheduled_at integer,
  started_at   integer,
  sent_at      integer,
  created_at   integer not null
) strict;
create index broadcasts_status_scheduled_idx on broadcasts (status, scheduled_at);

create table sequences (
  id         integer primary key,
  slug       text    not null,
  name       text    not null,
  trigger    text    not null check (trigger in ('subscribe','tag_added','manual')),
  trigger_tag_id integer references tags (id) on delete cascade,
  -- nullable-fk: only 'tag_added' sequences have a trigger tag
  is_active  integer not null default 0 check (is_active in (0,1)),
  created_at integer not null
) strict;
create unique index sequences_slug_key on sequences (slug);

create table sequence_steps (
  id           integer primary key,
  sequence_id  integer not null references sequences (id) on delete cascade,
  position     integer not null,
  delay_minutes integer not null default 0,     -- after the previous step
  subject      text    not null,
  body_md      text    not null
) strict;
create unique index sequence_steps_order_key on sequence_steps (sequence_id, position);

create table sequence_enrollments (
  id            integer primary key,
  sequence_id   integer not null references sequences (id)   on delete cascade,
  subscriber_id integer not null references subscribers (id) on delete cascade,
  next_step_id  integer references sequence_steps (id) on delete set null,
  -- nullable-fk: null once the sequence is completed
  status        text    not null default 'active'
                  check (status in ('active','completed','cancelled')),
  next_run_at   integer,
  enrolled_at   integer not null
) strict;
create unique index sequence_enrollments_key on sequence_enrollments (sequence_id, subscriber_id);
create index sequence_enrollments_due_idx on sequence_enrollments (status, next_run_at);

create table messages (                        -- one row per intended send
  id                  integer primary key,
  subscriber_id       integer not null references subscribers (id) on delete cascade,
  kind                text    not null check (kind in ('broadcast','sequence','transactional')),
  broadcast_id        integer references broadcasts (id)      on delete cascade,
  sequence_step_id    integer references sequence_steps (id)  on delete cascade,
  -- nullable-fk: exactly one source per `kind`; transactional has neither
  subject             text    not null,
  status              text    not null default 'queued'
                        check (status in ('queued','sent','failed','suppressed')),
  provider            text,
  provider_message_id text,
  idempotency_key     text,
  error               text,
  created_at          integer not null,
  sent_at             integer
) strict;
create index messages_broadcast_idx on messages (broadcast_id);
create index messages_subscriber_idx on messages (subscriber_id);
create unique index messages_idempotency_key on messages (idempotency_key)
  where idempotency_key is not null;

create table events (
  id          integer primary key,
  message_id  integer not null references messages (id) on delete cascade,
  type        text    not null
                check (type in ('delivered','open','click','bounce','complaint','failed')),
  occurred_at integer not null,
  meta        text    not null default '{}',   -- json: url, bounce type, ua
  url         text generated always as (json_extract (meta, '$.url')) stored
) strict;
create index events_message_type_idx on events (message_id, type);
create index events_url_idx on events (url);

create table sequence_optouts (              -- ⭐ scoped consent: off ONE sequence
  subscriber_id integer not null references subscribers (id) on delete cascade,
  sequence_id   integer not null references sequences (id)   on delete cascade,
  opted_out_at  integer not null,
  primary key (subscriber_id, sequence_id)
) strict;

create table suppressions (                  -- global kill switch; checked before every send
  id         integer primary key,
  email      text    not null,
  reason     text    not null
               check (reason in ('unsubscribed_all','hard_bounce','complaint','manual')),
  created_at integer not null
) strict;
create unique index suppressions_email_key on suppressions (email);

create table api_keys (                        -- for /api/send
  id           integer primary key,
  name         text    not null,
  token_hash   text    not null,
  created_at   integer not null,
  last_used_at integer,
  revoked_at   integer
) strict;
create unique index api_keys_token_hash_key on api_keys (token_hash);
```

**Why `suppressions` is its own table and not a subscriber status:** transactional
recipients and bounced addresses may have no `subscribers` row at all. Suppression
is a property of an *address*, not a subscriber. Getting this wrong is how you mail
someone who complained.

## ⭐ Consent model — scoped, not blanket

This is the product's reason to exist. On Kit, unsubscribing from one sequence removes
the person from everything, permanently. Here, **consent is scoped to a channel** and
there are three independent levels:

| Level | Stored as | Effect |
|---|---|---|
| **Sequence** | `sequence_optouts` row | Off that one sequence. Still on the newsletter, still on every other sequence. |
| **Broadcast** | `subscribers.status = 'unsubscribed'` | Off the newsletter. Sequences continue. |
| **Global** | `suppressions` row | Off everything. The legal escape hatch, and where bounces/complaints land. |

Rules:

- Leaving a sequence **cancels that enrollment only** and never sets a global suppression.
- A sequence send checks: global suppression → sequence opt-out → subscriber not `bounced`/`complained`.
  It does **not** check `status = 'unsubscribed'`, because that's a broadcast-scoped signal.
- A broadcast send checks: global suppression → `status = 'active'`.
- Only an explicit "unsubscribe from everything", a hard bounce, or a complaint writes
  a global suppression. Nothing else may.

Every marketing email links to a **preference center** keyed by `subscribers.unsub_token`,
with `?scope=sequence:<id>` or `?scope=broadcast` naming where the reader came from. The
page pre-selects the narrowest action that matches their intent — leave *this* sequence —
and offers per-sequence toggles, the newsletter toggle, and "unsubscribe from everything"
as a distinct, deliberate choice. One click from a sequence email leaves that sequence and
nothing else.

**Why a stable `unsub_token` column rather than a signed/HMAC token:** it survives content
changes, is revocable by rotating one row, needs no key management in the Worker, and the
preference center is idempotent — so replay is not a threat worth cryptography.

## Key decisions

| Decision | Why | Rejected |
|---|---|---|
| **Cloudflare Workers + D1** | Rob's choice; D1 is SQLite so the schema stays portable. Cheap, no servers. | Fly.io/VPS + local SQLite — real disk, but ops and cost we don't need. |
| **Hono + JSX for the UI** | Runs *as* the Worker, no adapter, server-rendered. CF's own recommendation. ~6 admin screens don't justify more. | Next.js via `@opennextjs/cloudflare` — community adapter, Node-runtime middleware unsupported, large surface for little gain. |
| **Cloudflare Queues for fan-out** | 5k msg/sec, batches of 100, per-message ack/retry, DLQ. Exactly the shape of a broadcast. | Looping sends inside one Worker invocation — dies on CPU/query limits and isn't resumable. |
| **Provider as a port; Resend first** | Deliverability is risk #1; the escape hatch must be cheap. Resend has clean webhooks and no SDK friction on Workers. | SES first (cheaper, but SNS wiring + access review up front); Cloudflare Email Service (zero extra vendor, but unpublished bulk limits — can't bet risk #1 on it). |
| **Cloudflare Access for auth** | One operator. Zero auth code in the app; identity handled at the edge. | Password/magic-link — code to write, secrets to hold, for one user. |
| **Materialize `messages` before sending** | Resumable, auditable, idempotent across retries. | Computing recipients at send time — a crash mid-broadcast becomes unrecoverable. |
| **Suppression keyed by email, not subscriber** | Transactional and bounced addresses may have no subscriber row. | A `subscribers.status` flag — silently misses non-subscriber addresses. |
| **MCP inside the same Worker, stateless** | Ships and deploys with the app; no second service, no session store, no Durable Object. MCP 2026-07-28 dropped session state, so a Worker is now the natural shape. | A separate MCP process proxying the HTTP API — another deploy target and a second copy of every rule to keep in sync. |
| **Preflight tokens for irreversible sends** | An agent can be wrong in one tool call. The token binds a send to a preview the operator can read, dies on any edit, and is single-use. | A `confirm: true` flag — an agent satisfies it in the same breath as the mistake. |

## 🤖 MCP server

`POST /mcp/<MCP_PATH_SECRET>` — the whole mailer as ~93 tools, plus resources and prompts.
Mounted ahead of the Cloudflare Access gate in `worker.tsx`, because an agent has no browser to
complete an Access login in. It authenticates itself instead:

1. **Path secret** — constant-time compare against `MCP_PATH_SECRET`. A miss returns 404, not
   403: an unguessed URL should look like nothing is there.
2. **Bearer key** — `api_keys.scope = 'admin'`. Existing transactional keys are `'send'` and
   cannot reach MCP.
3. **Per-tool guards** — preflight tokens on irreversible sends, `MCP_ALLOW_SEND` as a global
   kill switch (off in production by default), `confirm_*` echo arguments on the few tools that
   destroy history.

Every call — including refusals — writes an `mcp_calls` row. Workers logs expire in a week and
this is automation operating unattended, so the audit trail has to be in D1.

`mcp/tools/*.ts` are thin wrappers over `core/`. They hold no domain logic: anything an MCP tool
needs that the admin UI already did was pulled down into `core/` first, so there is exactly one
implementation of every rule. `db_query` is the deliberate exception — SELECT-only, single
statement, 500-row cap (`mcp/sql.ts`), for the analytics questions no fixed tool anticipates.

Stripe reconciliation (`core/stripe.ts`) runs on a second cron (`17 9 * * *`) and through the
`stripe_*` tools. It does not decide attribution — it hands charges to `recordSale`, which
already dedupes on the charge id and resolves the campaign from the buyer's last touch. Runs are
recorded in `sync_runs` with a cursor, so a nightly job that silently did nothing is
distinguishable from one that silently failed.

## Not building (YAGNI)

Visual builder, multi-tenancy, self-run SMTP (all `/explore` outs), plus: A/B
testing, link-tracking domains, per-subscriber send-time optimization, read
replicas, D1 sharding. Volume is 5k–25k weekly — none of these earn their keep yet.

## Open questions
- ❓ Open/click tracking: pixel + redirect are ours to host, but do we want per-subscriber
  history or just per-campaign counts? Schema supports both; UI scope undecided.
- ❓ Double opt-in — is `status='pending'` → confirm email required, or import-as-active?
- ❓ Compliance floor (CAN-SPAM/GDPR consent records, unsubscribe SLA) — still TODO in PROJECT.md.
- ❓ Migration path from the current ESP: which one, and does history come with it?
- ❓ Markdown → HTML rendering and templating: which library, and does it run at send time
  or at compose time? (Send-time costs CPU per message.)
