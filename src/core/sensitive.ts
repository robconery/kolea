import type { Env } from '../types.ts'

/**
 * Whether an agent (MCP) may make a sensitive change: one that decides where
 * subscriber data goes or removes something that cannot be put back. Today
 * that is the webhook writes.
 *
 * Off unless the operator opts in with `MCP_ALLOW_SENSITIVE="true"` — the same
 * shape as `MCP_ALLOW_SEND`, because an agent that finds its way past
 * everything else should still not be able to point the list at a URL of its
 * choosing. The one place this question is answered; every gated tool asks
 * here.
 */
export function agentsMaySensitive(env: Pick<Env, 'MCP_ALLOW_SENSITIVE'>): boolean {
  return env.MCP_ALLOW_SENSITIVE === 'true'
}

export const SENSITIVE_DISABLED =
  'Sensitive changes via MCP are switched off (MCP_ALLOW_SENSITIVE is not "true"). Reading still works; the operator can make this change in the admin under System → Webhooks, or turn agent access on in the Worker config.'
