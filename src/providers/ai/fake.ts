import type { AiProvider, AiReply, AiRequest } from './types.ts'

/**
 * A model that never leaves the machine. Picked with `AI_PROVIDER=fake`, for
 * local work without a key's worth of network, and for specs.
 *
 * With a schema it answers the smallest JSON that schema accepts (every
 * required property, one item per array, a placeholder per string). Without
 * one it answers a sentence. It reports tokens and no cost, the way a direct
 * provider does, so the estimate path gets exercised too.
 */

/** Every request the fake answered, oldest first. Specs read it; nothing else does. */
export const fakeAiCalls: AiRequest[] = []

export const fakeAi: AiProvider = {
  name: 'fake',
  async complete(req: AiRequest): Promise<AiReply> {
    fakeAiCalls.push(req)
    const text = req.schema ? JSON.stringify(sample(req.schema.schema)) : 'A fake answer from a fake model.'
    return {
      kind: 'answer',
      text,
      model: req.model,
      finish: 'stop',
      usage: { promptTokens: 1000, completionTokens: 200, costUsd: null },
    }
  },
}

function sample(schema: Record<string, unknown>): unknown {
  switch (schema.type) {
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, sample(v)]))
    }
    case 'array':
      return [sample((schema.items ?? {}) as Record<string, unknown>)]
    case 'number':
    case 'integer':
      return 1
    case 'boolean':
      return true
    default:
      return 'A plain fake answer'
  }
}
