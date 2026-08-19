import { eq } from 'drizzle-orm'
import type { KeyScope } from '../core/api-keys.ts'
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
 * `admin` satisfies a `send` requirement; the reverse never holds. That
 * asymmetry is the point of the scope: a key handed to a checkout webhook can
 * post a receipt and nothing else.
 */
export async function verifyApiKey(
  db: Db,
  header: string | undefined,
  requiredScope: KeyScope = 'send',
) {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null

  const key = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.tokenHash, await sha256(token)))
    .get()
  if (!key || key.revokedAt) return null
  if (requiredScope === 'admin' && key.scope !== 'admin') return null

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id))
  return key
}
