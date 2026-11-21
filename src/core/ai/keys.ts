/**
 * The operator's own model keys, at rest.
 *
 * AES-GCM (WebCrypto, so it runs the same in a Worker and under Bun) with a
 * 256-bit key derived from `AI_KEY_ENCRYPTION_SECRET` by SHA-256. A fresh
 * 12-byte IV per encryption; the provider name is the associated data, so a
 * ciphertext copied onto another provider's row fails to open.
 *
 * Without the secret nothing is stored: a key in plain text in D1 is a key in
 * every backup and every `wrangler d1 export`. Change the secret and every
 * stored key becomes unreadable, which the settings screen reports as "paste
 * it again" rather than as an error.
 */

export type KeyProvider = 'openrouter' | 'anthropic' | 'openai'

export const KEY_PROVIDERS: KeyProvider[] = ['openrouter', 'anthropic', 'openai']

export function isKeyProvider(v: unknown): v is KeyProvider {
  return typeof v === 'string' && (KEY_PROVIDERS as string[]).includes(v)
}

export function providerName(p: KeyProvider): string {
  return { openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI' }[p]
}

/** Whether there is a secret to encrypt with at all. */
export function canStoreKeys(secret: string | undefined): boolean {
  return Boolean(secret?.trim())
}

const PATTERNS: Record<KeyProvider, RegExp> = {
  openrouter: /^sk-or-[A-Za-z0-9_-]{16,200}$/,
  anthropic: /^sk-ant-[A-Za-z0-9_-]{16,300}$/,
  openai: /^sk-(?!or-|ant-)[A-Za-z0-9_-]{16,300}$/,
}

/** The key as pasted, trimmed, if it looks like one of `provider`'s; null otherwise. */
export function parseKey(provider: KeyProvider, raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  return PATTERNS[provider].test(key) ? key : null
}

async function derive(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret.trim()))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

export async function encryptKey(secret: string, provider: KeyProvider, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(provider) },
    await derive(secret),
    new TextEncoder().encode(plain),
  )
  return `v1:${b64(iv)}:${b64(new Uint8Array(ct))}`
}

/** The key, or null if it cannot be opened with this secret (wrong secret, wrong row, tampered). */
export async function decryptKey(
  secret: string | undefined,
  provider: KeyProvider,
  stored: string,
): Promise<string | null> {
  if (!canStoreKeys(secret)) return null
  const [v, iv, ct] = stored.split(':')
  if (v !== 'v1' || !iv || !ct) return null
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(provider) },
      await derive(secret!),
      unb64(ct),
    )
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}
