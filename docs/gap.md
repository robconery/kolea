# Gap analysis: Big Mailer vs Kōlea (kolea-pro)

What kolea-pro does that Big Mailer (the open source app, `robconery/kolea`) does not, so Big Mailer can be brought up to the same features as a single-host app on Cloudflare.

Checked 2026-11-21 by reading both codebases: kolea-pro `main` (Elixir, about 192k lines, about 180 tables) and Big Mailer `main` on Rob's Mac (TypeScript on one Worker with D1, about 48k lines, 46 tables, 110 MCP tools). Each row was checked with a code search of both. Rows marked **check** I could not settle from the code alone.

Sizes are rough guesses: **S** is a day or less, **M** a few days, **L** a week or more.

## Is there already a plan?

No. Nothing in kolea-pro (docs, branches, issues) or in Big Mailer describes a single-host or open source version of the Elixir app. Big Mailer's `docs/PLAN.md` is a record of what got built in August and September, with a short "Not done" list. Several items on it are still open and appear below (media library, double opt-in, API key screen, segment builder).

## Leave out: things that only exist because kolea-pro is a hosted service

These do not belong in a single-host app.

- Sign-up, waitlist, invite-only switch, accounts, staff console, impersonation
- Billing, plans, usage limits, referrals
- Abuse desk: probation, daily caps, canary sends, AI content screening and holds, the Standing screen
- Tenancy: `account_id` scoping, row-level security, the platform repo
- Per-tenant site slugs on a platform domain (`<slug>.kolea.pro`)
- Usage tracking of admin screens, "Send Rob a note"
- The free book-machine downloads (Resources), unless Rob wants them in the open source app

## Missing from Big Mailer

### Mail and sending

| Feature | What kolea-pro does | Size |
|---|---|---|
| Double opt-in | A form can require confirmation; the person stays pending until they click. Big Mailer's SPEC still lists it as a TODO. | M |
| Mailgun adapter | Big Mailer sends through Resend only. The provider port is one file, so a Mailgun adapter (with its webhook signature check) is small. | S |
| Sending domain setup | A screen to add a domain, show the DNS records, check them, and one-click add them to Cloudflare DNS. On a single host this is still useful, since the operator has the same Cloudflare account. | M |
| Custom tracking hostname | Opens and clicks on the sender's own subdomain instead of the app's host. | S |
| Machine-open detection | Apple Mail Privacy Protection and other prefetch opens are flagged and left out of reader counts. Big Mailer only weights opens low. | S |
| Sequence send-time window | A due step waits for a set window in the operator's time zone (for example 8am to 6pm). Big Mailer sends at the first cron tick after the delay. | S |
| Transactional templates | Stored subject and body by slug; an API call names the slug and fills `{{variables}}`. Big Mailer's API takes the whole mail each time. | S |
| Resend failed form replies | A form reply that failed to send can be sent again from the form screen and over MCP. | S |

### Audience

| Feature | What kolea-pro does | Size |
|---|---|---|
| Custom fields | Named, typed fields (text, number, date) with a screen to manage them, usable in segments and merge tags. Big Mailer stores an untyped `attributes` blob with no screen. | M |
| Clean up | Pick groups of people to prune (never opened, bounced, and so on), download a backup CSV, then delete. | S |
| Importers from other tools | Connect Kit, Ghost, Mailchimp or Drip and bring over the list and past mail, with the other tool's send totals kept for analytics. Resumable in the background. Big Mailer has CSV import only. On Cloudflare this needs Queues to resume across invocations. | L (about M per tool) |

### Public site and members

| Feature | What kolea-pro does | Size |
|---|---|---|
| Members and Premium | Readers sign in on the site by emailed link; Premium is a monthly or yearly paid subscription on the operator's Stripe; posts can be limited to members or Premium; a screen shows subscribers and which posts converted them. Nothing like it in Big Mailer. | L |
| Store checkout | Offer pages on the site that start a Stripe Checkout, with the converting post recorded. Big Mailer mirrors the Stripe catalog and records sales but never starts a checkout. | M to L |
| Testimonials | A `{{testimonial_link}}` in mail lets a known subscriber write one, confirmed by email, shown on a `/testimonials` wall, managed in the admin. | M |
| Topics | Topics as managed objects with their own pages and settings. Big Mailer has post tags used in URLs, but no topic management or MCP tools. | S |
| Media library | A screen listing every uploaded image, reusable across posts and mail. Big Mailer has the upload endpoint and no screen (open on its PLAN). | S to M |

### Money

| Feature | What kolea-pro does | Size |
|---|---|---|
| Sales history import | Upload a CSV of past sales so revenue and attribution cover the time before Stripe was connected. | S to M |

### Writing help (AI)

Big Mailer already has: suggest a subject, clean this up, draft a sequence from a template, and the slop scanner.

