---
name: security-web
description: >-
  Web application security review for TypeScript/JavaScript stacks, frontend
  and backend: XSS and output encoding, CSRF, clickjacking, secrets leaking
  into client bundles, authn/authz and IDOR, injection (SQL/command/NoSQL/
  template), SSRF, mass assignment, insecure deserialization, file upload,
  path traversal, security headers and cookie flags, and dependency/supply-
  chain risk. Includes targeted rules for Next.js (Server Actions, route
  handlers, middleware, `NEXT_PUBLIC_`, RSC data exposure), Nuxt (Nitro
  server routes, `runtimeConfig` vs `public`, `v-html`), Bun (`Bun.serve`,
  `Bun.$` shell, file serving), and Hono (middleware order, JWT, CORS,
  context). Use when reviewing or writing web code for vulnerabilities,
  triaging a security finding, or answering "is this exploitable / how do I
  fix it" questions. Ships secure-default config templates and a finding
  report format.
---

# Web Application Security Review

Treat every byte that crossed a network boundary as hostile until proven
otherwise, and prove it on the server. The client is an untrusted rendering
surface you do not control. Frameworks add convenience (Server Actions,
Nitro routes, `Bun.serve`, Hono middleware) that *hides* the trust boundary
— this skill's job is to make the reviewer see the boundary the framework
obscured.

## 🎯 Why: Design for Change

The goal of writing software is to be able to **change it safely**.
Secure-by-default config (CSP, cookie flags, parameterized queries,
authz-at-the-edge) means the next feature ships without re-litigating
the threat model. Every insecure default you accept becomes a foothold
the next change has to step around.

This skill is for *security review and secure implementation*. For general
TypeScript correctness use `typescript-best-practices`; for schema-level
integrity use `postgres-dba`. This skill never assumes another layer will
catch it.

## How to use this skill (review workflow)

1. **Map the attack surface first.** Identify every trust boundary: HTTP
   handlers, Server Actions, form posts, websocket frames, file uploads,
   outbound fetches, `postMessage`, `process.env` reaching the client,
   third-party script tags. A vuln you didn't enumerate is a vuln you
   didn't find.
2. **Triage each input against the decision guide** below; open the matching
   `references/*.md` for the exploit, the vulnerable pattern, the fix, and
   the false-positive caveat.
3. **Apply the framework reference** (`references/nextjs.md`, `nuxt.md`,
   `bun.md`, `hono.md`) — the generic finding almost always has a
   framework-specific trap or a framework-specific fix.
4. **Report findings in the standard format** (`templates/finding.md`):
   severity, location (`file:line`), a concrete exploit walkthrough, and the
   minimal fix. No exploit path stated → it is an observation, not a
   finding; say which.
5. **Recommend the secure default**, not a bespoke patch. The
   `templates/` configs (CSP, security headers, cookies, CORS) are the
   target state; a one-off escape is a stopgap.

## Severity (how to rank a finding)

| Severity | Bar |
|---|---|
| **Critical** | Unauthenticated RCE, auth bypass, secret/PII mass disclosure, SQLi on a reachable path |
| **High** | Stored XSS, IDOR on sensitive data, SSRF to internal network, privilege escalation, CSRF on a state-changing action |
| **Medium** | Reflected XSS needing interaction, missing security headers with a real impact, weak session handling, verbose error leakage |
| **Low** | Defense-in-depth gaps with no direct exploit, missing hardening, informational |

Rank by *exploitability and blast radius on this codebase*, not by the
generic CVSS of the bug class. State the assumption that makes it that
severity.

## The hard rules (non-negotiable defaults)

1. **All trust decisions happen server-side, per request, per object.**
   Authentication establishes *who*; authorization re-checks *may this
   principal touch this specific resource* on every access. A hidden button,
   a disabled field, or a client-side route guard is UX, never a control.
   Object-level checks are mandatory — assume every ID in a request was
   tampered (IDOR). See `references/backend.md`.

