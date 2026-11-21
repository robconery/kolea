import { type EmailProvider, OUTCOME_UNKNOWN, type OutgoingEmail, type ProviderEvent, type SendResult } from './types.ts'

/**
 * Mailgun, over plain `fetch`: one form-encoded `POST /v3/<domain>/messages`
 * per mail, the API key as basic auth (`api:<key>`).
 *
 * Why per mail and not Mailgun's recipient-variables batch: that batch sends ONE
 * body to many people and fills `%recipient.x%` placeholders. Every mail here is
 * already rendered for its one reader — a scoped unsubscribe link, tracking links
 * carrying that message's id — so there is no shared body to batch. Calls run a
 * few at a time instead, which is what buys the speed back.
 *
 * Mailgun's own open, click and unsubscribe tracking is switched off on every
 * send: we rewrite links and serve the pixel ourselves, and Mailgun's would
 * count every open twice and put its own unsubscribe page in front of ours.
 */

const BASE_URLS = {
  us: 'https://api.mailgun.net',
  eu: 'https://api.eu.mailgun.net',
} as const

export type MailgunRegion = keyof typeof BASE_URLS

/** Mail in flight at once. Mailgun rate-limits per domain; this stays well under. */
const CONCURRENCY = 8

/**
 * Mailgun retries an undelivered webhook for about eight hours. A signature
 * older than this is refused; a replay inside it changes nothing, because every
 * event is recorded once under its own Mailgun event id (SPEC 5.3).
 */
const SIGNATURE_MAX_AGE_SECONDS = 86_400

/**
 * Permanent-failure reasons that mean the mailbox is dead. Every other permanent
 * failure (an ESP block, a message that expired in Mailgun's queue) is a soft
 * bounce: it says nothing lasting about the address, so it must not suppress.
 */
const HARD_REASONS = new Set(['bounce', 'suppress-bounce'])

/** Just the call this adapter makes, so a test can hand in a plain function. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export interface MailgunOptions {
  apiKey: string
  domain: string
  region?: string
  /** Injected in tests. Production uses the global. */
  fetch?: Fetch
}

/** A webhook Mailgun signed but we refuse, or one that is not Mailgun's at all. */
export class InvalidWebhookError extends Error {}

export class MailgunProvider implements EmailProvider {
  readonly name = 'mailgun'

  private readonly baseUrl: string
  private readonly fetcher: Fetch

  constructor(private readonly options: MailgunOptions) {
    this.baseUrl = mailgunBaseUrl(options.region)
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /** The form fields for one mail. Pure. */
  static form(email: OutgoingEmail): URLSearchParams {
    const form = new URLSearchParams()
    form.append('from', fromHeader(email.fromName, email.fromEmail))
    form.append('to', email.to)
    form.append('subject', email.subject)
    form.append('html', email.html)
    form.append('text', email.text)
    form.append('o:tracking', 'no')
    form.append('o:tracking-clicks', 'no')
    form.append('o:tracking-opens', 'no')
    // Comes back on every event, which makes a webhook traceable to our row by
    // eye. Matching still goes by Mailgun's message id, as it does for Resend.
    form.append('v:ref', String(email.ref))
    if (email.listUnsubscribeUrl) {
      form.append('h:List-Unsubscribe', `<${email.listUnsubscribeUrl}>`)
      form.append('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click')
    }
    return form
  }

  /** 429 and 5xx are worth another attempt; 4xx generally is not. */
  private static retryable(status: number): boolean {
    return status === 429 || status >= 500
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    let res: Response
    try {
      res = await this.fetcher(`${this.baseUrl}/v3/${encodeURIComponent(this.options.domain)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`api:${this.options.apiKey}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: MailgunProvider.form(email).toString(),
      })
    } catch (err) {
      // The request may have reached Mailgun before the line dropped, and a
      // send is not idempotent. Re-queueing it could mail the reader twice, so
      // it fails visibly instead, for the operator to resend once they've looked.
      return {
        ok: false,
        error: `${OUTCOME_UNKNOWN}: mailgun connection dropped, not retried (${String(err).slice(0, 200)})`,
        retryable: false,
        outcomeUnknown: true,
      }
    }

    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { id?: string }
      if (body.id) return { ok: true, providerMessageId: bareId(body.id) }
      // A 2xx with no id: Mailgun may well be sending it. Not a refusal to retry,
      // and not something to send again without looking.
      return {
        ok: false,
        error: `${OUTCOME_UNKNOWN}: mailgun ${res.status} accepted it without an id`,
        retryable: false,
        outcomeUnknown: true,
      }
    }

    const text = await res.text().catch(() => res.statusText)
    return {
      ok: false,
      error: `mailgun ${res.status}: ${text.slice(0, 500)}`,
      retryable: MailgunProvider.retryable(res.status),
    }
  }

  async sendBatch(emails: OutgoingEmail[]): Promise<SendResult[]> {
    const results: SendResult[] = new Array(emails.length)
    let next = 0
    const worker = async () => {
      while (next < emails.length) {
        const i = next++
        results[i] = await this.send(emails[i]!)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, emails.length) }, worker))
    return results
  }

  /**
   * Verify and read one Mailgun webhook: `{ signature, "event-data" }` as JSON.
   *
   * Throws `InvalidWebhookError` for a bad, stale or missing signature, or a
   * body that is not a Mailgun webhook. Returns [] for a verified event we do not
   * act on (opens and clicks — ours are counted by our own pixel and redirect).
   */
  async parseWebhook(request: Request, secret: string | undefined): Promise<ProviderEvent[]> {
    if (!secret) throw new InvalidWebhookError('no webhook signing key is configured')

    const raw = await request.text()
    let payload: MailgunWebhook
    try {
      payload = JSON.parse(raw) as MailgunWebhook
    } catch {
      throw new InvalidWebhookError('body is not JSON')
    }

    const why = await verifyMailgunSignature(payload?.signature, secret, Date.now())
    if (why) throw new InvalidWebhookError(why)

    const ev = toProviderEvent(payload['event-data'])
    return ev ? [ev] : []
  }
}

