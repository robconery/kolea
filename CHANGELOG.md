# Changelog

What changed for someone who runs Kōlea. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases are
tagged on GitHub, and "Unreleased" is what has landed on `main` since the last one.

## [Unreleased]

A large set of new screens and features. Nothing you already run changes shape,
but there is a migration to apply and four things to do on your first visit.

### ⚠️ Before you pull

- **Apply migration 0030 before you deploy the new code.** The order matters:

  ```bash
  bunx wrangler d1 export kolea --remote --env production --output backup.sql
  bunx wrangler d1 migrations apply DB --remote --env production
  bun run deploy
  ```

  The migration only adds. It creates 34 new tables (imports, custom fields, team,
  API and agent settings, webhooks, members, the store, testimonials, sending
  domains, the writing helpers and the audit trail) and adds 14 columns to eight
  tables you already have, all with defaults: `broadcasts`, `sequences`,
  `messages`, `events`, `forms`, `ai_calls`, `mcp_calls` and `site_settings`. It
  rewrites no rows, drops nothing and changes no existing column. The Worker you
  are running today keeps working against the migrated database, so there is no
  downtime between the two steps. The new code does not run against the old
  database, so never deploy first. Locally, `bun run db:migrate` does the same.
- **Sign in yourself straight after the deploy.** The console now has roles
  (owner, admin, writer). The first person through the Cloudflare Access login
  after the upgrade becomes the owner. Anyone else your Access policy lets in is
  turned away until you add them on **System → Team**.
- **Agents cannot send until you turn it on again.** `MCP_ALLOW_SEND` used to switch
  agent sending on. It is now a switch on **System → Agents & keys**, and it starts
  off, even if your config says `"true"`. The var can only force sending off:
  `"false"` wins over the switch, and any other value is ignored. A second switch
  there, also off, covers deleting people, lifting suppressions, importing a list
  and creating keys.
- **Nothing new is needed in your `wrangler.jsonc`.** There is no new binding,
  queue or schedule. The new settings are optional and are listed under Added.

### Added

- **Import from Kit, Ghost, Mailchimp or Drip.** Open **Audience → Imports**, paste
  an API key, and your list and past mail come over in the background, a page a
  minute. A run survives a deploy and resumes where it stopped. Nothing imported
  can send: people who left in the other tool stay left, nobody is enrolled in a
  sequence, past mail lands as sent and unpublished, and sequences land switched
  off. The key is deleted when the run ends. Drafts, Ghost tags and Mailchimp or
  Drip automations are not brought over.
- **Custom fields.** Named, typed fields on a subscriber (text, number, date, yes
  or no). Use them in a segment, in a CSV import, on a form, and in mail as
  `{{plan}}` or `{{plan|free}}`.
- **Clean up.** Pick groups of people to prune (never engaged, unsubscribed,
  bounced, never confirmed),
  download a backup CSV, then delete. People who left stay blocked if they are
  imported again.
- **Double opt-in.** A form can ask a new subscriber to confirm by mail. New forms
  ask by default. The forms you already have are unchanged until you switch it on.
- **Mailgun.** Set `EMAIL_PROVIDER` to `mailgun`, with `MAILGUN_DOMAIN`, the
  `MAILGUN_API_KEY` and `MAILGUN_WEBHOOK_SIGNING_KEY` secrets, and Mailgun's
  webhooks pointed at `/webhooks/mailgun`.
- **Sending domains.** **System → Sending domains** shows the DNS records your
  sending domain needs and checks them. With a `CLOUDFLARE_DNS_API_TOKEN` secret it
  can add them to Cloudflare for you.
- **Your own tracking host.** Set `TRACKING_HOST` to a subdomain of yours and new
  mail's open pixel and tracked links use it. Links already sent keep working. Never
  remove a host that has been used: put the new one first in a comma-separated list.
