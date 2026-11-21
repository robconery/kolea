import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { oauthClients, oauthCodes, oauthGrants, oauthTokens } from '../db/schema.ts'
import { randomToken, sha256 } from './ids.ts'

/**
 * Adding the mailer to Claude, or any MCP client, by pasting a URL.
 *
 * The MCP authorization spec, which is OAuth 2.1 with discovery bolted on: the
 * Worker is the resource server (`/mcp`) and its own authorization server, so
 * nobody copies a key. Ported from Kōlea's `Kolea.Connectors`, minus the
 * per-account addresses (there is one operator), plus short-lived access tokens
 * and rotating refresh tokens where Kōlea hands out a long-lived key.
 *
 * The flow, and the rule each step holds:
 *
 *   - **register** (RFC 7591): a client names itself and its redirect URIs. No
 *     secret — a public client. Registering grants nothing.
 *   - **authorize**: the operator, signed in through Cloudflare Access, sees the
 *     client's name, the redirect URI and what it asks for, and approves. That
 *     approval is the whole authentication. The code is single use, lives two
 *     minutes, is stored hashed and is bound to the client, the exact redirect
 *     URI and a PKCE S256 challenge. Read-only unless the operator ticks
 *     "allow changes".
 *   - **token**: code + verifier → an access token (one hour) and a refresh
 *     token (thirty days, good once — rotation). A replayed code or a replayed
 *     refresh token revokes the whole grant: only a thief and the rightful
 *     client would both be holding it.
 *   - **revoke** (RFC 7009), from the client or from Connected apps.
 *
 * Every way a code or refresh token can be wrong is the same `invalid_grant`,
 * so an answer never says which guess was close.
 */

export type Access = 'read' | 'write'

export const CODE_TTL_MS = 2 * 60 * 1000
export const ACCESS_TTL_MS = 60 * 60 * 1000
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** What a grant's token is allowed, as OAuth scope strings. */
export const SCOPES = ['mcp:read', 'mcp:write'] as const

export function scopeOf(access: Access): string {
  return access === 'write' ? 'mcp:read mcp:write' : 'mcp:read'
}

/** The MCP endpoint an OAuth token is for. One operator, one address. */
export function resourceUrl(origin: string): string {
  return `${origin}/mcp`
}

/** RFC 9728 §3.1: the metadata for `/mcp` lives at the well-known prefix + `/mcp`. */
export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`
}

/** RFC 8414 authorization server metadata. Everything an MCP client discovers. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
  }
}

/** RFC 9728 protected resource metadata for `/mcp`. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [...SCOPES],
    resource_name: 'Kōlea',
  }
}

// ───────────────────────────────────────────────── small, pure rules

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/

/**
 * Whether a code may be sent to `uri`: absolute, no fragment, no credentials,
 * and either https or plain http to this machine's loopback (RFC 8252), so a
 * code never crosses a network in the clear. Custom schemes are refused.
 */
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2000) return false
  // `new URL` drops an empty trailing `#`, so look for one in the raw string.
  if (uri.includes('#')) return false
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return url.hostname.length > 0
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname)
  return false
}

/** Whether a `resource` (RFC 8707) names this server's MCP endpoint. */
function isOurResource(resource: string, origin: string): boolean {
  return resource.replace(/\/+$/, '') === resourceUrl(origin)
}

/** base64url(SHA-256(verifier)) — the S256 transform (RFC 7636 §4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  let binary = ''
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Constant time, because both sides of these compares are secrets. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function withQuery(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v)
  return url.toString()
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

// ───────────────────────────────────────────────── register (RFC 7591)

export type OAuthClient = typeof oauthClients.$inferSelect

export type RegisterResult =
  | { ok: true; client: OAuthClient }
  | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string }

/**
 * Register a client from its metadata. Only the name and the redirect URIs are
 * taken; everything else a client sends (grant types, auth method, logo) is
 * answered with what this server does rather than honoured.
 */
export async function registerClient(db: Db, metadata: unknown): Promise<RegisterResult> {
  const body = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
    return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uris must list 1 to 10 URIs' }
  }
  if (!uris.every(isAllowedRedirectUri)) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: 'each redirect URI must be https, or http to localhost / 127.0.0.1, with no fragment',
    }
  }

  const rawName = typeof body.client_name === 'string' ? body.client_name.trim() : ''
  // Strip control characters: the name is shown to the operator, and a name
  // with embedded newlines or bidi overrides is how a consent screen lies.
  const name = rawName.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, 100)

  const row = await db
    .insert(oauthClients)
    .values({
      clientId: randomToken(32),
      clientName: name || 'MCP client',
      redirectUris: [...new Set(uris as string[])],
      createdAt: new Date(),
    })
    .returning()
    .get()

  return { ok: true, client: row }
}