2. **Untrusted data is validated at the boundary and encoded at the sink.**
   Parse external input with a schema (zod/valibot) into a typed value;
   never cast. Encode for the *exact* context at output — HTML, attribute,
   JS, URL, SQL, shell, OS path are different escapings. `innerHTML`,
   `dangerouslySetInnerHTML`, `v-html` with anything request-derived is a
   finding until a vetted sanitizer (DOMPurify, server-side) is proven in
   the path. See `references/frontend.md`, `references/backend.md`.

3. **Secrets never cross to the client.** No secret in a `NEXT_PUBLIC_*` /
   `NUXT_PUBLIC_*` / `VITE_*` / `PUBLIC_*` var, in an RSC payload, in a
   serialized loader/`useState`, in client JS, or in the repo. The client
   bundle is public. Treat any secret that ever shipped as compromised:
   the fix is rotation, not deletion. See `references/frontend.md`.

4. **Injection is closed by structure, not by filtering.** Parameterized
   queries / prepared statements for SQL; argument arrays (never a shell
   string, never `Bun.$` interpolating input) for processes; no
   user-controlled keys into `eval`/`Function`/template compilation/object
   prototypes. Denylists and escaping-by-hand are findings. See
   `references/backend.md`.

4. **Outbound requests to user-influenced URLs are denied by default.**
   SSRF: allowlist host + scheme, resolve and reject private/link-local/
   metadata IPs, and disable or re-validate redirects. "We fetch the URL
   the user gave us" is High until proven constrained. See
   `references/backend.md`.

5. **Cookies and headers carry their security flags or it's a finding.**
   Session cookies: `HttpOnly`, `Secure`, `SameSite` (Lax min; `None`
   requires a stated cross-site reason), host-scoped, sane `Max-Age`.
   Responses: CSP (no `unsafe-inline`/`unsafe-eval` without justification),
   `X-Content-Type-Options: nosniff`, frame-ancestors/`X-Frame-Options`,
   HSTS on HTTPS. See `templates/security-headers.md`.

6. **State-changing requests are CSRF-protected.** Cookie-authenticated
   POST/PUT/DELETE (incl. Next.js Server Actions and Nuxt/Nitro POST
   routes) need `SameSite` *and* either a synchronizer/double-submit token
   or a verified `Origin`/`Sec-Fetch-Site` check. Token-in-header APIs are
   exempt only if they never accept the credential from a cookie.

7. **Framework "magic" endpoints are public endpoints.** A Server Action,
   a Nitro `defineEventHandler`, a `Bun.serve` fetch, a Hono route is an
   internet-facing handler: it gets explicit authn, authz, input
   validation, and rate limiting regardless of how the framework lets you
   call it from your own UI. The caller is the attacker, not your form.

8. **Fail closed and quiet.** On auth/validation failure: deny, log
   server-side with context, return a generic error. No stack traces,
   no SQL, no internal hostnames, no "user not found vs wrong password"
   oracles in responses.

## Decision guide

