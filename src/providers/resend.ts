import { ResendDomains } from './resend-domains.ts'
import { type EmailProvider, OUTCOME_UNKNOWN, type OutgoingEmail, type ProviderEvent, type SendResult } from './types.ts'

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

/**
 * The tag that carries our own `messages.id` on every mail. Resend echoes a
 * mail's tags in each of its webhooks, so an event can name its row by primary
 * key. Tag names and values may hold only ASCII letters, digits, `_` and `-`.
 */
export const MESSAGE_ID_TAG = 'kolea_message_id'

export interface ResendOptions {
  /**
   * How long to wait before asking again, once, when a batch request got no
   * answer at all. Tests pass 0.
   */
  retryDelayMs?: number
}

export class ResendProvider implements EmailProvider {
  readonly name = 'resend'
  readonly domains: ResendDomains
  private readonly retryDelayMs: number

  constructor(
    private readonly apiKey: string,
    options: ResendOptions = {},
  ) {
    this.domains = new ResendDomains(apiKey)
    this.retryDelayMs = options.retryDelayMs ?? 1000
  }

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
      tags: [{ name: MESSAGE_ID_TAG, value: String(email.messageId) }],
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

  /**
   * What a refused request said about when to come back.
   *
   * `retry-after` is the direct answer: whole seconds, or (HTTP allows it) a
   * date. `ratelimit-reset` is the same fact from the other side, seconds until
   * the window reopens, and stands in when `retry-after` is missing. Absent or
   * unreadable, this adds nothing and the caller backs off on its own.
   */
  private static retryAfter(res: Response): { retryAfterSeconds?: number } {
    if (!ResendProvider.retryable(res.status)) return {}
    for (const name of ['retry-after', 'ratelimit-reset']) {
      const raw = res.headers.get(name)?.trim()
      if (!raw) continue
      const seconds = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000
      if (Number.isFinite(seconds) && seconds > 0) return { retryAfterSeconds: Math.ceil(seconds) }
    }
    return {}
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
      ...ResendProvider.retryAfter(res),
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

    // Built once, outside any retry: the same bytes make the same key, and the
    // key is what lets Resend recognise a request it has already taken.
    const body = JSON.stringify(emails.map((email) => this.payload(email)))
    const init: RequestInit = {
      method: 'POST',
      headers: { ...this.headers(), 'Idempotency-Key': await idempotencyKey(emails, body) },
      body,
    }
    const unknown = (why: string): SendResult[] =>
      emails.map(() => ({
        ok: false,
        error: `${OUTCOME_UNKNOWN}: ${why}`.slice(0, 600),
        retryable: false,
        outcomeUnknown: true,
      }))

    // ⭐ No answer at all: the request may or may not have reached Resend. This
    // is the one retry that is safe to make, because it is the identical request
    // under the identical key, made now: a request Resend took gets its first
    // answer back and nothing is sent twice. Any later retry would go through
    // the queue, possibly in a differently composed batch, which no key covers.
    // So if the second try gets no answer either, the outcome is unknown and
    // the operator decides (SPEC 4.9). The adapter never throws past this point
    // (`EmailProvider.sendBatch`).
    let res: Response
    try {
      res = await fetch(BATCH_ENDPOINT, init)
    } catch {
      if (this.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
      try {
        res = await fetch(BATCH_ENDPOINT, init)
      } catch (err) {
        return unknown(`resend batch: no answer, twice (${String(err).slice(0, 200)})`)
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      // The same request is still being worked on under the same key. With
      // the send claim, only our own retry above can be that request, and the
      // first try may yet succeed: a later send of these could be a second copy.
      if (res.status === 409 && text.includes('concurrent_idempotent_requests')) {
        return unknown(`resend batch 409: the same request is still in flight (${text.slice(0, 200)})`)
      }
      // The whole call failed, so every email in it failed the same way.
      const failure: SendResult = {
        ok: false,
        error: `resend batch ${res.status}: ${text.slice(0, 500)}`,
        retryable: ResendProvider.retryable(res.status),
        ...ResendProvider.retryAfter(res),
      }
      return emails.map(() => failure)
    }

    let data: ({ id?: string; error?: string } | null)[]
    try {
      const answer = (await res.json()) as { data?: ({ id?: string; error?: string } | null)[] }
      data = answer.data ?? []
    } catch (err) {
      // A success we cannot read. Resend took the batch; we do not know the ids.
      return unknown(`resend batch ${res.status} accepted it with an unreadable answer (${String(err).slice(0, 200)})`)
    }

    // Entries come back positionally. An entry with an error is Resend refusing
    // that one email, which a retry may fix. An entry with neither, in a success,
    // is not a refusal: Resend may be sending it, so it is never sent again
    // blind (SPEC 4.9).
    return emails.map((_, i): SendResult => {
      const entry = data[i]
      if (entry?.id) return { ok: true, providerMessageId: entry.id }
      if (entry?.error) return { ok: false, error: `resend batch: ${entry.error}`.slice(0, 500), retryable: true }
      return {
        ok: false,
        error: `${OUTCOME_UNKNOWN}: resend batch ${res.status} returned no id for this entry`,
        retryable: false,
        outcomeUnknown: true,
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
      data?: { email_id?: string; bounce?: { type?: string }; click?: { link?: string }; tags?: unknown }
    }

    const type = payload.type ? EVENT_MAP[payload.type] : undefined
    const providerMessageId = payload.data?.email_id
    if (!type || !providerMessageId) return []
    const messageId = taggedMessageId(payload.data?.tags)

    return [
      {
        providerMessageId,
        ...(messageId ? { messageId } : {}),
        type,
        occurredAt: payload.created_at ? new Date(payload.created_at) : new Date(),
        hardBounce: payload.data?.bounce?.type?.toLowerCase() === 'hard',
        meta: payload.data?.click?.link ? { url: payload.data.click.link } : {},
        dedupeKey: `${request.headers.get('svix-id') ?? providerMessageId}:${payload.type}`,
      },
    ]
  }
}

/**
 * Our message id from a webhook's `data.tags`, or undefined.
 *
 * Resend's webhook pages show tags as a map (`{ "kolea_message_id": "42" }`),
 * the shape they are sent in is a list of `{ name, value }`, and older payloads
 * have used the list. Both are read. Anything that is not a whole positive
 * number is ignored: the tag is a lookup hint, and `core/events.ts` checks the
 * row it names against the provider's own id before using it.
 */
function taggedMessageId(tags: unknown): number | undefined {
  let raw: unknown
  if (Array.isArray(tags)) {
    raw = (tags as { name?: unknown; value?: unknown }[]).find((t) => t?.name === MESSAGE_ID_TAG)?.value
  } else if (tags && typeof tags === 'object') {
    raw = (tags as Record<string, unknown>)[MESSAGE_ID_TAG]
  }
  const text = typeof raw === 'number' ? String(raw) : raw
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,15}$/.test(text)) return undefined
  const id = Number(text)
  return Number.isSafeInteger(id) ? id : undefined
}

/**
 * The key that lets Resend recognise a batch it has already taken.
 *
 * Resend keeps a key for 24 hours and answers a repeat of the same request with
 * the first answer, sending nothing. So the key is a digest of exactly what is
 * being asked: which messages (`ref`) and the request body, byte for byte.
 *
 * - The same messages rendered the same way make the same key, so a retry
 *   after a send we failed to record is not a second copy.
 * - `ref` is in it because two different messages can have identical bodies
 *   (a receipt sent again on purpose). Those are two sends and get two keys.
 * - The body is in it because Resend refuses a known key with a different
 *   payload (409). A changed body is a different request and gets its own key.
 *
 * What it cannot cover: the same messages arriving in a differently composed
 * batch are a different request, and Resend will send them again. One key per
 * request is all the batch endpoint offers.
 */
async function idempotencyKey(emails: OutgoingEmail[], body: string): Promise<string> {
  const subject = `${emails.map((email) => email.ref).join(',')}\n${body}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subject))
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `batch/${hex}`
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
