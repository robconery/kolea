# Frontend / Browser-Side — full reference

Each section: **threat**, a **vulnerable** pattern, the **fix**, **review
notes**, and **false positives** (when it is not a finding). The browser
runs attacker-influenced data in a context you don't control; every output
sink is a potential interpreter.

---

## §XSS — Cross-Site Scripting

**Threat:** untrusted data reaches an HTML/JS/URL/CSS interpreter and runs
as code in the victim's origin: session theft, account takeover, request
forgery with the victim's cookies. Stored XSS (persisted, hits every
viewer) is High–Critical; reflected/DOM XSS is Medium–High.

### The sinks to grep for

`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
`dangerouslySetInnerHTML`, `v-html`, `el.innerHTML=`, `$(...).html()`,
`eval`, `new Function`, `setTimeout`/`setInterval` with a string,
`<a href={userUrl}>` / `src=` with `javascript:`, `style={userValue}`,
`jsonp`, framework `ref` + manual DOM, Angular `[innerHTML]`/`bypassSecurity*`.

```tsx
// ❌ vulnerable — comment body is attacker-controlled
<div dangerouslySetInnerHTML={{ __html: comment.body }} />
```
```vue
<!-- ❌ vulnerable -->
<div v-html="comment.body" />
```

**Fix — pick the weakest tool that works:**

1. **Don't render HTML.** Render text; let the framework escape it
   (`{comment.body}` in JSX, `{{ body }}` in Vue auto-escape). This closes
   the bug entirely and is the default expectation.
2. **If HTML is genuinely required**, sanitize with a vetted, allowlist
   sanitizer in the proven path — DOMPurify client-side, or sanitize on
   the server before storage *and* on render (store raw, sanitize on
   output, so the policy can change):

```tsx
import DOMPurify from "isomorphic-dompurify";
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(comment.body) }} />
```

3. **Contextual encoding for non-HTML sinks.** A value safe in HTML text is
   unsafe in an attribute, a `<script>` block, a URL, or CSS. Never build a
   `<script>JSON</script>` by string concat — use `JSON.stringify` with
   `<`/`>`/`&`/`U+2028`/`U+2029` escaped, or a data attribute parsed with
   `JSON.parse`.

**Review notes:** trace the data, don't pattern-match the line. `body` may
be sanitized three calls upstream (not a finding) or "sanitized" by a regex
that strips `<script>` only (still a finding — `onerror=`, `javascript:`,
SVG, `<iframe srcdoc>` bypass it). Markdown renderers (`marked`,
`markdown-it`) emit raw HTML by default — they need a sanitizer too.
A CSP (see `templates/security-headers.md`) is *mitigation*, not a fix;
report the XSS even if a CSP exists.

**False positives:** the value is a hardcoded constant or developer-authored
content with no request-derived path; the framework's default escaping is
in effect and not bypassed; the sink receives a sanitizer output you traced.

---

## §URL / navigation sinks

**Threat:** `javascript:` and `data:` URLs in `href`/`src`/`window.open`
execute script; `target="_blank"` without `rel` lets the opened page
rewrite `window.opener.location` (reverse tabnabbing); user-controlled
redirect targets enable open redirect → phishing / OAuth token theft.

```tsx
// ❌ javascript: executes; open redirect; tabnabbing
<a href={user.website}>site</a>
<a href={next} target="_blank">continue</a>          // no rel
location.href = params.get("returnTo");              // open redirect
```
```tsx
// ✅
const safe = /^https?:\/\//i.test(user.website) ? user.website : "#";
<a href={safe} target="_blank" rel="noopener noreferrer">site</a>;
// redirect: allowlist to same-origin / known paths
const dest = ALLOWED_PATHS.has(next) ? next : "/";
```

**Review notes:** validate scheme with an allowlist (`https:`/`http:`/
`mailto:`), never a denylist of `javascript:`. For redirects, prefer a
path allowlist or a mapping table; if a full URL must be accepted, require
same-origin (`new URL(next, location.origin).origin === location.origin`).
Modern Chromium implies `noopener` for `_blank` but Safari/older do not —
still require explicit `rel`.

**False positives:** href is a static internal route; redirect target is an
opaque server-issued token resolved server-side, not the literal URL.

---

## §postMessage / cross-window messaging

**Threat:** a `message` listener that doesn't verify `event.origin` (and
`event.source`) accepts commands from any page that framed or opened you —
DOM XSS, token exfiltration.

```ts
// ❌ accepts messages from anyone
window.addEventListener("message", (e) => { applyConfig(e.data); });
```
```ts
// ✅
window.addEventListener("message", (e) => {
  if (e.origin !== "https://trusted.example.com") return;
  // validate shape; treat e.data as untrusted input
});
```
Sending side: pass an explicit `targetOrigin`, never `"*"`, for any
non-public data.

**False positives:** origin is checked against an allowlist just below;
the listener handles only public, side-effect-free data and posts to `"*"`
intentionally.

---

## §Clickjacking / framing

**Threat:** your authenticated, state-changing UI is framed transparently
over attacker bait; the victim's clicks hit your buttons.

**Fix:** `Content-Security-Policy: frame-ancestors 'none'` (or an
allowlist) *and* `X-Frame-Options: DENY` for legacy. Sensitive actions
(transfer, delete, grant) also need an explicit confirmation step — framing
defenses are not the only control. See `templates/security-headers.md`.

**False positives:** the route is public, read-only, and intentionally
embeddable (a widget) — then the allowlist is the design, document it.

---

## §Secrets in the client bundle / payload

**Threat:** the client bundle, source maps, network responses, RSC/SSR
payload, and `localStorage` are all attacker-readable. Any secret there is
disclosed. Common leaks: API keys in `NEXT_PUBLIC_*`/`NUXT_PUBLIC_*`/
`VITE_*`/`PUBLIC_*`, a server token serialized into props/loader data, a
full user object (with hashes/PII) hydrated for the client, JWTs in
`localStorage` (readable by any XSS).

```ts
// ❌ shipped to every browser
const stripe = new Stripe(process.env.NEXT_PUBLIC_STRIPE_SECRET);
// ❌ serializes the whole row, incl. password_hash, into HTML
return { props: { user: await db.user.find(id) } };
```
```ts
// ✅ secret stays server-side; only the publishable key is public
// ✅ project the response to exactly the fields the client needs
return { props: { user: { id: u.id, name: u.name, avatar: u.avatar } } };
```

**Review notes:** `*_PUBLIC_*` / `VITE_` / `PUBLIC_` prefixes are inlined
into client code by design — finding any credential, signing key, or
internal URL there is automatic. Check serialized server data (getServer
SideProps, RSC, Nuxt payload, loaders) for over-fetching: project DTOs,
never return ORM rows. A leaked secret is **rotate, not redact** — note
that in the finding. Prefer in-memory or `HttpOnly` cookie token storage
over `localStorage`/`sessionStorage`.

**False positives:** the "secret" is a designed-public value (Stripe
publishable key, Firebase web config, Sentry DSN, public Mapbox token) —
these are meant to be client-side; confirm it is the publishable variant.

---

## §DOM clobbering & prototype pollution (client)

**Threat:** attacker-named DOM ids/names shadow JS globals/properties
(`window.config`); merging attacker JSON with a recursive `merge`/`extend`
into `Object.prototype` corrupts every object → XSS/auth bypass downstream.

**Fix:** never deep-merge untrusted input into existing objects; use
`Object.create(null)` maps, reject `__proto__`/`constructor`/`prototype`
keys, prefer `structuredClone` + explicit field copy. Audit `lodash.merge`/
`deepmerge`/query-string parsers fed request data.

**False positives:** merge source is a static config object, not request
data; library version is patched and keys are filtered.

---

## §Third-party scripts & supply chain (client)

**Threat:** a `<script src="cdn…">` (analytics, tag manager, widget) runs
with full origin privileges; a compromised CDN/package = full client
compromise (Magecart). Inline event handlers and CDN scripts also force
`unsafe-inline`, gutting CSP.

**Fix:** self-host where possible; otherwise Subresource Integrity
(`integrity=` + `crossorigin`) and a strict CSP `script-src` allowlist;
minimize third parties; review what each can access (a payment page should
have near-zero third-party JS).

**False positives:** SRI is present and pinned; the script is first-party
and CSP-scoped.

---

## Quick triage table

| Seen in diff | Default severity if request-derived |
|---|---|
| `dangerouslySetInnerHTML` / `v-html` / `innerHTML` on stored data | High (stored XSS) |
| same, on reflected query/hash | Medium–High |
| `eval`/`new Function` with any non-constant | High |
| credential in `*_PUBLIC_*`/`VITE_`/`PUBLIC_` | High (rotate) |
| ORM row / user object serialized to client | Med–High (PII/secret) |
| `postMessage` listener, no origin check | Medium–High |
| `target="_blank"` no `rel` | Low |
| open redirect | Medium (High if in OAuth flow) |
| missing `frame-ancestors` on sensitive UI | Medium |
