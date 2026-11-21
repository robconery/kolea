import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { apiKeys } from '../db/schema.ts'
import { randomToken, sha256 } from './ids.ts'

/**
 * What a key may reach.
 *
 * - `send`: `POST /api/send` and `POST /api/sales`, nothing else. The default,
 *   because the commonest key is one pasted into a checkout's webhook.
 * - `read`: reads only. Nothing reads with a key yet; the REST API will (Kōlea
 *   SPEC 20.1). It can neither send nor reach MCP, which is admin-only.
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
