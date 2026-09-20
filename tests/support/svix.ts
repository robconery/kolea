/**
 * Sign a webhook the way Resend does, so a spec can post one that the real
 * verifier accepts.
 *
 * Resend signs with Svix: HMAC-SHA256 over `id.timestamp.body`, base64, in a
 * `v1,<sig>` header. This is the only way to exercise `POST /webhooks/resend`
 * end to end — and it means the "bad signature is rejected" spec (SPEC 5.2) is
 * testing the real check rather than a stubbed one.
 */
export interface SignedWebhook {
  body: string
  headers: Record<string, string>
}

export async function signResendWebhook(
  payload: unknown,
  secret: string,
  id = 'msg_test_1',
): Promise<SignedWebhook> {
  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000).toString()

  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (ch) => ch.charCodeAt(0))
  const key = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  )
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)))

  return {
    body,
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  }
}

/** A `whsec_`-prefixed secret of the shape Resend issues. */
export const WEBHOOK_SECRET = `whsec_${btoa('a-test-signing-secret-32-bytes!!')}`
