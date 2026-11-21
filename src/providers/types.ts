export interface OutgoingEmail {
  /**
   * Opaque caller correlation handle, echoed nowhere and interpreted by nobody
   * here. It exists so a batch result can be matched back to whatever the caller
   * was tracking without this file learning what that is.
   */
  ref: number
  to: string
  fromEmail: string
  fromName: string
  subject: string
  html: string
  text: string
  /** RFC 8058 one-click unsubscribe target. Scoped to where the reader came from. */
  listUnsubscribeUrl?: string
}

/**
 * The words every "we cannot tell whether it went" failure starts with, so the
 * stored `messages.error` says it on its own and every resend path can leave it
 * out by prefix. A dropped connection after the request may have reached the
 * provider, or a 2xx came back with no id: sending it again could be the
 * reader's second copy.
 */
export const OUTCOME_UNKNOWN = 'outcome unknown'

export type SendResult =
  | { ok: true; providerMessageId: string }
  | {
      ok: false
      error: string
      retryable: boolean
      /**
       * The provider may have the mail. Never retried, and never offered for a
       * bulk resend: the operator checks the provider first (see OUTCOME_UNKNOWN).
       */
      outcomeUnknown?: boolean
    }

export interface ProviderEvent {
  providerMessageId: string
  /**
   * `unsubscribe` is a provider telling us it will no longer deliver to this
   * address because the reader asked it to (Mailgun's own unsubscribe list).
   */
  type: 'delivered' | 'open' | 'click' | 'bounce' | 'complaint' | 'failed' | 'unsubscribe'
  occurredAt: Date
  /** Hard bounces suppress the address; soft bounces do not. */
  hardBounce?: boolean
  /**
   * The provider took the mail and has now given up on it for good without
   * saying the mailbox is dead (an ESP block, its own suppression list, expired
   * in its queue). Changes no consent, but the mail did not arrive, so the
   * message must stop reading `sent`. `failed` events are always this.
   */
  permanent?: boolean
  meta?: Record<string, unknown>
  dedupeKey?: string
}

/**
 * The seam that protects us from the project's #1 risk.
 *
 * Deliverability is the thing most likely to sink Kōlea, so swapping the
 * sending provider must cost one file. Nothing outside `providers/` may name a
 * vendor, and nothing here may know about broadcasts, sequences, or consent.
 */
export interface EmailProvider {
  readonly name: string
  send(email: OutgoingEmail): Promise<SendResult>
  /**
   * Send many at once. Returns one result per input, in input order.
   *
   * Providers rate-limit on API *requests*, so this is the difference between a
   * 15,000-email broadcast taking 25 minutes and taking seconds. Implementations
   * chunk internally to whatever their own per-call ceiling is.
   */
  sendBatch(emails: OutgoingEmail[]): Promise<SendResult[]>
  /** Verify + parse a provider webhook. Returns [] if it isn't ours to handle. */
  parseWebhook(request: Request, secret: string | undefined): Promise<ProviderEvent[]>
  /** The provider's side of a sending domain, when it has an API for it. */
  readonly domains?: DomainIdentity
}

// ───────────────────────────────────────────── sending domains (optional)

/** One DNS record the provider wants at the sender's DNS host. Fully qualified name. */
export interface ProviderRecord {
  purpose: 'dkim' | 'spf' | 'return_path'
  type: 'TXT' | 'CNAME' | 'MX'
  name: string
  value: string
  priority?: number
}

/**
 * A domain as the provider knows it.
 *
 * `active`: the provider found its records and signs for the domain.
 * `unverified`: it has not seen them yet. `failed`: it gave up looking (Resend
 * does after 72 hours) — a re-verify starts it looking again.
 */
export interface ProviderDomain {
  id: string
  state: 'unverified' | 'active' | 'failed'
  records: ProviderRecord[]
}

export type ProviderDomainResult = { ok: true; domain: ProviderDomain } | { ok: false; error: string }

/**
 * "What records does the provider want for this domain, and will it send for
 * it?" Optional on `EmailProvider`: a provider without a domains API simply has
 * no `domains`, and the sending-domain screen then judges by DNS alone.
 *
 * Adapters must leave out a provider's *receiving* MX (it would take over the
 * domain's inbound mail) and its own open/click tracking CNAME (Kōlea tracks
 * on its own host). Neither belongs on the operator's checklist.
 */
export interface DomainIdentity {
  /** Registers `name`, or finds it if the provider already holds it. Idempotent. */
  register(name: string): Promise<ProviderDomainResult>
  /** Asks the provider to look again, and reports what it now says. */
  verify(name: string, providerDomainId: string): Promise<ProviderDomainResult>
}