- **A send window for a sequence.** A step that comes due at 3am can wait for the
  hours you set on the sequence's "When it sends" card, in one time zone for the
  whole install.
- **Stored transactional templates.** `POST /api/send` can name a template by slug
  and pass `variables`, in place of the whole mail each time.
- **Undelivered.** Failed mail has its own screen, with "send again" for what is
  safe to resend. Mail whose outcome is unknown is held back until you have checked
  with the provider.
- **A REST API.** `/api/v1` covers subscribers, tags, segments, forms, broadcasts,
  sequences, templates, posts, topics, sales and stats, with an OpenAPI document at
  `/api/v1/openapi.json`. Keys have a scope: `read`, `send` or `admin`.
- **Outbound webhooks.** Send subscribed, unsubscribed, bounced, complained,
  purchased and published events to a URL of yours. They are signed, retried with backoff, and
  each delivery is listed on **System → Webhooks**.
- **Add Kōlea to an agent by URL.** Paste `https://<your admin host>/mcp` into Claude
  and approve it in the browser. There is no key to copy, and the agent starts
  read-only. In production this needs five more Cloudflare Access Bypass apps
  (`/mcp`, `/.well-known/*`, `/oauth/register`, `/oauth/token`, `/oauth/revoke`).
  `bun scripts/onboard.ts access` adds them, or see step 8 of
  [`docs/INSTALL.md`](docs/INSTALL.md). The path secret and bearer key still work.
- **API keys on a screen.** Create and revoke keys on **System → Agents & keys**.
  No more SQL to make the first one.
- **Logs and an audit trail.** **System → Logs** lists what the mailer did and saw
  over the last 90 days in plain words. Every change made in the console, by a key
  or by an agent is recorded, refusals included.
- **A team.** Add people on **System → Team** as owner, admin or writer. A writer
  can draft and edit, and cannot send or change settings. Signing in is still
  Cloudflare Access.
- **Members and Premium on the public site.** Readers sign in by emailed link. A
  post can be for everyone, for members, or for Premium members, chosen in the
  composer's Web panel. Premium is a monthly or yearly subscription on your own
  Stripe account. It needs the `MEMBER_SESSION_SECRET` secret, and a Stripe key
  that is allowed to create Checkout Sessions.
- **Offer pages.** **Money → For sale** puts a product on a page of your site that
  starts a Stripe Checkout. A link to it that carries `?from=<post id>` records the
  post that sent the buyer.
- **Testimonials.** Put `{{testimonial_link}}` in a mail. A reader writes one, you
  approve it, and it appears on `/testimonials` on your site.
- **Topics and a media library.** Each has its own screen under **System**. The
  editor can reuse an image you have already uploaded.
- **Import past sales.** Upload a CSV of older sales on **Money → Import sales** so
  revenue covers the time before Stripe was connected. It mails nobody.
- **More writing help.** A Ghostwriter that drafts in a voice you tune, a reader
  council that reviews a draft, and Launch Studio, which walks a launch in seven
  steps and builds a paused sequence. **System → AI** chooses which key pays (your
  own OpenRouter, Anthropic or OpenAI key, stored encrypted with the
  `AI_KEY_ENCRYPTION_SECRET` secret) and which model each helper uses. All of it
  stays off until there is a key.
- **A first-run checklist.** "Get set up" sits on the dashboard until its six steps
  are done or you dismiss it. An install that is already running sees it too, with
  the steps it has already done ticked.
- `bun run setup` now also writes `MEMBER_SESSION_SECRET` and
  `AI_KEY_ENCRYPTION_SECRET` into a new `.dev.vars`, and **Seed demo data** adds two
  custom fields and a finished import to look at.

### Changed

- **Opens from machines are not counted as readers.** Apple Mail Privacy Protection
  and link scanners fetch the pixel without anybody reading. Those opens are now
  kept apart, shown beside the reader count, and no longer fire tag rules. Expect
  open numbers to be lower from here on. Opens recorded before the upgrade are
  not reclassified.
