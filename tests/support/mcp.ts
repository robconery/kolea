/**
 * Call one MCP tool through the deployed entry point, the way a client does:
 * `POST /mcp/<secret>` with a bearer key and a JSON-RPC `tools/call`.
 *
 * The server is stateless (a fresh `McpServer` per request), so no
 * `initialize` handshake is needed. It answers as a one-event SSE stream; this
 * unwraps it. A refusal at the door (404 path, 401 key) comes back as `status`
 * with no `result`.
 */
import type { World } from './world.ts'

/** The path secret every MCP-driving spec runs its world with. */
export const MCP_SECRET = 'spec-path-secret'

export interface ToolCall {
  status: number
  /** The tool's result, when the request got as far as a tool. */
  result?: { content: { type: string; text: string }[]; isError?: boolean }
  /** The first text block, which is what the model reads. */
  text: string
}

export async function callTool(
  world: World,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCall> {
  const res = await world.fetch(`/mcp/${MCP_SECRET}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })

  const raw = await res.text()
  if (res.status !== 200) return { status: res.status, text: raw }

  const data = raw
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .join('')
  const message = JSON.parse(data || raw) as { result?: ToolCall['result'] }
  return { status: res.status, result: message.result, text: message.result?.content[0]?.text ?? '' }
}

/**
 * An agent, as far as a spec is concerned.
 *
 * `agentFor()` mints a real `admin` API key and drives `ALL /mcp/:secret`
 * through `worker.fetch` — the deployed entry point, all three gates included
 * (path secret, bearer key, per-tool guards). Nothing underneath is called
 * directly, so a tool that is registered wrong, typed wrong or guarded wrong
 * fails here the way it would fail for Claude.
 *
 * The world must be created with `MCP_PATH_SECRET` set (and `MCP_ALLOW_SEND:
 * 'true'` for a spec that wants a tool to be allowed to send). `MCP_SECRET`
 * below is the value the specs use.
 */
import { createApiKey } from '../../src/core/api-keys.ts'
export interface ToolReply {
  isError: boolean
  /** The tool's first text block, as the model reads it. */
  text: string
  /** `text` parsed as JSON, or null when the tool answered in prose. */
  json: any
}

export interface Agent {
  call(tool: string, args?: Record<string, unknown>): Promise<ToolReply>
}

let rpcId = 0

export async function agentFor(w: World): Promise<Agent> {
  const { token } = await createApiKey(w.db, 'spec agent', 'admin')

  return {
    async call(tool, args = {}) {
      const res = await w.fetch(`/mcp/${MCP_SECRET}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++rpcId,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      })
      const raw = await res.text()
      // Streamable HTTP answers as one SSE event; plain JSON is accepted too.
      const payload = raw.includes('data: ')
        ? raw
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('')
        : raw
      const msg = JSON.parse(payload) as {
        result?: { isError?: boolean; content: { type: string; text?: string }[] }
        error?: { message: string }
      }
      if (msg.error) return { isError: true, text: msg.error.message, json: null }
      const text = msg.result?.content[0]?.text ?? ''
      let json: unknown = null
      try {
        json = JSON.parse(text)
      } catch {
        /* prose */
      }
      return { isError: Boolean(msg.result?.isError), text, json }
    },
  }
}
