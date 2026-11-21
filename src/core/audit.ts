import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { apiKeys, auditEntries } from '../db/schema.ts'
import { sha256 } from './ids.ts'

/**
 * ⭐ The audit trail: who changed what, and what they were refused.
 *
 * Three kinds of actor, two tables:
 *   operator — a person through the console, identified by the email in the
 *              verified Cloudflare Access JWT (`web/auth.ts`)
 *   key      — another application through `/api/send` or `/api/sales`
 *   agent    — an MCP client, already recorded call by call in `mcp_calls`
 *              (`mcp/kit.ts`). Not written again here; the Logs page reads both.
 *
 * Rules, same as `core/activity.ts`: recording never throws into its caller (a
 * lost audit row is bad; a lost send because the audit insert failed is worse),
 * and request bodies never land here whole.
 */

export type AuditOutcome = 'ok' | 'denied' | 'error'

export interface AuditInput {
  actorKind: 'operator' | 'key'
  actorId: string | null
  /** The operator's team role at the time (`core/team.ts`). Null for keys. */
  actorRole?: 'owner' | 'admin' | 'writer' | null
  apiKeyId?: number | null
  action: string
  target: string | null
  outcome: AuditOutcome
  detail?: string | null
  status: number
  summary?: Record<string, string>
  at?: Date
}

export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  try {
    await db.insert(auditEntries).values({
      at: input.at ?? new Date(),
      actorKind: input.actorKind,
      actorId: input.actorId?.slice(0, 200) ?? null,
      actorRole: input.actorRole ?? null,
      apiKeyId: input.apiKeyId ?? null,
      action: input.action.slice(0, 200),
      target: input.target?.slice(0, 200) ?? null,
      outcome: input.outcome,
      detail: input.detail ? input.detail.split('\n')[0]!.slice(0, 300) : null,
      status: input.status,
      summary: input.summary ?? {},
    })
  } catch {
    /* the trail is never worth the operation it is describing */
  }
}

// ───────────────────────────────────────────────── pure helpers

/**
 * The fields worth keeping from a request body. An allowlist, not a denylist:
 * a new form field is invisible here until someone decides it is safe, which
 * is the right failure for a table that is kept forever.
 */
const SUMMARY_FIELDS = [
  'name',
  'subject',
  'title',
  'status',
  'scope',
  'kind',
  'slug',
  'tag',
  'email',
  'reason',
  'trigger',
  'confirm',
  'expected',
] as const

/** Belt and braces: even an allowlisted name is dropped if it smells like a credential. */
const SECRET = /token|secret|password|passwd|key|auth|card|cvc/i

export function summarize(body: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!body || typeof body !== 'object') return out
  for (const field of SUMMARY_FIELDS) {
    if (SECRET.test(field)) continue
    const v = body[field]
    if (v === undefined || v === null || v === '') continue
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue
    out[field] = String(v).slice(0, 120)
  }
  return out
}

/**
 * `POST /broadcasts/12/send` → action `POST /broadcasts/:id/send`, target
 * `broadcasts/12`. Numeric segments are the ids; the last one, with the
 * segment before it, is what the action was done to.
 */
export function describeRequest(method: string, path: string): { action: string; target: string | null } {
  const parts = path.split('/').filter(Boolean)
  let target: string | null = null
  const pattern = parts.map((seg, i) => {
    if (/^\d+$/.test(seg)) {
      target = i > 0 ? `${parts[i - 1]}/${seg}` : seg
      return ':id'
    }
    return seg
  })
  return { action: `${method.toUpperCase()} /${pattern.join('/')}`, target }
}

/**
 * Read the outcome off what the caller got. A refusal in this app is either a
 * 4xx or a redirect carrying `kind=warn` / `kind=error` (the console's flash
 * convention), so most refusals need no code in the handler at all.
 */
export function outcomeOf(status: number, location: string | null): { outcome: AuditOutcome; flash: string | null } {
  if (status >= 500 || status === 0) return { outcome: 'error', flash: null }
  if (status >= 400) return { outcome: 'denied', flash: null }
  if (status >= 300 && location) {
    try {
      const url = new URL(location, 'http://x')
      const kind = url.searchParams.get('kind')
      if (kind === 'warn' || kind === 'error') {
        return { outcome: 'denied', flash: url.searchParams.get('flash') }
      }
    } catch {
      /* a Location we cannot parse is still a success */
    }
  }
  return { outcome: 'ok', flash: null }
}

/** The key a bearer header names, without touching `last_used_at`. Null if none. */
export async function keyIdFor(db: Db, header: string | undefined): Promise<number | null> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null
  try {
    const row = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.tokenHash, await sha256(token)))
      .get()
    return row?.id ?? null
  } catch {
    return null
  }
}