/** The registration response body (RFC 7591 §3.2.1). */
export function registrationResponse(client: OAuthClient) {
  return {
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
  }
}

export async function getClient(db: Db, clientId: unknown): Promise<OAuthClient | null> {
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 200) return null
  return (await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).get()) ?? null
}

// ───────────────────────────────────────────────── authorize

/** A checked authorization request, ready to show the operator. */
export interface AuthorizeRequest {
  client: OAuthClient
  redirectUri: string
  codeChallenge: string
  state: string | null
  /** What the client asked for. Shown; never decides the grant's access. */
  scope: string | null
  resource: string | null
}

export type CheckResult =
  | { ok: true; request: AuthorizeRequest }
  /** Shown to the operator, never redirected to: the redirect URI is not trusted. */
  | { ok: false; show: string }
  /** Sent back to the client with OAuth's error code. */
  | { ok: false; redirect: string }

/**
 * Check an authorization request (the query of `/oauth/authorize`, or the same
 * fields posted back from the consent page — re-checked there, since a hidden
 * field is just another query string).
 *
 * An unknown client or a redirect URI it did not register is shown, never
 * redirected to: redirecting to an unverified URI is an open redirect that
 * also leaks the error. Anything else goes back to the client.
 */
export async function checkAuthorizeRequest(
  db: Db,
  params: Record<string, unknown>,
  origin: string,
): Promise<CheckResult> {
  const client = await getClient(db, params.client_id)
  if (!client) return { ok: false, show: 'This app is not registered. Start again from the app.' }

  const asked = str(params.redirect_uri)
  // A client with exactly one registered redirect URI may leave it out (OAuth 2.1 §4.1.1).
  const redirectUri =
    asked === null
      ? client.redirectUris.length === 1
        ? client.redirectUris[0]!
        : null
      : client.redirectUris.includes(asked)
        ? asked
        : null
  if (!redirectUri) {
    return { ok: false, show: 'The address this app wants to return to is not one it registered.' }
  }

  const state = str(params.state)
  const back = (error: string, description: string) => ({
    ok: false as const,
    redirect: withQuery(redirectUri, { error, error_description: description, state, iss: origin }),
  })

  if (params.response_type !== 'code') {
    return back('unsupported_response_type', 'only response_type=code is supported')
  }
  const challenge = str(params.code_challenge)
  if (params.code_challenge_method !== 'S256' || !challenge || !CHALLENGE.test(challenge)) {
    return back('invalid_request', 'PKCE with code_challenge_method=S256 is required')
  }
  const resource = str(params.resource)
  if (resource && !isOurResource(resource, origin)) {
    return back('invalid_target', 'resource must be this server’s /mcp endpoint')
  }

  return {
    ok: true,
    request: {
      client,
      redirectUri,
      codeChallenge: challenge,
      state,
      scope: str(params.scope),
      resource,
    },
  }
}

/** Where the operator's "No" goes (OAuth's `access_denied`). */
export function denyUrl(request: AuthorizeRequest, origin: string): string {
  return withQuery(request.redirectUri, {
    error: 'access_denied',
    error_description: 'the operator declined',
    state: request.state,
    iss: origin,
  })
}

/**
 * The operator approves: a one-time code is minted and the URL to send the
 * browser back to the client is returned. Only reachable from behind
 * `requireOperator` — the caller has already proved who is approving.
 */
export async function approve(
  db: Db,
  request: AuthorizeRequest,
  opts: { access: Access; approvedBy: string | null; origin: string; now?: Date },
): Promise<string> {
  const now = opts.now ?? new Date()
  const code = randomToken(48)
  await db.insert(oauthCodes).values({
    codeHash: await sha256(code),
    clientId: request.client.id,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    access: opts.access,
    approvedBy: opts.approvedBy,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    createdAt: now,
  })
  return withQuery(request.redirectUri, { code, state: request.state, iss: opts.origin })
}

// ───────────────────────────────────────────────── token

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

