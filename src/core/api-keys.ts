import { and, desc, eq, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { apiKeys, apiRateWindows } from '../db/schema.ts'
import { randomToken, sha256 } from './ids.ts'

/**
 * What a key may reach.
 *
 * - `send`: `POST /api/send` and `POST /api/sales`, nothing else. The default,
 *   because the commonest key is one pasted into a checkout's webhook.
 * - `read`: the REST API's GETs (`/api/v1`), nothing else. It
 *   can neither send, nor write, nor reach MCP, which is admin-only.
 * - `admin`: everything, MCP included.
 */
export const KEY_SCOPES = ['send', 'read', 'admin'] as const
export type KeyScope = (typeof KEY_SCOPES)[number]

export function isKeyScope(value: unknown): value is KeyScope {
  return typeof value === 'string' && (KEY_SCOPES as readonly string[]).includes(value)
}

/**
 * Whether a key holding `have` may do something that needs `need`.
 *
 * `admin` satisfies everything. Otherwise only an exact match does: a `read`
 * key cannot send and a `send` key cannot read, because each is handed to a
 * different kind of program and neither should grow into the other.
 */
export function scopeSatisfies(have: KeyScope, need: KeyScope): boolean {
  return have === 'admin' || have === need
}

/** Long enough to say what it is for; short enough to fit in a table cell. */
const NAME_MAX = 80

/**
 * Mint an API key. The plaintext token is returned exactly once and never
 * stored — only its SHA-256 goes in the row, so a leaked database still can't
 * be used to post as you (see `api/auth.ts`).
 */
export async function createApiKey(
  db: Db,
  name: string,
  scope: KeyScope = 'send',
): Promise<{ id: number; token: string }> {
  const token = randomToken(36)
  const inserted = await db
    .insert(apiKeys)
    .values({ name, tokenHash: await sha256(token), scope, createdAt: new Date() })
    .returning({ id: apiKeys.id })

  return { id: inserted[0]!.id, token }
}

export type MintResult =
  | { ok: true; id: number; token: string; name: string; scope: KeyScope }
  | { ok: false; reason: string }

/**
 * Mint from untrusted input (the admin form, an MCP call): a name is required,
 * and an unknown scope is refused rather than quietly read as `send`.
 */
export async function mintApiKey(
  db: Db,
  input: { name?: unknown; scope?: unknown },
): Promise<MintResult> {
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : ''
  if (!name) return { ok: false, reason: 'A key needs a name, so you can tell later what it was for.' }
  if (name.length > NAME_MAX) return { ok: false, reason: `Keep the name under ${NAME_MAX} characters.` }

  const scope = input.scope == null || input.scope === '' ? 'send' : input.scope
  if (!isKeyScope(scope)) {
    return { ok: false, reason: `Unknown scope. Use one of: ${KEY_SCOPES.join(', ')}.` }
  }

  const { id, token } = await createApiKey(db, name, scope)
  return { ok: true, id, token, name, scope }
}

/** Never returns `tokenHash` — there is no reason to move a hash around. */
export async function listApiKeys(db: Db) {
  return await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      scope: apiKeys.scope,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
    .all()
}

/**
 * Revoke, don't delete. The row is what `mcp_calls.api_key_id` points at, and a
 * revoked key you can still see in a list is how you answer "did I turn that
 * off?" months later.
 *
 * Takes effect on the next request: `verifyApiKey` reads the row every time and
 * nothing caches a key.
 */
export async function revokeApiKey(
  db: Db,
  id: number,
): Promise<{ ok: boolean; reason?: string }> {
  const key = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()
  if (!key) return { ok: false, reason: 'no such key' }
  if (key.revokedAt) return { ok: false, reason: 'already revoked' }

  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id))
  return { ok: true }
}

/** Requests a key may make per clock minute on `/api/v1`. */
export const RATE_LIMIT_PER_MINUTE = 120

/**
 * Count one request against a key's current minute. `ok: false` once the key is
 * over its limit, with how many seconds until the next minute opens.
 *
 * One upsert per request; the first request in a new minute also clears the
 * key's older buckets, so the table never grows past one row per active key.
 */
export async function takeRateSlot(
  db: Db,
  apiKeyId: number,
  now = Date.now(),
): Promise<{ ok: true; remaining: number } | { ok: false; retryAfter: number }> {
  const minute = Math.floor(now / 60_000)
  const rows = await db
    .insert(apiRateWindows)
    .values({ apiKeyId, minute, count: 1 })
    .onConflictDoUpdate({
      target: [apiRateWindows.apiKeyId, apiRateWindows.minute],
      set: { count: sql`${apiRateWindows.count} + 1` },
    })
    .returning({ count: apiRateWindows.count })
  const used = rows[0]?.count ?? 1

  if (used === 1) {
    await db
      .delete(apiRateWindows)
      .where(and(eq(apiRateWindows.apiKeyId, apiKeyId), lt(apiRateWindows.minute, minute)))
  }
  if (used > RATE_LIMIT_PER_MINUTE) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000)) }
  }
  return { ok: true, remaining: RATE_LIMIT_PER_MINUTE - used }
}
