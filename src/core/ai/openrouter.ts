import { gte, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { aiCalls } from '../../db/schema.ts'
import type { Env } from '../../types.ts'

/**
 * OpenRouter: one HTTP endpoint in front of every model we might want.
 *
 * Off until configured. With no `OPENROUTER_KEY` the composer shows no AI
 * buttons and nothing here is ever called, the same way the Unsplash picker
 * works.
 *
 * ⚠️ Nothing in `core/ai/` sends mail, schedules mail, or writes to a row a
 * subscriber can see. Every answer comes back to the operator's screen as a
 * suggestion or as an edit in the draft they are looking at, and a draft goes
 * nowhere until they press Send. That boundary is the reason it is safe to let
 * a model near the composer at all.
 *
 * Two things keep the bill honest:
 *
 *  1. Every call, won or lost, is a row in `ai_calls` with what OpenRouter says
 *     it cost. OpenRouter reports `usage.cost` on every response.
 *  2. Before every call, this month's total is read back and compared with
 *     `AI_MONTHLY_BUDGET_USD`. Over the line, the call is refused before it is
 *     made. Set a credit limit on the OpenRouter key as well; this is the
 *     second lock, not the only one.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

export type AiTask = 'subject' | 'cleanup' | 'sequence'

/**
 * The defaults, chosen for this job and this price list (September 2026, per
 * million tokens in / out):
 *
 * - Subject lines: Sonnet 5 ($2 / $10). Short in, very short out, and the
 *   judgement is about taste rather than stamina. About a cent a click.
 * - Clean-up: Opus 5.5 ($4 / $20). Rewriting prose without flattening the
 *   writer's voice is the hardest thing on this list. About 5 to 10 cents.
 * - Sequence drafts: Opus 5.5. A plan plus one call per mail, around 20 to 40
 *   cents for a seven-mail sequence.
 *
 * Any of them can be swapped with an env var without a deploy of new code.
 */
export const DEFAULT_MODELS: Record<AiTask, string> = {
  subject: 'anthropic/claude-sonnet-5',
  cleanup: 'anthropic/claude-opus-5.5',
  sequence: 'anthropic/claude-opus-5.5',
}

const DEFAULT_BUDGET_USD = 10

/**
 * The one switch for every AI feature. A key present means the subject link,
 * "Clean this up", the template pitch box and the `/ai/*` endpoints all exist.
 * No key (or a blank one) means none of them render and the endpoints 404.
 * Every screen asks this function; none of them reads the env var itself.
 */
export function aiConfigured(env: Env): boolean {
  return Boolean(env.OPENROUTER_KEY?.trim())
}

export function modelFor(env: Env, task: AiTask): string {
  const override = {
    subject: env.AI_MODEL_SUBJECT,
    cleanup: env.AI_MODEL_CLEANUP,
    sequence: env.AI_MODEL_SEQUENCE,
  }[task]
  return override?.trim() || DEFAULT_MODELS[task]
}

/** "anthropic/claude-opus-5.5" → "Claude Opus 5.5", for a button's small print. */
export function modelLabel(model: string): string {
  const name = model.split('/').pop() ?? model
  return name
    .split('-')
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

export function monthlyBudget(env: Env): number {
  const n = Number(env.AI_MONTHLY_BUDGET_USD)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_USD
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** Dollars spent on models since the first of this month (UTC). */
export async function spentThisMonth(db: Db): Promise<number> {
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)` })
    .from(aiCalls)
    .where(gte(aiCalls.createdAt, monthStart()))
    .get()
  return Number(row?.total ?? 0)
}

export interface Spend {
  spent: number
  budget: number
}

export async function spend(env: Env, db: Db): Promise<Spend> {
  return { spent: await spentThisMonth(db), budget: monthlyBudget(env) }
}

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CallInput {
  /** What the row in `ai_calls` is filed under. */
  label: string
  model: string
  messages: Message[]
  maxTokens: number
  /** A JSON Schema. When set, the reply is parsed and returned as `json`. */
  schema?: { name: string; schema: Record<string, unknown> }
  /** Give up after this long. A hung request must not hold the composer hostage. */
  timeoutMs?: number
}

export type CallResult =
  | { ok: true; text: string; json: unknown; model: string; costUsd: number }
  | { ok: false; reason: string }

/**
 * One chat completion, budget-checked and recorded.
 *
 * Never throws: a model that is down, slow or over budget is a sentence for
 * the operator, not a 500.
 */
export async function complete(env: Env, db: Db, input: CallInput): Promise<CallResult> {
  if (!aiConfigured(env)) return { ok: false, reason: 'AI is not set up. Add OPENROUTER_KEY.' }

  const budget = monthlyBudget(env)
  const spent = await spentThisMonth(db)
  if (spent >= budget) {
    return {
      ok: false,
      reason: `This month's AI budget is used up ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Raise AI_MONTHLY_BUDGET_USD or wait for the 1st.`,
    }
  }

  const started = Date.now()
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    max_tokens: input.maxTokens,
    // No `temperature`: the Claude 5 models refuse sampling parameters, and
    // with `require_parameters` on, asking for one routes to nowhere (404).
  }
  if (input.schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: input.schema.name, strict: true, schema: input.schema.schema },
    }
    // Only route to a provider that honours the schema, rather than one that
    // quietly ignores it and hands back prose.
    body.provider = { require_parameters: true }
  }

  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        // ASCII only: a header value with "ō" in it throws before it is sent.
        'X-OpenRouter-Title': 'Kolea',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs ?? 90_000),
    })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    const reason = timedOut ? 'The model took too long to answer.' : 'Could not reach OpenRouter.'
    await record(db, input, started, { ok: false, error: reason })
    return { ok: false, reason }
  }

  const data = (await res.json().catch(() => null)) as Completion | null
  const usage = data?.usage
  const costUsd = Number(usage?.cost ?? 0) || 0
  const tokens = { prompt: usage?.prompt_tokens ?? 0, completion: usage?.completion_tokens ?? 0 }

  if (!res.ok || !data || data.error) {
    const reason = `OpenRouter said no (${res.status}): ${data?.error?.message ?? res.statusText}`
    await record(db, input, started, { ok: false, error: reason, costUsd, tokens })
    return { ok: false, reason }
  }

  const choice = data.choices?.[0]
  const text = (choice?.message?.content ?? '').trim()
  const model = data.model ?? input.model

  if (!text) {
    const reason = 'The model answered with nothing.'
    await record(db, input, started, { ok: false, error: reason, costUsd, tokens, model })
    return { ok: false, reason }
  }
  if (choice?.finish_reason === 'length') {
    const reason = 'The answer was cut off before it finished. Nothing was changed.'
    await record(db, input, started, { ok: false, error: reason, costUsd, tokens, model })
    return { ok: false, reason }
  }

  let json: unknown = null
  if (input.schema) {
    json = parseJson(text)
    if (json === null) {
      const reason = 'The model answered, but not in the shape asked for.'
      await record(db, input, started, { ok: false, error: reason, costUsd, tokens, model })
      return { ok: false, reason }
    }
  }

  await record(db, input, started, { ok: true, costUsd, tokens, model })
  return { ok: true, text, json, model, costUsd }
}

/** Strict JSON first; then the outermost object, for a reply wrapped in a fence. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const a = text.indexOf('{')
    const b = text.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    try {
      return JSON.parse(text.slice(a, b + 1))
    } catch {
      return null
    }
  }
}

async function record(
  db: Db,
  input: CallInput,
  started: number,
  r: {
    ok: boolean
    error?: string
    costUsd?: number
    tokens?: { prompt: number; completion: number }
    model?: string
  },
): Promise<void> {
  try {
    await db.insert(aiCalls).values({
      task: input.label,
      model: r.model ?? input.model,
      promptTokens: r.tokens?.prompt ?? 0,
      completionTokens: r.tokens?.completion ?? 0,
      costUsd: r.costUsd ?? 0,
      ok: r.ok,
      error: r.error ?? null,
      durationMs: Date.now() - started,
      createdAt: new Date(),
    })
  } catch {
    // The call already happened. Losing its receipt is bad; failing the
    // operator's request over it would be worse.
  }
}

interface Completion {
  model?: string
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  error?: { message?: string; code?: number }
}
