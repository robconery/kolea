# ✅ PLAN — Kōlea

> Owner: `/plan`. This file was filled in by the build on 2026-08-07 rather than by `/plan`,
> so it records what actually got built instead of a forecast. Re-run `/plan` to slice the
> remaining work properly.

## Built and verified locally

- [x] Project scaffold — Bun, Wrangler, Hono + JSX, Drizzle, D1
- [x] Schema + migration (13 tables), Postgres-portable per `sqlite-dev`
- [x] ⭐ Scoped consent: `sequence_optouts` / `subscribers.status` / `suppressions`
- [x] ⭐ Preference center — token-only, no JS, narrow action is the prominent one
- [x] ⭐ RFC 8058 one-click unsubscribe scoped to the sending series
- [x] Subscribers: add, search, detail, per-scope consent view, tags
- [x] CSV import — updates in place, never resurrects an unsubscribe
- [x] Broadcasts: draft, edit, segment by tag, send, stats
- [x] Sequences: steps, triggers (subscribe / tag_added / manual), enrollment, tick
- [x] Send pipeline — materialized `messages`, idempotency keys, consent re-checked at send
- [x] Cloudflare Queues fan-out with per-message ack/retry; inline fallback when unbound
- [x] Cron handler — sequence ticks + scheduled broadcast pages
- [x] `EmailProvider` port + `console` (local Outbox) and Resend adapters
- [x] Transactional `POST /api/send` — bearer auth, idempotency, suppression-aware, no footer
- [x] Open/click tracking + Resend webhook handling with signature verification
- [x] Outbox screen rendering real sent HTML in an iframe
- [x] Seed + reset for a playable local demo

## Verified by hand against a running server

- [x] Leaving one series keeps the subscriber `active`, unsuppressed, and on the newsletter
- [x] A broadcast sent afterwards still reaches them
- [x] Global unsubscribe suppresses and cancels all enrollments
- [x] Transactional: 401 unauthenticated, 400 malformed, 202 valid, replayed key returns the original
- [x] Transactional mail carries no unsubscribe footer; sequence mail carries a scoped one
- [x] Open pixel and click redirect record events; the redirect survives a tracking failure
- [x] D1 foreign keys are enforced; a stale sequence id is a no-op, not a 500

## Editor (2026-08-08)

- [x] TipTap v3 vanilla, bundled to a static asset, loaded only on compose screens
- [x] Block-style editing — MIT drag handle + node-range multi-block selection
- [x] Slash command menu (custom, over `@tiptap/suggestion`) — 16 block types
- [x] Bubble menu; becomes a URL + colour picker when a CTA button is selected
- [x] Custom `emailButton` node → nested-table CTA in email
- [x] Custom `mergeTag` node → personalization that can't be misspelled
- [x] Image upload to R2 on drop/paste/pick, with a MIME allowlist
- [x] Code blocks with syntax highlighting (15 curated languages)
- [x] Tables, task lists, toggles, YouTube, highlight, text align, typography
- [x] Hand-written TipTap-JSON → email-HTML renderer (inlined styles, table buttons)
- [x] Markdown → document conversion on load, so legacy bodies can't be erased
- [x] Per-step sequence editing + deletion
- [x] Delays in days (first step 0, later steps 1), clamped 0–365
- [x] Local `Fast-forward the clock` so day-scale sequences are testable
- [x] Browser smoke test, 33 checks (`bun run smoke`)

## Not done

- [ ] **Server-side tests.** `bun run smoke` covers the editor only; `docs/SPEC.md` is written
      to feed the `bdd-specs` skill.
- [ ] Media library UI (the `/api/media` list endpoint exists; nothing consumes it)
- [ ] Sequence step reordering (positions are append-only; editing and deleting work)
- [ ] Image alt-text / link editing from the bubble menu
- [ ] Orphan-media sweep (uploads removed from a draft stay in R2)
- [ ] **Verify the Cloudflare Access JWT** (`src/web/auth.ts` checks presence only) — deploy blocker
- [ ] API key management UI (keys exist in the DB; only the seed mints one)
- [ ] Scheduled-broadcast UI (the model and cron path support it; there's no date picker)
- [ ] Double opt-in — still an open question in SPEC §1
- [ ] Per-subscriber engagement history UI — SPEC §5 TODO
- [ ] Segment builder beyond a single include-tag
- [ ] Real D1 database + `--env production` deploy
- [ ] ESP migration path — depends on which ESP, still open in PROJECT.md