export type TokenResult =
  | { ok: true; body: TokenResponse }
  | {
      ok: false
      status: 400 | 401
      error: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unsupported_grant_type' | 'invalid_target'
      description?: string
    }

const invalidGrant: TokenResult = { ok: false, status: 400, error: 'invalid_grant' }

/**
 * The token endpoint (OAuth 2.1 §3.2): `authorization_code` with its PKCE
 * verifier, or `refresh_token`. Public clients only, so the client proves
 * nothing but its `client_id`; the verifier and the single-use refresh token
 * are what carry the weight.
 */
export async function exchangeToken(
  db: Db,
  params: Record<string, unknown>,
  origin: string,
  now = new Date(),
): Promise<TokenResult> {
  const grantType = str(params.grant_type)
  if (!grantType) return { ok: false, status: 400, error: 'invalid_request', description: 'grant_type is required' }
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return { ok: false, status: 400, error: 'unsupported_grant_type' }
  }

  const client = await getClient(db, params.client_id)
  if (!client) return { ok: false, status: 401, error: 'invalid_client' }

  const resource = str(params.resource)
  if (resource && !isOurResource(resource, origin)) {
    return { ok: false, status: 400, error: 'invalid_target' }
  }

  return grantType === 'authorization_code'
    ? await redeemCode(db, client, params, now)
    : await rotateRefresh(db, client, params, now)
}

async function redeemCode(
  db: Db,
  client: OAuthClient,
  params: Record<string, unknown>,
  now: Date,
): Promise<TokenResult> {
  const code = str(params.code)
  const verifier = str(params.code_verifier)
  if (!code || !verifier) {
    return { ok: false, status: 400, error: 'invalid_request', description: 'code and code_verifier are required' }
  }
  if (!VERIFIER.test(verifier)) return invalidGrant

  const row = await db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, await sha256(code))).get()
  if (!row) return invalidGrant

  // ⭐ A code presented twice: somebody else has it. Kill what it made.
  if (row.usedAt) {
    if (row.grantId) await revokeGrant(db, row.grantId, now)
    return invalidGrant
  }

  const redirectUri = str(params.redirect_uri)
  const good =
    row.clientId === client.id &&
    row.expiresAt.getTime() > now.getTime() &&
    (redirectUri === null || redirectUri === row.redirectUri) &&
    safeEqual(await pkceChallenge(verifier), row.codeChallenge)
  if (!good) return invalidGrant

  // Conditional claim: two exchanges racing on one code cannot both win.
  const claimed = await db
    .update(oauthCodes)
    .set({ usedAt: now })
    .where(and(eq(oauthCodes.id, row.id), isNull(oauthCodes.usedAt)))
    .returning({ id: oauthCodes.id })
    .all()
  if (claimed.length === 0) return invalidGrant

  const grant = await db
    .insert(oauthGrants)
    .values({
      clientId: client.id,
      access: row.access,
      redirectUri: row.redirectUri,
      approvedBy: row.approvedBy,
      createdAt: now,
      lastUsedAt: now,
    })
    .returning()
    .get()
  await db.update(oauthCodes).set({ grantId: grant.id }).where(eq(oauthCodes.id, row.id))

  return { ok: true, body: await issuePair(db, grant.id, grant.access, now) }
}

async function rotateRefresh(
  db: Db,
  client: OAuthClient,
  params: Record<string, unknown>,
  now: Date,
): Promise<TokenResult> {
  const token = str(params.refresh_token)
  if (!token) return { ok: false, status: 400, error: 'invalid_request', description: 'refresh_token is required' }

  const found = await db
    .select({ token: oauthTokens, grant: oauthGrants })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .where(and(eq(oauthTokens.tokenHash, await sha256(token)), eq(oauthTokens.kind, 'refresh')))
    .get()
  if (!found || found.grant.clientId !== client.id) return invalidGrant
  if (found.grant.revokedAt || found.token.revokedAt) return invalidGrant

  // ⭐ Rotation's whole point: a used refresh token coming back means two
  // parties hold it. Cut the grant off rather than guess which one is real.
  if (found.token.usedAt) {
    await revokeGrant(db, found.grant.id, now)
    return invalidGrant
  }
  if (found.token.expiresAt.getTime() <= now.getTime()) return invalidGrant

  const claimed = await db
    .update(oauthTokens)
    .set({ usedAt: now })
    .where(and(eq(oauthTokens.id, found.token.id), isNull(oauthTokens.usedAt)))
    .returning({ id: oauthTokens.id })
    .all()
  if (claimed.length === 0) return invalidGrant

  await db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, found.grant.id))
  return { ok: true, body: await issuePair(db, found.grant.id, found.grant.access, now) }
}

