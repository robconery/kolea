# Next.js (App Router + Pages) — security review

Generic findings still apply (`frontend.md`, `backend.md`). This file is
the Next-specific traps and the Next-specific fixes.

---

## Server Actions are public, unauthenticated POST endpoints

`"use server"` functions compile to a callable HTTP endpoint with a stable
id. Anyone can invoke any Server Action with any arguments — the form/
component that "calls" it is irrelevant. Treat each like an API route.

```ts
// ❌ assumes only the admin UI can reach this
"use server";
export async function deleteUser(id: string) {
  await db.user.delete({ where: { id } });   // no authn, no authz
}
```
```ts
// ✅ authn + authz + input validation INSIDE the action
"use server";
export async function deleteUser(formData: FormData) {
  const session = await auth();
  if (!session) throw new Error("unauthorized");
  const { id } = DeleteUser.parse({ id: formData.get("id") });
  if (!(await canManage(session.user, id))) throw new Error("forbidden");
  await db.user.delete({ where: { id } });
}
```

**Review:** every exported `"use server"` function must self-check
auth/authz/validation. Arguments are attacker-controlled and must be
schema-parsed (closures capture client-passed values too — a captured
`userId` is client data, not trusted). Server Actions are CSRF-relevant:
Next checks `Origin` vs `Host` by default, but verify `allowedOrigins`/
proxy config hasn't widened it and that the action isn't also exposed via
a hand-rolled route without that check.

---

## Route handlers vs Server Components — both run on the server, neither is trusted-by-caller

`app/api/**/route.ts` and RSC data fetching run server-side but receive
attacker input (params, query, headers, cookies, body). No implicit authz.
`cookies()`/`headers()` values are attacker-set. Re-check authorization in
the handler/component that touches data; don't rely on `middleware.ts`.

---

## middleware.ts is not an authorization boundary

Middleware runs on the Edge runtime, can't safely do DB/heavy auth, can be
skipped by matcher misconfig, and historically has had bypass CVEs
(e.g. `x-middleware-subrequest`). Use it for redirects/coarse gating only.
**Real authz lives in the Server Action / route handler / data layer**, not
solely in middleware. A finding if the only access control is a middleware
matcher. Keep Next patched (middleware-bypass CVEs are version-specific).

---

## `NEXT_PUBLIC_` and the RSC/serialization boundary

- Any `NEXT_PUBLIC_*` env is inlined into client JS — a secret there is
  High (rotate). Plain `process.env.X` is server-only *only* in server
  code; referenced in a Client Component it is `undefined` (not a leak)
  but signals confusion — check it isn't `NEXT_PUBLIC_`.
- Data returned from a Server Component to a Client Component (props),
  `getServerSideProps`, or a Server Action **is serialized into the HTML/
  RSC payload and is client-visible**. Returning an ORM row leaks every
  column (password hash, internal flags, PII). Project to an explicit DTO.
- `server-only` package import on modules that must never bundle to the
  client — recommend it for data-access modules.

---

## SSRF via `next.config` rewrites and `next/image`

- `images.remotePatterns`/`domains` too broad → `/_next/image?url=` becomes
  an open image proxy / SSRF. Pin to exact hosts.
- `rewrites()`/`redirects()` with a wildcard `destination` interpolating a
  param can proxy to internal hosts. Allowlist.

---

## Caching and authorization

`fetch` and route segment caching can serve one user's authorized response
to another. Per-user/authenticated data must be `cache: "no-store"` /
`dynamic = "force-dynamic"` / not statically rendered. A finding if
user-specific data is cached at a shared layer (incl. CDN with cookies
ignored).

---

## Triage table

| Pattern | Severity |
|---|---|
| `"use server"` with no authn/authz/validation, sensitive effect | High–Critical |
| ORM row returned to client (props/RSC/SSP/action) | High (PII/secret) |
| Authz only in `middleware.ts` | High |
| Secret in `NEXT_PUBLIC_*` | High (rotate) |
| `next/image` `remotePatterns`/`domains` wildcard | Medium–High (SSRF) |
| User-specific data statically cached / CDN-cached | High |
| Rewrite/redirect destination from user param | High (SSRF/open redirect) |
