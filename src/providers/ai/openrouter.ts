import { type AiProvider, type AiReply, type AiRequest, count, post } from './types.ts'

/**
 * OpenRouter's chat completions: one endpoint in front of every model. The
 * only adapter that reports what a call cost (`usage.cost`), so the only one
 * whose ledger rows are exact rather than estimated.
 */
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

export const openRouter: AiProvider = {
  name: 'openrouter',
  async complete(req: AiRequest): Promise<AiReply> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      // No `temperature`: the Claude 5 models refuse sampling parameters, and
      // with `require_parameters` on, asking for one routes to nowhere (404).
    }
    if (req.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema },
      }
      // Only route to a provider that honours the schema, rather than one that
      // quietly ignores it and hands back prose.
      body.provider = { require_parameters: true }
    }

    const r = await post(
      ENDPOINT,
      // ASCII only: a header value with "ō" in it throws before it is sent.
      { Authorization: `Bearer ${req.apiKey}`, 'X-OpenRouter-Title': 'Kolea' },
      body,
      req.timeoutMs,
    )
    if ('kind' in r) return r

    const data = r.data as Completion | null
    const usage = {
      promptTokens: count(data?.usage?.prompt_tokens),
      completionTokens: count(data?.usage?.completion_tokens),
      costUsd: Number(data?.usage?.cost ?? 0) || 0,
    }
    if (!r.res.ok || !data || data.error) {
      return { kind: 'rejected', status: r.res.status, message: data?.error?.message ?? r.res.statusText, usage }
    }
    const choice = data.choices?.[0]
    return {
      kind: 'answer',
      text: (choice?.message?.content ?? '').trim(),
      model: data.model ?? req.model,
      finish: choice?.finish_reason === 'length' ? 'length' : 'stop',
      usage,
    }
  },
}

interface Completion {
  model?: string
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  error?: { message?: string; code?: number }
}
