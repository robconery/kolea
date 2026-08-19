import { eq } from 'drizzle-orm'
import { randomToken, sha256 } from '../core/ids.ts'
import type { Db } from '../db/index.ts'
import { preflightTokens } from '../db/schema.ts'
import type { Env } from '../types.ts'

export type PreflightKind = 'broadcast_send' | 'sequence_activate'

/** Long enough that a preview can be read; short enough that a stale plan dies. */
const TTL_MS = 10 * 60 * 1000

/**
 * A fingerprint of what was previewed.
 *
 * Editing the broadcast between preview and send changes this, and the send is
 * refused — which closes the gap where an agent previews a two-line test, edits
 * the body, and sends something nobody looked at.
 */
export async function digestOf(parts: unknown[]): Promise<string> {
  return await sha256(JSON.stringify(parts))
}

export async function mintPreflight(
  db: Db,
  kind: PreflightKind,
  targetId: number,
  digest: string,
  recipientCount: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(24)
  const expiresAt = new Date(Date.now() + TTL_MS)

  await db.insert(preflightTokens).values({
    tokenHash: await sha256(token),
    kind,
    targetId,
    digest,
    recipientCount,
    expiresAt,
    createdAt: new Date(),
  })

  return { token, expiresAt }
}

export type PreflightCheck =
  | { ok: true; recipientCount: number }
  | { ok: false; reason: string }

/**
 * Spend a preflight token, or explain why it can't be spent.
 *
 * Single-use: the row is stamped `used_at` before the caller sends anything, so
 * a retried tool call cannot send the same broadcast twice. Every rejection
 * says which of the four ways it failed, because "invalid token" leaves an
 * agent with nothing to do but guess.
 */
export async function consumePreflight(
  db: Db,
  kind: PreflightKind,
  targetId: number,
  digest: string,
  token: string,
): Promise<PreflightCheck> {
  if (!token) return { ok: false, reason: 'no preflight token supplied' }

  const row = await db
    .select()
    .from(preflightTokens)
    .where(eq(preflightTokens.tokenHash, await sha256(token)))
    .get()

  if (!row) return { ok: false, reason: 'unknown preflight token' }
  if (row.usedAt) return { ok: false, reason: 'preflight token was already used' }
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'preflight token expired' }
  if (row.kind !== kind) return { ok: false, reason: `token is for ${row.kind}, not ${kind}` }
  if (row.targetId !== targetId) {
    return { ok: false, reason: `token was minted for #${row.targetId}, not #${targetId}` }
  }
  if (row.digest !== digest) {
    return { ok: false, reason: 'content changed since the preview — preview it again' }
  }

  await db
    .update(preflightTokens)
    .set({ usedAt: new Date() })
    .where(eq(preflightTokens.id, row.id))

  return { ok: true, recipientCount: row.recipientCount }
}

/**
 * The kill switch. Off by default in production, so an agent that finds a way
 * past everything else still cannot put mail on the wire until you flip a var.
 */
export function sendingAllowed(env: Env): boolean {
  return env.MCP_ALLOW_SEND === 'true'
}

export const SEND_DISABLED =
  'Sending via MCP is switched off (MCP_ALLOW_SEND is not "true"). Everything else still works — the operator has to enable it in the Worker config.'
