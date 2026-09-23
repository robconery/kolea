---
name: onboard
description: >-
  Welcome someone who just cloned Kōlea and get them running: a local tour in
  two minutes, or a full production install on their own Cloudflare account
  from nothing but a Cloudflare API token. Interviews them one question at a
  time, fills in wrangler.jsonc from wrangler.template.jsonc, creates D1, R2,
  Queues and the Cloudflare Access apps, wires Resend's DNS and webhook,
  pushes secrets, and deploys only when they say so. Use when the user types
  /onboard, or asks to set up, install, configure, deploy for the first time,
  or "get this running".
---

# 🐦 /onboard

You are welcoming someone to Kōlea. They have just cloned the repo. They may
know nothing about Cloudflare. By the end they should either be looking at it
locally, or have it live on their own domain, having typed very little.

## 🧭 How to run this interview

- **One question per message.** Ask, wait, then ask the next. Never stack two
  questions in one message. Use `AskUserQuestion` whenever the answer is a
  choice; ask plainly in text when it is free-form (a name, a hostname).
- **Offer a default for everything** you can derive: `list.<their domain>` for
  the admin host, their sending address as the login address, and so on. "Press
  enter for `list.example.com`" beats an open question.
- **Say what you're about to do before you do it**, in one line, and what it
  costs if it's slow.
- **The script does the work.** `bun scripts/onboard.ts <command>` holds every
  API call and every file write. Don't improvise `curl` or hand-edit
  `wrangler.jsonc`. If a command fails, read its message out to the person in
  plain words and fix the cause. Don't paper over it.
- **Resume, don't restart.** Answers live in `.onboard/state.json`, secrets in
  `.onboard/secrets.env` (both gitignored, secrets mode 600). Start every run
  with `bun scripts/onboard.ts status`. If there's progress, say what's done and
  pick up at the first thing that isn't.
- Record each answer as soon as you have it:
  `bun scripts/onboard.ts set KEY=value` (quote values with spaces).
  Secrets go through `bun scripts/onboard.ts secret KEY=value`, never `set`.

## 🚨 Hard rules

These come from `CLAUDE.md` and they are not negotiable here either.

- **Onboarding never sends email.** Not a test, not a "just to check". The
  person does their own first test send from the admin, to themselves, after
  you hand over. Nothing you run should reach a provider's send endpoint.
- **Nothing reaches production without an explicit yes, right then.** Before
  `migrate`, `deploy` and `secrets`, show what's about to happen and ask. An
  earlier yes doesn't carry over.
- **Always go through the script** (it uses `--env production`). A bare
  `wrangler deploy` publishes the admin console with no login.
- **Never overwrite the upstream install.** If `status` or `render` reports the
  upstream `wrangler.jsonc` belongs to the account the token opens, stop: this
  is Rob's own production, not a fresh clone.
- **Never echo a secret back** into the conversation once it's stored. Say
  "saved" and move on. The single exception is the admin API key that `seed`
  prints once; they need to copy it.
- **If they paste a token into chat, that's allowed.** Also offer the
  alternative: open `.onboard/secrets.env` in their editor and add the line
  themselves, then say "done".

## 1 · Welcome

Open with a short welcome. Four or five lines at most:

> 🐦 Welcome to **Kōlea**: broadcasts, drip sequences, transactional mail and a
> blog, all running in one Cloudflare Worker you own. The thing that makes it
> different is that unsubscribing is *scoped*: leaving one series doesn't take
> someone off your newsletter.
>
> I'll ask one question at a time. You can stop whenever you like and pick up
> later with `/onboard`.

Then run `status`. Then the first question.

## 2 · Local or live?

`AskUserQuestion`: **"Where do you want to start?"**

- **Look around locally (Recommended)**: two minutes, mails nobody, no account needed.
- **Go live on my own domain**: about 30 minutes plus DNS waiting. Needs a
  Cloudflare account and a domain.

### 🏝 Local

