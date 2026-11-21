import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { aiKeys, aiSettings } from '../../db/schema.ts'
import { anthropic } from '../../providers/ai/anthropic.ts'
import { fakeAi } from '../../providers/ai/fake.ts'
import { openAi } from '../../providers/ai/openai.ts'
import { openRouter } from '../../providers/ai/openrouter.ts'
import type { AiProvider } from '../../providers/ai/types.ts'
import type { Env } from '../../types.ts'
import {
  type AiTask,
  type Payer,
  HELPERS,
  defaultModel,
  inCatalogue,
  isPayer,
  isTask,
  serves,
} from './catalogue.ts'
import {
  type KeyProvider,
  KEY_PROVIDERS,
  canStoreKeys,
  decryptKey,
  encryptKey,
  parseKey,
  providerName,
} from './keys.ts'

/**
 * Which key pays and which model each helper uses: the one place that turns
 * the `ai_settings` row, the `ai_keys` rows and the `AI_*` variables into a
 * decision. Every screen and every call asks `resolveAi`; none of them reads
 * the env vars or the tables itself.
 */

const ALL_TASKS: AiTask[] = [
  'subject',
  'cleanup',
  'sequence-plan',
  'sequence-mail',
  'council',
  'ghostwriter',
  'launch',
]

export type ModelSource = 'chosen' | 'env' | 'default'

export interface AiSetup {
  payer: Payer
  /** True when a call can be made: the paying key is present and readable. */
  ready: boolean
  /** Why it is not ready, as a sentence for the operator. Null when ready. */
  reason: string | null
  /** The adapter and the key it is handed. Null when not ready. */
  route: { provider: AiProvider; apiKey: string } | null
  models: Record<AiTask, string>
  sources: Record<AiTask, ModelSource>
  /** A stored choice the paying key cannot serve, and was set aside for the default. */
  setAside: Partial<Record<AiTask, string>>
}

function envModel(env: Env, task: AiTask): string | undefined {
  const v =
    task === 'subject'
      ? env.AI_MODEL_SUBJECT
      : task === 'cleanup'
        ? env.AI_MODEL_CLEANUP
        : task === 'sequence-plan' || task === 'sequence-mail'
          ? env.AI_MODEL_SEQUENCE
          : undefined
  return v?.trim() || undefined
}

async function settingsRow(db: Db) {
  return (await db.select().from(aiSettings).where(eq(aiSettings.id, 1)).get()) ?? null
}

/** The operator's stored key for `provider`, decrypted, or null (none, or unreadable). */
async function storedKey(env: Env, db: Db, provider: KeyProvider): Promise<string | null> {
  const row = await db.select().from(aiKeys).where(eq(aiKeys.provider, provider)).get()
  if (!row) return null
  return decryptKey(env.AI_KEY_ENCRYPTION_SECRET, provider, row.ciphertext)
}

const ADAPTERS: Record<KeyProvider, AiProvider> = { openrouter: openRouter, anthropic, openai: openAi }

export async function resolveAi(env: Env, db: Db): Promise<AiSetup> {
  const row = await settingsRow(db)
  const payer: Payer = row && isPayer(row.payer) ? row.payer : 'env'
  const chosen = row?.models ?? {}

  const models = {} as Record<AiTask, string>
  const sources = {} as Record<AiTask, ModelSource>
  const setAside: Partial<Record<AiTask, string>> = {}
  for (const task of ALL_TASKS) {
    const pick = chosen[task]
    const fromEnv = envModel(env, task)
    if (pick && inCatalogue(pick) && serves(payer, pick)) {
      models[task] = pick
      sources[task] = 'chosen'
    } else if (fromEnv && serves(payer, fromEnv)) {
      if (pick) setAside[task] = pick
      models[task] = fromEnv
      sources[task] = 'env'
    } else {
      if (pick) setAside[task] = pick
      models[task] = defaultModel(payer, task)
      sources[task] = 'default'
    }
  }

  const base = { payer, models, sources, setAside }

  // The local fake answers whoever "pays": nothing leaves the machine.
  if (env.AI_PROVIDER === 'fake') {
    return { ...base, ready: true, reason: null, route: { provider: fakeAi, apiKey: 'fake' } }
  }

  if (payer === 'env') {
    const key = env.OPENROUTER_KEY?.trim()
    if (!key) return { ...base, ready: false, reason: 'No OPENROUTER_KEY is set for this install.', route: null }
    return { ...base, ready: true, reason: null, route: { provider: openRouter, apiKey: key } }
  }

  const key = await storedKey(env, db, payer)
  if (!key) {
    const why = !canStoreKeys(env.AI_KEY_ENCRYPTION_SECRET)
      ? `Your ${providerName(payer)} key pays, but AI_KEY_ENCRYPTION_SECRET is not set, so it cannot be read.`
      : `Your ${providerName(payer)} key pays, but it is missing or cannot be read with the current AI_KEY_ENCRYPTION_SECRET. Paste it again.`
    return { ...base, ready: false, reason: why, route: null }
  }
  return { ...base, ready: true, reason: null, route: { provider: ADAPTERS[payer], apiKey: key } }
}

