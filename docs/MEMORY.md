# 🧠 MEMORY — big-mailer

Decision log for work done with Claude. Curated by `/document`, appended by every phase command.
Distinct from the `~/.claude` memory system.

Format: `## YYYY-MM-DD — title` + what was decided and why.

## Entries

## 2026-08-07 — /explore

- Scope is **broadcast + transactional in one service**, not two tools. Why: consolidating
  scattered sending is part of the point.
- **Single-user, never multi-tenant.** Why: it's Rob's own lists; SaaS surface is pure cost.
- **Drip sequences are in scope.** Why: an ESP replacement isn't credible without them.
- **No visual email builder.** Why: authoring stays plain markdown/HTML; a WYSIWYG is a
  project unto itself.
- **Will not run own SMTP or warm own IPs** — relay through an existing provider.
  Why: deliverability is the top risk and self-run mail servers make it worse, not better.
- MVP bar set at the **full loop (send + track)**, not send-only. Why: without bounce/
  complaint feedback there's no way to know deliverability is holding.
- Success is defined as **cancelling the paid ESP**, not as shipping a feature set.

## 2026-08-07 — /design

- **Cloudflare Workers + D1**, not Fly.io/VPS + SQLite. Why: Rob's call; D1 *is* SQLite so
  the schema stays Postgres-portable, and there are no servers to run. Rejected: persistent-disk
  hosting — real ops cost for no benefit at this volume.
- **Hono + JSX for the admin UI**, not Next.js. Why: runs as the Worker itself with no adapter;
  ~6 admin screens don't justify OpenNext's surface. Rejected: `@opennextjs/cloudflare` —
  community-maintained adapter, Node-runtime middleware still unsupported.
- **Cloudflare Queues for broadcast fan-out.** Why: 5k msg/sec, 100-message batches, per-message
  ack/retry and a DLQ — the exact shape of a broadcast. Rejected: looping sends in one invocation,
  which breaks on CPU/query limits and isn't resumable.
