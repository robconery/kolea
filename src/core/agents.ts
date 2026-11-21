import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { type AgentSettings, agentSettings } from '../db/schema.ts'
import type { Env } from '../types.ts'

/**
 * ⭐ What an agent may do that cannot be taken back. Ported from Kōlea's
 * `Kolea.Agents` (SPEC 20.3): two switches, both off until the operator turns
 * them on, and one function per switch that every gated MCP tool asks.
 *
 * **Sending.** `MCP_ALLOW_SEND` used to be the whole switch, which meant a
 * redeploy to flip it. Now the row decides, and the var is only a hard
 * override that can force sending off: `"false"` always wins, anything else
 * (unset, `"true"`) defers to the row. The var can take away; it can never
 * turn sending on behind the screen's back.
 *
 * **Sensitive changes.** Deleting people, removing a suppression, importing a
 * list, minting a key. An agent reads text strangers wrote (names, form
 * answers), and that text can steer it, so the tools that could put mail in
 * front of someone who left or hand out lasting access ask
 * `agentSensitiveAllowed` first. There is no env override: nothing deployed
 * today depends on these being open.
 *
 * Neither switch has an MCP tool. The switch exists to stop the agent that
 * holds a key, so only a person on the admin screen flips it.
 */

export type AgentSwitches = Pick<AgentSettings, 'allowSend' | 'allowSensitive'>

const OFF: AgentSwitches = { allowSend: false, allowSensitive: false }

export async function getAgentSwitches(db: Db): Promise<AgentSwitches & { updatedAt: Date | null }> {
  const row = await db.select().from(agentSettings).where(eq(agentSettings.id, 1)).get()
  return row
    ? { allowSend: row.allowSend, allowSensitive: row.allowSensitive, updatedAt: row.updatedAt }
    : { ...OFF, updatedAt: null }
}

/** Create or update the one row. Only the switches passed are written. */
export async function setAgentSwitches(db: Db, patch: Partial<AgentSwitches>): Promise<AgentSwitches> {
  const now = new Date()
  const row = await db
    .insert(agentSettings)
    .values({ id: 1, ...OFF, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: agentSettings.id, set: { ...patch, updatedAt: now } })
    .returning()
    .get()
  return { allowSend: row.allowSend, allowSensitive: row.allowSensitive }
}

/** True when the Worker config forces agent sending off, whatever the row says. */
export function sendForcedOff(env: Pick<Env, 'MCP_ALLOW_SEND'>): boolean {
  return env.MCP_ALLOW_SEND === 'false'
}

/**
 * ⭐ The one answer to "may an MCP tool put mail on the wire now?". Every MCP
 * send tool calls this; none reads the var or the row itself.
 */
export async function agentSendAllowed(env: Pick<Env, 'MCP_ALLOW_SEND'>, db: Db): Promise<boolean> {
  if (sendForcedOff(env)) return false
  return (await getAgentSwitches(db)).allowSend
}

/** The one answer to "may an MCP tool make a sensitive change now?". */
export async function agentSensitiveAllowed(db: Db): Promise<boolean> {
  return (await getAgentSwitches(db)).allowSensitive
}

/** Why a send tool refused, in words the model can act on. */
export function agentSendRefusal(env: Pick<Env, 'MCP_ALLOW_SEND'>): string {
  return sendForcedOff(env)
    ? 'Sending via MCP is switched off: the Worker config sets MCP_ALLOW_SEND="false", which overrides the admin switch. Everything else still works; the operator has to remove that var to allow agent sending.'
    : 'Sending via MCP is switched off. Everything else still works; the operator can turn agent sending on in the admin under System > Agents & keys.'
}

export const AGENT_SENSITIVE_OFF =
  'Sensitive changes (deleting people, removing suppressions, importing lists, minting keys) are switched off for agents. The operator can turn them on in the admin under System > Agents & keys.'