export function mailgunBaseUrl(region: string | undefined): string {
  return region?.toLowerCase() === 'eu' ? BASE_URLS.eu : BASE_URLS.us
}

interface MailgunWebhook {
  signature?: { timestamp?: unknown; token?: unknown; signature?: unknown }
  'event-data'?: MailgunEventData
}

interface MailgunEventData {
  id?: string
  event?: string
  timestamp?: number
  severity?: string
  reason?: string
  recipient?: string
  message?: { headers?: { 'message-id'?: string } }
  'delivery-status'?: { code?: number; message?: string; description?: string; 'bounce-type'?: string }
}

/**
 * Mailgun signs each webhook with HMAC-SHA256 of `timestamp + token` under the
 * webhook signing key, hex. Returns null when it verifies, or why it does not.
 */
export async function verifyMailgunSignature(
  sig: MailgunWebhook['signature'],
  signingKey: string,
  nowMs: number,
): Promise<string | null> {
  if (!sig || typeof sig !== 'object') return 'no signature'
  const { timestamp, token, signature } = sig
  if (typeof timestamp !== 'string' || typeof token !== 'string' || typeof signature !== 'string') {
    return 'no signature'
  }
  if (!/^\d+$/.test(timestamp)) return 'the timestamp is not a number'
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > SIGNATURE_MAX_AGE_SECONDS) {
    return 'the signature is too old'
  }

  const expected = await hmacSha256Hex(signingKey, timestamp + token)
  return timingSafeEqual(expected, signature.toLowerCase()) ? null : 'the signature does not match'
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Mailgun's event in the words the event pipeline already reads.
 *
 * - `delivered` → delivered
 * - `failed` permanent, mailbox dead → hard bounce (suppresses)
 * - `failed` permanent, anything else → soft bounce flagged `permanent`: changes
 *   no consent, but the message is marked failed so it shows on Undelivered
 * - `failed` temporary → soft bounce (countable, changes nothing; Mailgun retries)
 * - `complained` → complaint (suppresses)
 * - `unsubscribed` → unsubscribe (off everything: Mailgun will refuse that
 *   address from this domain from now on, so pretending otherwise would be mail
 *   silently dropped)
 * - `rejected` → failed (Mailgun would not take it at all; the message is
 *   marked failed, and listed on Undelivered to check before sending)
 * - `opened` / `clicked` → ignored; tracking is ours, and this would double it
 */
function toProviderEvent(data: MailgunEventData | undefined): ProviderEvent | null {
  const id = data?.message?.headers?.['message-id']
  if (!data?.event || !id) return null

  const status = data['delivery-status'] ?? {}
  const base = {
    providerMessageId: bareId(id),
    occurredAt: typeof data.timestamp === 'number' ? new Date(data.timestamp * 1000) : new Date(),
    // Mailgun's event id is unique per event. Without one, fall back to what
    // makes the fact unique, so a replay still lands on the same key.
    dedupeKey: `mailgun:${data.id ?? `${bareId(id)}:${data.event}:${data.timestamp ?? ''}`}`,
  }
  const meta: Record<string, unknown> = { provider: 'mailgun' }
  if (data.reason) meta.reason = data.reason
  if (status.code !== undefined) meta.code = status.code
  const words = status.message || status.description
  if (words) meta.message = String(words).slice(0, 500)

  switch (data.event) {
    case 'delivered':
      return { ...base, type: 'delivered', meta }
    case 'complained':
      return { ...base, type: 'complaint', meta }
    case 'unsubscribed':
      return { ...base, type: 'unsubscribe', meta }
    case 'rejected':
      return { ...base, type: 'failed', meta }
    case 'failed': {
      const permanent = data.severity === 'permanent'
      const hard = permanent && (HARD_REASONS.has(data.reason ?? '') || status['bounce-type'] === 'hard')
      return {
        ...base,
        type: 'bounce',
        hardBounce: hard,
        // A permanent failure that is not a dead mailbox: Mailgun has stopped
        // trying, so the reader never got it, and the message has to say so.
        ...(permanent && !hard ? { permanent: true } : {}),
        meta: { ...meta, severity: data.severity ?? 'unknown' },
      }
    }
    default:
      return null
  }
}

/** Mailgun answers a send with `<id@domain>` and reports events as `id@domain`. */
function bareId(id: string): string {
  return id.trim().replace(/^</, '').replace(/>$/, '')
}

/** A quote would end the display name early, so it is dropped rather than escaped. */
function fromHeader(name: string, email: string): string {
  const clean = name.replace(/["\r\n]/g, '').trim()
  return clean ? `"${clean}" <${email}>` : email
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