- **`EmailProvider` is a port; Resend is the first adapter.** Why: deliverability is risk #1, so
  the escape hatch must be cheap — swapping providers is one new file. Rejected: SES first
  (cheaper but SNS wiring + access review up front) and Cloudflare Email Service (zero extra
  vendor, but its bulk throughput limits are unpublished — can't bet the top risk on it).
- **Corrected a wrong assumption:** Cloudflare *can* now send to arbitrary recipients via Email
  Service once a domain is onboarded. It's viable, just unproven for bulk — so it stays a
  candidate adapter, not the default.
- **Cloudflare Access for auth**, no app-level login. Why: one operator; zero auth code to write
  or secrets to hold.
- **Materialize all `messages` rows before sending.** Why: makes a broadcast resumable, auditable,
  and idempotent across queue retries. Rejected: resolving recipients lazily at send time — a
  mid-broadcast crash becomes unrecoverable.
- **Suppression is keyed by email address, not by subscriber.** Why: transactional and bounced
  addresses may have no subscriber row; a `subscribers.status` flag would silently miss them.
- ⚠️ Open correctness risk logged: D1's foreign-key enforcement default is unverified. If FKs
  aren't enforced, every `ON DELETE` in the schema is decorative and `core/` must enforce it.
  → **Resolved 2026-08-07 during the build: D1 does enforce FKs.** See below.

## 2026-08-07 — build

- **Unsubscribe is scoped, not blanket** (Rob's requirement, and the product's reason to exist).
  Three independent levels: `sequence_optouts` (one series) → `subscribers.status` (newsletter)
  → `suppressions` (everything). Only an explicit "leave everything", a hard bounce, or a
  complaint may write the global level. Why: on Kit, leaving one sequence removes the person
  permanently, which is what drove the migration.
- **Sequence sends deliberately ignore `status = 'unsubscribed'`.** That flag is broadcast-scoped,
  so someone who left the newsletter still gets an onboarding series they opted into. This
  asymmetry is intentional and is the easiest thing for a future change to break.
- **Transactional mail ignores marketing consent** — blocked only by hard bounce or complaint,
  and rendered with no unsubscribe footer and no tracking. Why: a receipt is not marketing, and
  an unsubscribed customer still needs their download.
- **D1 enforces foreign keys** — confirmed by a real `FOREIGN KEY constraint failed` error, not
  by reading docs. Consequence: FK values from user input must be validated before insert.
  The public preference center hit exactly this and returned 500 on a stale sequence id.
- **`startBroadcast` is the only way to send a broadcast.** `sendBroadcastNow` ignores drafts by
  design, so callers that forget to promote the status silently send nothing — which is exactly
  what the seed script did before this was factored out.
- **Consent is re-checked immediately before the provider call**, not at enqueue time. Caught by
  the seed: the queue delivered after a subscriber opted out, and the message was correctly
  suppressed. Correct behaviour, but it means anything needing deterministic results must use
  `drainQueued` rather than the queue.
- **Local `console` provider writes rendered mail to `dev_outbox`** so the whole app is playable
  offline with nothing leaving the machine. Rejected: sending real mail in dev behind a flag.
- **`dispatch` falls back to inline sending when no queue binding exists.** Why: keeps
  `wrangler dev` working where Queues aren't provisioned, so the app is always runnable.

## 2026-08-08 — TipTap editor

- **TipTap v3 (3.29.2), vanilla JS, not React.** Why: the app is server-rendered Hono/JSX and
  the vanilla API is first-class; a React runtime would be dead weight for one screen.
- **DragHandle and NodeRange are MIT in v3** — they were Pro in v2, so Notion-style block
  editing needs no paid dependency. Only Comments, AI, and DOCX/PDF export remain Pro, and
  none are used. Verified against the live npm registry, not memory.
- **Wrote a hand-rolled TipTap-JSON → email-HTML renderer** (`core/render-doc.ts`) instead of
  using `@tiptap/html`. Why: its server entry point requires `happy-dom`, which is unsupported
  inside `workerd`. Upside anyway — the walker inlines every style (Gmail strips `<style>`) and
  emits nested tables for buttons (Outlook ignores padding on `<a>`), which generic HTML wouldn't.
- **Slash menu is custom, built on `@tiptap/suggestion`.** Why: TipTap publishes no slash-command
  package; their own docs call it an unmaintained experiment and point at this exact pattern.
- **Two email-specific custom nodes:** `emailButton` (CTA, label as *inline content* so it's typed
  in-document and the href lives in the bubble menu) and `mergeTag` (personalization as a node,
  not raw `{{first_name}}` text — a typo there mails "Hi {{frist_name}}" to the whole list).
- **`body_json` added alongside `body_md`; markdown is converted on load** (`core/md-to-doc.ts`),
  never migrated in bulk. Why: the editor only reads JSON, so without conversion a legacy
  markdown broadcast would open as an empty editor and the first save would erase it. The
  converter also upgrades `{{field}}` text into real mergeTag nodes.
- **R2 for image uploads, not S3** (Rob's call). Native binding needs no credentials, which is
  what makes uploads work in `wrangler dev` offline. Uploads are operator-only; *serving* is
  public because the URLs go into email.
- **Upload MIME allowlist, not blocklist.** Why: an uploaded SVG can carry script and these
  files are served from our own origin.
- **Separate tsconfig for `src/client`.** Why: the browser bundle needs DOM types and must not
  see `@cloudflare/workers-types`, whose `Response`/`Headers` shadow the DOM ones and make
  `element.append(...)` resolve to the wrong overload.
- **Curated lowlight language set instead of `common`** — 15 grammars rather than ~40, roughly
  halving the bundle (226KB gzipped, loaded only on the two compose screens).
- **Sequence delays are days, not minutes** (`delay_days`), first step defaulting to 0 and later
  steps to 1. Why: a drip is authored in days, and storing minutes while only ever writing
  multiples of 1440 lies about the precision. Migrated as add-then-drop across two migrations
  (drizzle-kit's rename prompt needs a TTY), with a conversion that rounds any sub-day delay
  **up** to 1 rather than collapsing it to 0.
- **Added a local-only `Fast-forward the clock`.** Why: day-scale delays make a multi-step
  sequence impossible to exercise locally — it rewrites `next_run_at`, which would be falsifying
  history anywhere real, so it's gated behind DEV_AUTH_BYPASS.
- **Added a browser smoke test** (`scripts/smoke-editor.mjs`, `bun run smoke`) driving real
  Chromium. Why: a renamed extension option fails silently in the browser and the body field
  just never saves — nothing server-side can catch that. 33 checks.