1. `bun install` if `node_modules` is missing.
2. `bun scripts/onboard.ts local`: writes a minimal `.dev.vars` (only if
   there isn't one already) and applies migrations to the local D1.
3. Start `bun run dev` in the background. Tell them to open
   <http://localhost:8787>, click **Seed demo data**, then read the
   **Outbox**. Point them at README § "A tour of the console" for what each
   screen is for, and § "Try the thing it's for" for the five-click demo of
   scoped consent.
4. Ask whether they want to go live now or later. Later is a fine answer.
   Tell them `/onboard` picks up where they left off.

### 🚀 Live: continue below

## 3 · Before we start

Check the three things you can't do for them. Ask one at a time, and stop
with clear instructions at the first "no":

1. **A domain on Cloudflare.** Its nameservers must point at Cloudflare. If
   they don't have one: <https://dash.cloudflare.com> → *Add a domain*. It can
   take a few hours to activate. Come back after.
2. **The Workers Paid plan ($5/month).** The free plan caps each request at
   50 database queries and 10 ms of CPU, and Kōlea's sending can't fit inside
   either, even for a small list. <https://dash.cloudflare.com> → *Workers &
   Pages* → *Plans*.
3. **A Resend account** at <https://resend.com>. They can sign up free and
   verify their domain in this flow, but be straight about it: the free tier
   stops at 100 emails a day, so any broadcast to more than 100 people needs
   Resend Pro ($20/month). They can upgrade before their first real send;
   they don't need to now.

If they ask what it all costs, or hesitate at a price, point them at README
§ "How much is all of this going to cost?". Don't restate the numbers from
memory.

## 4 · The Cloudflare API token

This is the only Cloudflare credential. Tell them exactly this:

> Open **<https://dash.cloudflare.com/profile/api-tokens>** → **Create Token**
> → **Create Custom Token** (at the bottom). Name it `Kōlea onboarding` and add
> these permissions:
>
> | Level | Permission | Access |
> |---|---|---|
> | Account | Workers Scripts | Edit |
> | Account | D1 | Edit |
> | Account | Workers R2 Storage | Edit |
> | Account | Queues | Edit |
> | Account | Access: Apps and Policies | Edit |
> | Account | Access: Organizations, Identity Providers, and Groups | Read |
> | Account | Account Settings | Read |
> | Zone | Workers Routes | Edit |
> | Zone | DNS | Edit |
> | Zone | Zone | Read |
> | User | User Details | Read |
> | User | Memberships | Read |
>
> Under **Account Resources** choose your account. Under **Zone Resources**
> choose the domain you'll use. Leave **Client IP filtering** empty and set a
> TTL if you like. You can revoke the token the moment we're done.
> **Create Token** → copy it. Cloudflare shows it once.

Store it: `bun scripts/onboard.ts secret CLOUDFLARE_API_TOKEN=<token>`.

Run `bun scripts/onboard.ts verify`. It prints the accounts the token can see
and one ✅ or ❌ per capability. If there's more than one account, ask which
(`AskUserQuestion`) and `set CLOUDFLARE_ACCOUNT_ID=<id>`. If anything is ❌,
name the missing permission and have them **edit** the token (they don't need
a new one), then re-run `verify`.

If `verify` says **Zero Trust isn't set up**, walk them through it once: <https://one.dash.cloudflare.com>
→ pick a team name (this becomes `<team>.cloudflareaccess.com`) → choose the
**Free** plan. Cloudflare asks for a card even on Free. Then re-run `verify`.

## 5 · Who you are

One question each, in this order. `set` each answer immediately.

| Ask | Key | Default / notes |
|---|---|---|
| Your name, as it appears in the From line | `FROM_NAME` | |
| The address you send from | `FROM_EMAIL` | Must be on a domain they own and control DNS for |
| The address you log in with | `OPERATOR_EMAIL` | Default `FROM_EMAIL`. Cloudflare Access emails a one-time code here |
| Which domain (from the list `bun scripts/onboard.ts zones` prints) | `ZONE` | Usually the domain of `FROM_EMAIL` |
| The admin console's hostname | `ADMIN_HOST` | Default `list.<ZONE>` |
| Do you want the public site (a blog of everything you send)? | | `AskUserQuestion`: yes / not now |
| ↳ Its hostname | `SITE_HOST` | Default `<ZONE>` only if nothing's there; otherwise suggest `blog.<ZONE>` |
| ↳ The site's name | `SITE_TITLE` | |
| ↳ One line under the name | `SITE_TAGLINE` | |
| ↳ A few sentences about you, for the front page | `SHORT_BIO` | Optional. Skip is fine |
| ↳ Links to you elsewhere | `SOCIAL_<KEY>` | Optional. Keys: website, github, linkedin, x, mastodon, bluesky, youtube |

⚠️ Explain once, when they give `ADMIN_HOST`: **this hostname is baked into
every tracking link, unsubscribe link and image in every email at send
time.** Changing it later breaks mail that has already gone out. It's worth a
second's thought.

Then run `bun scripts/onboard.ts preflight`. It checks that the zone exists
and that neither hostname already has DNS records. If one does, **don't delete
anything yourself.** Show them what's there, and explain that Cloudflare won't
attach the Worker to a hostname already in use. If it's serving something
(an old landing page, a previous ESP's links), repointing it breaks those links
in mail already sent. Let them choose another hostname or remove the records
in the dashboard themselves.

## 6 · Build the Cloudflare side

Say what's coming ("creating the database, two storage buckets, two queues and
the login protection; about a minute"), then run in order:

1. `bun scripts/onboard.ts provision`: D1, R2 ×2, Queues ×2. Idempotent. It
   reuses anything that already exists by name.
2. `bun scripts/onboard.ts access`: one **Allow** app on `ADMIN_HOST` for
   `OPERATOR_EMAIL`, plus the eight **Bypass** apps (`/t/*`, `/f/*`, `/p/*`,
   `/d/*`, `/media/*`, `/api/*`, `/webhooks/*`, `/mcp/*`). Explain in one
   sentence why: *tracking pixels, unsubscribe pages and signup forms have to
   open for everyone, and each of those paths does its own checking.*
3. `bun scripts/onboard.ts render`: writes `wrangler.jsonc` from
   `wrangler.template.jsonc`. Show them the `git diff --stat` and mention that
   the file is now theirs. It'll conflict on a future `git pull` from upstream,
   and they should keep their side.

## 7 · Mail: Resend

1. Ask for a Resend API key: <https://resend.com/api-keys> → **Create API
   Key** → permission **Full access** (onboarding needs it to add the domain
   and the webhook). Tell them they can swap it for a *Sending access* key
   later with `bunx wrangler secret put RESEND_API_KEY --env production`.
   `secret RESEND_API_KEY=…`.
2. `bun scripts/onboard.ts resend-domain` adds the sending domain to Resend
   and writes its SPF/DKIM records, plus a monitoring-mode DMARC record if
   there isn't one, straight into their Cloudflare DNS. It then asks Resend to
   verify.
3. `bun scripts/onboard.ts resend-webhook` points Resend's delivery, bounce
   and complaint events at `https://ADMIN_HOST/webhooks/resend` and saves the
   signing secret. One sentence on why it matters: *without it, hard bounces
   and spam complaints never suppress anyone, and your sender reputation
   quietly drains.*
4. `bun scripts/onboard.ts resend-status`. Verification usually takes a few
   minutes, sometimes longer. If it isn't verified yet, don't wait on it.
   Carry on. `render` sets `EMAIL_PROVIDER=console` until the domain
   verifies, so the deploy is safe either way. Re-run `resend-status` and
   `render` before handing over.

## 8 · Optional extras

`AskUserQuestion` with `multiSelect: true`: **"Want any of these now? All can
be added later."**

- **Stripe**: revenue attributed to the mail that earned it. Needs a
  *restricted* key (read-only: charges, refunds, customers, products, prices)
  → `STRIPE_SECRET_KEY`. Then a webhook endpoint at
  `https://ADMIN_HOST/webhooks/stripe` → its `whsec_…` →
  `STRIPE_WEBHOOK_SECRET`. They create the endpoint themselves in the Stripe
  dashboard. Onboarding doesn't touch Stripe.
- **Unsplash**: stock photos on the publishing screen. The **Access Key**
  (not the Secret key) from <https://unsplash.com/oauth/applications> →
  `UNSPLASH_ACCESS_KEY`.
- **AI writing help**: a key from <https://openrouter.ai/settings/keys>, with a
  credit limit set there → `OPENROUTER_KEY`.

One key per message. `MCP_PATH_SECRET` is generated for them. They don't
need to ask for it.

## 9 · Push to production

Recap in a short table: hostnames, from line, login address, provider
(`resend` or `console` and why), which extras are on. Then ask, on its own:

**"Ready to push this to production?"** (yes / not yet)

On yes, run in order, reporting each in one line:

1. `bun scripts/onboard.ts migrate`: creates the tables in the remote D1.
2. `bun scripts/onboard.ts deploy`: typecheck, build, deploy with `--env production`.
3. `bun scripts/onboard.ts secrets`: pushes everything in `secrets.env`
   that the Worker reads (never the Cloudflare token).
4. `bun scripts/onboard.ts seed`: writes their profile, creates the
   `newsletter` signup form the site's subscribe box posts to, and mints the
   first **admin API key**. It prints the key once. Tell them to save it in a
   password manager now.
5. `bun scripts/onboard.ts check`: confirms the admin host asks for a login,
   and that the public paths (`/p/`, `/t/open/`) don't.

A new custom domain can take a minute or two to get its certificate. If
`check` fails on TLS or DNS, wait a minute and run it again before debugging.

## 10 · Hand over

Finish with:

- 🔗 **Admin:** `https://ADMIN_HOST`. Cloudflare will email a login code to
  `OPERATOR_EMAIL`.
- 🔗 **Site:** `https://SITE_HOST` (if they have one). It says "nothing
  published yet" until the first broadcast goes out.
- 🤖 **Drive it from Claude Code:** the `claude mcp add …` line that
  `seed` printed. Suggest `--scope local`.
- ✅ **Their first-send checklist.** These are theirs to do, not yours:
  1. Write a draft broadcast → **Send test** (it can only reach
     `FROM_EMAIL`). Check the From line, the images and the footer.
  2. Click the unsubscribe link in it. It should offer the *narrow* choice
     first.
  3. After a week of clean DMARC reports, tighten DMARC from `p=none` to
     `p=quarantine`.
  4. ⚠️ Add a postal address to their footer or signature if they mail anyone
     in the US or EU. CAN-SPAM requires one and Kōlea doesn't add it for them.
- 🧹 Offer to revoke the Cloudflare token now that it's done
  (<https://dash.cloudflare.com/profile/api-tokens>), and to delete
  `.onboard/secrets.env`. Keep `.onboard/state.json`; it's harmless and makes
  the next `/onboard` a resume.
- 📖 README § "A tour of the console" explains every screen. `docs/INSTALL.md`
  § Troubleshooting covers what goes wrong.

## 🩺 When something fails

| Symptom | What to do |
|---|---|
| `7403` / "account is not valid or not authorized" | Retry once (it can be transient). Then check the token's Account Resources include this account. The script already strips `CLOUDFLARE_API_KEY` from the environment |
| `10000 Authentication error` on one capability | That permission is missing from the token. Edit the token, add it, re-run `verify` |
| Queue create fails mentioning the plan or a quota | Workers Paid isn’t active on this account |
| Deploy: `code: 100117` | The hostname has DNS records. Back to `preflight`; let them decide |
| `check`: admin host loads without a login | **Stop.** Access isn't in front of it. Re-run `access`, then `check`. Don't hand over until this passes |
| `check`: `/p/` or `/t/` redirects to a login | A Bypass app is missing. Re-run `access` (idempotent) |
| Resend domain stays `pending` | DNS propagation. Normal for up to an hour. `resend-status` re-checks |
