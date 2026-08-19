# Hono — security review

Generic findings still apply (`backend.md`, `frontend.md`). Hono is
unopinionated: security comes entirely from middleware you wired correctly
and in the right order.

---

## Middleware order — auth must run *before* the handler and before what it protects

Hono runs middleware in registration order, onion-style. Auth registered
*after* a route, scoped to the wrong path, or placed after the handler
does nothing.

```ts
// ❌ handler registered before auth → auth never guards it
app.get("/admin/users", listUsers);
app.use("/admin/*", jwt({ secret }));
```
```ts
// ✅ guard first, then routes; scope precisely
app.use("/admin/*", jwt({ secret }));
app.use("/admin/*", requireRole("admin"));     // authz, not just authn
app.get("/admin/users", listUsers);
```
Review: every protected path has its auth middleware registered **before**
its handlers and with a matcher that actually covers them (`/admin` does
not match `/admin/x` — use `/admin/*`). `app.route()` sub-apps: confirm the
guard is applied on the parent mount or inside the sub-app, not assumed.

---

## `jwt()` / auth — authn is not authz

Hono's `jwt()` only verifies the signature/expiry and sets
`c.get("jwtPayload")`. It does **not** check roles, ownership, or scopes.
Object-level authorization (IDOR, see `backend.md` §authz-idor) is still
your code. Also: pin the algorithm, keep the secret server-side and strong,
verify the payload claims (`aud`/`iss`/`exp`) you rely on.

```ts
// ✅ payload is identity only — re-check ownership in the handler
app.get("/notes/:id", jwt({ secret, alg: "HS256" }), async (c) => {
  const { sub } = c.get("jwtPayload");
  const note = await db.note.findFirst({ where: { id: c.req.param("id"), userId: sub } });
  return note ? c.json(note) : c.notFound();
});
```

---

## Validate input with the validator/zod middleware — not `c.req` raw

`c.req.param/query/header`, `await c.req.json()`, `c.req.parseBody()` are
all attacker-controlled. Use `@hono/zod-validator` (or `validator()`) and
read the **validated** value, not the raw request.

```ts
// ❌ trusts body shape → mass assignment / type confusion
const body = await c.req.json();
await db.user.update({ where: { id }, data: body });
```
```ts
// ✅
import { zValidator } from "@hono/zod-validator";
app.patch("/me", zValidator("json", UpdateMe), async (c) => {
  const data = c.req.valid("json");           // typed, allowlisted
  await db.user.update({ where: { id: c.get("uid") }, data });
});
```

---

## Built-in middleware — use them, configure them tight

- `secureHeaders()` — add it; sets `nosniff`, frame options, etc. Tune CSP
  (default is minimal). See `templates/security-headers.md`.
- `cors()` — never `origin: "*"` with `credentials: true`; pass an explicit
  origin allowlist or a checked function (see `templates/cors.md`,
  `backend.md` §cors).
- `csrf()` — enable for cookie-authenticated state-changing routes; it
  checks `Origin`/`Referer`. Header-token APIs that never read the
  credential from a cookie may be exempt.
- `bodyLimit()` — set it; Hono does not cap body size by default (DoS).
- `logger()` — ensure it doesn't log `Authorization`, cookies, or bodies
  with secrets.

---

## Context vars are only as trusted as what set them

`c.set("user", ...)` is trusted **iff** an auth middleware that ran earlier
on this path set it. A handler reading `c.get("user")` on a route with no
auth middleware gets `undefined` (or worse, a value set by a permissive
middleware). Trace where each `c.get(...)` value originates.

---

## Runtime caveats

Hono runs on Workers/Deno/Bun/Node/Lambda. `process.env` may be empty on
edge runtimes (secrets come via bindings) — a misread can fail open
(e.g., empty JWT secret → forgeable tokens). Verify the secret is actually
present and non-empty at startup (fail closed). Edge: no Node crypto in
some runtimes — ensure JWT/hash libs are runtime-appropriate.

---

## Triage table

| Pattern | Severity |
|---|---|
| Auth middleware after route / wrong matcher (route unguarded) | High–Critical |
| `jwt()` present but no object-level authz (IDOR) | High |
| JWT alg not pinned / secret from possibly-empty env | High–Critical |
| Handler reads `c.req.json()` raw into ORM (mass assignment) | High |
| `cors()` reflect/`*` + credentials | High |
| No `csrf()` on cookie-auth state change | Medium–High |
| No `bodyLimit()` / `secureHeaders()` | Medium |
| `c.get(x)` trusted on a route with no setter middleware | High |
