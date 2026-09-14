# 🛠 INSTALL — Kōlea

> Two paths. **[Run it locally](#-part-1--run-it-locally)** takes three commands
> and mails nobody. **[Deploy it for real](#-part-2--deploy-it-for-real)** takes
> about an hour, most of it waiting for DNS.
>
> Read [Part 2](#-part-2--deploy-it-for-real) end to end before starting it.
> There are two steps that are painful to undo.

---

## 📋 What you need

| For local | For production |
|---|---|
| [Bun](https://bun.sh) 1.1+ | Everything on the left, plus… |
| Node 18+ (only for `bun run smoke`) | A **Cloudflare account** |
| — | The **Workers Paid plan** — $5/mo. Queues are not on the free tier, and Kōlea cannot send without them. |
| — | A **domain on Cloudflare** (nameservers pointed at Cloudflare). Access can only protect a hostname on a zone you control. |
| — | A **[Resend](https://resend.com) account** with a verified sending domain, or another provider you write an adapter for. |
| — | Optional: a **Stripe** account, for revenue attribution. |

No database to install, no Redis, no server. D1, R2, and Queues are all
Cloudflare-managed, and `wrangler dev` emulates all three locally.

---

## 🏝 Part 1 — Run it locally

```bash
git clone https://github.com/robconery/kolea.git
cd kolea
bun install
bun run db:migrate     # applies migrations to the local D1 database
bun run dev            # → http://localhost:8787
```

Open <http://localhost:8787> and click **Seed demo data**: twelve people, two
live series, a sent broadcast, and a draft that shows off every editor block.
Then open the **Outbox** to read the mail that "went out".

> ### 🔒 Nothing leaves your machine
>
> `EMAIL_PROVIDER=console` is the local default (set in `wrangler.jsonc`'s
> top-level `vars`). The console provider writes fully rendered mail — footer,
> merge tags, tracking links and all — to the in-app Outbox instead of sending
> it. No API key is needed, and there is no way to accidentally mail a real
> person while you poke at it.

Seeding also prints two API keys, once, in the flash message at the top of the
page. Copy them if you want to try the transactional API or MCP locally. They
are never shown again — only their SHA-256 hashes are stored.

### Local commands

| | |
|---|---|
| `bun run dev` | Build the client bundle, then serve on :8787 |
| `bun run watch:client` | Rebuild the editor bundle on change (run alongside `dev`) |
| `bun run typecheck` | Three passes: Worker, browser bundle, scripts. Must be clean. |
| `bun run smoke` | 33 real-Chromium checks against the editor. Needs `dev` running. |
| `bun run db:generate` | Generate a migration after editing `src/db/schema.ts` |
| `bun run db:migrate` | Apply migrations to the local D1 database |
| `bun run db:studio` | Drizzle Studio against the local database |

The dashboard has a **Fast-forward the clock** button (local only). Sequence
delays are in whole days, so a seeded series would otherwise never finish while
you watch. Fast-forward pulls every pending step to now and runs a tick — use it
and you'll watch step 2 skip the people who left that one series.

### 🔑 Local secrets

Copy the example file and fill in only what you need:

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` is gitignored. `.dev.vars.example` is not — **never paste a real
value into the example file.** Everything in `.dev.vars` is optional locally;
leave the file absent entirely and Kōlea runs in console mode with MCP and
Stripe switched off.

---

## 🚀 Part 2 — Deploy it for real

Once you deploy, this system can send email to real people. Work through these
in order.

### Step 0 — Read the two irreversible bits

Before anything else, know what you cannot take back:

> ### ⚠️ `PUBLIC_URL` is baked into every email at send time
>
> Tracking pixels, click links, unsubscribe links and image URLs are all
> rendered with `PUBLIC_URL` at the moment the mail is generated. Set it wrong,
> send a broadcast, and that mail is permanently broken in ten thousand inboxes.
> It cannot be fixed afterwards. Get this right *before* the first send.

> ### ⚠️ A bare `wrangler deploy` publishes an unauthenticated admin console
>
> The top-level `vars` in `wrangler.jsonc` carry `DEV_AUTH_BYPASS=true` so the
> app is runnable locally. Only `--env production` turns it off. `bun run deploy`
> hard-codes `--env production` for exactly this reason. **Do not work around
> it, and never run `wrangler deploy` without it.**

### Step 1 — Log in and pick your names

```bash
bunx wrangler login
```

Throughout this guide the Cloudflare resources are named `big-mailer` — that is
what the checked-in `wrangler.jsonc` uses, and the names are internal, so there
is no need to change them. If you do rename them, change **every** occurrence,
including the duplicates under `env.production`.

### Step 2 — Create the D1 database

```bash
bunx wrangler d1 create big-mailer
```

It prints a `database_id`. Put it into `wrangler.jsonc` in **both** places:

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "big-mailer",
                   "database_id": "PASTE-IT-HERE", "migrations_dir": "migrations" }],
```

> ### ⚠️ Wrangler environments do **not** inherit bindings
>
> Every binding declared at the top level must be repeated verbatim under
> `env.production`. Miss one and production deploys without a database, bucket,
> or queue — `env.DB` is simply `undefined` at runtime, and the first request
> 500s. The checked-in config already has both copies; keep them in sync.

### Step 3 — Create the bucket and the queues

```bash
bunx wrangler r2 bucket create big-mailer-media

bunx wrangler queues create big-mailer-send
bunx wrangler queues create big-mailer-dlq
```

R2 stores uploaded images; the `media` table is the catalogue that lets the
library list them without paging the bucket. The dead-letter queue has **no send
path** — its handler exists solely to mark a give-up as a row in D1, because a
message that quietly stopped existing is the worst failure mode a mailer has.

### Step 4 — Apply the migrations to production

```bash
bunx wrangler d1 migrations apply big-mailer --remote --env production
```

Never hand-write a migration. Edit `src/db/schema.ts`, then
`bun run db:generate` to have drizzle-kit produce one.

### Step 5 — Point it at your domain

In `wrangler.jsonc`, under `env.production`:

```jsonc
"workers_dev": false,
"routes": [{ "pattern": "list.example.com", "custom_domain": true }],
```

> ### ⚠️ Leave `workers_dev: false`
>
> Cloudflare Access can only protect a hostname on a zone you control. Leaving
> the `*.workers.dev` route enabled publishes an unauthenticated way straight
> around Access to your origin.

Then set the matching vars in the same block:

```jsonc
"vars": {
  "EMAIL_PROVIDER": "resend",
  "FROM_EMAIL": "you@example.com",
  "FROM_NAME": "Your Name",
  "PUBLIC_URL": "https://list.example.com",   // ⚠️ must match the route exactly
  "DEV_AUTH_BYPASS": "false",
  "MCP_ALLOW_SEND": "false"
}
```

#### Optional: the public site, on a second hostname

Kōlea can publish broadcasts as a blog. It runs from the same Worker on its own
hostname — `worker.tsx` splits on the request host before either router runs —
so it needs a second route and its own vars:

```jsonc
"routes": [
  { "pattern": "list.example.com", "custom_domain": true },
  { "pattern": "www.example.com",  "custom_domain": true }   // the public site
],
"vars": {
  // …the block above, plus:
  "SITE_URL": "https://www.example.com",   // ⚠️ must match the second route exactly
  "SITE_TITLE": "Your Publication",
  "SITE_TAGLINE": "One line, shown under the masthead and in the feed.",
  "SITE_AUTHOR": "Your Name",
  "SITE_FORM_SLUG": "newsletter"           // a `forms.slug`; omit to hide the signup box
}
```

**`SITE_URL` unset is the kill switch.** With no value, the public site does not
exist and every request goes to the admin app. That is the default.

> ### ⚠️ If that hostname already points somewhere
>
> `custom_domain: true` refuses to take over a hostname that has existing DNS
> records, and the deploy fails with `code: 100117`. Delete the old records
> first — **and know what they were serving.** Repointing a hostname that used to
> host your previous ESP's landing pages breaks every link to them, in every
> email you already sent. Export the records before you delete them.

Locally, the two hosts share one `wrangler dev`: `*.localhost` resolves to
127.0.0.1, so `SITE_URL` of `http://site.localhost:8787` gives you the site on
`site.localhost:8787` and the console on `localhost:8787`, from one process.
⚠️ `wrangler dev` does **not** reload `.dev.vars` — restart it after editing.

### Step 6 — Set up sending, and get the DNS right

Deliverability is the number one risk in self-hosting email. A mailer that lands
in spam is worthless no matter how well it's built.

1. Add your sending domain in Resend and publish the DNS records it gives you
   (SPF and DKIM). Wait for verification.
2. Publish a **DMARC** record. Start in monitoring mode:

   ```
   _dmarc.example.com   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@example.com"
   ```

   Move to `p=quarantine` and then `p=reject` once the reports are clean.
3. **Point Resend's webhook at `https://list.example.com/webhooks/resend`** and
   subscribe to delivery, bounce and complaint events.

> ### ⚠️ The webhook is not optional
>
> Without it, hard bounces and spam complaints never write `suppressions` rows.
> You keep mailing dead addresses and people who reported you, and your sending
> reputation degrades silently — the slow way to lose deliverability for your
> entire domain.

**Using something other than Resend?** Write one file in `src/providers/`
implementing the `EmailProvider` port — `name`, `send`, `sendBatch` and
`parseWebhook` — add a branch to `providerFor()` in `src/core/sending.ts`, and
point `EMAIL_PROVIDER` at it. Nothing in `core/` names a vendor; that's the whole
reason the port exists. See **Make it yours** in the README for the walkthrough.

### Step 7 — Push the secrets

Secrets go in Cloudflare, never in `wrangler.jsonc` and never in
`.dev.vars.example`.

```bash
bunx wrangler secret put RESEND_API_KEY        --env production
bunx wrangler secret put RESEND_WEBHOOK_SECRET --env production

# MCP path secret — generate with: openssl rand -hex 24
bunx wrangler secret put MCP_PATH_SECRET       --env production

# Only if you're using Stripe attribution
bunx wrangler secret put STRIPE_SECRET_KEY     --env production
bunx wrangler secret put STRIPE_WEBHOOK_SECRET --env production

# Only if you want the Unsplash picker on the publishing screen.
# The "Access Key" from https://unsplash.com/oauth/applications — NOT the
# "Secret key" (that one is for OAuth user auth and returns 401 here), and not
# the numeric Application ID. Unset just hides the picker; upload still works.
bunx wrangler secret put UNSPLASH_ACCESS_KEY   --env production
```

`MCP_PATH_SECRET` must be a **secret, not a var**. Unset means the MCP endpoint
404s, which is the correct default — turn it on deliberately.

### Step 8 — Lock the console behind Cloudflare Access

The app holds no password. Cloudflare Access terminates identity at the edge and
forwards a signed JWT, which `src/web/auth.ts` verifies properly: signature
against the team's live JWKS (cached per isolate, forced refetch on an unknown
key id), `alg` pinned to `RS256`, plus audience, issuer, `exp` and `nbf`.
Presence of the header proves nothing and is never treated as proof.

**Create one Allow app**, then **eight Bypass apps**:

| App | Path | Policy | Why |
|---|---|---|---|
| Admin console | `list.example.com` | **Allow** — your email only | The operator UI |
| Tracking | `list.example.com/t/*` | **Bypass** — everyone | Open pixels and click redirects |
| Forms | `list.example.com/f/*` | **Bypass** — everyone | Signup posts from your own site |
| Preferences | `list.example.com/p/*` | **Bypass** — everyone | The reader's preference center |
| Downloads | `list.example.com/d/*` | **Bypass** — everyone | Lead-magnet files; the grant token is the auth |
| Media | `list.example.com/media/*` | **Bypass** — everyone | Images embedded in sent mail |
| API | `list.example.com/api/*` | **Bypass** — everyone | Bearer-key authenticated inside |
| Webhooks | `list.example.com/webhooks/*` | **Bypass** — everyone | Signature-verified inside |
| MCP | `list.example.com/mcp/*` | **Bypass** — everyone | Path secret + admin bearer key inside |

> ### ⚠️ This is the step people get wrong
>
> ### 🚨 If you run the public site, scope this Access app to the admin hostname
>
> The public site is a **different hostname**, not a bypassed path — being
> outside the Access application is the only thing keeping readers off a login
> screen. An Access app matching `*.example.com` takes the whole blog down, and
> it will look like a Worker bug. Match `list.example.com` exactly.
>
> One more, easy to miss: `public/robots.txt` disallows all crawling and the
> assets layer serves it on **every** hostname the Worker answers, ahead of your
> code. `assets.run_worker_first` in `wrangler.jsonc` lists that path so each
> host can answer for itself — the site allows crawling and links its sitemap,
> the console keeps the blanket disallow. Anything else you add to `public/`
> has the same trap waiting.

> Access matches **the most specific path first**, so the Bypass apps take
> precedence over the hostname-wide Allow. Protecting the whole hostname with a
> single Allow policy also protects the tracking pixel, the signup forms, the
> preference center, the download links, the embedded images, the webhooks, and
> MCP. That means **every tracking pixel in every email you have ever sent
> redirects to a login screen** — permanently, for mail already delivered — and
> readers who click unsubscribe are asked to log into your Cloudflare account.
> Each bypassed path carries its own auth or is public by design.

Now put the Access identity into `wrangler.jsonc` under `env.production.vars`:

```jsonc
"CF_ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",
"CF_ACCESS_AUD": "the-allow-app-s-audience-tag"
```

Both are required. `requireOperator` **fails closed**: if either is missing it
refuses everyone, including you. That is the correct direction to fail.

### Step 9 — Deploy

```bash
bun run deploy      # builds the client bundle, then wrangler deploy --env production
```

### Step 10 — Verify before you trust it

Work down this list. Do not send a broadcast until all of it passes.

- [ ] `https://list.example.com` prompts for Access, then loads the dashboard
- [ ] Logged out / in a private window, the same URL does **not** load
- [ ] `https://list.example.com/p/anything` returns a page, not a login screen
- [ ] `https://list.example.com/t/open/1.gif` returns a GIF, not a login screen
- [ ] The two cron triggers appear under the Worker in the Cloudflare dashboard
- [ ] **Settings** shows the provider as `resend` and the right `PUBLIC_URL`
- [ ] Send a **test send to yourself** from a draft broadcast. Check the sender,
      the images, the unsubscribe footer, and that clicking a link redirects
      correctly. `PREVIEW_EMAIL` (or `FROM_EMAIL`) is hard-coded as the only
      destination a preview can reach — a preview can never become a send to
      somebody else.
- [ ] Click the unsubscribe link in that test. It should land on the preference
      center with the narrow option pre-selected — not unsubscribe you from
      everything.
- [ ] Bounce test: send to a known-invalid address on your own domain and
      confirm a `suppressions` row appears

---

## 🔌 Part 3 — Optional integrations

### Transactional sending from your other apps

Mint a `send`-scoped key (see [Minting keys](#-minting-an-api-key-in-production)),
then:

```bash
curl -X POST https://list.example.com/api/send \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"customer@example.com","subject":"Your download","body":"Here it is.","idempotency_key":"order-1234"}'
```

Replaying the same `idempotency_key` returns the original result instead of
sending twice. Transactional mail ignores marketing consent entirely — it is
blocked only by a dead address or a spam complaint. A receipt isn't marketing,
and an unsubscribed customer still needs their download.

### Signup forms on your own site

Create a form in the admin console, then post a plain HTML `<form>` to it. No
JavaScript, no embed script, no hosted landing page:

```html
<form method="POST" action="https://list.example.com/f/newsletter">
  <input type="email" name="email" required>
  <button>Subscribe</button>
</form>
```

### Driving Kōlea from Claude Code (MCP)

The Worker serves an MCP server at `POST /mcp/<secret>` — **96 tools**, 4
resources and 4 prompts covering the whole mailer.

```bash
claude mcp add --transport http --scope local \
  --header "Authorization: Bearer $KOLEA_ADMIN_KEY" \
  kolea "https://list.example.com/mcp/$MCP_PATH_SECRET"
```

Three gates, cheapest first: an unguessable path secret compared in constant
time (a miss returns `404`, not `403` — a URL nobody guessed should look like
nothing is there), then an `admin`-scoped bearer key (transactional `send` keys
cannot reach it), then per-tool guards. Every call lands in `mcp_calls`,
including the refusals.

**`MCP_ALLOW_SEND` is `"false"` in production.** MCP can read and draft
everything but cannot put mail on the wire until you deliberately flip that var
and redeploy. Flipping it back is the instant off-switch. On top of that,
irreversible sends need a preflight token: single-use, 10-minute expiry, and
invalidated by any edit to the content or the audience.

> 💡 Tell your agent to read `kolea://conventions` before it touches consent.
> Scoped unsubscribe is not the shape anything trained on normal ESPs expects,
> and getting it wrong is exactly the failure Kōlea was built to avoid.

### Stripe → campaign attribution

Set `STRIPE_SECRET_KEY` (a **restricted** key, read-only on charges, refunds,
customers, products and prices) and `STRIPE_WEBHOOK_SECRET`. Point a Stripe
webhook endpoint at `https://list.example.com/webhooks/stripe`.

The webhook is the live path — a charge becomes a `sales` row within seconds.
The 09:17 UTC cron is the safety net: it walks the same charges again and books
whatever the webhook missed, then refreshes the product catalog. Both are
idempotent on the Stripe charge id, so re-runs and overlapping backfills are
harmless, and both write a `sync_runs` row so a nightly job that silently did
nothing is distinguishable from one that silently failed.

Without `STRIPE_WEBHOOK_SECRET` the endpoint fails closed with a 503 — an
endpoint that accepts unsigned bodies is an endpoint anybody can post fake
revenue to.

---

## 🔑 Minting an API key in production

There is deliberately no "create key" button in the admin console — keys are
minted by the seed route (local only) or by the `apikey_create` MCP tool. For
the very first key, which is what you need to *reach* MCP, insert it directly:

```bash
TOKEN=$(openssl rand -hex 18)
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)

bunx wrangler d1 execute big-mailer --remote --env production --command \
  "insert into api_keys (name, token_hash, scope, created_at)
   values ('MCP admin', '$HASH', 'admin', $(date +%s)000)"

echo "Your key: $TOKEN"     # stored nowhere — save it now
```

Only the SHA-256 hash is stored, so a leaked database still cannot be used to
post as you. Scope `send` reaches the transactional endpoint and nothing else;
`admin` also reaches MCP, which can rewrite the whole mailer — so `send` is the
default. After this, use `apikey_create` for everything else.

Revoke, don't delete: `mcp_calls.api_key_id` points at the row, and a revoked
key you can still see in a list is how you answer "did I turn that off?" months
later.

---

## 📥 Migrating a list in

> ### 🚨 Read this before importing anybody
>
> **Bulk imports must never go through `upsertSubscriber()`.** It fires
> `enrollOnSubscribe()`, so importing N people into a live `subscribe` sequence
> mails all N of them, immediately. Import as direct SQL — see
> `scripts/import-kit.ts` for the pattern — or pass
> `triggerSubscribeSequences: false`.
>
> Three more rules that make an import safe:
>
> - **Imported content arrives inert.** Land broadcasts as `status: 'sent'` with
>   `sent_at` set, and sequences as `is_active: 0`. The minutely tick only claims
>   `sending` or `scheduled`-and-due broadcasts, and every enrollment path gates
>   on `isActive`. Activating is a separate, deliberate act.
> - **`unsubscribed` is permanent.** No import may return somebody to `active`.
>   Consent only ever moves one way without the person asking.
> - **Import with `EMAIL_PROVIDER=console` first**, check the Outbox, then flip
>   the provider back.

`scripts/` has working importers for Kit (ConvertKit) subscribers and content,
and for a Neon-backed storefront. They are written for one specific setup — read
them as reference implementations, not as a general-purpose tool.

---

## 🩺 Troubleshooting

| Symptom | Cause |
|---|---|
| Every request 500s right after deploy | A binding missing from `env.production`. Wrangler envs don't inherit — `env.DB` is `undefined`. |
| Locked out of your own admin console | `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` is missing or wrong. `requireOperator` fails closed by design. Fix the var and redeploy. |
| Admin console loads with no login prompt | You deployed without `--env production`, so `DEV_AUTH_BYPASS` is still `true`. **Redeploy immediately.** |
| MCP endpoint returns 404 | `MCP_PATH_SECRET` unset, or the path segment doesn't match. A 404 on a wrong secret is intentional. |
| MCP returns 401 | The key is missing, revoked, or `send`-scoped. MCP needs `admin`. |
| An MCP send tool refuses | Expected. Either `MCP_ALLOW_SEND` is `"false"`, or you need a fresh preflight token — any edit to content or audience invalidates the old one. |
| Broadcast stuck in `sending` | Normal for a large list. It materializes across cron ticks under D1's 1,000-query cap, resuming from `cursor_subscriber_id`. Check `messages` count is rising. |
| Nothing sends at all | Queues not created, or you're on the free plan. Queues require Workers Paid. |
| Mail dead-lettering en masse | Provider rate limit. `max_concurrency` is pinned to 6 for this reason — one batch is one provider request, so batch concurrency *is* the request rate. |
| Bounces never suppress anyone | The provider webhook isn't pointed at `/webhooks/:provider`, or `RESEND_WEBHOOK_SECRET` is wrong. |
| Tracking pixels redirect to a login page | Missing Access **Bypass** app for `/t/*`. See [Step 8](#step-8--lock-the-console-behind-cloudflare-access). |
| Download links land on a Cloudflare login | Missing Access **Bypass** app for `/d/*` — the exact same mistake, one path over. Happened in production on 2026-09-12. Existing links start working the moment the Bypass app exists; grants point at the form, not at a session, so nothing needs re-sending. |
| Images in email are broken | `PUBLIC_URL` didn't match the real host at send time. Mail already delivered cannot be fixed. |
| Deploy fails with `Hostname … already has externally managed DNS records [code: 100117]` | The public site's hostname still has A/CNAME records from whatever served it before. Export them, delete them, redeploy. |
| The public site shows a Cloudflare login | Its hostname is inside the Access application. Access apps match by hostname; scope the Allow app to the admin host exactly. |
| The public site is empty, "Nothing published yet" | Correct until you publish something. Publishing is one deliberate act per post, on `/broadcasts/:id/publishing`. There is no bulk publish anywhere, by design. |
| The blog isn't being indexed | Check `https://yoursite/robots.txt`. If it says `Disallow: /`, the asset is shadowing the Worker — `assets.run_worker_first` needs `/robots.txt`. |
| The Unsplash picker doesn't appear | `UNSPLASH_ACCESS_KEY` isn't set, or it's the *Secret key* rather than the *Access Key* — the API returns 401 for the wrong one. `wrangler dev` also won't reload `.dev.vars`; restart it. |
| Editor body silently never saves | A renamed TipTap extension option. Nothing server-side catches this — run `bun run smoke`. |
| `typecheck` fails only in `src/client` | The browser bundle has its own tsconfig on purpose. workerd's `Response`/`Headers` shadow the DOM ones; the two must never share a config. |

---

## ⬆️ Upgrading

```bash
git pull
bun install
bunx wrangler d1 migrations apply big-mailer --remote --env production
bun run typecheck
bun run deploy
```

Migrations are additive and applied in order. Check `git log migrations/` before
a large jump, and take a D1 export first:

```bash
bunx wrangler d1 export big-mailer --remote --env production --output backup.sql
```

---

## 📚 Next

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it works, and the invariants you must not break
- [`SPEC.md`](SPEC.md) — numbered behavioral requirements
- [`PROJECT.md`](PROJECT.md) — the problem, and what is deliberately out of scope
