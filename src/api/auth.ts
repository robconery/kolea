import { eq } from 'drizzle-orm'
import { type KeyScope, scopeSatisfies } from '../core/api-keys.ts'
import { sha256 } from '../core/ids.ts'
import type { Db } from '../db/index.ts'
import { apiKeys } from '../db/schema.ts'

/**
 * Resolve a `Authorization: Bearer <token>` header to a live API key.
 *
 * Only the hash is stored, so a leaked database still can't be used to post as
 * you. Returns null for missing, unknown, revoked and under-scoped tokens
 * alike — the caller says "invalid token" to all of them, because
 * distinguishing them out loud tells an attacker which guesses were close.
 *
 * `admin` satisfies any requirement; `send` and `read` satisfy only
 * themselves (`scopeSatisfies` in core). That asymmetry is the point of the
 * scope: a key handed to a checkout webhook can post a receipt and nothing else,
 * and a `read` key can never put mail on the wire.
 */
export async function verifyApiKey(
  db: Db,
  header: string | undefined,
  requiredScope: KeyScope = 'send',
) {
  const key = await liveApiKey(db, header)
  if (!key || !scopeSatisfies(key.scope, requiredScope)) return null

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id))
  return key
}

/**
 * The live (present, unrevoked) key a bearer header names, whatever its scope,
 * or null. For `/api/v1`, which answers 401 for "no usable key" and 403 for
 * "a real key that may not do this". The scope check is the caller's, and so
 * is stamping `last_used_at`.
 */
export async function liveApiKey(db: Db, header: string | undefined) {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null

  const key = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.tokenHash, await sha256(token)))
    .get()
  if (!key || key.revokedAt) return null
  return key
}

/** Stamp a key's last use. */
export async function touchApiKey(db: Db, id: number): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id))
}