async function issuePair(db: Db, grantId: number, access: Access, now: Date): Promise<TokenResponse> {
  const accessToken = randomToken(48)
  const refreshToken = randomToken(48)
  await db.insert(oauthTokens).values([
    {
      grantId,
      kind: 'access',
      tokenHash: await sha256(accessToken),
      expiresAt: new Date(now.getTime() + ACCESS_TTL_MS),
      createdAt: now,
    },
    {
      grantId,
      kind: 'refresh',
      tokenHash: await sha256(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
      createdAt: now,
    },
  ])
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: scopeOf(access),
  }
}

// ───────────────────────────────────────────────── using a token

export interface OAuthCaller {
  grantId: number
  access: Access
  clientName: string
}

/**
 * Resolve `Authorization: Bearer <access token>` to a live grant, or null for
 * missing, unknown, expired, revoked and refresh tokens alike. A hit bumps the
 * grant's `last_used_at` — that is what Connected apps shows.
 */
export async function verifyAccessToken(
  db: Db,
  header: string | undefined,
  now = new Date(),
): Promise<OAuthCaller | null> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null

  const found = await db
    .select({ token: oauthTokens, grant: oauthGrants, clientName: oauthClients.clientName })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthTokens.tokenHash, await sha256(token)), eq(oauthTokens.kind, 'access')))
    .get()
  if (!found) return null
  if (found.token.revokedAt || found.grant.revokedAt) return null
  if (found.token.expiresAt.getTime() <= now.getTime()) return null

  await db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, found.grant.id))
  return { grantId: found.grant.id, access: found.grant.access, clientName: found.clientName }
}

// ───────────────────────────────────────────────── revoking

/**
 * RFC 7009 revocation, from the client. Always "fine" to the caller (§2.2):
 * whether a token existed is not something to confirm. Revoking a refresh
 * token ends the grant; revoking an access token ends just that token.
 * Holding a token is already holding its power, so revoking it needs nothing
 * more — but a `client_id` that names another client is ignored.
 */
export async function revokeToken(db: Db, params: Record<string, unknown>, now = new Date()): Promise<void> {
  const token = str(params.token)
  if (!token) return

  const found = await db
    .select({ token: oauthTokens, grant: oauthGrants, clientId: oauthClients.clientId })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(eq(oauthTokens.tokenHash, await sha256(token)))
    .get()
  if (!found) return

  const claimed = str(params.client_id)
  if (claimed !== null && claimed !== found.clientId) return

  if (found.token.kind === 'refresh') await revokeGrant(db, found.grant.id, now)
  else await db.update(oauthTokens).set({ revokedAt: now }).where(eq(oauthTokens.id, found.token.id))
}

/**
 * Disconnect an app. Revoke, don't delete — `mcp_calls` points at the grant.
 * Its tokens are stamped too, though the grant check alone would refuse them.
 */
export async function revokeGrant(
  db: Db,
  grantId: number,
  now = new Date(),
): Promise<{ ok: boolean; reason?: string }> {
  const grant = await db.select().from(oauthGrants).where(eq(oauthGrants.id, grantId)).get()
  if (!grant) return { ok: false, reason: 'no such connection' }
  if (grant.revokedAt) return { ok: false, reason: 'already disconnected' }

  await db.update(oauthGrants).set({ revokedAt: now }).where(eq(oauthGrants.id, grantId))
  await db
    .update(oauthTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)))
  return { ok: true }
}

/** Every app ever connected, newest first, live and revoked. */
export async function listConnectedApps(db: Db) {
  return await db
    .select({
      id: oauthGrants.id,
      clientName: oauthClients.clientName,
      redirectUri: oauthGrants.redirectUri,
      access: oauthGrants.access,
      approvedBy: oauthGrants.approvedBy,
      createdAt: oauthGrants.createdAt,
      lastUsedAt: oauthGrants.lastUsedAt,
      revokedAt: oauthGrants.revokedAt,
    })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .orderBy(desc(oauthGrants.createdAt), desc(oauthGrants.id))
    .all()
}
