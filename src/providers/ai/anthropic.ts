import { type AiProvider, type AiReply, type AiRequest, count, post } from './types.ts'

/**
 * Anthropic's Messages API, on the operator's own Anthropic key.
 *
 * The model goes by Anthropic's own id (`anthropic/claude-opus-5.5` is
 * `claude-opus-5-5`), system messages go in `system`, a schema asks for
 * structured output through `output_config.format`. No temperature.
 *
 * Anthropic reports tokens but not cost, so `costUsd` is null and the caller
 * estimates from its price table.
 */
const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const VERSION = '2023-06-01'

/** `anthropic/claude-opus-5.5` → `claude-opus-5-5`. An OpenRouter `:variant` means nothing here. */
export function anthropicModelId(model: string): string {
  return (model.replace(/^anthropic\//, '').split(':')[0] ?? model).replace(/\./g, '-')
}

export const anthropic: AiProvider = {
  name: 'anthropic',
  async complete(req: AiRequest): Promise<AiReply> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const body: Record<string, unknown> = {
      model: anthropicModelId(req.model),
      max_tokens: req.maxTokens,
      messages: req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
    }
    if (system) body.system = system
    if (req.schema) body.output_config = { format: { type: 'json_schema', schema: req.schema.schema } }

    const r = await post(ENDPOINT, { 'x-api-key': req.apiKey, 'anthropic-version': VERSION }, body, req.timeoutMs)
    if ('kind' in r) return r

    const data = r.data as Message | null
    const u = data?.usage
    const usage = {
      promptTokens:
        count(u?.input_tokens) + count(u?.cache_creation_input_tokens) + count(u?.cache_read_input_tokens),
      completionTokens: count(u?.output_tokens),
      costUsd: null,
    }
    if (!r.res.ok || !data || data.type === 'error') {
      return { kind: 'rejected', status: r.res.status, message: data?.error?.message ?? r.res.statusText, usage }
    }
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()
    const finish = data.stop_reason === 'max_tokens' ? 'length' : data.stop_reason === 'refusal' ? 'refusal' : 'stop'
    return { kind: 'answer', text, model: req.model, finish, usage }
  },
}

interface Message {
  type?: string
  content?: { type?: string; text?: string }[]
  stop_reason?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  error?: { message?: string }
}