- **A broadcast's audience is fixed when the send starts.** Someone who joins while
  a large send is still going out no longer receives it.
- **Two copies of one send cannot both go out.** A message is claimed before it is
  handed to the provider, so a second delivery of the same queue job waits its
  turn and finds the mail already sent.
- **A send that stalled is picked up again.** If a batch failed and its retry was
  lost, the mail is handed over again later, and the broadcast finishes in place
  of blocking the ones behind it.
- The composer's Web panel has a "Who can read it" choice.

## [0.1.0] - 2026-11-26

The first tagged release.

### ⚠️ Before you pull

- **`wrangler.jsonc` is no longer in the repo.** It is gitignored, and
  `wrangler.template.jsonc` is the only config that ships. If your clone has a
  `wrangler.jsonc` that git tracks, **copy it somewhere safe before you pull**: git
  removes a tracked file that the incoming commits delete. Put your copy back
  afterwards. It stays yours and git leaves it alone from then on.
- The template's send queue now retries twelve times, with `retry_delay: 30`. If you
  keep your own `wrangler.jsonc`, copy those two values into both `consumers` blocks,
  along with the `observability` block.

### Added

- **A Web panel in the composer.** Choose **Email + web** or **Email only** per
  broadcast, and set the excerpt, the featured image (your upload or an Unsplash
  search) and the topics without leaving the editor.
- **Publishing as it sends.** A broadcast set to Email + web goes up on the public
  site at the moment it starts sending, so the "read this online" link works for the
  first reader.
- **Your name and address in the footer.** Mail now names your publication
  (`SITE_TITLE`) in the footer and prints your postal address when you set the
  `POSTAL_ADDRESS` secret.
- **`ACCOUNT_URL`.** An optional setting for the page where buyers manage what they
  own. It fills `{{account_url}}` in purchase mail. Unset, the dashboard line is left
  out.
- **`bun run setup`.** One command gets a fresh clone running locally: a local-only
  `wrangler.jsonc`, a `.dev.vars`, and the local database. `bun run dev` now tells you
  to run it if you have not.
- **`bun run screenshots`.** Re-shoots the pictures in `docs/img/` from a throwaway
  local instance filled with demo data.
- Workers Logs are switched on in the config template.

### Changed

- **A failed send waits before it retries.** Retries used to fire at once and give up
  after three tries, so a provider hiccup of a few seconds could fail good mail. They
  now back off from 15 seconds up to five minutes, never sooner than the provider
  asks, for about twenty minutes in all.
- **One mail template.** Broadcasts, sequence mail and purchase mail share one palette
  and type scale. Body copy is 17px, links take the accent colour, and the layout
  holds its width in Outlook on Windows.
- **The Kōlea bird.** The admin, the favicon, the default share card and the docs carry
  the kōlea mark, plover gold for the primary action, and the Righteous wordmark.
- **A shorter README.** The long sections moved into `docs/`: the tour, costs,
  configuration, the public site, agents and AI help each have their own page.
- `onboard.ts render` refuses to overwrite a `wrangler.jsonc` it did not write, unless
  you pass `--force`.
- Local setup needs Bun 1.2 or newer and Node 22 or newer, and says so when they are
  missing.

### Fixed

- **No second copy.** If the database write failed after the provider had accepted a
  batch, the whole batch was sent again. Now only the record is retried, and Resend
  batches carry an idempotency key.
- A message that gives up keeps the last real error, so `messages.error` says why.
- The composer's preview dialog has its background again.
- A button in a page header lines up with the links beside it.

### Removed

- The one-off import and backfill scripts that were written for a single install
  (`scripts/import-kit.ts` and friends). Bulk imports are still done as direct SQL:
  see "Migrating a list in" in [`docs/INSTALL.md`](docs/INSTALL.md).
- `docs/screenshot.jpg` and `docs/analytics.jpg`, replaced by `docs/img/`.
