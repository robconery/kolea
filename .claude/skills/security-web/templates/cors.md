# CORS — correct allowlist pattern

The only safe credentialed CORS is an **exact-match allowlist**. `*` with
credentials is browser-rejected; reflecting `Origin` unconditionally
reintroduces the same hole. Substring/`endsWith`/regex matches are how
`evil-example.com` and `example.com.attacker.io` get in — use a `Set`.

```ts
const ALLOWED = new Set([
  "https://app.example.com",
  "https://admin.example.com",
]);

function corsHeaders(origin: string | null): HeadersInit {
  if (!origin || !ALLOWED.has(origin)) return {};        // no CORS = denied
  return {
    "Access-Control-Allow-Origin": origin,               // echo the matched origin
    "Vary": "Origin",                                     // cache correctness
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "600",
  };
}
```

## Hono

```ts
import { cors } from "hono/cors";
app.use("/api/*", cors({
  origin: (o) => (ALLOWED.has(o) ? o : null),  // exact match; null = blocked
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "DELETE"],
  allowHeaders: ["Content-Type", "Authorization"],
}));
```

## Rules

- Public, credential-free, read-only API → `Access-Control-Allow-Origin: *`
  is acceptable (and then **never** `Allow-Credentials: true`).
- Credentialed API → exact-match allowlist only, always `Vary: Origin`.
- `null` origin (sandboxed iframe, `file://`, some redirects) is **not**
  trusted — never allowlist the literal string `"null"`.
- Preflight (`OPTIONS`) must apply the *same* allowlist as the actual
  request; don't blanket-allow `OPTIONS`.
- CORS controls who can *read cross-origin responses in a browser*. It is
  **not** authn/authz and not CSRF defense — those are still required.
