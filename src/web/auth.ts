import type { MiddlewareHandler } from 'hono'
import type { Env } from '../types.ts'

/**
 * Cloudflare Access, actually verified.
 *
 * The app holds no password (SPEC 8.1): Access terminates identity at the edge
 * and forwards a signed JWT. Presence of that header is NOT proof of anything —
 * anyone who can reach the Worker origin can set a header — so the signature,
 * issuer, audience and expiry are all checked here against the team's live
 * JWKS. Getting this wrong means an open admin console on the public internet.
 */

interface AccessClaims {
  aud?: string | string[]
  iss?: string
  exp?: number
  nbf?: number
  email?: string
  sub?: string
}

/**
 * Per-isolate JWKS cache.
 *
 * Access rotates keys every 6 weeks and keeps the previous key valid for 7
 * days, so a short TTL is plenty and a rotation can never lock us out. Cached
 * because a fetch per request would put a network round trip in front of every
 * admin page load. Never hard-code the key: a pinned key expires and takes the
 * console with it.
 */
const JWKS_TTL_MS = 60 * 60 * 1000
let jwksCache: { teamDomain: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null

async function loadKeys(teamDomain: string, force = false): Promise<Map<string, CryptoKey>> {
  const fresh =
    jwksCache &&
    jwksCache.teamDomain === teamDomain &&
    Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
  if (fresh && !force) return jwksCache!.keys

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`)

  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] }
  const keys = new Map<string, CryptoKey>()
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid) continue
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    )
  }

  jwksCache = { teamDomain, keys, fetchedAt: Date.now() }
  return keys
}

/** base64url → bytes. JWTs are base64url, which atob does not accept directly. */
function decodeSegment(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
}

export type AccessResult =
  | { ok: true; email: string | null }
  | { ok: false; reason: string }

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<AccessResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' }

  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string]

  let header: { alg?: string; kid?: string }
  let claims: AccessClaims
  try {
    header = JSON.parse(new TextDecoder().decode(decodeSegment(rawHeader)))
    claims = JSON.parse(new TextDecoder().decode(decodeSegment(rawPayload)))
  } catch {
    return { ok: false, reason: 'unparseable token' }
  }

  // Pin the algorithm. Accepting whatever `alg` says is how "alg: none" and
  // RSA-key-as-HMAC-secret forgeries work.
  if (header.alg !== 'RS256') return { ok: false, reason: `unexpected alg ${header.alg}` }
  if (!header.kid) return { ok: false, reason: 'no key id' }

  let keys = await loadKeys(teamDomain)
  let key = keys.get(header.kid)
  if (!key) {
    // Unknown kid usually means a rotation we have not seen yet, not an attack.
    keys = await loadKeys(teamDomain, true)
    key = keys.get(header.kid)
  }
  if (!key) return { ok: false, reason: 'unknown signing key' }

  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  const signature = decodeSegment(rawSignature)
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as unknown as ArrayBuffer,
    signed as unknown as ArrayBuffer,
  )
  if (!valid) return { ok: false, reason: 'bad signature' }

  // A valid signature only proves Access issued it — for some application, in
  // some account. The audience check is what ties it to *this* app; without it
  // any Access token from anywhere is accepted.
  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []
  if (!aud.includes(audience)) return { ok: false, reason: 'audience mismatch' }
  if (claims.iss !== `https://${teamDomain}`) return { ok: false, reason: 'issuer mismatch' }

  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp === 'number' && claims.exp < now) return { ok: false, reason: 'expired' }
  if (typeof claims.nbf === 'number' && claims.nbf > now) return { ok: false, reason: 'not yet valid' }

  return { ok: true, email: claims.email ?? null }
}

export const requireOperator: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.env.DEV_AUTH_BYPASS === 'true') return await next()

  const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN
  const audience = c.env.CF_ACCESS_AUD

  // Fail closed. A misconfigured deploy must lock the console, never open it —
  // the failure mode of the opposite choice is the whole list walking out.
  if (!teamDomain || !audience) {
    return c.text('Forbidden: Cloudflare Access is not configured on this Worker', 403)
  }

  const token =
    c.req.header('Cf-Access-Jwt-Assertion') ??
    // Browsers carry the cookie; the header is preferred but not guaranteed.
    /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(c.req.header('Cookie') ?? '')?.[1]

  if (!token) return c.text('Forbidden: Cloudflare Access required', 403)

  let result: AccessResult
  try {
    result = await verifyAccessJwt(token, teamDomain, audience)
  } catch {
    // A JWKS fetch failure is our problem, not the caller's — but it still
    // cannot be allowed to admit anyone.
    return c.text('Forbidden: could not verify Access token', 403)
  }

  if (!result.ok) return c.text('Forbidden: invalid Access token', 403)

  c.set('operatorEmail' as never, result.email as never)
  return await next()
}