| Symptom / what you're reviewing | Where |
|---|---|
| Request data rendered into the DOM / JSX / template | `references/frontend.md` §XSS |
| `dangerouslySetInnerHTML`, `v-html`, `innerHTML`, `document.write` | `references/frontend.md` §XSS, framework refs |
| `eval`, `new Function`, `setTimeout(string)`, template-string compiled | `references/frontend.md` §XSS, `backend.md` §injection |
| `postMessage` handler without strict `origin` check | `references/frontend.md` §postMessage |
| Page can be framed; clickjacking on a sensitive action | `references/frontend.md` §clickjacking |
| Token/key/PII visible in client bundle, network tab, or RSC payload | `references/frontend.md` §secrets, framework refs |
| `target="_blank"` without `rel`, open redirect, `javascript:` URL | `references/frontend.md` §navigation |
| Login/session/JWT/cookie handling | `references/backend.md` §auth-sessions |
| An ID/slug from the request used to fetch or mutate a record | `references/backend.md` §authz-idor |
| SQL/Mongo/Prisma raw query built from input | `references/backend.md` §injection |
| `exec`, `spawn` with a shell, `Bun.$`, child process from input | `references/backend.md` §injection, `bun.md` |
| Server fetches a URL/host the user supplied (webhook, image proxy) | `references/backend.md` §ssrf |
| `Object.assign`/spread of request body into a model; ORM create(body) | `references/backend.md` §mass-assignment |
| File upload, file download, path/filename from input | `references/backend.md` §files |
| `JSON.parse`/yaml/node-serialize/`pickle`-like on untrusted bytes | `references/backend.md` §deserialization |
| Rate limiting / brute force / enumeration / resource exhaustion | `references/backend.md` §abuse |
| CORS config, `Access-Control-Allow-Origin: *` with credentials | `references/backend.md` §cors, `hono.md` |
| Dependency risk, lockfile, postinstall, typosquat, CDN script | `references/backend.md` §supply-chain |
| Next.js: Server Action, route handler, middleware, RSC, env | `references/nextjs.md` |
| Nuxt: Nitro route, `runtimeConfig`, `useFetch` SSR, `v-html` | `references/nuxt.md` |
| Bun: `Bun.serve`, `Bun.$`, `Bun.file`, password hashing, env | `references/bun.md` |
| Hono: middleware order, `jwt()`, `cors()`, context, validator | `references/hono.md` |

## Reference files

- `references/frontend.md` — browser-side: XSS (all sinks/contexts), CSP
  as mitigation, DOM clobbering, `postMessage`, clickjacking, tabnabbing,
  open redirect, secrets in the bundle, client storage, third-party scripts.
- `references/backend.md` — server-side: authn/session/JWT, authz/IDOR,
  injection (SQL/NoSQL/command/template), SSRF, mass assignment,
  deserialization, file handling/path traversal, CORS, rate limiting/abuse,
  error handling, supply chain.
- `references/nextjs.md` — Server Actions as endpoints, route handler vs
  Server Component trust, `middleware.ts` limits, `NEXT_PUBLIC_`, RSC/
  serialization leakage, `next/image` & rewrites as SSRF, caching auth.
- `references/nuxt.md` — Nitro `defineEventHandler`, `runtimeConfig` vs
  `public`, SSR data serialized into the payload, `v-html`, server-only
  utils, route rules, proxy/SSRF.
- `references/bun.md` — `Bun.serve` (no framework safety net), `Bun.$`
  shell injection, `Bun.file`/static serving path traversal, `Bun.password`
  vs hand-rolled hashing, `Bun.env`, SQLite/`sql` parameterization.
- `references/hono.md` — middleware ordering (auth before handler),
  built-in `jwt`/`csrf`/`cors`/`secureHeaders`, `c.req` validation with
  the validator/zod middleware, context var trust, edge runtime caveats.

## Templates (recommend these as the target state)

| File | Use |
|---|---|
| `templates/finding.md` | The report format every finding must follow |
| `templates/security-headers.md` | CSP + headers + cookie flags per framework |
| `templates/cors.md` | Correct origin-reflection allowlist (not `*`) |
| `templates/input-validation.ts` | Boundary schema-parse pattern (zod) |
| `templates/review-checklist.md` | The pass to run before sign-off |

## What this skill will not do

- Bless input *sanitization by denylist/regex* as an injection or XSS fix.
  Structure (parameterization, contextual encoding, vetted sanitizer) only.
- Bless client-side-only authorization, validation, or "security by
  obscurity" (hidden routes, minified code, disabled buttons).
- Bless `dangerouslySetInnerHTML`/`v-html`/`innerHTML` on request-derived
  data without a named, server-or-DOMPurify sanitizer in the proven path.
- Bless `Access-Control-Allow-Origin: *` together with credentials, or
  reflecting `Origin` without an allowlist.
- Bless a custom crypto/JWT/hash/CSRF implementation where a vetted library
  (or `Bun.password`, framework `csrf()`) exists.
- Downgrade a finding to "won't fix" inside this skill — it reports
  severity and the fix; the human owns acceptance.
