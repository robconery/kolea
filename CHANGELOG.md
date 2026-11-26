# Changelog

What changed for someone who runs Kōlea. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases are
tagged on GitHub, and "Unreleased" is what has landed on `main` since the last one.

## [Unreleased]

Nothing yet.

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
