import { type AiProvider, type AiReply, type AiRequest, count, post } from './types.ts'

/**
 * OpenAI's Chat Completions API, on the operator's own OpenAI key.
 *
 * The model goes by OpenAI's own id (`openai/gpt-5` is `gpt-5`), the cap as
 * `max_completion_tokens`, a schema as strict `json_schema`. No temperature.
 *
 * OpenAI reports tokens but not cost, so `costUsd` is null and the caller
 * estimates from its price table.
 */
const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

/** `openai/gpt-5` → `gpt-5`. */
export function openAiModelId(model: string): string {
  return model.replace(/^openai\//, '').split(':')[0] ?? model
}

export const openAi: AiProvider = {
  name: 'openai',
  async complete(req: AiRequest): Promise<AiReply> {
    const body: Record<string, unknown> = {
      model: openAiModelId(req.model),
      messages: req.messages,
      max_completion_tokens: req.maxTokens,
    }
    if (req.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema },
      }
    }

    const r = await post(ENDPOINT, { Authorization: `Bearer ${req.apiKey}` }, body, req.timeoutMs)
    if ('kind' in r) return r

    const data = r.data as Completion | null
    const usage = {
      promptTokens: count(data?.usage?.prompt_tokens),
      completionTokens: count(data?.usage?.completion_tokens),
      costUsd: null,
    }
    if (!r.res.ok || !data || data.error) {
      return { kind: 'rejected', status: r.res.status, message: data?.error?.message ?? r.res.statusText, usage }
    }
    const choice = data.choices?.[0]
    const refused = choice?.finish_reason === 'content_filter' || typeof choice?.message?.refusal === 'string'
    const finish = refused ? 'refusal' : choice?.finish_reason === 'length' ? 'length' : 'stop'
    return { kind: 'answer', text: (choice?.message?.content ?? '').trim(), model: req.model, finish, usage }
  },
}

interface Completion {
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string }
}
