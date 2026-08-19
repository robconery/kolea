# Web security review checklist

Run before sign-off. For each item: pass / finding (→ `templates/finding.md`)
/ N/A-with-reason. Skipping an item silently is not allowed.

## Attack surface mapped
- [ ] Every HTTP handler, Server Action, Nitro route, `Bun.serve` fetch,
      websocket, file upload, outbound fetch, `postMessage`, and
      client-exposed env enumerated.

## AuthN / AuthZ (rule 1)
- [ ] Every state-changing / data-returning handler authenticates.
- [ ] Every id/slug/path from the request is authorized at the **object**
      level (ownership/tenant in the query or an explicit policy).
- [ ] Role/permission checks are server-side, not just hidden UI.
- [ ] No authz that lives *only* in middleware / route meta / client guard.
- [ ] Sessions: regenerated on login; cookies `HttpOnly`+`Secure`+
      `SameSite`; JWT alg pinned, secret server-side & non-empty.

## Input & output (rules 2, 4)
- [ ] External input schema-parsed at the boundary (no raw cast/spread).
- [ ] No mass assignment (`...req.body` / `create(body)` into a model).
- [ ] Output contextually encoded; no `dangerouslySetInnerHTML`/`v-html`/
      `innerHTML`/`eval` on request-derived data without a traced sanitizer.
- [ ] SQL/NoSQL/command/template: parameterized/structured, no concat,
      no shell string, dynamic identifiers allowlisted.

## Network & data egress (rules 3, 5)
- [ ] No secret in client bundle / `*_PUBLIC_*` / RSC/SSR payload / repo.
- [ ] Server data projected to DTOs (no ORM rows serialized to client).
- [ ] Outbound user-influenced URLs: scheme+host allowlist, private-IP
      block, redirects handled (SSRF).
- [ ] CORS exact-match allowlist (no `*`+credentials, no origin reflect).

## Hardening (rules 5, 6, 8)
- [ ] Security headers + CSP set (`templates/security-headers.md`).
- [ ] CSRF protection on cookie-auth state changes.
- [ ] Body size limits, rate limits on auth/OTP/expensive routes.
- [ ] File upload: generated names, path-confined, type-by-content, size
      cap, served safely.
- [ ] Errors fail closed; no stack/SQL/internal leakage to clients.
- [ ] Dependencies pinned, lockfile committed, audit clean; new deps sane.

## Framework pass
- [ ] Ran the matching `references/{nextjs,nuxt,bun,hono}.md` triage table
      against the diff.

## Output
- [ ] Findings reported in `templates/finding.md` format with severity +
      concrete exploit + minimal fix. Observations labeled as such.
