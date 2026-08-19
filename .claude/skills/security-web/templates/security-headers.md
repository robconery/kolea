# Secure response headers & cookie flags — target state

Recommend these defaults; a per-route relaxation must carry a comment
saying why. Tighten CSP to your actual sources — a CSP with
`unsafe-inline`/`unsafe-eval` (or `*`) is barely a CSP; flag it.

## The header set

| Header | Value (baseline) | Why |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'` (add nonces/hashes, not `unsafe-inline`) | XSS mitigation, anti-framing |
| `X-Content-Type-Options` | `nosniff` | stop MIME sniffing |
| `X-Frame-Options` | `DENY` | legacy clickjacking (CSP `frame-ancestors` is primary) |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | HTTPS only (HTTPS sites only) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | limit referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` (deny unused) | reduce feature surface |
| `Cache-Control` (authed responses) | `no-store` | don't cache per-user data |

## Cookie flags (session/auth cookies)

```
Set-Cookie: sid=…; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400
```
- `HttpOnly` — JS can't read it (limits XSS token theft).
- `Secure` — HTTPS only.
- `SameSite=Lax` minimum; `None` requires `Secure` **and** a written
  cross-site reason; `Strict` for the most sensitive.
- `__Host-` prefix (no `Domain`, `Path=/`, `Secure`) for session cookies
  where possible.

## Hono

```ts
import { secureHeaders } from "hono/secure-headers";
app.use("*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"],
    frameAncestors: ["'none'"], scriptSrc: ["'self'"],
  },
  strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
}));
```

## Next.js (`next.config.js` headers + middleware nonce)

```js
async headers() {
  return [{
    source: "/:path*",
    headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      // CSP: prefer a per-request nonce set in middleware.ts over a static one
      { key: "Content-Security-Policy", value: "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
    ],
  }];
}
```

## Nuxt

Use the `nuxt-security` module (sets the above by default); verify it is
not disabled and CSP is tightened:

```ts
// nuxt.config.ts
modules: ["nuxt-security"],
security: {
  headers: {
    contentSecurityPolicy: {
      "default-src": ["'self'"], "object-src": ["'none'"],
      "base-uri": ["'none'"], "frame-ancestors": ["'none'"],
    },
    strictTransportSecurity: { maxAge: 63072000, includeSubdomains: true },
  },
},
```

## Bun (`Bun.serve`) — no middleware adds these; do it yourself

```ts
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Content-Security-Policy":
    "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
// merge SECURITY_HEADERS into every Response's headers
```
