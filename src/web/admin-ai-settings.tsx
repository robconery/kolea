import { Hono } from 'hono'
import { CATALOGUE, HELPERS, type Payer, modelLabel, modelsFor } from '../core/ai/catalogue.ts'
import { canStoreKeys, isKeyProvider, providerName } from '../core/ai/keys.ts'
import { spend } from '../core/ai/openrouter.ts'
import {
  type SettingsResult,
  keyStatuses,
  removeKey,
  resolveAi,
  saveKey,
  setModel,
  setPayer,
} from '../core/ai/settings.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout } from './layout.tsx'

/**
 * Settings → AI: which key pays for the writing helpers, and which model each
 * one uses. Thin: every rule (what a key looks like, which key can serve which
 * model, what happens when the paying key goes away) lives in
 * `core/ai/settings.ts`.
 *
 * Not under `/ai/*`: those are the composer's JSON endpoints, and they 404
 * while AI is off, which is exactly when this screen is needed.
 */
export const aiSettingsAdmin = new Hono<{ Bindings: Env }>()

const BASE = '/settings/ai'

/**
 * A key saved from another site's form would route the operator's drafts to
 * whoever owns that key. Browsers say where a post came from; a cross-site one
 * is refused before it touches anything.
 */
aiSettingsAdmin.post(`${BASE}/*`, async (c, next) => {
  if (c.req.header('sec-fetch-site') === 'cross-site') return c.text('Cross-site request refused.', 403)
  await next()
})

function back(r: SettingsResult): string {
  return r.ok
    ? `${BASE}?flash=${encodeURIComponent(r.message)}`
    : `${BASE}?flash=${encodeURIComponent(r.reason)}&kind=warn`
}

const PAYER_LABEL: Record<Payer, string> = {
  env: "This install's OpenRouter key (OPENROUTER_KEY)",
  openrouter: 'Your own OpenRouter key',
  anthropic: 'Your own Anthropic key',
  openai: 'Your own OpenAI key',
}

