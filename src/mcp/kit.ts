import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server'
import type * as z from 'zod/v4'
import type { Db } from '../db/index.ts'
import { mcpCalls } from '../db/schema.ts'
import type { Env } from '../types.ts'

/**
 * Everything a tool handler needs, assembled once per request in `server.ts`.
 *
 * The SDK's factory gets no bindings, so this is closed over rather than passed
 * through `authInfo` — a Worker's `env` is not serializable and does not belong
 * in an auth payload.
 */
export interface Ctx {
  env: Env
  db: Db
  executionCtx: ExecutionContext
  apiKeyId: number
}

/**
 * Aliased from the SDK rather than redeclared: the wire shape carries an
 * `[x: string]: unknown` index signature and a wide content union, and a
 * hand-written stand-in silently stops assigning the moment either moves.
 */
export type ToolResult = CallToolResult

/** Success. Objects go out as pretty JSON — the model reads this, not a person. */
export function ok(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text }] }
}

/**
 * Failure the model should recover from, not a protocol error.
 *
 * `hint` is the whole point: the model has nothing but this string to work out
 * what to do next, so say what to call instead.
 */
export function fail(message: string, hint?: string): ToolResult {
  return {
    content: [{ type: 'text', text: hint ? `${message}\n\nNext: ${hint}` : message }],
    isError: true,
  }
}

/** `{ ok: false, reason }` from a core function, rendered as a tool error. */
export function failed(result: { reason?: string }, hint?: string): ToolResult {
  return fail(result.reason ?? 'refused', hint)
}

/** Uniform clamp so no tool can be talked into paging the whole database. */
export function clampLimit(limit: number | undefined, fallback = 50, max = 500): number {
  if (!Number.isFinite(limit)) return fallback
  return Math.min(Math.max(Math.floor(limit as number), 1), max)
}

/** Cents to a readable amount, because "$41.00" is checkable and 4100 isn't. */
export function money(cents: number, currency = 'usd'): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}${currency.toUpperCase()} ${(Math.abs(cents) / 100).toFixed(2)}`
}

/**
 * Tool schemas are Zod objects, but the SDK types them as Standard Schema. The
 * intersection keeps both true: authors write plain Zod, and `registerTool`
 * still sees the shape its overload wants.
 */
type Schema = z.ZodType & StandardSchemaWithJSON

type Handler<S extends Schema> = (args: z.output<S>) => Promise<ToolResult>

interface Config<S extends Schema> {
  description: string
  inputSchema: S
  /**
   * Behavior hints for the client. `readOnlyHint` lets a host auto-approve a
   * lookup; `destructiveHint` makes it ask first. Worth setting on every tool —
   * it is the difference between an agent that can browse freely and one that
   * needs a human for every call.
   */
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
  }
}

/**
 * Register a tool with auditing wrapped around it.
 *
 * Every call lands in `mcp_calls` — including the ones that threw. Workers logs
 * expire in a week and this is an agent operating a mailer unattended, so "what
 * did it do in March" has to be answerable from D1 or it isn't answerable.
 *
 * A thrown error becomes an `isError` result rather than a protocol fault: the
 * model can read a tool error and retry, but a protocol fault it never sees.
 */
export function defineTool<S extends Schema>(
  server: McpServer,
  ctx: Ctx,
  name: string,
  config: Config<S>,
  handler: Handler<S>,
): void {
  // `registerTool`'s callback parameter is a conditional type keyed on the
  // schema. Inside a generic wrapper the schema is still unresolved, so the
  // conditional can't reduce and the assignment fails no matter how the handler
  // is typed. The cast is on the SDK boundary only — `Config` and `Handler`
  // above are what every caller is actually checked against.
  const register = server.registerTool.bind(server) as (
    name: string,
    config: Config<S>,
    cb: (args: z.output<S>) => Promise<ToolResult>,
  ) => unknown

  register(name, config, async (args: z.output<S>) => {
    const started = Date.now()
    let outcome: 'ok' | 'error' | 'denied' = 'ok'
    let detail: string | null = null
    let result: ToolResult

    try {
      result = await handler(args)
      if (result.isError) {
        outcome = 'denied'
        // `content` is a union of block kinds; only a text block has a message.
        const block = result.content[0]
        detail = block?.type === 'text' ? (block.text.split('\n')[0] ?? null) : null
      }
    } catch (err) {
      outcome = 'error'
      detail = err instanceof Error ? err.message : String(err)
      result = fail(`${name} failed: ${detail}`)
    }

    // The audit row must not be able to break the call it is recording.
    try {
      await ctx.db.insert(mcpCalls).values({
        tool: name,
        apiKeyId: ctx.apiKeyId,
        args: (args ?? {}) as Record<string, unknown>,
        outcome,
        detail: detail?.slice(0, 500) ?? null,
        durationMs: Date.now() - started,
        createdAt: new Date(),
      })
    } catch {
      /* swallow — losing the audit row is bad, losing the answer is worse */
    }

    return result
  })
}
