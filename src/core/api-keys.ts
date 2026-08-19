import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { apiKeys } from '../db/schema.ts'
import { randomToken, sha256 } from './ids.ts'

export type KeyScope = 'send' | 'admin'

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
    .orderBy(desc(apiKeys.createdAt))
    .all()
}

/**
 * Revoke, don't delete. The row is what `mcp_calls.api_key_id` points at, and a
 * revoked key you can still see in a list is how you answer "did I turn that
 * off?" months later.
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