// ─────────────────────────────────────────────── the settings screen's reads

export interface KeyStatus {
  provider: KeyProvider
  name: string
  stored: boolean
  last4: string | null
  /** Stored, and opens with the current secret. */
  readable: boolean
}

export async function keyStatuses(env: Env, db: Db): Promise<KeyStatus[]> {
  const rows = await db.select().from(aiKeys).all()
  return Promise.all(
    KEY_PROVIDERS.map(async (provider) => {
      const row = rows.find((r) => r.provider === provider)
      const readable = row
        ? (await decryptKey(env.AI_KEY_ENCRYPTION_SECRET, provider, row.ciphertext)) !== null
        : false
      return { provider, name: providerName(provider), stored: Boolean(row), last4: row?.last4 ?? null, readable }
    }),
  )
}

// ─────────────────────────────────────────────── writes

export type SettingsResult = { ok: true; message: string } | { ok: false; reason: string }

async function upsertSettings(db: Db, patch: { payer?: Payer; models?: Record<string, string> }) {
  const now = new Date()
  const current = await settingsRow(db)
  if (!current) {
    await db.insert(aiSettings).values({ id: 1, payer: patch.payer ?? 'env', models: patch.models ?? {}, updatedAt: now })
  } else {
    await db
      .update(aiSettings)
      .set({ ...patch, updatedAt: now })
      .where(eq(aiSettings.id, 1))
  }
}

/** Store (or replace) the operator's key for `provider`, encrypted. Refuses without a secret. */
export async function saveKey(env: Env, db: Db, provider: KeyProvider, raw: unknown): Promise<SettingsResult> {
  if (!canStoreKeys(env.AI_KEY_ENCRYPTION_SECRET)) {
    return {
      ok: false,
      reason: 'Keys cannot be stored until AI_KEY_ENCRYPTION_SECRET is set. Nothing was saved.',
    }
  }
  const key = parseKey(provider, raw)
  if (!key) {
    return { ok: false, reason: `That does not look like an ${providerName(provider)} key. Nothing was saved.` }
  }
  const ciphertext = await encryptKey(env.AI_KEY_ENCRYPTION_SECRET!, provider, key)
  const last4 = key.slice(-4)
  await db
    .insert(aiKeys)
    .values({ provider, ciphertext, last4, createdAt: new Date() })
    .onConflictDoUpdate({ target: aiKeys.provider, set: { ciphertext, last4, createdAt: new Date() } })
  return { ok: true, message: `${providerName(provider)} key ending ${last4} saved.` }
}

/**
 * Forget the key. If it was the one paying, the install's key pays again: the
 * operator just removed the only thing that could, and saying so beats a
 * screen of helpers that quietly stopped working.
 */
export async function removeKey(db: Db, provider: KeyProvider): Promise<SettingsResult> {
  await db.delete(aiKeys).where(eq(aiKeys.provider, provider))
  const row = await settingsRow(db)
  if (row?.payer === provider) {
    await upsertSettings(db, { payer: 'env' })
    return { ok: true, message: `${providerName(provider)} key removed. The install's OpenRouter key pays again.` }
  }
  return { ok: true, message: `${providerName(provider)} key removed.` }
}

export async function setPayer(env: Env, db: Db, raw: unknown): Promise<SettingsResult> {
  if (!isPayer(raw)) return { ok: false, reason: 'Pick one of the keys on the list.' }
  if (raw === 'env') {
    if (!env.OPENROUTER_KEY?.trim()) {
      return { ok: false, reason: 'This install has no OPENROUTER_KEY, so it cannot pay. Nothing was changed.' }
    }
  } else if (!(await storedKey(env, db, raw))) {
    return { ok: false, reason: `Save an ${providerName(raw)} key first. Nothing was changed.` }
  }
  await upsertSettings(db, { payer: raw })
  return {
    ok: true,
    message: raw === 'env' ? "The install's OpenRouter key pays." : `Your ${providerName(raw)} key pays.`,
  }
}

/** Choose a model for one helper, or `''` to go back to the default. */
export async function setModel(env: Env, db: Db, task: unknown, model: unknown): Promise<SettingsResult> {
  if (!isTask(task)) return { ok: false, reason: 'There is no such helper.' }
  const row = await settingsRow(db)
  const models = { ...(row?.models ?? {}) }
  const pick = typeof model === 'string' ? model.trim() : ''
  const label = HELPERS.find((h) => h.task === task)!.label
  if (!pick) {
    delete models[task]
    await upsertSettings(db, { models })
    return { ok: true, message: `${label} is back on its default.` }
  }
  if (!inCatalogue(pick)) return { ok: false, reason: 'That model is not on the list.' }
  const setup = await resolveAi(env, db)
  if (!serves(setup.payer, pick)) {
    return { ok: false, reason: 'The key that pays cannot use that model. Nothing was changed.' }
  }
  models[task] = pick
  await upsertSettings(db, { models })
  return { ok: true, message: `${label} will use ${pick}.` }
}
