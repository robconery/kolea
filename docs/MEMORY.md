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

## 2026-08-19 — commerce mirror & purchase segmentation (branch `feat/sales-segmentation`)

Goal: know what customers bought and what they've spent, and segment on it. Neon (the
storefront's Postgres) is the source of truth; nothing in production was touched.

- **Mirror into D1, never query Neon at send time.** Why: segment evaluation runs inside the
  Worker on every broadcast materialization tick under D1's 1,000-query cap. It cannot join
  across to Postgres. Neon stays authoritative; D1 holds a rebuildable projection.
- **`purchases` is a separate table from `sales`, and must never be summed with it.** `sales` is
  campaign-attributed revenue this mailer earned. `purchases` is ten years of storefront history
  with no attribution — backfilling `campaign_id` onto a 2016 Shopify order from a last-touch
  that didn't exist would be inventing history.
- **`purchases` is keyed by email, not `subscriber_id`.** Why: 21,403 people have bought
  something, 13,766 are on the list. `sales.subscriber_id` is NOT NULL, so reusing it would have
  meant fabricating ~8k subscriber rows for people who never opted in — and at `status: 'active'`
  they'd receive the next broadcast. Email-keying also means a buyer who subscribes later arrives
  with their history already attached.
- **Offers are the grain, not products** (Rob's call — people buy offers). `orders.offer_id` is a
  direct FK, so no expansion step. `offer_products` is mirrored anyway (79 rows, two columns)
  because `imposter-video` ships inside 11 different offers and the "don't pitch what they
  already own in a bundle" case will eventually need it. Nothing reads it yet, by design.
- **Mirrored the `offers` table itself**, so the segment builder is a checklist of real titles
  with retired offers marked, rather than raw kebab-case slugs.
- **`purchase_stats` rollup, rebuilt wholesale, never incremented.** Why: without it, "spent over
  $100" aggregates 31k rows on every segment count and every page of a send. The rebuild SQL
  lives in `core/purchase-stats-sql.ts` and is shared verbatim by the Worker and the offline
  backfill — a rollup that disagrees with itself depending on who rebuilt it is worse than none.
- **`SegmentRule` gained flat purchase predicates** (`boughtOffers`, `notBoughtOffers`,
  `offerMatch`, `spentAtLeast/AtMostCents`, `orderCountAtLeast`, `purchasedAfter/Before`,
  `confidentPurchasesOnly`) — no nesting, matching the existing design. Every clause resolves as
  `subscribers.email IN (<indexed subquery>)`, never a join.
- **Carried `confidence` from Neon's `recovered_orders`.** 5,044 of the 31,385 orders are
  reconstructed from old records; 1,237 of those resolved to nothing. `confidentPurchasesOnly`
  exists so a mail that tells somebody what they've spent can exclude the guesses. Joined via a
  `max()` scalar subquery, not a join — `order_number` has no unique constraint over there and a
  fan-out would silently double someone's lifetime spend.
- **`fmtDay` added alongside `fmtDate`.** Order history reaches back to 2015 and `fmtDate` omits
  the year.
- **The backfill script is local-only with no `--remote` flag at all.** A full-refresh rebuild
  pointed at production deserves its own reviewed script, not a flag on this one. It reads Neon
  through `psql --csv` rather than adding a Postgres driver to a Worker project.

Loaded locally: 31,385 orders / 21,403 buyers / $1,254,107.10 gross. **8,122 buyers (59% of the
list) are reachable, worth $542,432** — the number that justifies the whole feature.

Still open: the scheduled Worker-side sync (`@neondatabase/serverless`, watermarked, needs
`sync_runs.kind = 'neon'`); purchase-driven auto-tagging, which must NOT go through `addTags` on
a backfill or it fires `tag_added` enrollment for thousands of people; and a read-only Neon role —
the `NEON_URL` currently in `.dev.vars` is `neondb_owner`, i.e. full write on the live store.

## 2026-08-19 — Store section & segment suggestions (same branch)

Rob's call: the commerce work deserves its own top-level tab, and he's fine with this growing
into a CRM.

- **Store promoted to a top-nav section** with its own `StoreTabs` (Overview / Offers /
  Customers / Segment ideas), rather than a fourth audience tab. Why: the audience screens are
  about list hygiene — people, facts, questions. This is about people *as customers*, and it has
  four screens' worth to say.
- **Two predicates added that the data demanded**: `hasPurchased` (the customers /
  not-yet-customers split — the one rule no list of offer slugs can express, since an order may
  carry no `offer_id`) and `orderCountAtMost` (so "bought exactly once" is real rather than a
  caption on a rule that doesn't say it). `hasPurchased` tests `purchases` directly, not the
  rollup — "has this person ever paid me" should not depend on a rebuild having run.
- **`core/segment-ideas.ts` proposes segments from behaviour, not hunches.** Lifecycle and value
  shapes are fixed rules sized from the data; the upsell ideas are derived from a co-purchase
  self-join restricted to reachable people, ranked by attach rate × remaining audience, with
  floors (≥50 owners, ≥100 unsold, ≥12% attach) so coincidence doesn't get promoted to insight.
  Every idea is sized with `countSegment` — the same function a broadcast uses — so a suggestion
  can never advertise an audience the send won't produce. Ideas matching nobody are dropped.
- **The big-spender threshold is derived, not hardcoded** (~top decile of reachable customers,
  rounded to a human number). A fixed $200 means something different on a list selling $30 books.
- **Ideas can create a segment, and that's the only write in the section.** Rules arrive as JSON
  in a hidden field and are rebuilt field-by-field by `safeRule` rather than trusted wholesale —
  a stray key must not end up persisted in a rule that later decides who a broadcast reaches.
  Creating a segment is not sending to it.
- **`Bar` is a styled div.** No chart library, no canvas, no script — the admin ships zero JS
  outside the two compose screens and this wasn't worth breaking that for.
- Fixed: the "live offers" stat was counted from the order leaderboard, which only knows offers
  that have *sold* — it read 11 of 39 instead of 13 of 52. Now read from the catalogue, and the
  overview names live offers that have never sold (currently *Working with a Massive Codebase*
  and *Upgrading a Legacy Application*).

Worth Rob's attention: **$1,254,107 all time, but $17,277 across the last 12 months (266 orders)**,
and only 8 reachable people bought anything in the last 90 days. The list is 8,122 customers and
5,644 who have never bought — the store's history is large and its present is quiet.

## 2026-08-19 — the dashboard (same branch)

Rob: make the 12-month figure a real chart, the list composition a pie, and go wild — "this
should be the actual dashboard".

- **Charts are server-rendered SVG in `web/charts.tsx`.** No charting library, no client script:
  the admin ships zero JS outside the two compose screens and a dashboard is not worth breaking
  that for. Tooltips are native `<title>` elements (free, keyboard- and screen-reader-reachable)
  and every chart is backed by a real table on the same page, so no value is reachable only by
  hovering.
- **Colours are the validated data-viz blue ramp, not the app accent.** The accent means
  "interactive" everywhere else in this UI and a bar that looks clickable isn't. The four donut
  steps were run through the palette validator in ordinal mode — monotone lightness, visible step
  gaps, light end at 2.11:1 on white — rather than eyeballed.
- **The tiers are ordinal, so the donut ramp is ordinal too** (one hue, light→dark = buys more
  often). Four categorical hues would have thrown away the ordering the tiers exist to show.
  Four slices, not two — the interesting story is the gap between one-time and repeat buyers,
  and a customers-vs-not split hides it entirely.
- **`core/insights.ts` splits every query by scope — storefront-wide vs reachable — and says
  which.** Mixing them produces a dashboard that overstates every opportunity, because two thirds
  of the buyers can't be emailed. The KPI tiles are two separate cards for the same reason.
- **`revenueByMonth` gap-fills from a calendar walk**, not from the rows that exist: a month with
  no sales is data, and dropping it compresses the axis so a quiet stretch reads as continuous
  trading. The current (partial) month is labelled as such under both charts.
- **Median, not mean, for the gap to a second purchase** — a few people who bought twice eight
  years apart drag an average into meaninglessness.
- **`tagLift` is the most useful thing on the page**: share of each tag's people who have ever
  bought, against the 59% list-wide rate. Tags under 100 people are excluded — a perfect rate
  across six people is noise wearing a suit.
- **Home (`/`) now leads with the commerce dashboard** and keeps the operational half (provider,
  dev controls, consent, recent messages) below it. Nothing was removed: the dev buttons and the
  consent story still needed a home, and deleting them to make room would have traded one useful
  page for another.
- Fixed while looking at the rendered output (the reason to render and look): single-letter month
  labels read "M A M J J"; the SVG was letterboxing itself inside its card (`width:100%` plus a
  fixed `height` makes `xMidYMid meet` scale to the height and centre); a viewBox much narrower
  than the render width magnified everything past the 24px bar cap; and the tag rows linked to an
  empty new-segment form instead of the filtered subscriber list.

Noticed in the data, for Rob: **`Top Shelf` and `Top Shelf Import` are duplicate tags** — same 400
people, same 96% buy rate, same $64,315. Candidates for `tag_merge`.

## 2026-08-19 — Abyssal redesign (left rail, real charts)

Full visual redesign on `feat/abyssal-redesign`. The brief: the top nav had outgrown itself, and
the admin should be somewhere you want to sit, not a form.

- **The nav moved to a fixed left rail** grouped Dashboard / Audience / Mail / Money / System.
  It is a floating glass panel, not a flush sidebar, and its open state on narrow screens is a
  `<input type="checkbox">` + sibling selectors — so the drawer, the scrim, and the
  hamburger→X morph all work with JavaScript off. The admin still ships zero JS outside the
  composer and the two charting screens.
- **The look is "Abyssal"**: deep water at the bottom of the page, sunlight raked through the
  surface, caustics, grain, and a few drifting motes — all in one fixed `pointer-events:none`
  layer behind everything, animated only via `transform`. `backdrop-filter` is confined to the
  rail and the mobile bar; putting it on scrolling content repaints every frame.
- **Every card is a double bezel** — a lit glass tray with a darker plate inset 6px inside it,
  built as a `::before` so the existing `.card-h` / `.card-b` markup did not have to change.
  That is why the redesign is ~one stylesheet plus a shell rewrite: the class vocabulary
  (`card`, `stat`, `pill`, `btn`, `tabs`, `note`, `empty`) was already good, so it was restyled
  rather than replaced, and all six admin screens came along for free.
- **Charts are ApexCharts now**, not hand-rolled SVG. Server-configured, client-rendered: a
  chart is a `<div data-chart="{...}">` carrying a complete JSON spec, and `/charts.js` turns
  every one of them into a drawing. The bundle is large (~970KB raw), so `Layout` only links it
  on the screens that plot something. Every chart is still backed by a real table on the same
  card.
- **The ordinal ramp survived the repaint** (`#a5f3fc → #38bdf8 → #6366f1 → #8b5cf6`, light→deep).
  Donut slices fall toward a *darker version of themselves* rather than toward a shared light:
  Apex's plain `shadeIntensity` washes every slice toward the same value and flattens exactly the
  ordering the tiers exist to show.
- **The composer stays on white paper inside a dark tray.** Mail lands on paper in somebody
  else's client; composing against a dark canvas would mean writing blind to the contrast people
  actually read at. The chrome around it — toolbar, slash menu, bubble bar — went dark, because
  that chrome belongs to the app, not to the mail.
- **Reveals are a staggered CSS entrance, deliberately not a `view()` scroll timeline.** Tried the
  timeline first; a card taller than the viewport never finishes its entry range, so the
  subscribers table sat there permanently half-faded and blurred. A fixed-duration keyframe
  always completes.
- Verified against the running app at every step (screenshots at 1440 and 414), and the 33-check
  editor smoke suite still passes with no JS errors.

## 2026-08-19 — The flow pass (no containers)

First cut of the redesign put everything in glass trays — cards with a bezel, a floating rail
panel, a 1,080px column. Rob's verdict: *"it looks like someone took paste and glued some pictures
onto the screen."* Correct, and worth writing down.

- **There are no containers now.** Not a card, not a panel, not a sidebar with a wall around it.
  Every region sits directly on the water, and the only thing separating two of them is a
  one-pixel gradient rule that fades out before it reaches either end. **A rule that fades has no
  corners, and without corners nothing reads as a window pasted onto the page.** Whitespace does
  the rest.
- **`.card` stopped being a container and became a band of the page**: one hairline above it, air
  around it, nothing else. Same markup, so every screen came along unchanged.
- **KPI rows are divided, not boxed** — numbers in a row with vertical hairlines between them.
- **The layout is edge to edge.** No max-width on the shell; the gutter is
  `clamp(26px, 3.4vw, 64px)` and the content uses whatever the display gives it.
- **Except forms.** `.field`, `.row` and the composer cap at 1,040px. A 1,500px text input is not
  using the space, it is making somebody track a metre of empty box with their eye — and the
  composer's page is a preview of mail that lands about 600px wide. Data (tables, charts, KPI
  rows) still runs the full width.
- **Bar width is computed, not guessed.** Apex only takes a percentage of the band, so at full
  bleed twelve months became 70px slabs. The client measures the mount and asks for whatever
  percentage lands a 34px column.
- Bug worth remembering: `label{display:block}` lives in the `controls` layer, and the hamburger
  and drawer scrim are `<label>` elements declared in the `shell` layer. **Cascade layers beat
  specificity**, so the generic rule silently reset both. `label:not(.burger):not(.scrim)`.

