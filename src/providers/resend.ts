import type { EmailProvider, OutgoingEmail, ProviderEvent, SendResult } from './types.ts'

const ENDPOINT = 'https://api.resend.com/emails'
const BATCH_ENDPOINT = 'https://api.resend.com/emails/batch'

/** Resend accepts up to 100 emails per batch call. */
const BATCH_MAX = 100

const EVENT_MAP: Record<string, ProviderEvent['type']> = {
  'email.delivered': 'delivered',
  'email.opened': 'open',
  'email.clicked': 'click',
  'email.bounced': 'bounce',
  'email.complained': 'complaint',
  'email.failed': 'failed',
}

export class ResendProvider implements EmailProvider {
  readonly name = 'resend'

  constructor(private readonly apiKey: string) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  private payload(email: OutgoingEmail) {
    return {
      from: `${email.fromName} <${email.fromEmail}>`,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(email.listUnsubscribeUrl
        ? {
            headers: {
              'List-Unsubscribe': `<${email.listUnsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }
        : {}),
    }
  }

  /** 429 and 5xx are worth another attempt; 4xx generally is not. */
  private static retryable(status: number): boolean {
    return status === 429 || status >= 500
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.payload(email)),
    })

    if (res.ok) {
      const body = (await res.json()) as { id?: string }
      return { ok: true, providerMessageId: body.id ?? 'unknown' }
    }

    const text = await res.text().catch(() => res.statusText)
    return {
      ok: false,
      error: `resend ${res.status}: ${text.slice(0, 500)}`,
      retryable: ResendProvider.retryable(res.status),
    }
  }

  async sendBatch(emails: OutgoingEmail[]): Promise<SendResult[]> {
    const results: SendResult[] = []
    for (let i = 0; i < emails.length; i += BATCH_MAX) {
      results.push(...(await this.sendOneBatch(emails.slice(i, i + BATCH_MAX))))
    }
    return results
  }

  private async sendOneBatch(emails: OutgoingEmail[]): Promise<SendResult[]> {
    if (emails.length === 0) return []

    const res = await fetch(BATCH_ENDPOINT, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(emails.map((email) => this.payload(email))),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      // The whole call failed, so every email in it failed the same way.
      const failure: SendResult = {
        ok: false,
        error: `resend batch ${res.status}: ${text.slice(0, 500)}`,
        retryable: ResendProvider.retryable(res.status),
      }
      return emails.map(() => failure)
    }

    const body = (await res.json()) as { data?: ({ id?: string; error?: string } | null)[] }
    const data = body.data ?? []

    // Entries come back positionally. A short or gappy array means Resend didn't
    // accept that email — retryable, because we can't tell a dropped one from a
    // rejected one and a broadcast would rather double-check than lose mail.
    // `sendMessages` only re-queues, and the status guard stops a double send.
    return emails.map((_, i) => {
      const entry = data[i]
      if (entry?.id) return { ok: true, providerMessageId: entry.id }
      return {
        ok: false,
        error: entry?.error ?? 'resend batch: no id returned for this entry',
        retryable: true,
      }
    })
  }

  async parseWebhook(request: Request, secret: string | undefined): Promise<ProviderEvent[]> {
    const raw = await request.text()

    if (secret && !(await verifySvix(request, raw, secret))) {
      throw new Error('invalid webhook signature')
    }

    const payload = JSON.parse(raw) as {
      type?: string
      created_at?: string
      data?: { email_id?: string; bounce?: { type?: string }; click?: { link?: string } }
    }

    const type = payload.type ? EVENT_MAP[payload.type] : undefined
    const providerMessageId = payload.data?.email_id
    if (!type || !providerMessageId) return []

    return [
      {
        providerMessageId,
        type,
        occurredAt: payload.created_at ? new Date(payload.created_at) : new Date(),
        hardBounce: payload.data?.bounce?.type?.toLowerCase() === 'hard',
        meta: payload.data?.click?.link ? { url: payload.data.click.link } : {},
        dedupeKey: `${request.headers.get('svix-id') ?? providerMessageId}:${payload.type}`,
      },
    ]
  }
}

/** Resend signs webhooks with Svix: HMAC-SHA256 over `id.timestamp.body`. */
async function verifySvix(request: Request, body: string, secret: string): Promise<boolean> {
  const id = request.headers.get('svix-id')
  const timestamp = request.headers.get('svix-timestamp')
  const signature = request.headers.get('svix-signature')
  if (!id || !timestamp || !signature) return false

  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(secret.replace(/^whsec_/, '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))
  const expected = bytesToBase64(new Uint8Array(mac))

  // Header holds space-separated `v1,<sig>` entries.
  return signature
    .split(' ')
    .map((part) => part.split(',')[1])
    .some((sig) => sig !== undefined && timingSafeEqual(sig, expected))
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  // Allocated explicitly rather than via Uint8Array.from so the buffer type is
  // ArrayBuffer, which is what importKey's BufferSource requires.
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}
