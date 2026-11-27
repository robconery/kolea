# 🔍 How Kōlea works

The short version of what runs where and why. The full reference, written for a person
or an agent to read before changing code, is [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 🔐 Consent model

Three independent scopes. A narrow choice never escalates to a wide one.

| Scope | Stored as | Effect |
|---|---|---|
| Sequence | `sequence_optouts` row | Off that one series. Everything else continues. |
| Broadcast | `subscribers.status` | Off the newsletter. Series keep running. |
| Global | `suppressions` row | Off everything. The legal escape hatch. |

Only an explicit "unsubscribe from everything", a hard bounce, or a complaint writes a
global suppression.

Sequence sends deliberately ignore `status = 'unsubscribed'`, because that flag is
broadcast-scoped: someone who left the newsletter still gets the onboarding series they
asked for. Transactional mail (receipts, downloads) ignores marketing consent entirely
and is blocked only by a dead address or a spam complaint. A receipt isn't marketing,
and an unsubscribed customer still needs their download.

---

## 🔍 Under the hood

### What lives in your Cloudflare account

| Thing | Name | Why it's there |
|---|---|---|
| **Worker** | `kolea` | The whole app: the admin, the public site, the API, MCP, the cron jobs and the queue consumer. One deploy. |
| **D1** (SQLite) | `kolea` | Every subscriber, message, event, sale and audit row. Anything worth knowing later is a row here, because Worker logs vanish within a week. |
| **R2** | `kolea-media` | Images you upload. Served at `/media/…` so they work inside mail. |
| **R2** | `kolea-downloads` | Lead-magnet files. Nothing serves this bucket directly; files leave only through `/d/<token>`: a per-person link, or the form's direct link. |
| **Queue** | `kolea-send` | Fan-out for sending. One batch of 100 is one request to the mail provider. |
| **Queue** | `kolea-dlq` | Where a message goes when its retries run out. Nothing sends from here; it records the failure as a row. |
| **Cron** | every minute | Sequence steps that are due, scheduled broadcasts, and big sends resuming where they left off. After the mail: sending-domain checks, webhook deliveries, one page of a running import, and Ghostwriter takes. |
| **Cron** | 09:17 UTC daily | Stripe reconciliation: books any sale the webhook missed. |
| **Access** | 1 Allow + 13 Bypass apps | The login. Only you get into the admin; readers get into the paths they need. |
| **Secrets** | `RESEND_API_KEY` and friends | Keys the Worker reads. Never in `wrangler.jsonc`, never in git. |

Those are the names `/onboard` and the template give a new install. They're internal:
nothing outside your account sees them, and every command addresses the database by
its binding (`DB`) rather than its name. Your own `wrangler.jsonc` can name them
anything.

### How a broadcast actually goes out

```
 You press Send
     │
     ▼
 scheduled → sending          publish the post first, so "read online" works on arrival
     │
     ▼
 materialize                  one `messages` row per recipient, written before anything
     │                        is sent. Resumable across cron ticks for big lists
     ▼
 SEND_QUEUE                   batches of 100, at most 6 at once (the provider's rate limit)
     │
     ▼
 claim                        each row is taken in one conditional write, so a job
     │                        delivered twice cannot be sent twice
     ▼
 consent re-check             right before the provider call, not at enqueue. Someone
     │                        can opt out in the minutes between
     ▼
 Resend or Mailgun            one request per batch, then one write for every result
     │
     ▼
 /webhooks/<provider>         delivered, bounced, complained → events, and a hard
                              bounce or complaint writes a suppression
 /t/open, /t/click            opens and clicks → events → tag rules → maybe a sequence
```

The audience is fixed when the send starts: someone who joins while a large send is
still going out does not get it. A batch that fails gives its rows back and waits
before it tries again. If the provider took the mail and the database would not record
it, only the record is retried, and the rows stay claimed so nothing sends them twice.

A sequence step takes the same road from the minutely cron instead of the Send button.
Transactional mail from `/api/send` joins at the queue: one `messages` row, answered
with `202` as soon as it's recorded, then checked against its own, narrower consent
rule on the way out.

### How a request finds its app

One Worker answers two hostnames. `worker.tsx` looks at the host before any router
runs: your site host goes to the public site app, everything else to the admin app.
They never share a router, so an admin route can't leak onto the public site by being
registered in the wrong place. The admin app then checks the Cloudflare Access token
on every request, except the public paths listed in [the tour](TOUR.md#-pages-your-readers-see).

---

## 🧱 Architecture at a glance

Cloudflare Workers · D1 (SQLite) via Drizzle · Queues for send fan-out · Cron Triggers
for scheduling · R2 for media · Hono + JSX server-rendered admin · Cloudflare Access for
auth · a pluggable `EmailProvider` port with `console` and Resend adapters.

The decisions worth knowing about, and why:

**Every `messages` row is materialized before a single send goes out.** A broadcast
resolves its full recipient list up front, writes a row per intended send, and only
then fans out to the queue. That makes a broadcast resumable after a crash, idempotent
across queue retries, and auditable afterward. Resolving recipients lazily at send time
is cheaper and turns any mid-broadcast failure into an unrecoverable mess.

**Consent is re-checked immediately before the provider call, not at enqueue time.**
A queue can deliver minutes after the message was created, and someone can opt out in
between. Checking at enqueue would mail them anyway.

**Queue concurrency is pinned to 6.** One batch is one provider request, so batch
concurrency *is* the request rate. Left unset, Cloudflare Queues autoscales to 250
concurrent consumers and buries Resend's 10 req/s limit under 429s. Six batches of
100 leaves ~600 emails/sec of headroom while staying under the limit.

**A retry waits, and a send is recorded in one write.** A queue retries at once unless
told otherwise, which meets the same failure again and spends the whole retry budget in
a second. Every retry here backs off (15s doubling to five minutes, never sooner than
the provider's `retry-after`), and twelve retries make that at least twenty minutes.
What the provider said about a batch is written to D1 in a single round trip; if that
write fails, the acceptance is kept on the queue and written later rather than the mail
being sent again.

**Suppression is keyed by email address, not by subscriber.** Transactional recipients
and bounced addresses often have no subscriber row at all, so a `subscribers.status`
flag would silently miss them.

**Anything observable is a row in D1, never a log line.** Workers logs expire in 3–7
days. An audit trail with a one-week retention isn't one. `mcp_calls` records every
agent action including the refusals; `sync_runs` records every Stripe pull.

**The admin console has no password.** Cloudflare Access terminates identity at the
edge, and `src/web/auth.ts` verifies the forwarded JWT properly: signature against the
team's live JWKS (cached per isolate, with a forced refetch on an unknown key id),
`alg` pinned to `RS256`, plus audience, issuer, `exp` and `nbf`. Presence of the header
proves nothing and is never treated as proof. Misconfigure it and the middleware
**fails closed** and locks everyone out, including you. That's the correct direction to
fail.

**One scorer, two subjects.** A broadcast and a sequence are graded by the same
instrument (`core/signal.ts`), so a sequence's 62 and a broadcast's 62 are the same 62
and "is this series better than my newsletter?" is a question with an answer. Every rate
in the system divides by **people reached** (recipients minus bounces) and never by
delivered: provider `delivered` webhooks cover a fraction of what goes out, and dividing
by them reports open rates above 100%.

**A number that could never have been measured is `null`, not `0`.** Mail imported from
a previous ESP has no per-recipient history here and never will, so no click could be
recorded and no conversion could ever attach to it. Those rows drop the MONEY component
and renormalize the rest, rather than scoring a decade of good work as a zero on
something that was never measurable. Same reflex everywhere: a sequence under 30 people
reached is *unscored*, because a 100% click rate across eight people is noise wearing a
suit.

**Attribution is last-*click*, inside a per-source window.** An open is never a touch:
Apple's Mail Privacy Protection fires opens from proxies, so crediting them hands
revenue to whoever mailed most recently. Anything with no click in the window is
`direct`, which is the honest answer for most sales on most lists and is drawn as an
ordinary result rather than a hole in the data.

**There are two renderers, not one with a flag.** `core/render-doc.ts` emits email
HTML; `core/render-web.ts` emits web HTML for the public site. They walk the same
TipTap document and agree on nothing else: inlined styles versus classes, click
tracking versus none, a consent footer versus none, merge tags resolved per recipient
versus neutral copy. One function with a `web: true` flag was the obvious move and the
wrong one: the flags multiply, and the failure mode is an unsubscribe footer rendered
onto a public page.

**The email HTML renderer is hand-written** (`core/render-doc.ts`) rather than using
`@tiptap/html`, whose server entry point needs `happy-dom` and doesn't run inside
`workerd`. It turned out to be the better answer anyway: the walker inlines every style
(Gmail strips `<style>`) and emits nested tables for buttons (Outlook ignores padding
on `<a>`), which generic HTML serialization wouldn't do.

📖 The full picture, written to be read by a person *or* an agent, with the
alternatives that were rejected and why, is in
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

---

[Back to the README](../README.md)
