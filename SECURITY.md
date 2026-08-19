# Security Policy 🔐

## Supported versions

There are no tagged releases yet. `main` is the only supported version, and fixes land
there directly.

| Version | Supported |
|---|---|
| `main` | ✅ |
| Anything older | ❌ — rebase onto `main` |

Because this is self-hosted, **you** own the deployed copy. Nothing is pushed to you: if
you forked or deployed, watch the repo so you see security fixes when they land.

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private vulnerability reporting:
the **Security** tab → **Report a vulnerability**. That opens a private advisory only
maintainers can see.

Include what you'd want to receive: the affected file or endpoint, what an attacker
gets, and the smallest reproduction you can manage.

**Expect an acknowledgement within 5 business days.** This is a personal project rather
than a staffed product, so please size your expectations for a fix accordingly — but you
will get a reply. Coordinated disclosure appreciated; I'll credit you in the advisory
unless you'd rather I didn't.

## Scope

This is a self-hosted mailer. There is no hosted instance to test against, so "in
scope" means the code in this repository and the configuration it ships with — not any
running deployment.

**In scope:** authentication and authorization bypass, injection, consent bypass
(anything that sends mail to an address that opted out, or that escalates a narrow
opt-out into a global one), API-key handling, template injection into rendered email,
SSRF, secrets exposure, and any default in `wrangler.jsonc` that is unsafe in
production.

**Out of scope:** findings that require `DEV_AUTH_BYPASS=true` (that is the documented
local-development mode and is explicitly disabled by the production environment);
missing rate limits on Cloudflare-fronted endpoints; and deliverability or spam-filter
behavior, which is a property of your sending domain, not of this code.

## How the security model works

Useful context for anyone reviewing:

- **The admin console has no password.** Cloudflare Access terminates identity at the
  edge and forwards a signed JWT. `src/web/auth.ts` verifies the signature against the
  team's live JWKS, pins `alg` to `RS256`, and checks audience, issuer, `exp` and
  `nbf`. Presence of the header proves nothing on its own and is never treated as
  proof. If `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` is missing, the middleware
  **fails closed** and refuses everyone rather than letting anyone through.
- **API keys are stored as SHA-256 hashes.** The plaintext is returned once at
  creation and never persisted, so a dumped database does not yield usable keys. Keys
  are revoked, never deleted, so the audit trail in `mcp_calls` keeps pointing at
  something real.
- **Keys are scoped.** A `send` key reaches the transactional API and nothing else. The
  MCP endpoint requires `admin`.
- **The MCP endpoint has three gates**: an unguessable path secret compared in constant
  time (a miss returns `404`, not `403`), an `admin`-scoped bearer key, and per-tool
  guards. Every call — including every refusal — is recorded in `mcp_calls`.
- **Irreversible sends require a preflight token.** `broadcast_send` and
  `sequence_activate` refuse without a single-use token from their preflight tool,
  which expires in 10 minutes and is invalidated by any edit to the content or the
  audience. On top of that, `MCP_ALLOW_SEND` defaults to `"false"` in production: an
  agent can read and draft everything and still cannot put mail on the wire.
- **Uploads use a MIME allowlist, not a blocklist** — uploaded media is served from the
  same origin, and an SVG can carry script.
- **Everything observable is a row in D1**, not a log line. Workers logs expire in 3–7
  days; `mcp_calls` and `sync_runs` do not.

## If you are deploying this

Two steps are load-bearing, and both are easy to get wrong:

1. **Never `wrangler deploy` without `--env production`.** The top-level vars carry
   `DEV_AUTH_BYPASS=true` for local development. A plain deploy publishes an
   unauthenticated admin console.
2. **Set `MCP_PATH_SECRET` with `wrangler secret put`, not as a var.** Unset means the
   MCP endpoint returns `404`, which is the safe default — turn it on deliberately.

Secrets belong in `wrangler secret put` or `.dev.vars` (gitignored). Never in
`wrangler.jsonc`, and never in `.dev.vars.example`.
