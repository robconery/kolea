/**
 * The seam between the writing helpers and whoever answers them.
 *
 * Three adapters (OpenRouter, Anthropic, OpenAI) over plain `fetch`, and a fake.
 * Nothing in here knows about subjects, clean-ups, budgets or keys at rest: an
 * adapter is handed a key and a request, makes one HTTP call, and hands back
 * one `AiReply`. It never throws; a dead network is a reply like any other.
 *
 * Models are named the OpenRouter way everywhere above this line
 * (`anthropic/claude-opus-5.5`, `openai/gpt-5`). Each direct adapter turns that
 * into its own vendor's id.
 */

export type AiProviderName = 'openrouter' | 'anthropic' | 'openai'

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiRequest {
  apiKey: string
  /** OpenRouter-style id, e.g. `anthropic/claude-sonnet-5`. */
  model: string
  messages: AiMessage[]
  maxTokens: number
  /** A JSON Schema the reply must follow, strictly. */
  schema?: { name: string; schema: Record<string, unknown> }
  timeoutMs: number
}

export interface AiUsage {
  promptTokens: number
  completionTokens: number
  /**
   * US dollars, as the provider reported it. `null` when the provider does not
   * report cost at all (Anthropic, OpenAI): the caller estimates instead.
   */
  costUsd: number | null
}

export type AiReply =
  | {
      kind: 'answer'
      text: string
      /** The model that answered, OpenRouter-style. */
      model: string
      /** `length` means the answer was cut off; `refusal` that the model declined. */
      finish: 'stop' | 'length' | 'refusal'
      usage: AiUsage
    }
  | { kind: 'rejected'; status: number; message: string; usage: AiUsage }
  | { kind: 'timeout' }
  | { kind: 'unreachable' }

export interface AiProvider {
  readonly name: AiProviderName | 'fake'
  complete(req: AiRequest): Promise<AiReply>
}

export const NO_USAGE: AiUsage = { promptTokens: 0, completionTokens: 0, costUsd: null }

/** `fetch`, with a timeout and the two ways it fails folded into replies. */
export async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ res: Response; data: unknown } | { kind: 'timeout' } | { kind: 'unreachable' }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await res.json().catch(() => null)
    return { res, data }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { kind: timedOut ? 'timeout' : 'unreachable' }
  }
}

export function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}
