# Bun runtime — security review

Generic findings still apply (`backend.md`, `frontend.md`). Bun gives you
fast primitives with **no framework safety net** — `Bun.serve` has no
default body limits, no CSRF, no auth, no routing guards. You own all of it.

---

## `Bun.$` shell — command injection

`Bun.$` runs a shell. Interpolated template values are auto-escaped by Bun
*as arguments*, which helps — but `$({ raw })`, building the command string
yourself, or passing untrusted data as a flag/path is still injection or
argument injection.

```ts
// ❌ raw bypasses escaping → command injection
await $`sh -c ${"echo " + userInput}`;
await $({ raw: `convert ${name} out.png` });
// ⚠️ argument injection even when escaped: name = "--malicious-flag"
await $`mytool ${name}`;
```
```ts
// ✅ no shell, explicit args, `--` to end option parsing
Bun.spawn(["convert", "--", name, "out.png"]);
```
Prefer `Bun.spawn`/`Bun.spawnSync` with an argv array over `Bun.$` for
anything touching input. Never `{ raw }` with request data. Guard against
argument injection (values starting with `-`) with `--` or validation.

---

## `Bun.serve` — you implement the safety net

```ts
// ❌ no body cap, no auth, path from URL → traversal + DoS
Bun.serve({
  async fetch(req) {
    const p = new URL(req.url).pathname;
    return new Response(Bun.file("." + p));      // ../ traversal
  },
});
```
```ts
// ✅
Bun.serve({
  maxRequestBodySize: 1_000_000,                 // cap (default is large)
  async fetch(req) {
    const name = path.basename(new URL(req.url).pathname); // strip dirs
    const full = path.resolve(PUBLIC_DIR, name);
    if (!full.startsWith(path.resolve(PUBLIC_DIR) + path.sep))
      return new Response("no", { status: 403 });
    // authn/authz/validation here — nothing does it for you
    return new Response(Bun.file(full));
  },
});
```
Review every `Bun.serve`: body size cap set; auth/authz in `fetch`;
`Bun.file(...)` paths confined and not built from the URL; security headers
added manually (no middleware adds them — see
`templates/security-headers.md`); errors caught (an uncaught throw leaks
stack in dev). If a framework (Elysia/Hono) is on top, review *its* config
instead, but confirm Bun-level limits aren't bypassed.

---

## Passwords & crypto

Use `Bun.password.hash`/`verify` (argon2id default, salted, constant-time)
— not `Bun.hash` (non-cryptographic, for hashmaps) and not
`crypto.createHash("sha256")` for passwords. `crypto.randomUUID()` /
`crypto.getRandomValues` for tokens, never `Math.random()`.

```ts
const hash = await Bun.password.hash(pw);            // ✅
const ok = await Bun.password.verify(pw, user.hash); // ✅ constant-time
```

---

## `bun:sqlite` / `Bun.sql` — parameterize

```ts
// ❌ injection
db.query(`select * from users where email='${email}'`).get();
// ✅ bound params
db.query("select * from users where email=$email").get({ $email: email });
await sql`select * from users where email=${email}`;  // tagged = safe
```
Dynamic identifiers (table/column/`order by`) must be allowlisted — bind
params can't parameterize identifiers (see `backend.md` §injection).

---

## Env & files

- `Bun.env`/`process.env` is server-only — but a bundled client entry
  inlines referenced env. Don't reference secrets in client-bundled code.
  `.env`/`.env.local` must be git-ignored; flag committed `.env` with
  real secrets (rotate).
- `Bun.file(userPath)` / `Bun.write(userPath, ...)` with request-derived
  paths is traversal — confine with `path.resolve` + prefix check
  (see `backend.md` §files).
- Bun auto-loads `.env`; ensure test/CI env files don't ship to prod
  images.

---

## Triage table

| Pattern | Severity |
|---|---|
| `Bun.$({ raw })` / shell string with input | Critical (RCE) |
| `Bun.$`/`spawn` with input as flag/path, no `--`/validation | High |
| `Bun.file("." + url.pathname)` style | High (traversal) |
| `Bun.serve` no `maxRequestBodySize`, expensive handler | Medium (DoS) |
| `Bun.serve` handler with no authn/authz on sensitive route | High–Critical |
| `Bun.hash`/SHA for passwords | High |
| string-built `bun:sqlite`/`Bun.sql` query | Critical (SQLi) |
| committed `.env` with secrets | High (rotate) |