| Feature | What kolea-pro does | Size |
|---|---|---|
| Ghostwriter | Drafts a broadcast or a sequence mail in a voice the writer tunes with sliders, or learns from their own writing. Can write a whole sequence as numbered "takes" that sit beside the real one, reviewed mail by mail. | L |
| Reader council and review desk | Three readers modelled on the writer's own audience plus an editor review a draft before it goes out; the review gets its own page with notes in the margin. | M |
| Launch Studio | Seven steps from describing an offer to reviewing how the launch went, building a paused sequence from a launch template along the way. | L |
| Key and model choices | A screen to choose which key pays (own OpenRouter, Anthropic or OpenAI key) and which model each helper uses. Big Mailer has fixed defaults in code. | S |

### API, agents and integrations

| Feature | What kolea-pro does | Size |
|---|---|---|
| REST API | `/api/v1` covering subscribers, tags, segments, forms, broadcasts, sequences, templates, posts, topics, site, sales and stats, with an OpenAPI document and keys scoped `send`, `read` or `admin`. Big Mailer has the transactional send endpoint and MCP only. | M to L |
| Outbound webhooks | Subscribe URLs to subscribed, unsubscribed, bounced, purchased and published events; signed, retried with backoff, delivery log on screen. On Cloudflare the retries go through Queues. | M |
| MCP by URL with OAuth | Add Kōlea to Claude by pasting a URL and approving it; no key to copy. Big Mailer uses a path secret plus a bearer key. | M |
| Agent send switch on screen | Turning agent sending on or off is a setting in the admin. Big Mailer uses the `MCP_ALLOW_SEND` variable, which needs a redeploy. | S |
| API key screen | Create and revoke keys in the admin. Big Mailer only mints one in the seed (open on its PLAN). | S |
| Missing MCP tools | `broadcast_resume`, `broadcast_revise`, `sequence_exit_set`, `sequence_exit_remove`, the six `sequence_template_*` tools, the five `template_*` tools, `theme_list`, `theme_activate`, `topic_list`, `topic_update`, `post_update`, `sale_get`, `subscriber_unsubscribe`, `form_resend_replies`, `log_search`, `log_types`, `health`, and the five `webhook_*` tools. Most wrap code Big Mailer already has. | S to M |

### Operating it

| Feature | What kolea-pro does | Size |
|---|---|---|
| Event log | A Logs page of everything that happened, in plain words, kept 90 days and searchable over MCP. | M |
| Audit trail | Every change by a person, key or agent is recorded, refusals included. Big Mailer records MCP calls only. | S to M |
| More than one person | Several people on one install with roles (owner, admin, writer), invitations, emailed sign-in codes, GitHub or Google sign-in, passkeys. Big Mailer is one operator behind Cloudflare Access. Access can let several people in, but there are no roles. Worth deciding whether the open source app needs this at all. | M to L |
| In-app onboarding | A guided first run inside the app: name and from address, sending domain, site, an import or a form, a welcome sequence, the first broadcast. Big Mailer has a Claude Code install guide (`/onboard`) instead. | M |
| Held mail, released later | kolea-pro holds mail behind a kill switch and always shows a way to send it once the hold is lifted. Big Mailer's console provider renders to the Outbox. **Check** whether held mail can be released from there. | S to M |

## Where kolea-pro changed a rule

kolea-pro's SPEC changed three of Big Mailer's behaviours on purpose. Big Mailer should take these too.

- A broadcast resolves its audience once, at send. Big Mailer's cursor can pick up people who join while the send is going out.
- Machine opens are detected and excluded (above).
- Sequences can wait for a send-time window (above).

## What Big Mailer already has

So nobody ports these again: scoped consent and the preference center, one-click unsubscribe, broadcasts with schedule, cancel, resume, revise and preview to self, sequences with exits, chaining, templates and Go live, tag rules, segments, forms with lead magnets and direct links, the public site with three themes, theme upload and settings, profile, RSS, sitemap and search, reader traffic, Signal and the analytics screens, campaigns, sales, attribution, goals, conversions, the store overview and purchase mail, Unsplash images, the help manual, the transactional API, and an MCP server with 110 tools.

## Cloudflare notes

- Most of the gap is ordinary Worker code. The parts that run long (importers, webhook retries, Ghostwriter takes) need Queues, which Big Mailer already uses for sending.
- D1's limits are the reason for many of Big Mailer's workarounds (cursored sends, one broadcast per cron tick). Members, the REST API and the event log add tables and queries; watch D1's size and query limits as they land.
- Members and Premium need Stripe Checkout and subscription webhooks. Big Mailer's hand-written Stripe client covers charges only, so it grows here.

## A possible order

1. Small items that make the single-host app safer and easier to run: double opt-in, API key screen, agent send switch on screen, Mailgun adapter, audience resolved once, the missing MCP tools.
2. Sending domain setup, custom fields, transactional templates, tracking hostname, machine opens, send window.
3. Outbound webhooks and the REST API.
4. Members, Premium and store checkout.
5. Importers, starting with Kit and Ghost.
6. AI: key and model choices, then the council, Ghostwriter and Launch Studio.
7. Event log, audit trail, in-app onboarding, and more than one person if wanted.
