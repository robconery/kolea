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
