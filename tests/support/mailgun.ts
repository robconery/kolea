/**
 * Sign a webhook the way Mailgun does, so a spec can post one that the real
 * verifier accepts.
 *
 * Mailgun signs with HMAC-SHA256 over `timestamp + token` under the webhook
 * signing key, hex, and carries all three in the JSON body's `signature` object
 * beside `event-data`. This is the only way to exercise `POST /webhooks/mailgun`
 * end to end, and it means the "bad signature is rejected" spec (SPEC 5.2) is
 * testing the real check rather than a stubbed one.
 */
import { hmacSha256Hex } from '../../src/providers/mailgun.ts'
import type { SignedWebhook } from './svix.ts'

/** A signing key of the shape Mailgun issues. Not a real one. */
export const MAILGUN_SIGNING_KEY = 'mailgun-test-signing-key-0123456789'

export async function signMailgunWebhook(
  eventData: Record<string, unknown>,
  key: string = MAILGUN_SIGNING_KEY,
  options: { timestamp?: number; token?: string } = {},
): Promise<SignedWebhook> {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000))
  const token = options.token ?? crypto.randomUUID().replace(/-/g, '')
  const signature = await hmacSha256Hex(key, timestamp + token)
  return {
    body: JSON.stringify({ signature: { timestamp, token, signature }, 'event-data': eventData }),
    headers: { 'content-type': 'application/json' },
  }
}

/** One Mailgun event about `messageId`, in the shape its webhooks post. */
export function mailgunEvent(
  messageId: string,
  event: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `evt-${crypto.randomUUID()}`,
    event,
    timestamp: Date.now() / 1000,
    recipient: 'someone@example.test',
    message: { headers: { 'message-id': messageId } },
    ...extra,
  }
}