aiSettingsAdmin.get(BASE, async (c) => {
  const db = getDb(c.env)
  const [setup, keys, money] = await Promise.all([resolveAi(c.env, db), keyStatuses(c.env, db), spend(c.env, db)])
  const canStore = canStoreKeys(c.env.AI_KEY_ENCRYPTION_SECRET)
  const envKey = Boolean(c.env.OPENROUTER_KEY?.trim())
  const choices = modelsFor(setup.payer)
  const direct = setup.payer === 'anthropic' || setup.payer === 'openai'

  return c.html(
    <Layout title="AI" nav="aiset">
      <div class="head">
        <div>
          <h1>AI</h1>
          <div class="sub">Which key pays for the writing helpers, and which model each one uses.</div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class={setup.ready ? 'note' : 'note warn'} data-test="ai-status">
        {setup.ready ? (
          <>
            <strong>AI is on.</strong> {PAYER_LABEL[setup.payer]} pays.{' '}
            {c.env.AI_PROVIDER === 'fake' ? 'AI_PROVIDER=fake: every answer comes from a fake model on this machine.' : ''}
          </>
        ) : (
          <>
            <strong>AI is off.</strong> {setup.reason} The composer shows no AI buttons until a key can pay.
          </>
        )}
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Who pays</h2>
        </div>
        <div class="card-b">
          <form method="post" action={`${BASE}/payer`}>
            {(['env', 'openrouter', 'anthropic', 'openai'] as Payer[]).map((p) => {
              const usable = p === 'env' ? envKey : Boolean(keys.find((k) => k.provider === p)?.readable)
              return (
                <label style="display:flex;gap:8px;align-items:center;font-weight:400;margin:6px 0">
                  <input
                    type="radio"
                    name="payer"
                    value={p}
                    checked={setup.payer === p}
                    disabled={!usable && setup.payer !== p}
                  />
                  {PAYER_LABEL[p]}
                  {usable ? null : (
                    <span class="faint">{p === 'env' ? '(not set)' : '(save a key below first)'}</span>
                  )}
                </label>
              )
            })}
            <button class="btn primary" type="submit" style="margin-top:12px">
              Use this key
            </button>
          </form>
          <p class="faint" style="margin-top:12px">
            This month: ${money.spent.toFixed(2)} of ${money.budget.toFixed(2)} (AI_MONTHLY_BUDGET_USD). The budget
            counts every call whichever key pays. OpenRouter reports what each call cost; Anthropic and OpenAI
            report tokens only, so those calls are estimated from list prices, and a model with no list price
            here is counted at $0.
          </p>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>Your own keys</h2>
        </div>
        <div class="card-b">
          {canStore ? null : (
            <div class="note warn" data-test="no-secret">
              <strong>Keys cannot be saved here yet.</strong> Set the <span class="mono">AI_KEY_ENCRYPTION_SECRET</span>{' '}
              secret first: saved keys are encrypted with it, and without it nothing is stored.
            </div>
          )}
          <table>
            <tbody>
              {keys.map((k) => (
                <tr>
                  <td>{k.name}</td>
                  <td class="mono">
                    {k.stored ? `•••• ${k.last4}` : <span class="faint">none</span>}
                    {k.stored && !k.readable ? (
                      <span class="faint"> (cannot be read with the current secret; paste it again)</span>
                    ) : null}
                  </td>
                  <td style="text-align:right">
                    {k.stored ? (
                      <form method="post" action={`${BASE}/keys/${k.provider}/delete`} style="display:inline">
                        <button class="btn sm danger" type="submit">
                          Remove
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {canStore ? (
            <form method="post" action={`${BASE}/keys`} style="margin-top:16px">
              <div class="row" style="gap:8px">
                <select name="provider">
                  {keys.map((k) => (
                    <option value={k.provider}>{k.name}</option>
                  ))}
                </select>
                <input
                  type="password"
                  name="key"
                  placeholder="sk-…"
                  autocomplete="off"
                  spellcheck={false}
                  style="flex:1"
                  required
                />
                <button class="btn" type="submit">
                  Save key
                </button>
              </div>
              <p class="faint" style="margin:6px 0 0">
                Saved encrypted. It is never shown again, only its last four characters. Saving replaces the key
                already there for that provider. Give the key a spending limit with the provider too.
              </p>
            </form>
          ) : null}
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-h">
          <h2>Models</h2>
        </div>
        <div class="card-b">
          {direct ? (
            <p class="faint">
              {providerName(setup.payer as 'anthropic' | 'openai')} serves only its own models, so only those are
              listed.
            </p>
          ) : null}
          <table>
            <tbody>
              {HELPERS.map((h) => {
                const now = setup.models[h.task]
                const source = setup.sources[h.task]
                const aside = setup.setAside[h.task]
                return (
                  <tr data-task={h.task}>
                    <td>
                      <div>{h.label}</div>
                      <div class="faint">{h.what}</div>
                      {aside ? (
                        <div class="faint">
                          Your choice, {modelLabel(aside)}, is set aside: the key that pays cannot use it.
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <form method="post" action={`${BASE}/models`} class="row" style="gap:8px">
                        <input type="hidden" name="task" value={h.task} />
                        <select name="model">
                          <option value="" selected={source !== 'chosen'}>
                            Default{source === 'chosen' ? '' : `: ${modelLabel(now)}`}
                            {source === 'env' ? ' (from AI_MODEL_*)' : ''}
                          </option>
                          {choices.map((m) => (
                            <option value={m.id} selected={source === 'chosen' && m.id === now}>
                              {m.label} (${m.inPerM} / ${m.outPerM} per M)
                            </option>
                          ))}
                        </select>
                        <button class="btn sm" type="submit">
                          Save
                        </button>
                      </form>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p class="faint" style="margin-top:12px">
            Prices are list prices per million tokens in and out, used only to estimate calls on a key that does
            not report cost. {CATALOGUE.length} models on the list.
          </p>
        </div>
      </div>
    </Layout>,
  )
})

aiSettingsAdmin.post(`${BASE}/payer`, async (c) => {
  const form = await c.req.formData()
  return c.redirect(back(await setPayer(c.env, getDb(c.env), form.get('payer'))))
})

aiSettingsAdmin.post(`${BASE}/keys`, async (c) => {
  const form = await c.req.formData()
  const provider = form.get('provider')
  if (!isKeyProvider(provider)) return c.redirect(back({ ok: false, reason: 'Pick a provider.' }))
  return c.redirect(back(await saveKey(c.env, getDb(c.env), provider, form.get('key'))))
})

aiSettingsAdmin.post(`${BASE}/keys/:provider/delete`, async (c) => {
  const provider = c.req.param('provider')
  if (!isKeyProvider(provider)) return c.notFound()
  return c.redirect(back(await removeKey(getDb(c.env), provider)))
})

aiSettingsAdmin.post(`${BASE}/models`, async (c) => {
  const form = await c.req.formData()
  return c.redirect(back(await setModel(c.env, getDb(c.env), form.get('task'), form.get('model'))))
})
