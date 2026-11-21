import { gte, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { aiCalls } from '../../db/schema.ts'
import type { AiReply } from '../../providers/ai/types.ts'
import type { Env } from '../../types.ts'
import { type AiTask, estimateCost } from './catalogue.ts'
import { type AiSetup, resolveAi } from './settings.ts'

export { type AiTask, modelLabel } from './catalogue.ts'

/**
 * The one way a writing helper calls a model: budget-checked, routed to the
 * key that pays, and recorded. (The file keeps its old name; it is no longer
 * OpenRouter-only. Which provider answers is `settings.ts`'s decision and the
 * HTTP lives in `providers/ai/`.)
 *
 * Off until configured. With no usable key the composer shows no AI buttons
 * and nothing here is ever called, the same way the Unsplash picker works.
 *
 * ⚠️ Nothing in `core/ai/` sends mail, schedules mail, or writes to a row a
 * subscriber can see. Every answer comes back to the operator's screen as a
 * suggestion or as an edit in the draft they are looking at, and a draft goes
 * nowhere until they press Send. That boundary is the reason it is safe to let
 * a model near the composer at all.
 *
 * Two things keep the bill honest, whichever key pays:
 *
 *  1. Every call, won or lost, is a row in `ai_calls` with what it cost:
 *     OpenRouter's own figure, or tokens × list price for Anthropic and OpenAI,
 *     which report tokens and not money (flagged `cost_estimated`).
 *  2. Before every call, this month's total is read back and compared with
 *     `AI_MONTHLY_BUDGET_USD`. Over the line, the call is refused before it is
 *     made. Set a credit limit on the key as well; this is the second lock,
 *     not the only one.
 */

const DEFAULT_BUDGET_USD = 10

/**
 * The one switch for every AI feature: is there a key that pays, and can it be
 * read? Yes means the subject link, "Clean this up", the template pitch box
 * and the `/ai/*` endpoints all exist. No means none of them render and the
 * endpoints 404. Every screen asks this; none of them reads an env var itself.
 */
export async function aiReady(env: Env, db: Db): Promise<boolean> {
  return (await resolveAi(env, db)).ready
}

/** The model `task` uses now: the operator's choice, an `AI_MODEL_*` variable, or the default. */
export async function modelFor(env: Env, db: Db, task: AiTask): Promise<string> {
  return (await resolveAi(env, db)).models[task]
}

export function monthlyBudget(env: Env): number {
  const n = Number(env.AI_MONTHLY_BUDGET_USD)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_USD
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** Dollars spent on models since the first of this month (UTC), whoever answered. */
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
  /** The helper making the call. Picks the model and is what the `ai_calls` row is filed under. */
  task: AiTask
  messages: Message[]
  maxTokens: number
  /** A JSON Schema. When set, the reply is parsed and returned as `json`. */
  schema?: { name: string; schema: Record<string, unknown> }
  /** Give up after this long. A hung request must not hold the composer hostage. */
  timeoutMs?: number
  /** Already resolved, when a caller makes many calls at once (the sequence drafter). */
  setup?: AiSetup
}

export type CallResult =
  | { ok: true; text: string; json: unknown; model: string; costUsd: number }
  | { ok: false; reason: string }

/**
 * One model call, budget-checked and recorded.
 *
 * Never throws: a model that is down, slow or over budget is a sentence for
 * the operator, not a 500.
 */
export async function complete(env: Env, db: Db, input: CallInput): Promise<CallResult> {
  const setup = input.setup ?? (await resolveAi(env, db))
  if (!setup.ready || !setup.route) {
    return { ok: false, reason: `AI is not set up. ${setup.reason ?? ''} See Settings, AI.`.replace(/\s+/g, ' ') }
  }

  const budget = monthlyBudget(env)
  const spent = await spentThisMonth(db)
  if (spent >= budget) {
    return {
      ok: false,
      reason: `This month's AI budget is used up ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Raise AI_MONTHLY_BUDGET_USD or wait for the 1st.`,
    }
  }

  const { provider, apiKey } = setup.route
  const model = setup.models[input.task]
  const started = Date.now()
  const reply = await provider.complete({
    apiKey,
    model,
    messages: input.messages,
    maxTokens: input.maxTokens,
    schema: input.schema,
    timeoutMs: input.timeoutMs ?? 90_000,
  })
  const rec = (r: Receipt) => record(db, input.task, provider.name, model, started, r)
  const who = provider.name === 'fake' ? 'The fake model' : providerTitle(provider.name)

  if (reply.kind === 'timeout' || reply.kind === 'unreachable') {
    const reason = reply.kind === 'timeout' ? 'The model took too long to answer.' : `Could not reach ${who}.`
    await rec({ ok: false, error: reason, reply })
    return { ok: false, reason }
  }
  if (reply.kind === 'rejected') {
    const reason = `${who} said no (${reply.status}): ${reply.message}`
    await rec({ ok: false, error: reason, reply })
    return { ok: false, reason }
  }

  const answered = reply.model || model
  if (!reply.text) {
    const reason = 'The model answered with nothing.'
    await rec({ ok: false, error: reason, reply, model: answered })
    return { ok: false, reason }
  }
  if (reply.finish === 'length') {
    const reason = 'The answer was cut off before it finished. Nothing was changed.'
    await rec({ ok: false, error: reason, reply, model: answered })
    return { ok: false, reason }
  }
  if (reply.finish === 'refusal') {
    const reason = 'The model declined to answer. Nothing was changed.'
    await rec({ ok: false, error: reason, reply, model: answered })
    return { ok: false, reason }
  }

  let json: unknown = null
  if (input.schema) {
    json = parseJson(reply.text)
    if (json === null) {
      const reason = 'The model answered, but not in the shape asked for.'
      await rec({ ok: false, error: reason, reply, model: answered })
      return { ok: false, reason }
    }
  }

  const costUsd = await rec({ ok: true, reply, model: answered })
  return { ok: true, text: reply.text, json, model: answered, costUsd }
}

function providerTitle(name: string): string {
  return ({ openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI' } as Record<string, string>)[name] ?? name
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

interface Receipt {
  ok: boolean
  error?: string
  reply: AiReply
  model?: string
}

/** Writes the ledger row and returns the cost it recorded. */
async function record(
  db: Db,
  task: AiTask,
  provider: 'openrouter' | 'anthropic' | 'openai' | 'fake',
  model: string,
  started: number,
  r: Receipt,
): Promise<number> {
  const usage = 'usage' in r.reply ? r.reply.usage : null
  const promptTokens = usage?.promptTokens ?? 0
  const completionTokens = usage?.completionTokens ?? 0
  const answered = r.model ?? model
  // Reported beats estimated. No usage at all (a timeout) is a free call.
  const reported = usage?.costUsd ?? null
  const estimated = Boolean(usage) && reported === null
  const costUsd = reported ?? (estimated ? estimateCost(answered, promptTokens, completionTokens) : null) ?? 0
  try {
    await db.insert(aiCalls).values({
      task,
      model: answered,
      promptTokens,
      completionTokens,
      costUsd,
      ok: r.ok,
      error: r.error ?? null,
      durationMs: Date.now() - started,
      provider,
      costEstimated: estimated,
      createdAt: new Date(),
    })
  } catch {
    // The call already happened. Losing its receipt is bad; failing the
    // operator's request over it would be worse.
  }
  return costUsd
}
