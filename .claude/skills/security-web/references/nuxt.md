# Nuxt 3 / Nitro — security review

Generic findings still apply (`frontend.md`, `backend.md`). Nuxt-specific
traps and fixes below.

---

## `runtimeConfig` vs `runtimeConfig.public`

- `runtimeConfig.public.*` is **shipped to the browser** (and inlined into
  the SSR payload). Any secret there is High — rotate. Only publishable
  values belong there.
- `runtimeConfig.*` (non-`public`) is server-only — correct place for API
  keys, DB URLs, signing secrets. Verify secrets aren't duplicated under
  `public` "for convenience".
- `useRuntimeConfig()` in a component runs on both server and client; only
  `public` keys are populated client-side, but reading a server key in
  shared code is a smell to flag.

---

## Nitro server routes are public endpoints

`server/api/**` and `server/routes/**` `defineEventHandler`s are
internet-facing. No implicit auth. Each must authenticate, authorize, and
validate.

```ts
// ❌ no auth; body trusted; IDOR on id
export default defineEventHandler(async (e) => {
  const body = await readBody(e);
  return db.note.update({ where: { id: body.id }, data: body });
});
```
```ts
// ✅
export default defineEventHandler(async (e) => {
  const session = await requireUserSession(e);          // nuxt-auth-utils
  const body = UpdateNote.parse(await readBody(e));      // schema
  const note = await db.note.findFirst({
    where: { id: body.id, userId: session.user.id },     // ownership
  });
  if (!note) throw createError({ statusCode: 404 });
  return db.note.update({ where: { id: note.id }, data: { text: body.text } });
});
```

`readBody`/`getQuery`/`getRouterParams`/`getHeader`/cookies are all
attacker-controlled — schema-parse before use. Use server middleware
(`server/middleware/`) for coarse gating only; real authz in the handler.

---

## SSR payload serialization leaks

Anything returned from `asyncData`/`useFetch`/`useAsyncData` or set into
state during SSR is serialized into the HTML (`window.__NUXT__`) and is
client-visible. Returning a full ORM row leaks every column. Project to a
DTO in the server route; don't fetch sensitive data into SSR state you
don't render.

---

## `v-html` and template injection

`v-html` with request-derived content is XSS (see `frontend.md` §XSS) —
sanitize with DOMPurify or render text. Also watch dynamic component
(`<component :is>`) names from input, and `v-bind` of a full attribute
object from input.

---

## Nitro `routeRules` proxy = SSRF / open proxy

```ts
// ❌ proxies to a host derived from the request → SSRF / open proxy
routeRules: { "/proxy/**": { proxy: "/**" } }
```
Pin proxy targets to fixed hosts; never interpolate a user-supplied host
into a `proxy` rule or `$fetch` target on the server (see `backend.md`
§ssrf).

---

## Other Nuxt notes

- `useFetch` to your own API during SSR runs server-side with the
  incoming request's cookies — ensure that internal call still authorizes
  (don't assume "internal" means trusted).
- `nuxt-security` module provides headers/CSP/CORS defaults — recommend it
  and check it isn't disabled per-route for sensitive pages
  (see `templates/security-headers.md`).
- `definePageMeta({ middleware })` route guards are **client-navigable UX**,
  not server authorization.

---

## Triage table

| Pattern | Severity |
|---|---|
| Secret in `runtimeConfig.public` / `VITE_`/`PUBLIC_` | High (rotate) |
| Nitro handler, no authn/authz/validation, sensitive effect | High–Critical |
| ORM row into SSR payload (`useAsyncData`/state) | High |
| `routeRules` proxy / server `$fetch` to user host | High (SSRF) |
| `v-html` on request data | High (stored) / Medium (reflected) |
| Authz only via `definePageMeta` middleware | High |
